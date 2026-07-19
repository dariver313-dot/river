import { cookies } from "next/headers";
import { getD1 } from "../../db";
import { decryptAuthTotpSecret } from "./auth-totp-crypto";
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
  auth_totp_secret: string | null;
};

const authSessionTtlMs = 8 * 60 * 60_000;

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

function configuredApproverSecret() {
  const value = process.env.APPROVER_TOTP_SECRET?.trim();
  if (!value) throw new Error("APPROVER_TOTP_SECRET is not configured.");
  return value;
}

async function loginSecretFor(email: string) {
  const primary = primaryAdminEmail();
  if (!primary) throw new Error("PRIMARY_ADMIN_EMAIL is not configured.");
  if (email === primary) return configuredPrimarySecret();

  const user = await getD1().prepare(
    "SELECT email, status, auth_totp_secret FROM app_users WHERE email = ? LIMIT 1",
  ).bind(email).first<LoginUserRow>();
  if (!user || user.status !== "active" || !user.auth_totp_secret) return null;
  return decryptAuthTotpSecret(user.email, user.auth_totp_secret);
}

export async function verifySelfHostedLogin(input: { email: string; userCode: string; approverCode: string }) {
  const email = normalizedEmail(input.email);
  if (!isValidEmail(email)) return null;

  let userSecret: string | null;
  try {
    userSecret = await loginSecretFor(email);
  } catch {
    // Keep all login failures indistinguishable to callers.
    return null;
  }
  if (!userSecret) return null;

  try {
    const [userValid, approverValid] = await Promise.all([
      validTotp(userSecret, input.userCode.trim()),
      validTotp(configuredApproverSecret(), input.approverCode.trim()),
    ]);
    return userValid && approverValid ? email : null;
  } catch {
    return null;
  }
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
