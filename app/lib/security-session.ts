import { getDatabase } from "../../db";
import { RecentSecurityConfirmationRequiredError, SecuritySessionRequiredError } from "./security-errors";
import { verifySelfHostedTotp } from "./selfhost-auth";

const sessionTtlMs = 15 * 60_000;
const recentConfirmationTtlMs = 10 * 60_000;
const sessionTouchIntervalMs = 60_000;
const sessionCookieMaxAgeSeconds = 8 * 60 * 60;

type SecuritySessionRow = {
  id: string;
  email: string;
  auth_session_id: string | null;
  expires_at: string;
  recent_verified_at: string;
  last_active_at: string;
  revoked_at: string | null;
};

export type SecuritySessionStatus = {
  expiresAt: string;
  recentVerificationExpiresAt: string;
};

function cookieValue(request: Request, name: string) {
  const source = request.headers.get("cookie") ?? "";
  for (const entry of source.split(";")) {
    const [key, ...parts] = entry.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return null;
}

function toIso(value: number) {
  return new Date(value).toISOString();
}

function cookieSettings(request: Request) {
  const url = new URL(request.url);
  const forwardedProtocol = process.env.DJMIMA_TRUST_PROXY === "1"
    ? request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
    : undefined;
  const secure = url.protocol === "https:" || forwardedProtocol === "https";
  return {
    name: secure ? "__Host-djmima-session" : "djmima-session",
    secure: secure ? "; Secure" : "",
  };
}

function sessionCookie(id: string, request: Request) {
  const settings = cookieSettings(request);
  // Keep the opaque browser handle for the same maximum lifetime as the
  // authenticated session. The database remains authoritative for the
  // shorter 15-minute idle timeout and for explicit revocation.
  return `${settings.name}=${encodeURIComponent(id)}; Path=/; Max-Age=${sessionCookieMaxAgeSeconds}; HttpOnly${settings.secure}; SameSite=Strict`;
}

export function clearSecuritySessionCookie(request: Request) {
  const settings = cookieSettings(request);
  return `${settings.name}=; Path=/; Max-Age=0; HttpOnly${settings.secure}; SameSite=Strict`;
}

function isActive(row: SecuritySessionRow) {
  return !row.revoked_at && Date.parse(row.expires_at) > Date.now();
}

async function findSession(id: string) {
  return getDatabase().prepare(
    "SELECT id, email, auth_session_id, expires_at, recent_verified_at, last_active_at, revoked_at FROM security_sessions WHERE id = ? LIMIT 1",
  ).bind(id).first<SecuritySessionRow>();
}

/**
 * A security session is issued only immediately after credentials have been
 * verified.  It deliberately cannot be minted by merely holding an existing
 * application cookie: that would turn a page load into a fake reauthentication.
 */
export async function createSecuritySession(email: string, authSessionId: string, request: Request) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = toIso(Date.now() + sessionTtlMs);
  await getDatabase().prepare(
    `INSERT INTO security_sessions (id, email, auth_session_id, recent_verified_at, last_active_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, email, authSessionId, now, now, expiresAt).run();

  return {
    status: { expiresAt, recentVerificationExpiresAt: toIso(Date.parse(now) + recentConfirmationTtlMs) },
    setCookie: sessionCookie(id, request),
  };
}

/** Refreshes an existing session only; it never grants a new recent verification. */
export async function resumeSecuritySession(email: string, authSessionId: string, request: Request) {
  const suppliedId = cookieValue(request, cookieSettings(request).name);
  if (!suppliedId) throw new SecuritySessionRequiredError();
  const existing = await findSession(suppliedId);
  if (!existing || existing.email !== email || existing.auth_session_id !== authSessionId || !isActive(existing)) {
    throw new SecuritySessionRequiredError();
  }

  const shouldTouch = Date.now() - Date.parse(existing.last_active_at) >= sessionTouchIntervalMs;
  const expiresAt = shouldTouch ? toIso(Date.now() + sessionTtlMs) : existing.expires_at;
  if (shouldTouch) {
    const updated = await getDatabase().prepare(
      `UPDATE security_sessions SET last_active_at = ?, expires_at = ?
       WHERE id = ? AND email = ? AND auth_session_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    ).bind(new Date().toISOString(), expiresAt, existing.id, email, authSessionId, new Date().toISOString()).run();
    if ((updated.meta.changes ?? 0) !== 1) throw new SecuritySessionRequiredError();
  }

  return {
    status: { expiresAt, recentVerificationExpiresAt: toIso(Date.parse(existing.recent_verified_at) + recentConfirmationTtlMs) },
    setCookie: sessionCookie(existing.id, request),
  };
}

