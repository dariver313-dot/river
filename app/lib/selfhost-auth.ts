import { cookies } from "next/headers";
import { getDatabase } from "../../db";
import { decryptAuthTotpSecret, encryptAuthTotpSecret } from "./auth-totp-crypto";
import { hashLoginPassword, verifyLoginPassword } from "./auth-password";
import { accountDisplayName, isValidLoginAccount, normalizeLoginAccount } from "./identity";
import { initialAdminAccount } from "./initial-admin";
import { generateTotpCode, parseTotpInput } from "./totp";
import { writeAuditedMutation } from "./audit-log";
import { sharedAuditVaultId } from "./embedded-audit";
import { issueAdministratorRecoveryCodes } from "./one-time-tokens";
import { ClientSafeError } from "./security-errors";

export type SelfHostedUser = {
  displayName: string;
  email: string;
  fullName: null;
};

export type SelfHostedAuthenticatedSession = SelfHostedUser & {
  sessionId: string;
};

type AuthSessionRow = {
  id: string;
  email: string;
  expires_at: string;
  last_active_at: string;
  revoked_at: string | null;
};

type LoginUserRow = {
  email: string;
  status: "pending" | "active" | "suspended" | "frozen";
  password_hash: string | null;
  auth_totp_secret: string | null;
  security_email: string | null;
  security_email_verified_at: string | null;
  must_change_password: number;
};

const authSessionTtlMs = 8 * 60 * 60_000;
const authSessionIdleTtlMs = 15 * 60_000;
const sessionTouchIntervalMs = 60_000;
const bootstrapSetupKey = "selfhost_setup_completed";
let lastSecurityDataCleanupAt = 0;

