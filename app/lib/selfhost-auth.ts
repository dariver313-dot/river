import { cookies } from "next/headers";
import { getD1 } from "../../db";
import { decryptAuthTotpSecret } from "./auth-totp-crypto";
import { hashLoginPassword, verifyLoginPassword } from "./auth-password";
import { generateTotpCode, parseTotpInput } from "./totp";

export type SelfHostedUser = {
  displayName: string;
  email: string;
  fullName: null;
};

type AuthSessionRow = {
  id: string;
  email: string;
  expires_at: string;
  revoked_at: string | null;
};

type LoginUserRow = {
  email: string;
  status: "active" | "suspended";
  password_hash: string | null;
  auth_totp_secret: string | null;
  must_change_password: number;
};

const authSessionTtlMs = 8 * 60 * 60_000;
const bootstrapSetupKey = "selfhost_setup_completed";

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function primaryAdminEmail() {
  const value = normalizedEmail(process.env.PRIMARY_ADMIN_EMAIL ?? "");
  return isValidEmail(value) ? value : null;
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

function displayName(email: string) {
  return email.slice(0, email.indexOf("@")) || email;
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
  return getD1().prepare(
    "SELECT id, email, expires_at, revoked_at FROM auth_sessions WHERE id = ? LIMIT 1",
  ).bind(id).first<AuthSessionRow>();
}

async function resolveSession(id: string): Promise<SelfHostedUser | null> {
  const session = await sessionById(id);
  if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) return null;
  return { email: session.email, displayName: displayName(session.email), fullName: null };
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

async function bootstrapSetupCompleted() {
  const row = await getD1().prepare(
    "SELECT value FROM app_settings WHERE key = ? LIMIT 1",
  ).bind(bootstrapSetupKey).first<{ value: string }>();
  return row?.value === "completed";
}

export async function initialAuthenticatorSetup(token: string | null | undefined) {
  const configuredToken = configuredSetupToken();
  const email = primaryAdminEmail();
  if (!configuredToken || !email || !token || !equalSecret(token, configuredToken)) return null;
  if (await bootstrapSetupCompleted()) return null;
  try {
    return {
      email,
      primarySecret: configuredPrimarySecret(),
    };
  } catch {
    return null;
  }
}

export async function completeInitialAuthenticatorSetup(token: string | null | undefined, password: string) {
  const setup = await initialAuthenticatorSetup(token);
  if (!setup) return false;
  const passwordHash = await hashLoginPassword(password);
  const d1 = getD1();
  const results = await d1.batch([
    d1.prepare(
      `INSERT INTO app_users (email, role, status, password_hash, must_change_password, created_by)
       SELECT ?, 'admin', 'active', ?, 0, ?
       WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = ?)
       ON CONFLICT(email) DO UPDATE SET role = 'admin', status = 'active', password_hash = excluded.password_hash, must_change_password = 0, updated_at = CURRENT_TIMESTAMP`,
    ).bind(setup.email, passwordHash, setup.email, bootstrapSetupKey),
    d1.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, 'completed')").bind(bootstrapSetupKey),
  ]);
  return (results[1]?.meta.changes ?? 0) === 1;
}

async function loginCredentialsFor(email: string) {
  const primary = primaryAdminEmail();
  if (!primary) throw new Error("PRIMARY_ADMIN_EMAIL is not configured.");
  const user = await getD1().prepare(
    "SELECT email, status, password_hash, auth_totp_secret, must_change_password FROM app_users WHERE email = ? LIMIT 1",
  ).bind(email).first<LoginUserRow>();
  if (!user || user.status !== "active" || !user.password_hash) return null;
  const totpSecret = email === primary ? configuredPrimarySecret() : user.auth_totp_secret ? await decryptAuthTotpSecret(user.email, user.auth_totp_secret) : null;
  return totpSecret ? { passwordHash: user.password_hash, totpSecret, mustChangePassword: user.must_change_password === 1 } : null;
}

export async function verifySelfHostedLogin(input: { email: string; password: string; userCode: string }) {
  const email = normalizedEmail(input.email);
  if (!isValidEmail(email)) return null;

  let credentials: { passwordHash: string; totpSecret: string; mustChangePassword: boolean } | null;
  try {
    credentials = await loginCredentialsFor(email);
  } catch {
    // Keep all login failures indistinguishable to callers.
    return null;
  }
  if (!credentials) return null;

  try {
    const [passwordValid, userValid] = await Promise.all([
      verifyLoginPassword(input.password, credentials.passwordHash),
      validTotp(credentials.totpSecret, input.userCode.trim()),
    ]);
    return passwordValid && userValid ? { email, mustChangePassword: credentials.mustChangePassword } : null;
  } catch {
    return null;
  }
}

/** Re-authenticate before changing a password, including the user's own TOTP code. */
export async function changeSelfHostedPassword(input: { email: string; currentPassword: string; userCode: string; newPassword: string }) {
  const email = normalizedEmail(input.email);
  if (!isValidEmail(email)) return false;
  const authenticated = await verifySelfHostedLogin({ email, password: input.currentPassword, userCode: input.userCode });
  if (!authenticated || authenticated.email !== email) return false;

  const passwordHash = await hashLoginPassword(input.newPassword);
  const d1 = getD1();
  await d1.batch([
    d1.prepare(
      "UPDATE app_users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE email = ? AND status = 'active'",
    ).bind(passwordHash, email),
    d1.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL").bind(new Date().toISOString(), email),
    d1.prepare("UPDATE security_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL").bind(new Date().toISOString(), email),
  ]);
  return true;
}

export async function createAuthSession(email: string, request: Request) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + authSessionTtlMs).toISOString();
  const id = crypto.randomUUID();
  const d1 = getD1();
  await d1.prepare("DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(now).run();
  await d1.prepare(
    "INSERT INTO auth_sessions (id, email, expires_at, last_active_at) VALUES (?, ?, ?, ?)",
  ).bind(id, email, expiresAt, now).run();

  const secure = requestIsSecure(request);
  return `${authCookieName(secure)}=${encodeURIComponent(id)}; Path=/; Max-Age=${Math.floor(authSessionTtlMs / 1_000)}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export async function endAuthSession(request: Request) {
  const secure = requestIsSecure(request);
  const name = authCookieName(secure);
  const sessionId = cookieValue(request.headers.get("cookie") ?? "", name);
  if (sessionId) {
    await getD1().prepare(
      "UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).bind(new Date().toISOString(), sessionId).run();
  }
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export async function getSelfHostedUser(): Promise<SelfHostedUser | null> {
  const store = await cookies();
  const id = store.get("__Host-djmima-auth")?.value ?? store.get("djmima-auth")?.value;
  if (!id) return null;
  return resolveSession(id);
}
