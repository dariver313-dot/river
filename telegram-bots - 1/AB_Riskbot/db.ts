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
  if (envUrl) {
    // SQLite 串行化写入：connection_limit=1 消除 SQLITE_BUSY 竞争
    return envUrl.includes('connection_limit') ? envUrl : `${envUrl}${envUrl.includes('?') ? '&' : '?'}connection_limit=1`;
  }
  const dbPath = path.join(process.cwd(), 'prisma', 'db', 'riskbot.db');
  return `file:${dbPath}?journal_mode=WAL&synchronous=NORMAL&cache_size=-64000&connection_limit=1`;
}

function resolveDbFilePath(url: string): string {
  const raw = url.replace(/^file:/, '').split('?')[0];
  if (path.isAbsolute(raw)) return raw;
  // Prisma 对 SQLite 的相对 file: URL 一律以 schema.prisma 所在目录为基准。
  // 这里必须使用相同基准创建目录，否则 file:./db/app.db 会创建到项目根目录，
  // 而 Prisma 会尝试打开 prisma/db/app.db，最终触发 SQLITE_CANTOPEN。
  return path.resolve(process.cwd(), 'prisma', raw);
}

function deleteCorruptedDb(dbFile: string): void {
  // 先备份损坏文件，避免彻底丢失数据（可使用 SQLite .recover 工具尝试恢复）
  const timestamp = Date.now();
  const files = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];
  for (const f of files) {
    try {
      if (fs.existsSync(f)) {
        const bakPath = `${f}.corrupted.${timestamp}`;
        fs.renameSync(f, bakPath);
        logger.warn({ file: f, backup: bakPath }, '[数据库] 已备份损坏文件，可尝试使用 SQLite .recover 恢复');
      }
    } catch (e) {
      // rename 失败时回退到直接删除
      try {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
          logger.warn({ file: f }, '[数据库] 备份失败，已直接删除损坏文件');
        }
      } catch (e2) {
        logger.warn({ file: f, err: (e2 as Error).message }, '[数据库] 删除文件失败');
      }
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
    RuleFeedback: ['id', 'evalId', 'ruleId', 'feedback', 'memberId', 'periodInfo', 'createdAt'],
    BotConfig: ['id', 'key', 'value'],
    SuccessfulWithdrawal: ['orderId', 'memberId', 'memberName', 'amount', 'receivingBank', 'receivingName', 'receivingCardNo', 'receivingFingerprint', 'createTime', 'recordedAt'],
    ProfileContribution: ['orderId', 'memberName', 'proxyCode', 'createdAt'],
    MemberProfile: ['memberName', 'memberId', 'evalCount', 'highRiskCount', 'maxRiskLevel', 'lastEvalAt', 'lastEvalScore', 'topRules', 'totalWithdrawAmount', 'recentWithdrawTrend', 'lastWithdrawMethod', 'updatedAt'],
    AgentProfile: ['proxyCode', 'memberCount', 'evalCount', 'highRiskCount', 'totalWithdrawAmount', 'riskScore', 'topRules', 'updatedAt'],
  };

  const VALID_TABLE_NAMES = new Set(Object.keys(expectedColumns));

  try {
    // 获取数据库中所有表名
    const tables = await dbHolder.db.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'"
    );
    const tableNames = new Set(tables.map(t => t.name));

    const criticalIssues: string[] = [];

    for (const [tableName, requiredCols] of Object.entries(expectedColumns)) {
      if (!tableNames.has(tableName)) {
        criticalIssues.push(`表 ${tableName} 不存在`);
        continue;
      }

      // 表名白名单验证：防止 $queryRawUnsafe 注入
      if (!VALID_TABLE_NAMES.has(tableName)) {
        logger.warn({ table: tableName }, '[数据库] 跳过非预期的表名');
        continue;
      }

      const cols = await dbHolder.db.$queryRawUnsafe<{ name: string }[]>(
        `PRAGMA table_info("${tableName}")`
      );
      const colNames = new Set(cols.map(c => c.name));
      const missing = requiredCols.filter(c => !colNames.has(c));

      if (missing.length > 0) {
        const msg = `表 ${tableName} 缺少字段: ${missing.join(', ')}`;
        criticalIssues.push(msg);
      }
    }

    if (criticalIssues.length > 0) {
      throw new Error(`关键表结构不一致: ${criticalIssues.join('; ')}。请执行 prisma db push 修复。`);
    }
  } catch (err) {
    if ((err as Error).message.includes('关键表结构不一致')) {
      logger.fatal({ err: (err as Error).message }, '[数据库] Schema一致性校验致命错误');
      throw err; // 重新抛出，阻止启动
    }
    logger.warn({ err: (err as Error).message }, '[数据库] Schema一致性校验失败，继续启动');
  }
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
 * 仅执行无损的 SQLite 增列迁移。
 * 这类变更不会重建表、不会删除数据；其它结构差异仍由一致性校验阻止启动。
 */