async function cleanupExpiredSecurityData(now = new Date()) {
  if (now.getTime() - lastSecurityDataCleanupAt < 15 * 60_000) return;
  lastSecurityDataCleanupAt = now.getTime();
  const current = now.toISOString();
  const stale = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const loginEventCutoff = new Date(now.getTime() - 180 * 24 * 60 * 60_000).toISOString();
  try {
    await getDatabase().batch([
      getDatabase().prepare("DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(current),
      getDatabase().prepare("DELETE FROM security_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(current),
      getDatabase().prepare("DELETE FROM account_tokens WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?) OR (revoked_at IS NOT NULL AND revoked_at <= ?)").bind(current, stale, stale),
      getDatabase().prepare("DELETE FROM login_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)").bind(current, stale),
      getDatabase().prepare("DELETE FROM admin_recovery_stages WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)").bind(current, stale),
      getDatabase().prepare("DELETE FROM authenticator_reset_stages WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)").bind(current, stale),
      getDatabase().prepare("DELETE FROM login_events WHERE created_at < ?").bind(loginEventCutoff),
    ]);
  } catch {
    // Cleanup is maintenance only; authentication must not be weakened or fail
    // open if a transient SQLite write cannot be performed.
    lastSecurityDataCleanupAt = 0;
  }
}

function primaryAdminEmail() {
  return initialAdminAccount();
}

function authCookieName(secure: boolean) {
  return secure ? "__Host-djmima-auth" : "djmima-auth";
}

function requestIsSecure(request: Request) {
  const protocol = new URL(request.url).protocol;
  const forwarded = process.env.DJMIMA_TRUST_PROXY === "1"
    ? request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
    : undefined;
  return protocol === "https:" || forwarded === "https";
}

function cookieValue(source: string, name: string) {
  for (const entry of source.split(";")) {
    const [key, ...parts] = entry.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return null;
}

function equalCode(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function equalSecret(left: string, right: string) {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function validTotp(secret: string, suppliedCode: string) {
  if (!/^\d{6}$/.test(suppliedCode)) return false;
  const config = parseTotpInput(secret);
  if (config.digits !== 6) return false;
  const now = Date.now();
  const timestamps = [now - config.period * 1_000, now, now + config.period * 1_000];
  const candidates = await Promise.all(timestamps.map((timestamp) => generateTotpCode(config, timestamp)));
  return candidates.some((candidate) => equalCode(candidate, suppliedCode));
}

async function sessionById(id: string) {
  return getDatabase().prepare(
    "SELECT id, email, expires_at, last_active_at, revoked_at FROM auth_sessions WHERE id = ? LIMIT 1",
  ).bind(id).first<AuthSessionRow>();
}

async function resolveSession(id: string): Promise<SelfHostedAuthenticatedSession | null> {
  const session = await sessionById(id);
  const now = Date.now();
  if (!session || session.revoked_at || Date.parse(session.expires_at) <= now || Date.parse(session.last_active_at) + authSessionIdleTtlMs <= now) {
    if (session && !session.revoked_at) {
      await getDatabase().prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(new Date(now).toISOString(), session.id).run();
    }
    return null;
  }
  if (now - Date.parse(session.last_active_at) >= sessionTouchIntervalMs) {
    await getDatabase().prepare("UPDATE auth_sessions SET last_active_at = ? WHERE id = ?").bind(new Date(now).toISOString(), session.id).run();
  }
  return { sessionId: session.id, email: session.email, displayName: accountDisplayName(session.email), fullName: null };
}

function configuredPrimarySecret() {
  const value = process.env.PRIMARY_ADMIN_TOTP_SECRET?.trim();
  if (!value) throw new Error("PRIMARY_ADMIN_TOTP_SECRET is not configured.");
  return value;
}

function configuredSetupToken() {
  const value = process.env.SELFHOST_SETUP_TOKEN?.trim();
  return value && /^[a-zA-Z0-9_-]{32,256}$/.test(value) ? value : null;
}

function setupTokenIsCurrent() {
  const configured = process.env.SELFHOST_SETUP_EXPIRES_AT?.trim();
  if (!configured) return process.env.NODE_ENV !== "production";
  const expiresAt = Date.parse(configured);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

async function bootstrapSetupCompleted() {
  const row = await getDatabase().prepare(
    "SELECT value FROM app_settings WHERE key = ? LIMIT 1",
  ).bind(bootstrapSetupKey).first<{ value: string }>();
  return row?.value === "completed";
}

export async function initialAuthenticatorSetup(token: string | null | undefined) {
  const configuredToken = configuredSetupToken();
  const email = primaryAdminEmail();
  if (!configuredToken || !setupTokenIsCurrent() || !email || !token || !equalSecret(token, configuredToken)) return null;
  if (await bootstrapSetupCompleted()) return null;
  try {
    const primarySecret = configuredPrimarySecret();
    if (parseTotpInput(primarySecret).digits !== 6) return null;
    return { email, primarySecret };
  } catch {
    return null;
  }
}

export async function completeInitialAuthenticatorSetup(
  token: string | null | undefined,
  password: string,
  securityEmail: string,
) {
  const setup = await initialAuthenticatorSetup(token);
  if (!setup) return null;
  const normalizedSecurityEmail = validSecurityEmail(securityEmail);
  if (!normalizedSecurityEmail) throw new ClientSafeError("请填写初始管理员的安全邮箱。");
  const passwordHash = await hashLoginPassword(password);
  const encryptedTotpSecret = await encryptAuthTotpSecret(setup.email, setup.primarySecret);
  const database = getDatabase();

  // Bootstrap stores the administrator and its safety mailbox. The mailbox is
  // deliberately marked unverified until the first password + TOTP login
  // completes its one-time email confirmation; no application access exists
  // before that confirmation.
  await writeAuditedMutation(await sharedAuditVaultId(setup.email), setup.email, "initial_admin_initialized", setup.email, {
    auditOrder: "before",
    auditPrerequisite: {
      sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?)",
      values: [bootstrapSetupKey],
    },
    commitPrerequisite: {
      sql: `SELECT 1
            WHERE EXISTS (SELECT 1 FROM app_settings WHERE key = ? AND value = 'completed')
              AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND role = 'admin' AND status = 'active' AND password_hash = ? AND auth_totp_secret = ? AND security_email = ?)`,
      values: [bootstrapSetupKey, setup.email, passwordHash, encryptedTotpSecret, normalizedSecurityEmail],
    },
    expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      database.prepare(
        `INSERT INTO app_users (email, role, status, password_hash, auth_totp_secret, security_email, must_change_password, created_by)
         SELECT ?, 'admin', 'active', ?, ?, ?, 0, ?
         WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?)
           AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         ON CONFLICT(email) DO UPDATE SET
           role = 'admin', status = 'active', password_hash = excluded.password_hash, auth_totp_secret = excluded.auth_totp_secret,
           security_email = excluded.security_email, security_email_verified_at = NULL, must_change_password = 0, updated_at = CURRENT_TIMESTAMP`,
      ).bind(setup.email, passwordHash, encryptedTotpSecret, normalizedSecurityEmail, setup.email, bootstrapSetupKey, ...guard.values, guard.auditEventId),
      database.prepare(
        `INSERT INTO app_settings (key, value)
         SELECT ?, 'completed'
         WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?)
           AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND password_hash = ? AND auth_totp_secret = ? AND security_email = ?)
           AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(bootstrapSetupKey, bootstrapSetupKey, setup.email, passwordHash, encryptedTotpSecret, normalizedSecurityEmail, ...guard.values, guard.auditEventId),
    ],
  });
  const recoveryCodes = await issueAdministratorRecoveryCodes({ email: setup.email, createdBy: setup.email });
  return { completed: true, recoveryCodes };
}

async function loginCredentialsFor(email: string) {
  const primary = primaryAdminEmail();
  if (!primary) throw new Error("PRIMARY_ADMIN_ACCOUNT is not configured.");
  const user = await getDatabase().prepare(
    "SELECT email, status, password_hash, auth_totp_secret, security_email, security_email_verified_at, must_change_password FROM app_users WHERE email = ? LIMIT 1",
  ).bind(email).first<LoginUserRow>();
  if (!user || user.status !== "active" || !user.password_hash) return null;
  const recoveryConfirmation = await getDatabase().prepare(
    `SELECT 1 AS pending FROM account_tokens
     WHERE email = ? AND purpose = 'authenticator_reset_confirm'
       AND used_at IS NULL AND revoked_at IS NULL
       LIMIT 1`,
  ).bind(email).first<{ pending: number }>();
  // A replacement TOTP key cannot be used for a normal login until the
  // recovery flow has proved it. This prevents a partially completed reset
  // from bypassing its final one-time confirmation and audit entry.
  if (recoveryConfirmation?.pending) return null;
  const totpSecret = user.auth_totp_secret
    ? await decryptAuthTotpSecret(user.email, user.auth_totp_secret)
    : email === primary ? configuredPrimarySecret() : null;
  return totpSecret ? {
    passwordHash: user.password_hash,
    totpSecret,
    mustChangePassword: user.must_change_password === 1,
    securityEmailVerified: Boolean(validSecurityEmail(user.security_email) && user.security_email_verified_at),
  } : null;
}

function validSecurityEmail(value: string | null | undefined) {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Never return this address to an unauthenticated browser. */
export async function securityEmailForAccount(account: string) {
  const email = normalizeLoginAccount(account);
  if (!isValidLoginAccount(email)) return null;
  const user = await getDatabase().prepare(
    "SELECT security_email FROM app_users WHERE email = ? AND status = 'active' AND security_email_verified_at IS NOT NULL LIMIT 1",
  ).bind(email).first<{ security_email: string | null }>();
  return validSecurityEmail(user?.security_email);
}

export async function eligibleLoginChallengeAccount(account: string) {
  const email = normalizeLoginAccount(account);
  if (!isValidLoginAccount(email)) return null;
  try {
    const credentials = await loginCredentialsFor(email);
    if (!credentials) return null;
    return credentials.securityEmailVerified ? { email, mustChangePassword: credentials.mustChangePassword } : null;
  } catch {
    return null;
  }
}

export async function verifySelfHostedTotp(account: string, userCode: string) {
  const email = normalizeLoginAccount(account);
  if (!isValidLoginAccount(email)) return false;
  try {
    const credentials = await loginCredentialsFor(email);
    return Boolean(credentials && await validTotp(credentials.totpSecret, userCode.trim()));
  } catch {
    return false;
  }
}

export async function verifySelfHostedLogin(input: { email: string; password: string; userCode: string }) {
  const email = normalizeLoginAccount(input.email);
  if (!isValidLoginAccount(email)) return null;
  let credentials: { passwordHash: string; totpSecret: string; mustChangePassword: boolean; securityEmailVerified: boolean } | null;
  try {
    credentials = await loginCredentialsFor(email);
  } catch {
    return null;
  }
  if (!credentials) return null;
  try {
    const [passwordValid, userValid] = await Promise.all([
      verifyLoginPassword(input.password, credentials.passwordHash),
      validTotp(credentials.totpSecret, input.userCode.trim()),
    ]);
    if (!passwordValid || !userValid) return null;
    return {
      email,
      mustChangePassword: credentials.mustChangePassword,
      securityEmailVerified: credentials.securityEmailVerified,
    };
  } catch {
    return null;
  }
}

export async function changeSelfHostedPassword(input: { email: string; currentPassword: string; userCode: string; newPassword: string }) {
  const email = normalizeLoginAccount(input.email);
  if (!isValidLoginAccount(email)) return false;
  const authenticated = await verifySelfHostedLogin({ email, password: input.currentPassword, userCode: input.userCode });
  if (!authenticated || authenticated.email !== email) return false;
  const passwordHash = await hashLoginPassword(input.newPassword);
  const database = getDatabase();
  const now = new Date().toISOString();
  await writeAuditedMutation(await sharedAuditVaultId(email), email, "account_password_changed", email, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active'", values: [email] },
    commitPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND password_hash = ? AND must_change_password = 0", values: [email, passwordHash] },
    expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      database.prepare(
        `UPDATE app_users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP
         WHERE email = ? AND status = 'active' AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(passwordHash, email, ...guard.values, guard.auditEventId),
      database.prepare(
        `UPDATE auth_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND password_hash = ?)`,
      ).bind(now, email, ...guard.values, guard.auditEventId, email, passwordHash),
      database.prepare(
        `UPDATE security_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND password_hash = ?)`,
      ).bind(now, email, ...guard.values, guard.auditEventId, email, passwordHash),
      database.prepare(
        `UPDATE login_challenges SET used_at = ? WHERE email = ? AND used_at IS NULL
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, email, ...guard.values, guard.auditEventId),
    ],
  });
  return true;
}

export async function createAuthSession(email: string, request: Request) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + authSessionTtlMs).toISOString();
  const id = crypto.randomUUID();
  const database = getDatabase();
  await cleanupExpiredSecurityData(new Date(now));
  await database.batch([
    database.prepare("INSERT INTO auth_sessions (id, email, expires_at, last_active_at) VALUES (?, ?, ?, ?)").bind(id, email, expiresAt, now),
    database.prepare("UPDATE app_users SET last_login_at = ? WHERE email = ? AND status = 'active'").bind(now, email),
  ]);
  const secure = requestIsSecure(request);
  return {
    id,
    email: normalizeLoginAccount(email),
    expiresAt,
    setCookie: `${authCookieName(secure)}=${encodeURIComponent(id)}; Path=/; Max-Age=${Math.floor(authSessionTtlMs / 1_000)}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
  };
}

export async function endAuthSession(request: Request) {
  const secure = requestIsSecure(request);
  const name = authCookieName(secure);
  const sessionId = cookieValue(request.headers.get("cookie") ?? "", name);
  if (sessionId) {
    const session = await sessionById(sessionId);
    const now = new Date().toISOString();
    await getDatabase().batch([
      getDatabase().prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, sessionId),
      getDatabase().prepare("UPDATE security_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL").bind(now, session?.email ?? ""),
    ]);
  }
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export async function getSelfHostedSession(): Promise<SelfHostedAuthenticatedSession | null> {
  const store = await cookies();
  const id = store.get("__Host-djmima-auth")?.value ?? store.get("djmima-auth")?.value;
  if (!id) return null;
  return resolveSession(id);
}

export async function getSelfHostedUser(): Promise<SelfHostedUser | null> {
  const session = await getSelfHostedSession();
  if (!session) return null;
  return { email: session.email, displayName: session.displayName, fullName: null };
}
