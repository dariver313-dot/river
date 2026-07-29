import assert from "node:assert/strict";
import { getDatabase } from "../../db";
import { beginAuthenticatorReset, confirmAuthenticatorReset } from "../../app/lib/account-lifecycle";
import { issueAccountToken } from "../../app/lib/one-time-tokens";
import { verifySelfHostedTotp } from "../../app/lib/selfhost-auth";
import { generateTotpCode, parseTotpInput } from "../../app/lib/totp";

const database = getDatabase();
await database.prepare(
  "INSERT INTO app_users (email, role, status, password_hash, security_email, security_email_verified_at) VALUES (?, 'user', 'active', 'not-used-in-this-test', ?, CURRENT_TIMESTAMP)",
).bind("member01", "member@example.test").run();

const recovery = await issueAccountToken({
  email: "member01",
  purpose: "authenticator_reset",
  createdBy: "admin01",
  lifetimeMs: 60_000,
});
const started = await beginAuthenticatorReset({ code: recovery.code });
assert(started, "The administrator-issued recovery code should start an enrollment stage.");

const storedBeforeConfirmation = await database.prepare(
  "SELECT auth_totp_secret FROM app_users WHERE email = ?",
).bind("member01").first<{ auth_totp_secret: string | null }>();
assert.equal(storedBeforeConfirmation?.auth_totp_secret, null, "A staged replacement secret must not be written to app_users before confirmation.");

const replacementCode = await generateTotpCode(parseTotpInput(started.setupKey), Date.now());
assert.equal(await verifySelfHostedTotp("member01", replacementCode), false, "A staged authenticator must not work for normal login.");

const completed = await confirmAuthenticatorReset({ code: started.confirmationCode, userCode: replacementCode });
assert.equal(completed?.confirmed, true, "The first TOTP proof should complete the staged reset.");
assert.equal(await verifySelfHostedTotp("member01", replacementCode), true, "The replacement authenticator should work only after confirmation.");
