import assert from "node:assert/strict";

import { getDatabase } from "../../db";
import {
  confirmCurrentSecurityEmailChange,
  confirmSecurityEmailChange,
  requestSecurityEmailChange,
} from "../../app/lib/account-lifecycle";

const database = getDatabase();
const account = "member01";
const currentEmail = "current@example.test";
const targetEmail = "replacement@example.test";

await database.prepare(
  "INSERT INTO app_users (email, role, status, password_hash, security_email, security_email_verified_at) VALUES (?, 'user', 'active', 'not-used-in-this-test', ?, CURRENT_TIMESTAMP)",
).bind(account, currentEmail).run();

const currentDeliveries: Array<{ to: string; targetEmail: string; code: string }> = [];
const targetDeliveries: Array<{ to: string; code: string }> = [];
const delivery = {
  sendCurrent: async (input: { to: string; targetEmail: string; code: string }) => {
    currentDeliveries.push(input);
  },
  sendTarget: async (input: { to: string; code: string }) => {
    targetDeliveries.push(input);
  },
};

const requested = await requestSecurityEmailChange({ account, securityEmail: targetEmail }, delivery);
assert.equal(requested?.step, "confirm_current");
const currentDelivery = currentDeliveries[0];
assert(currentDelivery);
assert.equal(currentDelivery.to, currentEmail, "更换已验证邮箱时应先向原邮箱发码");
assert.equal(currentDelivery.targetEmail, targetEmail);
assert.equal(targetDeliveries.length, 0, "原邮箱确认前不得向新邮箱发码");

const directConfirmation = await confirmSecurityEmailChange({
  account,
  securityEmail: targetEmail,
  code: currentDelivery!.code,
});
assert.equal(directConfirmation, null, "原邮箱确认码不得直接完成邮箱变更");

const advanced = await confirmCurrentSecurityEmailChange({
  account,
  securityEmail: targetEmail,
  code: currentDelivery!.code,
}, delivery);
assert.equal(advanced?.step, "confirm_new");
const targetDelivery = targetDeliveries[0];
assert(targetDelivery);
assert.equal(targetDelivery.to, targetEmail, "原邮箱通过后才应向新邮箱发码");

const completed = await confirmSecurityEmailChange({
  account,
  securityEmail: targetEmail,
  code: targetDelivery!.code,
});
assert.equal(completed?.securityEmail, targetEmail);
assert.equal(completed?.requiresRelogin, true);
const stored = await database.prepare(
  "SELECT security_email, security_email_verified_at FROM app_users WHERE email = ?",
).bind(account).first<{ security_email: string; security_email_verified_at: string | null }>();
assert.equal(stored?.security_email, targetEmail);
assert.ok(stored?.security_email_verified_at);

const firstTimeAccount = "member02";
await database.prepare(
  "INSERT INTO app_users (email, role, status, password_hash) VALUES (?, 'user', 'active', 'not-used-in-this-test')",
).bind(firstTimeAccount).run();
targetDeliveries.length = 0;
const firstTime = await requestSecurityEmailChange({ account: firstTimeAccount, securityEmail: "first@example.test" }, delivery);
assert.equal(firstTime?.step, "confirm_new");
assert.equal(targetDeliveries[0]?.to, "first@example.test", "首次设置只需验证目标邮箱");
