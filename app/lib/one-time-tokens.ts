import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDatabase } from "../../db";
import { normalizeLoginAccount } from "./identity";

export type AccountTokenPurpose = "activation" | "activation_confirm" | "password_recovery" | "admin_recovery" | "admin_recovery_confirm" | "security_email_change" | "authenticator_reset" | "authenticator_reset_confirm";

type AccountTokenRow = {
  id: string;
  email: string;
  target_email: string | null;
  purpose: AccountTokenPurpose;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
};

export type PendingAccountToken = {
  id: string;
  email: string;
  targetEmail: string | null;
  expiresAt: string;
  purpose: AccountTokenPurpose;
  /** Internal HMAC value used only to make the audited consumption conditional. */
  tokenHash: string;
};

type AuditGuard = { conditionSql: string; values: readonly unknown[]; auditEventId: string };

const allowedPurposes = new Set<AccountTokenPurpose>(["activation", "activation_confirm", "password_recovery", "admin_recovery", "admin_recovery_confirm", "security_email_change", "authenticator_reset", "authenticator_reset_confirm"]);
const tokenAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function configuredHashKey() {
  const value = process.env.LOGIN_TOKEN_HASH_KEY?.trim();
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("LOGIN_TOKEN_HASH_KEY is not configured.");
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32) throw new Error("LOGIN_TOKEN_HASH_KEY must be a 32-byte Base64URL key.");
  return key;
}

function tokenHash(value: string) {
  return createHmac("sha256", configuredHashKey()).update(value, "utf8").digest("base64url");
}

