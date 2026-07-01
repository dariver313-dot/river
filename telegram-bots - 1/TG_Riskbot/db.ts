import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import path from 'path';
import fs from 'fs';

class DbHolder {
  private _db: PrismaClient | null = null;

  /** 获取已初始化的 PrismaClient，未初始化时抛出明确错误 */
  get db(): PrismaClient {
    if (!this._db) {
      throw new Error('数据库未初始化，请先调用 ensureDatabase()');
    }
    return this._db;
  }

  set db(value: PrismaClient) {
    this._db = value;
  }
}

export const dbHolder = new DbHolder();

/** 获取已初始化的 PrismaClient，未初始化时抛出明确错误 */
export function getDb(): PrismaClient {
  return dbHolder.db;
}

function getDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL || '';
  if (envUrl) return envUrl;
  const dbPath = path.join(process.cwd(), 'prisma', 'db', 'riskbot.db');
  return `file:${dbPath}?journal_mode=WAL&synchronous=NORMAL&cache_size=-64000`;
}

function resolveDbFilePath(url: string): string {
  const raw = url.replace(/^file:/, '').split('?')[0];
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(process.cwd(), raw);
}

function deleteCorruptedDb(dbFile: string): void {
  const files = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];
  for (const f of files) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        logger.warn({ file: f }, '[数据库] 已删除损坏文件');
      }
    } catch (e) {
      logger.warn({ file: f, err: (e as Error).message }, '[数据库] 删除文件失败');
    }
  }
}

/** 仅删除 WAL/SHM 日志文件（安全操作，主数据库文件保留，仅丢失未提交的写入） */
function deleteWalShm(dbFile: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const f = dbFile + suffix;
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        logger.warn({ file: f }, '[数据库] 已删除残留日志文件');
      }
    } catch (e) {
      logger.warn({ file: f, err: (e as Error).message }, '[数据库] 删除日志文件失败');
    }
  }
}

function migrateFromLegacyPath(newDbFile: string): void {
  if (fs.existsSync(newDbFile)) return;

  const legacyPaths = [
    path.resolve(process.cwd(), 'db', 'riskbot.db'),
    path.resolve(process.cwd(), 'riskbot.db'),
    path.resolve(process.cwd(), 'prisma', 'riskbot.db'),
  ];

  for (const legacyPath of legacyPaths) {
    if (!fs.existsSync(legacyPath)) continue;

    const newDir = path.dirname(newDbFile);
    if (!fs.existsSync(newDir)) {
      fs.mkdirSync(newDir, { recursive: true });
    }

    try {
      const filesToCopy = [
        { src: legacyPath, dest: newDbFile },
        { src: `${legacyPath}-wal`, dest: `${newDbFile}-wal` },
        { src: `${legacyPath}-shm`, dest: `${newDbFile}-shm` },
      ];

      for (const { src, dest } of filesToCopy) {
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
        }
      }

      logger.info({ from: legacyPath, to: newDbFile }, '[数据库] 已从旧路径迁移数据库');
      return;
    } catch (err) {
      logger.warn({ from: legacyPath, to: newDbFile, err: (err as Error).message }, '[数据库] 迁移失败，将创建新数据库');
    }
  }
}

