import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

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
  if (envUrl) {
    return envUrl.includes('connection_limit') ? envUrl : `${envUrl}${envUrl.includes('?') ? '&' : '?'}connection_limit=1`;
  }
  const dbPath = path.join(APP_ROOT, 'prisma', 'db', 'riskbot.db');
  return `file:${dbPath}?journal_mode=WAL&synchronous=NORMAL&cache_size=-64000&connection_limit=1`;
}

function resolveDbFilePath(url: string): string {
  const raw = url.replace(/^file:/, '').split('?')[0];
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(APP_ROOT, raw);
}

function archiveCorruptedDb(dbFile: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const files = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];
  for (const f of files) {
    try {
      if (fs.existsSync(f)) {
        const archived = `${f}.corrupt-${stamp}`;
        fs.renameSync(f, archived);
        logger.warn({ file: f, archived }, '[数据库] 已备份损坏文件');
      }
    } catch (e) {
      logger.error({ file: f, err: (e as Error).message }, '[数据库] 备份损坏文件失败');
      throw e;
    }
  }
}

function migrateFromLegacyPath(newDbFile: string): void {
  if (fs.existsSync(newDbFile)) return;

  const legacyPaths = [
    path.resolve(APP_ROOT, 'db', 'riskbot.db'),
    path.resolve(APP_ROOT, 'riskbot.db'),
    path.resolve(APP_ROOT, 'prisma', 'riskbot.db'),
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
async function verifySchemaConsistency(): Promise<string[]> {
  const issues: string[] = [];
  const expectedColumns: Record<string, string[]> = {
    RiskEval: ['id', 'orderId', 'memberId', 'memberName', 'totalScore', 'riskLevel', 'triggeredRules', 'detail', 'notified', 'finalStatus', 'feedback', 'notifyMsgId', 'notifiedAt', 'notifyLeaseAt', 'createdAt'],
    RuleFeedback: ['id', 'evalId', 'ruleId', 'feedback', 'memberId', 'periodInfo', 'createdAt'],
    BotConfig: ['id', 'key', 'value'],
    MemberProfile: ['memberName', 'memberId', 'evalCount', 'highRiskCount', 'maxRiskLevel', 'lastEvalAt', 'lastEvalScore', 'topRules', 'totalWithdrawAmount', 'recentWithdrawTrend', 'lastWithdrawMethod', 'createdAt', 'updatedAt'],
    AgentProfile: ['proxyCode', 'memberCount', 'evalCount', 'highRiskCount', 'totalWithdrawAmount', 'riskScore', 'topRules', 'createdAt', 'updatedAt'],
    SuccessfulWithdrawal: ['orderId', 'memberId', 'memberName', 'amount', 'receivingBank', 'receivingName', 'receivingCardNo', 'receivingFingerprint', 'createTime', 'recordedAt'],
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
        issues.push(`${tableName}表不存在`);
        continue;
      }

      const cols = await dbHolder.db.$queryRawUnsafe<{ name: string }[]>(
        `PRAGMA table_info("${tableName}")`
      );
      const colNames = new Set(cols.map(c => c.name));
      const missing = requiredCols.filter(c => !colNames.has(c));

      if (missing.length > 0) {
        logger.warn({ table: tableName, missing }, `[数据库] 表 ${tableName} 缺少字段: ${missing.join(', ')}，可能需要手动执行 prisma db push`);
        issues.push(`${tableName}缺少字段:${missing.join(',')}`);
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ err: message }, '[数据库] Schema一致性校验失败');
    issues.push(`无法校验数据库结构:${message}`);
  }
  return issues;
}

async function dedupeRuleFeedback(): Promise<void> {
  try {
    await dbHolder.db.$executeRawUnsafe(`
      DELETE FROM RuleFeedback
      WHERE rowid NOT IN (
        SELECT MIN(rowid)
        FROM RuleFeedback
        GROUP BY evalId, ruleId
      )
    `);
  } catch (err) {
    const msg = (err as Error).message || '';
    if (!msg.includes('no such table')) {
      logger.warn({ err: msg }, '[数据库] RuleFeedback 去重失败，唯一索引可能无法创建');
    }
  }
}

/**
 * prisma db push 在正常环境会完成此变更；此处仅为其失败时的安全兜底。
 * 列名与 SQL 均为固定常量，且只做 SQLite 支持的追加列操作。
 */
