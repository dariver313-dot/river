import { getD1 } from "../../db";
import { RecentSecurityConfirmationRequiredError, SecuritySessionRequiredError } from "./security-errors";

const sessionTtlMs = 15 * 60_000;
const recentConfirmationTtlMs = 10 * 60_000;

type SecuritySessionRow = {
  id: string;
  email: string;
  expires_at: string;
  recent_verified_at: string;
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
  const secure = url.protocol === "https:";
  return {
    name: secure ? "__Host-djmima-session" : "djmima-session",
    secure: secure ? "; Secure" : "",
  };
}

function sessionCookie(id: string, expiresAt: string, request: Request) {
  const maxAge = Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1_000));
  const settings = cookieSettings(request);
  return `${settings.name}=${encodeURIComponent(id)}; Path=/; Max-Age=${maxAge}; HttpOnly${settings.secure}; SameSite=Strict`;
}

export function clearSecuritySessionCookie(request: Request) {
  const settings = cookieSettings(request);
  return `${settings.name}=; Path=/; Max-Age=0; HttpOnly${settings.secure}; SameSite=Strict`;
}

function isActive(row: SecuritySessionRow) {
  return !row.revoked_at && Date.parse(row.expires_at) > Date.now();
}

async function findSession(id: string) {
  return getD1().prepare(
    "SELECT id, email, expires_at, recent_verified_at, revoked_at FROM security_sessions WHERE id = ? LIMIT 1",
  ).bind(id).first<SecuritySessionRow>();
}

export async function beginSecuritySession(email: string, request: Request) {
  const suppliedId = cookieValue(request, cookieSettings(request).name);
  if (suppliedId) {
    const existing = await findSession(suppliedId);
    if (existing && existing.email === email && isActive(existing)) {
      const expiresAt = toIso(Date.now() + sessionTtlMs);
      await getD1().prepare(
        "UPDATE security_sessions SET last_active_at = ?, expires_at = ? WHERE id = ?",
      ).bind(new Date().toISOString(), expiresAt, existing.id).run();
      return {
        status: {
          expiresAt,
          recentVerificationExpiresAt: toIso(Date.parse(existing.recent_verified_at) + recentConfirmationTtlMs),
        },
        setCookie: sessionCookie(existing.id, expiresAt, request),
      };
    }

    // 一个已过期或被撤销的浏览器会话不得在原页面上直接续期，必须返回登录流程。
    throw new SecuritySessionRequiredError();
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = toIso(Date.now() + sessionTtlMs);
  await getD1().prepare(
    `INSERT INTO security_sessions (id, email, recent_verified_at, last_active_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, email, now, now, expiresAt).run();

  return {
    status: { expiresAt, recentVerificationExpiresAt: toIso(Date.parse(now) + recentConfirmationTtlMs) },
    setCookie: sessionCookie(id, expiresAt, request),
  };
}

export async function requireActiveSecuritySession(email: string, request: Request): Promise<SecuritySessionStatus & { recentVerifiedAt: string }> {
  const id = cookieValue(request, cookieSettings(request).name);
  if (!id) throw new SecuritySessionRequiredError();

  const session = await findSession(id);
  if (!session || session.email !== email || !isActive(session)) throw new SecuritySessionRequiredError();

  const expiresAt = toIso(Date.now() + sessionTtlMs);
  const updated = await getD1().prepare(
    `UPDATE security_sessions
     SET last_active_at = ?, expires_at = ?
     WHERE id = ? AND email = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(new Date().toISOString(), expiresAt, id, email, new Date().toISOString()).run();
  if ((updated.meta.changes ?? 0) !== 1) throw new SecuritySessionRequiredError();

  return {
    expiresAt,
    recentVerifiedAt: session.recent_verified_at,
    recentVerificationExpiresAt: toIso(Date.parse(session.recent_verified_at) + recentConfirmationTtlMs),
  };
}

export async function requireRecentSecurityConfirmation(email: string, request: Request) {
  const session = await requireActiveSecuritySession(email, request);
  if (Date.parse(session.recentVerifiedAt) + recentConfirmationTtlMs <= Date.now()) {
    throw new RecentSecurityConfirmationRequiredError();
  }
  return session;
}

export async function endSecuritySession(email: string, request: Request) {
  const id = cookieValue(request, cookieSettings(request).name);
  if (id) {
    await getD1().prepare(
      "UPDATE security_sessions SET revoked_at = ? WHERE id = ? AND email = ? AND revoked_at IS NULL",
    ).bind(new Date().toISOString(), id, email).run();
  }
  return clearSecuritySessionCookie(request);
}
