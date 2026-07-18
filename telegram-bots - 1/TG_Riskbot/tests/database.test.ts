import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { dbHolder, ensureDatabase } from '../db';

test('database bootstrap creates the complete production schema', async () => {
  const dbFile = path.join(os.tmpdir(), `riskbot-schema-${process.pid}-${Date.now()}.db`);
  const databaseUrl = `file:${dbFile.replace(/\\/g, '/')}`;
  const files = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];
  process.env.DATABASE_URL = databaseUrl;

  try {
    await ensureDatabase();
    const rows = await dbHolder.db.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    );
    const tables = new Set(rows.map(row => row.name));
    for (const expected of ['RiskEval', 'RuleFeedback', 'BotConfig', 'MemberProfile', 'AgentProfile', 'SuccessfulWithdrawal']) {
      assert.ok(tables.has(expected), `missing table ${expected}`);
    }
    const riskEvalColumns = await dbHolder.db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("RiskEval")');
    assert.ok(riskEvalColumns.some(column => column.name === 'notifyLeaseAt'), 'missing RiskEval.notifyLeaseAt');
  } finally {
    try { await dbHolder.db.$disconnect(); } catch {}
    for (const file of files) {
      try { fs.unlinkSync(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
});

test('database bootstrap upgrades an existing RiskEval table with the notification lease column', async () => {
  const dbFile = path.join(os.tmpdir(), `riskbot-legacy-${process.pid}-${Date.now()}.db`);
  const databaseUrl = `file:${dbFile.replace(/\\/g, '/')}`;
  const files = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];
  process.env.DATABASE_URL = databaseUrl;

  const legacy = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await legacy.$executeRawUnsafe(`
      CREATE TABLE RiskEval (
        id TEXT PRIMARY KEY,
        orderId TEXT NOT NULL UNIQUE,
        memberId TEXT NOT NULL,
        memberName TEXT NOT NULL DEFAULT '',
        totalScore INTEGER NOT NULL DEFAULT 0,
        riskLevel TEXT NOT NULL DEFAULT 'LOW',
        triggeredRules TEXT NOT NULL DEFAULT '[]',
        detail TEXT NOT NULL DEFAULT '{}',
        notified INTEGER NOT NULL DEFAULT 0,
        finalStatus TEXT NOT NULL DEFAULT '',
        feedback TEXT NOT NULL DEFAULT '',
        notifyMsgId INTEGER,
        notifiedAt DATETIME,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await legacy.$disconnect();

    await ensureDatabase();
    const columns = await dbHolder.db.$queryRawUnsafe<Array<{ name: string }>>('PRAGMA table_info("RiskEval")');
    assert.ok(columns.some(column => column.name === 'notifyLeaseAt'), 'legacy RiskEval was not upgraded');
  } finally {
    try { await legacy.$disconnect(); } catch {}
    try { await dbHolder.db.$disconnect(); } catch {}
    for (const file of files) {
      try { fs.unlinkSync(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
});
