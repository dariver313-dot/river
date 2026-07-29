import assert from "node:assert/strict";

import { getDatabase } from "../../db";
import {
  createSecuritySession,
  requireActiveSecuritySession,
} from "../../app/lib/security-session";
import { SecuritySessionRequiredError } from "../../app/lib/security-errors";

const email = "session-test@example.test";
const authSessionId = "auth-session-test";
const baseRequest = new Request("https://vault.example.test/api/security/session");

function sessionRequest(setCookie: string) {
  const cookie = setCookie.split(";", 1)[0];
  return new Request(baseRequest, { headers: { cookie } });
}

const created = await createSecuritySession(email, authSessionId, baseRequest);
assert.match(created.setCookie, /Max-Age=28800(?:;|$)/u, "Browser handle must survive for the eight-hour auth-session ceiling.");

const request = sessionRequest(created.setCookie);
const sessionId = decodeURIComponent(created.setCookie.split(";", 1)[0].split("=", 2)[1]);
const oldActivity = new Date(Date.now() - 2 * 60_000).toISOString();
const stillActive = new Date(Date.now() + 30_000).toISOString();
await getDatabase().prepare(
  "UPDATE security_sessions SET last_active_at = ?, expires_at = ? WHERE id = ?",
).bind(oldActivity, stillActive, sessionId).run();

const refreshed = await requireActiveSecuritySession(email, authSessionId, request);
assert.ok(
  Date.parse(refreshed.expiresAt) >= Date.now() + 14 * 60_000,
  "Recent activity must extend the authoritative idle deadline.",
);

await getDatabase().prepare(
  "UPDATE security_sessions SET expires_at = ?, last_active_at = ? WHERE id = ?",
).bind(
  new Date(Date.now() - 1_000).toISOString(),
  new Date(Date.now() - 16 * 60_000).toISOString(),
  sessionId,
).run();
await assert.rejects(
  requireActiveSecuritySession(email, authSessionId, request),
  SecuritySessionRequiredError,
  "An idle-expired database session must not be revived by a surviving cookie.",
);

const revoked = await createSecuritySession(email, authSessionId, baseRequest);
const revokedRequest = sessionRequest(revoked.setCookie);
const revokedId = decodeURIComponent(revoked.setCookie.split(";", 1)[0].split("=", 2)[1]);
await getDatabase().prepare(
  "UPDATE security_sessions SET revoked_at = ? WHERE id = ?",
).bind(new Date().toISOString(), revokedId).run();
await assert.rejects(
  requireActiveSecuritySession(email, authSessionId, revokedRequest),
  SecuritySessionRequiredError,
  "Revocation must remain authoritative even while the browser cookie exists.",
);