export async function requireActiveSecuritySession(email: string, authSessionId: string, request: Request): Promise<SecuritySessionStatus & { recentVerifiedAt: string }> {
  const id = cookieValue(request, cookieSettings(request).name);
  if (!id) throw new SecuritySessionRequiredError();

  const session = await findSession(id);
  if (!session || session.email !== email || session.auth_session_id !== authSessionId || !isActive(session)) throw new SecuritySessionRequiredError();

  const shouldTouch = Date.now() - Date.parse(session.last_active_at) >= sessionTouchIntervalMs;
  const expiresAt = shouldTouch ? toIso(Date.now() + sessionTtlMs) : session.expires_at;
  if (shouldTouch) {
    const updated = await getDatabase().prepare(
      `UPDATE security_sessions
       SET last_active_at = ?, expires_at = ?
       WHERE id = ? AND email = ? AND auth_session_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    ).bind(new Date().toISOString(), expiresAt, id, email, authSessionId, new Date().toISOString()).run();
    if ((updated.meta.changes ?? 0) !== 1) throw new SecuritySessionRequiredError();
  }

  return {
    expiresAt,
    recentVerifiedAt: session.recent_verified_at,
    recentVerificationExpiresAt: toIso(Date.parse(session.recent_verified_at) + recentConfirmationTtlMs),
  };
}

export async function requireRecentSecurityConfirmation(email: string, authSessionId: string, request: Request) {
  const session = await requireActiveSecuritySession(email, authSessionId, request);
  if (Date.parse(session.recentVerifiedAt) + recentConfirmationTtlMs <= Date.now()) {
    throw new RecentSecurityConfirmationRequiredError();
  }
  return session;
}

/** Refreshes the ten-minute sensitive-operation window after a fresh TOTP proof. */
export async function renewRecentSecurityConfirmation(email: string, authSessionId: string, request: Request) {
  const session = await requireActiveSecuritySession(email, authSessionId, request);
  const id = cookieValue(request, cookieSettings(request).name);
  if (!id) throw new SecuritySessionRequiredError();
  const now = new Date().toISOString();
  const updated = await getDatabase().prepare(
    `UPDATE security_sessions
     SET recent_verified_at = ?, last_active_at = ?
     WHERE id = ? AND email = ? AND auth_session_id = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(now, now, id, email, authSessionId, now).run();
  if ((updated.meta.changes ?? 0) !== 1) throw new SecuritySessionRequiredError();
  return {
    expiresAt: session.expiresAt,
    recentVerificationExpiresAt: toIso(Date.parse(now) + recentConfirmationTtlMs),
  };
}

/**
 * A sensitive-operation form already asks the user for a current TOTP code.
 * Treat that successful proof as the recent confirmation for this operation,
 * instead of requiring the browser to complete the same proof twice.
 */
export async function verifyTotpAndRenewSecurityConfirmation(email: string, authSessionId: string, request: Request, userCode: unknown) {
  if (typeof userCode !== "string" || !await verifySelfHostedTotp(email, userCode)) return false;
  await renewRecentSecurityConfirmation(email, authSessionId, request);
  return true;
}

export async function endSecuritySession(email: string, request: Request) {
  const id = cookieValue(request, cookieSettings(request).name);
  if (id) {
    await getDatabase().prepare(
      "UPDATE security_sessions SET revoked_at = ? WHERE id = ? AND email = ? AND revoked_at IS NULL",
    ).bind(new Date().toISOString(), id, email).run();
  }
  return clearSecuritySessionCookie(request);
}
