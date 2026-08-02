import assert from "node:assert/strict";
import { getDatabase } from "../../db";
import { writeAuditEvent } from "../../app/lib/audit-log";
import { createVaultItem, deleteVaultItem, getVaultItem, getVaultItemScope, listManagementAudit, updateVaultItem } from "../../app/lib/vault-store";

const database = getDatabase();

for (const [email, role] of [["admin01", "admin"], ["member01", "user"], ["outsider01", "user"]] as const) {
  await database.prepare(
    "INSERT INTO app_users (email, role, status, password_hash, security_email, security_email_verified_at) VALUES (?, ?, 'active', 'not-used-in-this-test', ?, CURRENT_TIMESTAMP)",
  ).bind(email, role, `${email}@example.test`).run();
}

const publicItem = await createVaultItem("admin01", {
  name: "共享服务",
  domain: "shared.example.test",
  username: "team-user",
  password: "team-password",
  category: "团队",
  group: "公共",
  type: "登录",
  twoFactor: false,
  favorite: false,
  brand: "new",
  note: "",
});

const publicScope = await getVaultItemScope("admin01", publicItem.id);
assert.equal(publicScope.group, "公共");
await assert.rejects(
  deleteVaultItem("admin01", publicItem.id, `${publicScope.vaultId}-stale`),
  /项目所在工作区已变更/,
);
assert.equal((await getVaultItem("admin01", publicItem.id)).id, publicItem.id, "A stale scope must not delete a credential.");

await writeAuditEvent(publicScope.vaultId, "member01", "account_security_email_changed", "member01");
const userAudit = await listManagementAudit("admin01", { category: "user" });
const emailChangeEvent = userAudit.audit.find((event) => event.action === "account_security_email_changed");
assert(emailChangeEvent, "Security-email changes must be visible in management user audit.");
assert.equal(emailChangeEvent.integrity, "sealed");

const accessedPublicItem = await getVaultItem("member01", publicItem.id);
assert.equal(accessedPublicItem.password, "team-password");

const projectAudit = await listManagementAudit("admin01", { category: "project" });
const accessEvent = projectAudit.audit.find((event) => event.action === "public_secret_accessed" && event.itemId === publicItem.id);
assert(accessEvent, "Public credential delivery must produce a visible management audit event.");
assert.equal(accessEvent.actorEmail, "member01");
assert.equal(accessEvent.integrity, "sealed");
assert.equal(projectAudit.chainIntegrity, "sealed");

const accessCountBeforeUnauthorizedRead = await database.prepare(
  "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'public_secret_accessed' AND item_id = ?",
).bind(publicItem.id).first<{ count: number }>();

const personalItem = await createVaultItem("member01", {
  name: "私人服务",
  domain: "personal.example.test",
  username: "member-user",
  password: "personal-password",
  category: "个人",
  group: "个人",
  type: "登录",
  twoFactor: false,
  favorite: false,
  brand: "new",
  note: "",
});
const markedTwoFactor = await updateVaultItem("member01", personalItem.id, { ...personalItem, twoFactor: true });
assert.equal(markedTwoFactor.twoFactor, true, "External two-factor use must be recordable without storing a TOTP secret.");
await assert.rejects(
  updateVaultItem("member01", personalItem.id, { ...personalItem, name: "stale overwrite" }),
  /已被其他操作更新/,
);
assert.equal((await getVaultItem("member01", personalItem.id)).name, personalItem.name, "A stale credential edit must not overwrite the latest value.");
const clearedTwoFactor = await updateVaultItem("member01", personalItem.id, { ...markedTwoFactor, twoFactor: false });
assert.equal(clearedTwoFactor.twoFactor, false, "Removing the independent two-factor flag must not preserve stale state.");
const personalAuditBeforeRead = await database.prepare(
  "SELECT COUNT(*) AS count FROM audit_events WHERE item_id = ?",
).bind(personalItem.id).first<{ count: number }>();

await getVaultItem("member01", personalItem.id);
const personalAuditAfterRead = await database.prepare(
  "SELECT COUNT(*) AS count FROM audit_events WHERE item_id = ?",
).bind(personalItem.id).first<{ count: number }>();
assert.equal(personalAuditAfterRead?.count, personalAuditBeforeRead?.count, "Personal credential delivery must not be audited.");

await assert.rejects(getVaultItem("outsider01", personalItem.id), /没有访问该项目的权限/);
const accessCountAfterUnauthorizedRead = await database.prepare(
  "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'public_secret_accessed' AND item_id = ?",
).bind(publicItem.id).first<{ count: number }>();
assert.equal(accessCountAfterUnauthorizedRead?.count, accessCountBeforeUnauthorizedRead?.count, "An unauthorized read must not write an access audit event.");
