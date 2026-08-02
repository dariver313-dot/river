import assert from "node:assert/strict";

import { getDatabase } from "../../db";
import { regenerateAdministratorRecoveryCodes } from "../../app/lib/account-lifecycle";
import { completeInitialAuthenticatorSetup } from "../../app/lib/selfhost-auth";

const database = getDatabase();
const setupToken = process.env.SELFHOST_SETUP_TOKEN!;

await database.prepare(
  `CREATE TRIGGER reject_admin_recovery_codes
   BEFORE INSERT ON account_tokens
   WHEN NEW.purpose = 'admin_recovery'
   BEGIN SELECT RAISE(ABORT, 'simulated recovery-code failure'); END`,
).run();

await assert.rejects(
  completeInitialAuthenticatorSetup(setupToken, "a-long-initial-password", "admin@example.test"),
  /simulated recovery-code failure/,
);

for (const [table, where] of [
  ["app_users", "email = 'admin01'"],
  ["app_settings", "key = 'selfhost_setup_completed'"],
  ["account_tokens", "email = 'admin01' AND purpose = 'admin_recovery'"],
  ["audit_events", "action = 'initial_admin_initialized'"],
] as const) {
  const result = await database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).first<{ count: number }>();
  assert.equal(result?.count, 0, `${table} must roll back when initial recovery-code creation fails`);
}

await database.prepare("DROP TRIGGER reject_admin_recovery_codes").run();
const completed = await completeInitialAuthenticatorSetup(setupToken, "a-long-initial-password", "admin@example.test");
assert.equal(completed?.recoveryCodes.length, 10);

const activeBefore = await database.prepare(
  "SELECT id FROM account_tokens WHERE email = ? AND purpose = 'admin_recovery' AND used_at IS NULL AND revoked_at IS NULL ORDER BY id",
).bind("admin01").all<{ id: string }>();
const rotationAuditBefore = await database.prepare(
  "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'initial_admin_recovery_codes_rotated'",
).first<{ count: number }>();

await database.prepare(
  `CREATE TRIGGER reject_admin_recovery_rotation
   BEFORE INSERT ON account_tokens
   WHEN NEW.purpose = 'admin_recovery'
   BEGIN SELECT RAISE(ABORT, 'simulated recovery-code rotation failure'); END`,
).run();
await assert.rejects(regenerateAdministratorRecoveryCodes("admin01"), /simulated recovery-code rotation failure/);

const activeAfter = await database.prepare(
  "SELECT id FROM account_tokens WHERE email = ? AND purpose = 'admin_recovery' AND used_at IS NULL AND revoked_at IS NULL ORDER BY id",
).bind("admin01").all<{ id: string }>();
const rotationAuditAfter = await database.prepare(
  "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'initial_admin_recovery_codes_rotated'",
).first<{ count: number }>();
assert.deepEqual(activeAfter.results, activeBefore.results, "A failed rotation must keep the previous recovery codes active.");
assert.equal(rotationAuditAfter?.count, rotationAuditBefore?.count, "A failed rotation must not leave an audit event behind.");