async function applySafeAdditiveMigrations(): Promise<void> {
  const migrations = [
    { table: 'RiskEval', column: 'notifyMsgId', definition: 'INTEGER' },
    { table: 'RiskEval', column: 'notifiedAt', definition: 'DATETIME' },
  ] as const;

  // 新库尚未由 Prisma 建表时，不应执行旧库的 ALTER TABLE 迁移。
  // 后续的 `prisma db push` 会直接按当前 schema 创建完整的 RiskEval 表。
  const tables = await dbHolder.db.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'RiskEval'",
  );
  if (tables.length === 0) return;

  const columns = await dbHolder.db.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info("RiskEval")');
  const existing = new Set(columns.map(column => column.name));

  for (const migration of migrations) {
    if (existing.has(migration.column)) continue;
    // 表名、列名和类型全部来自上面的硬编码清单，不接受外部输入。
    await dbHolder.db.$executeRawUnsafe(
      `ALTER TABLE "${migration.table}" ADD COLUMN "${migration.column}" ${migration.definition}`,
    );
    logger.info({ table: migration.table, column: migration.column }, '[数据库] 已无损补齐新增字段');
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
  // getter 在 _db 为 null 时抛异常，只断开已有实例
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
      let recoveredAfterWalCleanup = false;

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
          // 连接恢复后仍必须执行 schema 同步和一致性校验，不能直接返回。
          recoveredAfterWalCleanup = true;
        } catch (retryErr) {
          logger.warn({ err: (retryErr as Error).message }, '[数据库] 清理日志文件无效，尝试完整重建');
          await dbHolder.db.$disconnect().catch(() => {});
        }
      }

      if (!recoveredAfterWalCleanup) {
        if (process.env.ALLOW_DB_REBUILD !== 'true') {
          logger.error({ db: dbFile }, '[数据库] 数据库文件不可用。为避免误删历史风控数据，已停止启动；确认可重建后设置 ALLOW_DB_REBUILD=true');
          process.exit(1);
        }

        // 完整重建（归档所有文件）
        logger.warn({ db: dbFile }, '[数据库] 数据库文件不可用，ALLOW_DB_REBUILD=true，开始归档并重建');
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
      }
    } else {
      logger.error({ err: msg }, '[数据库] 连接检查失败，无法继续运行');
      try { await dbHolder.db.$disconnect(); } catch {}
      process.exit(1);
    }
  }

  // 迁移前先清理历史重复反馈，确保唯一索引可以创建
  await dedupeRuleFeedback();
  await applySafeAdditiveMigrations();

  try {
    // 使用异步 execFile 替代 execSync，避免阻塞事件循环
    const { execFile } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      const prismaCli = path.resolve(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');
      execFile(process.execPath, [prismaCli, 'db', 'push'], {
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
        `CREATE TABLE IF NOT EXISTS MemberProfile (memberName TEXT PRIMARY KEY, memberId TEXT NOT NULL DEFAULT '', evalCount INTEGER NOT NULL DEFAULT 0, highRiskCount INTEGER NOT NULL DEFAULT 0, maxRiskLevel TEXT NOT NULL DEFAULT '', lastEvalAt DATETIME, lastEvalScore INTEGER NOT NULL DEFAULT 0, topRules TEXT NOT NULL DEFAULT '{}', totalWithdrawAmount REAL NOT NULL DEFAULT 0, recentWithdrawTrend TEXT NOT NULL DEFAULT '[]', lastWithdrawMethod TEXT NOT NULL DEFAULT '', updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS AgentProfile (proxyCode TEXT PRIMARY KEY, memberCount INTEGER NOT NULL DEFAULT 0, evalCount INTEGER NOT NULL DEFAULT 0, highRiskCount INTEGER NOT NULL DEFAULT 0, totalWithdrawAmount REAL NOT NULL DEFAULT 0, riskScore INTEGER NOT NULL DEFAULT 0, topRules TEXT NOT NULL DEFAULT '{}', updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS RiskEval (id TEXT PRIMARY KEY, orderId TEXT NOT NULL UNIQUE, memberId TEXT NOT NULL, memberName TEXT NOT NULL DEFAULT '', totalScore INTEGER NOT NULL DEFAULT 0, riskLevel TEXT NOT NULL DEFAULT 'LOW', triggeredRules TEXT NOT NULL DEFAULT '[]', detail TEXT NOT NULL DEFAULT '{}', notified INTEGER NOT NULL DEFAULT 0, finalStatus TEXT NOT NULL DEFAULT '', feedback TEXT NOT NULL DEFAULT '', notifyMsgId INTEGER, notifiedAt DATETIME, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_memberId_idx ON RiskEval(memberId)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_createdAt_idx ON RiskEval(createdAt)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_riskLevel_idx ON RiskEval(riskLevel)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_finalStatus_idx ON RiskEval(finalStatus)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_notified_finalStatus_idx ON RiskEval(notified, finalStatus)`,
        `CREATE INDEX IF NOT EXISTS RiskEval_notified_feedback_idx ON RiskEval(notified, feedback)`,
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
        `CREATE TABLE IF NOT EXISTS ProfileContribution (orderId TEXT PRIMARY KEY, memberName TEXT NOT NULL, proxyCode TEXT NOT NULL DEFAULT '', createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE INDEX IF NOT EXISTS ProfileContribution_createdAt_idx ON ProfileContribution(createdAt)`,
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

  // 迁移/兜底完成后再校验，避免新增字段时启动前误报致命错误
  await verifySchemaConsistency();
}

export default dbHolder;