async function ensureRiskEvalNotificationLeaseColumn(): Promise<void> {
  const tables = await dbHolder.db.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='RiskEval'",
  );
  if (tables.length === 0) return;

  const columns = await dbHolder.db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("RiskEval")');
  if (columns.some(column => column.name === 'notifyLeaseAt')) return;

  await dbHolder.db.$executeRawUnsafe('ALTER TABLE "RiskEval" ADD COLUMN "notifyLeaseAt" DATETIME');
  logger.info('[数据库] 已为历史 RiskEval 表补充通知租约字段');
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
        // WAL 可能包含已提交但尚未 checkpoint 的数据，不能通过删除 WAL/SHM 恢复。
        logger.warn({ db: dbFile }, '[数据库] 数据库暂时无法打开，等待后重连并保留全部数据库文件');
        await new Promise(resolve => setTimeout(resolve, 1000));

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
          logger.info('[数据库] 等待后重新连接成功');
          return; // 恢复成功，跳过完整重建
        } catch (retryErr) {
          logger.warn({ err: (retryErr as Error).message }, '[数据库] 重新连接失败');
          await dbHolder.db.$disconnect().catch(() => {});
        }
      }

      // 完整重建需要显式允许：默认不动主库，避免生产环境静默丢历史数据
      if (process.env.ALLOW_DB_REBUILD !== 'true') {
        logger.error({ db: dbFile }, '[数据库] 数据库文件不可用。为避免误删历史数据，已停止启动；确认可重建后设置 ALLOW_DB_REBUILD=true');
        try { await dbHolder.db.$disconnect(); } catch {}
        process.exit(1);
      }

      logger.warn({ db: dbFile }, '[数据库] 数据库文件不可用，将备份原文件后重建');
      try {
        archiveCorruptedDb(dbFile);
      } catch {
        try { await dbHolder.db.$disconnect(); } catch {}
        process.exit(1);
      }

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

  // 迁移前先清理历史重复反馈，确保唯一索引可以创建
  await dedupeRuleFeedback();

  try {
    // 使用异步 execFile 替代 execSync，避免阻塞事件循环
    const { execFile } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
       const prismaCli = path.resolve(APP_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
      execFile(process.execPath, [prismaCli, 'db', 'push'], {
        env: { ...process.env, DATABASE_URL: databaseUrl },
         cwd: APP_ROOT,
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
        `CREATE TABLE IF NOT EXISTS MemberProfile (memberName TEXT PRIMARY KEY, memberId TEXT NOT NULL DEFAULT '', evalCount INTEGER NOT NULL DEFAULT 0, highRiskCount INTEGER NOT NULL DEFAULT 0, maxRiskLevel TEXT NOT NULL DEFAULT '', lastEvalAt DATETIME, lastEvalScore INTEGER NOT NULL DEFAULT 0, topRules TEXT NOT NULL DEFAULT '{}', totalWithdrawAmount REAL NOT NULL DEFAULT 0, recentWithdrawTrend TEXT NOT NULL DEFAULT '[]', lastWithdrawMethod TEXT NOT NULL DEFAULT '', createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS AgentProfile (proxyCode TEXT PRIMARY KEY, memberCount INTEGER NOT NULL DEFAULT 0, evalCount INTEGER NOT NULL DEFAULT 0, highRiskCount INTEGER NOT NULL DEFAULT 0, totalWithdrawAmount REAL NOT NULL DEFAULT 0, riskScore INTEGER NOT NULL DEFAULT 0, topRules TEXT NOT NULL DEFAULT '{}', createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS RiskEval (id TEXT PRIMARY KEY, orderId TEXT NOT NULL UNIQUE, memberId TEXT NOT NULL, memberName TEXT NOT NULL DEFAULT '', totalScore INTEGER NOT NULL DEFAULT 0, riskLevel TEXT NOT NULL DEFAULT 'LOW', triggeredRules TEXT NOT NULL DEFAULT '[]', detail TEXT NOT NULL DEFAULT '{}', notified INTEGER NOT NULL DEFAULT 0, finalStatus TEXT NOT NULL DEFAULT '', feedback TEXT NOT NULL DEFAULT '', notifyMsgId INTEGER, notifiedAt DATETIME, notifyLeaseAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
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
        `CREATE UNIQUE INDEX IF NOT EXISTS RuleFeedback_evalId_ruleId_key ON RuleFeedback(evalId, ruleId)`,
        `CREATE TABLE IF NOT EXISTS BotConfig (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL DEFAULT '')`,
        `CREATE INDEX IF NOT EXISTS BotConfig_key_idx ON BotConfig(key)`,
        `CREATE TABLE IF NOT EXISTS SuccessfulWithdrawal (orderId TEXT PRIMARY KEY, memberId TEXT NOT NULL, memberName TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, receivingBank TEXT NOT NULL DEFAULT '', receivingName TEXT NOT NULL DEFAULT '', receivingCardNo TEXT NOT NULL DEFAULT '', receivingFingerprint TEXT NOT NULL DEFAULT '', createTime DATETIME NOT NULL, recordedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE INDEX IF NOT EXISTS SuccessfulWithdrawal_memberId_createTime_idx ON SuccessfulWithdrawal(memberId, createTime)`,
        `CREATE INDEX IF NOT EXISTS SuccessfulWithdrawal_memberName_createTime_idx ON SuccessfulWithdrawal(memberName, createTime)`,
        `CREATE INDEX IF NOT EXISTS SuccessfulWithdrawal_receivingFingerprint_createTime_idx ON SuccessfulWithdrawal(receivingFingerprint, createTime)`,
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

  // 即使 prisma CLI 不可用，也要让历史库获得通知去重所需的追加字段。
  await ensureRiskEvalNotificationLeaseColumn();

  // 迁移/兜底完成后再校验，避免新增字段时启动前误报
  const schemaIssues = await verifySchemaConsistency();
  if (schemaIssues.length > 0) {
    throw new Error(`数据库结构不完整，拒绝启动：${schemaIssues.join('；')}`);
  }
}

export default dbHolder;
