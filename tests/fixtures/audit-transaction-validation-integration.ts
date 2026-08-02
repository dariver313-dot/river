import assert from "node:assert/strict";

import { getDatabase } from "../../db";
import { writeAuditedMutation } from "../../app/lib/audit-log";

const database = getDatabase();
await database.prepare("CREATE TABLE audit_transaction_probe (id TEXT PRIMARY KEY NOT NULL)").run();

async function count(sql: string) {
  return (await database.prepare(sql).first<{ count: number }>())?.count ?? 0;
}

async function writeProbe(id: string, expectedChanges: number) {
  return writeAuditedMutation("audit-transaction-test", "admin01", "probe_changed", id, {
    auditOrder: "before",
    commitPrerequisite: { sql: "SELECT 1 FROM audit_transaction_probe WHERE id = ?", values: [id] },
    expectedChanges,
    statements: (guard) => [database.prepare(
      `INSERT INTO audit_transaction_probe (id)
       SELECT ? WHERE ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(id, ...guard.values, guard.auditEventId)],
  });
}

await assert.rejects(writeProbe("must-roll-back", 2), /业务变更与审计记录未能同步提交/);
assert.equal(await count("SELECT COUNT(*) AS count FROM audit_transaction_probe"), 0);
assert.equal(await count("SELECT COUNT(*) AS count FROM audit_events WHERE vault_id = 'audit-transaction-test'"), 0);
const stateAfterRollback = await database.prepare(
  "SELECT last_sequence FROM audit_chain_states WHERE vault_id = 'audit-transaction-test'",
).first<{ last_sequence: number }>();
assert.equal(stateAfterRollback?.last_sequence, 0);

await writeProbe("committed", 1);
assert.equal(await count("SELECT COUNT(*) AS count FROM audit_transaction_probe"), 1);
assert.equal(await count("SELECT COUNT(*) AS count FROM audit_events WHERE vault_id = 'audit-transaction-test'"), 1);
const stateAfterCommit = await database.prepare(
  "SELECT last_sequence FROM audit_chain_states WHERE vault_id = 'audit-transaction-test'",
).first<{ last_sequence: number }>();
assert.equal(stateAfterCommit?.last_sequence, 1);