/** 启动时验证数据库表结构与 Prisma schema / DDL 定义一致 */
async function verifySchemaConsistency(): Promise<void> {
  const expectedColumns: Record<string, string[]> = {
    RiskEval: ['orderId', 'memberId', 'memberName', 'totalScore', 'riskLevel', 'triggeredRules', 'detail', 'notified', 'finalStatus', 'feedback', 'notifyMsgId', 'notifiedAt', 'createdAt'],
    RuleFeedback: ['evalId', 'ruleId', 'feedback', 'memberId', 'periodInfo', 'createdAt'],
    BotConfig: ['key', 'value'],
    MemberProfile: ['memberName', 'memberId', 'evalCount', 'highRiskCount', 'maxRiskLevel', 'lastEvalAt', 'lastEvalScore', 'topRules', 'totalWithdrawAmount', 'recentWithdrawTrend'],
    AgentProfile: ['proxyCode', 'memberCount', 'evalCount', 'highRiskCount', 'totalWithdrawAmount', 'riskScore', 'topRules'],
  };

  try {
    // 获取数据库中所有表名
    const tables = await dbHolder.db.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'"
    );
    const tableNames = new Set(tables.map(t => t.name));

    for (const [tableName, requiredCols] of Object.entries(expectedColumns)) {
      if (!tableNames.has(tableName)) {
        logger.warn({ table: tableName }, '[数据库] 期望的表不存在，将在 prisma db push 中创建');
        continue;
      }

      const cols = await dbHolder.db.$queryRawUnsafe<{ name: string }[]>(
        `PRAGMA table_info("${tableName}")`
      );
      const colNames = new Set(cols.map(c => c.name));
      const missing = requiredCols.filter(c => !colNames.has(c));

      if (missing.length > 0) {
        logger.warn({ table: tableName, missing }, `[数据库] 表 ${tableName} 缺少字段: ${missing.join(', ')}，可能需要手动执行 prisma db push`);
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[数据库] Schema一致性校验失败，继续启动');
  }
}

export async function ensureDatabase(): Promise<void> {
  const databaseUrl = getDatabaseUrl();
  process.env.DATABASE_URL = databaseUrl;

  const dbFile = resolveDbFilePath(databaseUrl);
  const dbDir = path.dirname(dbFile);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  migrateFromLegacyPath(dbFile);

  // 先断开旧连接，避免连接泄漏
  try { await dbHolder.db.$disconnect(); } catch {}

  dbHolder.db = new PrismaClient();

  try {
    await dbHolder.db.$queryRaw`SELECT 1`;
    // 设置 SQLite PRAGMA 以优化并发写入和防止 SQLITE_BUSY
    // 注意：PRAGMA 语句返回结果行，必须使用 $queryRawUnsafe 而非 $executeRawUnsafe
    await dbHolder.db.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    await dbHolder.db.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await dbHolder.db.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
    logger.info('[数据库] SQLite PRAGMA 并发优化已应用 (WAL, busy_timeout=5000)');
  } catch (err: unknown) {
    const msg = (err as Error)?.message || '';
    const isCorrupt = msg.includes('malformed') || msg.includes('disk image') || msg.includes('corrupt') || msg.includes('SQLITE_CORRUPT');
    const isCantOpen = msg.includes('Unable to open') || msg.includes('SQLITE_CANTOPEN') || msg.includes('Error code 14');

    if (isCorrupt || isCantOpen) {
      await dbHolder.db.$disconnect().catch(() => {});

      if (isCantOpen && !isCorrupt) {
        // CANTOPEN 通常是残留锁或 WAL 文件损坏，先尝试只删除 WAL/SHM（保留主数据库）
        logger.warn({ db: dbFile }, '[数据库] 数据库无法打开，尝试清理残留日志文件');
        deleteWalShm(dbFile);

        // 确保目录存在
        if (!fs.existsSync(dbDir)) {
          fs.mkdirSync(dbDir, { recursive: true });
        }

        dbHolder.db = new PrismaClient();
        try {
          await dbHolder.db.$queryRaw`SELECT 1`;
          await dbHolder.db.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
          await dbHolder.db.$queryRawUnsafe('PRAGMA journal_mode = WAL');
          await dbHolder.db.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
          logger.info('[数据库] 清理日志文件后连接成功');
          return; // 恢复成功，跳过完整重建
        } catch (retryErr) {
          logger.warn({ err: (retryErr as Error).message }, '[数据库] 清理日志文件无效，尝试完整重建');
          await dbHolder.db.$disconnect().catch(() => {});
        }
      }

      // 完整重建（删除所有文件）
      logger.warn({ db: dbFile }, '[数据库] 数据库文件不可用，自动重建');
      deleteCorruptedDb(dbFile);

      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.info({ dbDir }, '[数据库] 已重新创建数据库目录');
      }

      dbHolder.db = new PrismaClient();
      try {
        await dbHolder.db.$queryRaw`SELECT 1`;
        await dbHolder.db.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
        await dbHolder.db.$queryRawUnsafe('PRAGMA journal_mode = WAL');
        await dbHolder.db.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
        logger.info('[数据库] 重建后连接成功');
      } catch (retryErr) {
        logger.error({ err: (retryErr as Error).message }, '[数据库] 重建后仍无法连接，无法继续运行');
        try { await dbHolder.db.$disconnect(); } catch {}
        process.exit(1);
      }
    } else {
      logger.error({ err: msg }, '[数据库] 连接检查失败，无法继续运行');
      try { await dbHolder.db.$disconnect(); } catch {}
      process.exit(1);
    }
  }

  // 验证数据库 schema 与代码中的 DDL 一致
  await verifySchemaConsistency();

  try {
    // 使用异步 execFile 替代 execSync，避免阻塞事件循环
    const { execFile } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      execFile('npx', ['prisma', 'db', 'push'], {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        cwd: process.cwd(),
      }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    logger.info({ db: dbFile }, '[数据库] Schema 同步完成');
  } catch (pushErr) {
    // prisma db push 失败时回退到 DDL 兜底
    logger.warn({ err: (pushErr as Error).message }, '[数据库] prisma db push 失败，尝试 DDL 兜底');
    try {
      // SECURITY: DDL 语句为硬编码常量，严禁在此处拼接任何变量，防止 SQL 注入
      const ddl: readonly string[] = [
        `CREATE TABLE IF NOT EXISTS MemberProfile (memberName TEXT PRIMARY KEY, memberId TEXT NOT NULL DEFAULT '', evalCount INTEGER NOT NULL DEFAULT 0, highRiskCount INTEGER NOT NULL DEFAULT 0, maxRiskLevel TEXT NOT NULL DEFAULT '', lastEvalAt DATETIME, lastEvalScore INTEGER NOT NULL DEFAULT 0, topRules TEXT NOT NULL DEFAULT '{}', totalWithdrawAmount REAL NOT NULL DEFAULT 0, recentWithdrawTrend TEXT NOT NULL DEFAULT '[]', updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS AgentProfile (proxyCode TEXT PRIMARY KEY, memberCount INTEGER NOT NULL DEFAULT 0, evalCount INTEGER NOT NULL DEFAULT 0, highRiskCount INTEGER NOT NULL DEFAULT 0, totalWithdrawAmount REAL NOT NULL DEFAULT 0, riskScore INTEGER NOT NULL DEFAULT 0, topRules TEXT NOT NULL DEFAULT '{}', updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS RiskEval (id TEXT PRIMARY KEY, orderId TEXT NOT NULL UNIQUE, memberId TEXT NOT NULL, memberName TEXT NOT NULL DEFAULT '', totalScore INTEGER NOT NULL DEFAULT 0, riskLevel TEXT NOT NULL DEFAULT 'LOW', triggeredRules TEXT NOT NULL DEFAULT '[]', detail TEXT NOT NULL DEFAULT '{}', notified INTEGER NOT NULL DEFAULT 0, finalStatus TEXT NOT NULL DEFAULT '', feedback TEXT NOT NULL DEFAULT '', notifyMsgId INTEGER, notifiedAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_memberId_idx ON RiskEval(memberId)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_createdAt_idx ON RiskEval(createdAt)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_riskLevel_idx ON RiskEval(riskLevel)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_finalStatus_idx ON RiskEval(finalStatus)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_notified_finalStatus_idx ON RiskEval(notified, finalStatus)`,
        `CREATE TABLE IF NOT EXISTS RuleFeedback (id TEXT PRIMARY KEY, evalId TEXT NOT NULL, ruleId TEXT NOT NULL, feedback TEXT NOT NULL DEFAULT '', memberId TEXT NOT NULL DEFAULT '', periodInfo TEXT NOT NULL DEFAULT '', createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE INDEX IF NOT EXISTS RuleFeedback_evalId_idx ON RuleFeedback(evalId)`,
        `CREATE INDEX IF NOT EXISTS RuleFeedback_memberId_idx ON RuleFeedback(memberId)`,
        `CREATE INDEX IF NOT EXISTS RuleFeedback_memberId_feedback_createdAt_idx ON RuleFeedback(memberId, feedback, createdAt)`,
        `CREATE INDEX IF NOT EXISTS RuleFeedback_memberId_feedback_ruleId_idx ON RuleFeedback(memberId, feedback, ruleId)`,
        `CREATE INDEX IF NOT EXISTS RuleFeedback_createdAt_idx ON RuleFeedback(createdAt)`,
        `CREATE TABLE IF NOT EXISTS BotConfig (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL DEFAULT '')`,
        `CREATE INDEX IF NOT EXISTS BotConfig_key_idx ON BotConfig(key)`,
      ] as const;
      // 运行时安全检查：确保无模板插值
      for (const sql of ddl) {
        if (sql.includes('${') || sql.includes('`')) {
          throw new Error('DDL contains template literal - possible SQL injection');
        }
      }
      await dbHolder.db.$transaction(ddl.map(sql => dbHolder.db.$executeRawUnsafe(sql)));
      logger.info('[数据库] DDL 兜底建表完成');
    } catch (ddlErr) {
      logger.error({ err: (ddlErr as Error).message }, '[数据库] DDL 兜底也失败，请手动执行 prisma db push');
    }
  }
}

export default dbHolder;
