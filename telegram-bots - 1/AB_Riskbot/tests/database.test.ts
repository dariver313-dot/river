import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { dbHolder, ensureDatabase } from '../db';

test('database bootstrap creates the complete production schema', async () => {
  const dbFile = path.join(os.tmpdir(), `ab-riskbot-schema-${process.pid}-${Date.now()}.db`);
  const databaseUrl = `file:${dbFile.replace(/\\/g, '/')}`;
  const files = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];
  process.env.DATABASE_URL = databaseUrl;

  try {
    await ensureDatabase();
    const rows = await dbHolder.db.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const tables = new Set(rows.map(row => row.name));
    for (const expected of [
      'RiskEval',
      'RuleFeedback',
      'BotConfig',
      'MemberProfile',
      'AgentProfile',
      'SuccessfulWithdrawal',
      'ProfileContribution',
    ]) {
      assert.ok(tables.has(expected), `missing table ${expected}`);
    }
  } finally {
    try { await dbHolder.db.$disconnect(); } catch {}
    for (const file of files) {
      try { fs.unlinkSync(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
});