function normalizeCode(value: unknown) {
  return typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

function createCode() {
  const bytes = randomBytes(20);
  let value = "";
  for (const byte of bytes) value += tokenAlphabet[byte % tokenAlphabet.length];
  return value.match(/.{1,5}/g)!.join("-");
}

function assertPurpose(value: string): asserts value is AccountTokenPurpose {
  if (!allowedPurposes.has(value as AccountTokenPurpose)) throw new Error("令牌用途无效。");
}

export type IssuedAccountToken = {
  id: string;
  code: string;
  expiresAt: string;
};

async function activeTokenCandidate(codeValue: unknown, purpose: AccountTokenPurpose) {
  assertPurpose(purpose);
  const code = normalizeCode(codeValue);
  if (code.length < 16 || code.length > 80) return null;
  const candidate = await getDatabase().prepare(
    "SELECT id, email, target_email, purpose, token_hash, expires_at, used_at, revoked_at FROM account_tokens WHERE token_hash = ? AND purpose = ? LIMIT 1",
  ).bind(tokenHash(code), purpose).first<AccountTokenRow>();
  if (!candidate || candidate.used_at || candidate.revoked_at || Date.parse(candidate.expires_at) <= Date.now()) return null;
  return candidate;
}

/** Checks an opaque code without consuming it, for multi-step secure flows. */
export async function inspectAccountToken(input: { code: unknown; purpose: AccountTokenPurpose }) {
  const candidate = await activeTokenCandidate(input.code, input.purpose);
  return candidate ? { id: candidate.id, email: candidate.email, targetEmail: candidate.target_email, expiresAt: candidate.expires_at } : null;
}

/**
 * Reads a still-valid one-time value without consuming it. The returned value
 * is intentionally usable only for a conditional SQL update inside the same
 * audited transaction as the business change.
 */
export async function pendingAccountToken(input: { code: unknown; purpose: AccountTokenPurpose }): Promise<PendingAccountToken | null> {
  const candidate = await activeTokenCandidate(input.code, input.purpose);
  return candidate ? {
    id: candidate.id,
    email: candidate.email,
    targetEmail: candidate.target_email,
    expiresAt: candidate.expires_at,
    purpose: candidate.purpose,
    tokenHash: candidate.token_hash,
  } : null;
}

/**
 * Builds the one-use gate for an audited mutation.  Domain statements that
 * follow it should additionally require `used_at = usedAt` for this token.
 */
export function consumePendingAccountTokenStatement(input: {
  token: PendingAccountToken;
  usedAt: string;
  guard: AuditGuard;
}) {
  const database = getDatabase();
  return database.prepare(
    `UPDATE account_tokens
     SET used_at = ?
     WHERE id = ? AND token_hash = ? AND purpose = ?
       AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
       AND ${input.guard.conditionSql}
       AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
  ).bind(
    input.usedAt,
    input.token.id,
    input.token.tokenHash,
    input.token.purpose,
    input.usedAt,
    ...input.guard.values,
    input.guard.auditEventId,
  );
}

export async function issueAccountToken(input: {
  email: string;
  purpose: AccountTokenPurpose;
  createdBy: string;
  lifetimeMs: number;
  revokeExisting?: boolean;
  targetEmail?: string;
}): Promise<IssuedAccountToken> {
  assertPurpose(input.purpose);
  const email = normalizeLoginAccount(input.email);
  const targetEmail = input.targetEmail?.trim().toLowerCase() || null;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.lifetimeMs).toISOString();
  const code = createCode();
  const id = crypto.randomUUID();
  const database = getDatabase();
  const statements = [];
  if (input.revokeExisting !== false) {
    statements.push(
      database.prepare(
        "UPDATE account_tokens SET revoked_at = ? WHERE email = ? AND purpose = ? AND used_at IS NULL AND revoked_at IS NULL",
      ).bind(now.toISOString(), email, input.purpose),
    );
  }
  statements.push(
    database.prepare(
      "INSERT INTO account_tokens (id, email, target_email, purpose, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, email, targetEmail, input.purpose, tokenHash(normalizeCode(code)), expiresAt, normalizeLoginAccount(input.createdBy)),
  );
  await database.batch(statements);
  return { id, code, expiresAt };
}

export async function revokeAccountTokens(input: { email: string; purpose?: AccountTokenPurpose }) {
  const email = normalizeLoginAccount(input.email);
  const now = new Date().toISOString();
  if (input.purpose) {
    assertPurpose(input.purpose);
    await getDatabase().prepare(
      "UPDATE account_tokens SET revoked_at = ? WHERE email = ? AND purpose = ? AND used_at IS NULL AND revoked_at IS NULL",
    ).bind(now, email, input.purpose).run();
    return;
  }
  await getDatabase().prepare(
    "UPDATE account_tokens SET revoked_at = ? WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL",
  ).bind(now, email).run();
}

export async function issueAdministratorRecoveryCodes(input: { email: string; createdBy: string; count?: number }) {
  const count = Math.max(1, Math.min(20, Math.floor(input.count ?? 10)));
  const email = normalizeLoginAccount(input.email);
  const now = new Date().toISOString();
  const database = getDatabase();
  const codes = Array.from({ length: count }, () => createCode());
  const statements = [
    database.prepare(
      "UPDATE account_tokens SET revoked_at = ? WHERE email = ? AND purpose = 'admin_recovery' AND used_at IS NULL AND revoked_at IS NULL",
    ).bind(now, email),
    ...codes.map((code) => database.prepare(
      "INSERT INTO account_tokens (id, email, purpose, token_hash, expires_at, created_by) VALUES (?, ?, 'admin_recovery', ?, ?, ?)",
    ).bind(crypto.randomUUID(), email, tokenHash(normalizeCode(code)), "2999-12-31T23:59:59.000Z", normalizeLoginAccount(input.createdBy))),
  ];
  await database.batch(statements);
  return codes;
}

export function accountTokenCodesEqual(left: string, right: string) {
  const leftHash = Buffer.from(tokenHash(normalizeCode(left)));
  const rightHash = Buffer.from(tokenHash(normalizeCode(right)));
  return leftHash.length === rightHash.length && timingSafeEqual(leftHash, rightHash);
}
