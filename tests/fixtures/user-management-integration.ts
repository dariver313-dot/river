import assert from "node:assert/strict";

import { getDatabase } from "../../db";
import { createManagedUser, deleteManagedUser, updateManagedUser } from "../../app/lib/user-store";

const actor = "admin01";
const departingUser = "member01";
const personalVaultId = "member01-personal";

const database = getDatabase();
await database.prepare(
  "INSERT INTO app_users (email, role, status, password_hash, security_email, security_email_verified_at) VALUES (?, 'admin', 'active', 'not-used-in-this-test', ?, CURRENT_TIMESTAMP)",
).bind(actor, `${actor}@example.test`).run();

const created = await createManagedUser(actor, {
  email: departingUser,
  role: "user",
  securityEmail: "member01@example.test",
});
assert.equal(created.user.status, "pending");
assert.equal(created.activation.delivery, "manual");

const pending = await database.prepare(
  "SELECT status, security_email_verified_at, must_change_password FROM app_users WHERE email = ?",
).bind(departingUser).first<{ status: string; security_email_verified_at: string | null; must_change_password: number }>();
assert.deepEqual(pending, { status: "pending", security_email_verified_at: null, must_change_password: 0 });
await assert.rejects(
  updateManagedUser(actor, { email: departingUser, status: "suspended" }),
  /待激活账户只能通过激活确认流程/,
);

await database.prepare(
  "UPDATE app_users SET status = 'active', security_email_verified_at = CURRENT_TIMESTAMP WHERE email = ?",
).bind(departingUser).run();
await database.prepare(
  "INSERT INTO vaults (id, owner_email, kind, name) VALUES (?, ?, 'personal', '个人工作区')",
).bind(personalVaultId, departingUser).run();
await database.prepare(
  "INSERT INTO vault_members (vault_id, email, role) VALUES (?, ?, 'owner')",
).bind(personalVaultId, departingUser).run();
await database.prepare(
  "INSERT INTO vault_items (id, vault_id, ciphertext, iv) VALUES ('member01-item', ?, 'ciphertext', 'iv')",
).bind(personalVaultId).run();

await deleteManagedUser(actor, { email: departingUser });
for (const [table, where] of [
  ["app_users", "email = 'member01'"],
  ["vaults", "owner_email = 'member01' AND kind = 'personal'"],
  ["vault_members", "vault_id = 'member01-personal'"],
  ["vault_items", "vault_id = 'member01-personal'"],
] as const) {
  const result = await database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).first<{ count: number }>();
  assert.equal(result?.count, 0, `${table} must be removed with the departing user`);
}
