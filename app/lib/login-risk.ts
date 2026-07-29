import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDatabase } from "../../db";
import { normalizeLoginAccount } from "./identity";
import { locateLoginRequest } from "./local-geoip";

export type LoginRiskLevel = "baseline" | "same_country" | "country_change" | "unavailable";
export { loginRiskMode, type LoginRiskMode } from "./login-risk-mode";

export type LoginRiskAssessment = {
  countryCode: string | null;
  available: boolean;
  level: LoginRiskLevel;
  reasons: string[];
};

type LoginEventRow = { country_code: string | null; created_at: string };
type LoginChallengeRow = {
  id: string;
  email: string;
  code_hash: string;
  browser_hash: string | null;
  country_code: string | null;
  expires_at: string;
  attempts: number;
  used_at: string | null;
};

const challengeLifetimeMs = 15 * 60_000;
const maxChallengeAttempts = 5;

function configuredHashKey() {
  const value = process.env.LOGIN_TOKEN_HASH_KEY?.trim();
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("LOGIN_TOKEN_HASH_KEY is not configured.");
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32) throw new Error("LOGIN_TOKEN_HASH_KEY must be a 32-byte Base64URL key.");
  return key;
}

function challengeCode() {
  const number = randomBytes(5).readUIntBE(0, 5) % 100_000_000;
  return String(number).padStart(8, "0");
}

function challengeHash(value: string) {
  return createHmac("sha256", configuredHashKey()).update(`country-challenge:${value}`, "utf8").digest("base64url");
}

function challengeBinding() {
  return randomBytes(32).toString("base64url");
}

function safeReasons(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

/** Compares only the current and immediately previous successful country. */
export async function assessLoginRisk(email: string, request: Request): Promise<LoginRiskAssessment> {
  const account = normalizeLoginAccount(email);
  const location = await locateLoginRequest(request);
  if (!location.available || !location.countryCode) {
    return { countryCode: null, available: false, level: "unavailable", reasons: ["country_unavailable"] };
  }

  const latest = await getDatabase().prepare(
    "SELECT country_code, created_at FROM login_events WHERE email = ? AND outcome = 'success' AND country_code IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).bind(account).first<LoginEventRow>();
  if (!latest?.country_code) {
    return { countryCode: location.countryCode, available: true, level: "baseline", reasons: ["first_country"] };
  }
  if (latest.country_code === location.countryCode) {
    return { countryCode: location.countryCode, available: true, level: "same_country", reasons: ["same_country"] };
  }
  return { countryCode: location.countryCode, available: true, level: "country_change", reasons: ["country_changed"] };
}

/** Stores only the coarse country code and outcome; never raw IP or user agent. */
export async function recordLoginEvent(input: {
  email?: string | null;
  outcome: "success" | "failure" | "challenge" | "blocked";
  assessment?: LoginRiskAssessment;
}) {
  const email = input.email ? normalizeLoginAccount(input.email) : null;
  const assessment = input.assessment ?? { countryCode: null, available: false, level: "unavailable" as const, reasons: ["not_available"] };
  await getDatabase().prepare(
    `INSERT INTO login_events (id, email, outcome, country_code, region, ip_hash, user_agent_hash, risk_level, risk_reasons)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    email,
    input.outcome,
    assessment.countryCode,
    assessment.level,
    JSON.stringify(assessment.reasons),
  ).run();
}

export async function issueLoginChallenge(input: { email: string; assessment: LoginRiskAssessment }) {
  if (!input.assessment.countryCode || input.assessment.level !== "country_change") throw new Error("登录地点无需安全邮箱确认。");
  const email = normalizeLoginAccount(input.email);
  const id = crypto.randomUUID();
  const code = challengeCode();
  const binding = challengeBinding();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + challengeLifetimeMs).toISOString();
  const database = getDatabase();
  await database.batch([
    database.prepare(
      "UPDATE login_challenges SET used_at = ? WHERE email = ? AND used_at IS NULL AND expires_at > ?",
    ).bind(now.toISOString(), email, now.toISOString()),
    database.prepare(
      `INSERT INTO login_challenges (id, email, code_hash, browser_hash, country_code, region, ip_hash, risk_reasons, expires_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).bind(id, email, challengeHash(code), challengeHash(binding), input.assessment.countryCode, JSON.stringify(input.assessment.reasons), expiresAt),
  ]);
  return { id, code, binding, expiresAt };
}

export async function consumeLoginChallenge(input: { id: unknown; code: unknown; binding: unknown }) {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const code = typeof input.code === "string" ? input.code.replace(/\D/g, "") : "";
  const binding = typeof input.binding === "string" ? input.binding.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d{8}$/.test(code) || !/^[a-zA-Z0-9_-]{32,128}$/.test(binding)) return null;
  const database = getDatabase();
  const row = await database.prepare(
    "SELECT id, email, code_hash, browser_hash, country_code, expires_at, attempts, used_at FROM login_challenges WHERE id = ? LIMIT 1",
  ).bind(id).first<LoginChallengeRow>();
  if (!row || row.used_at || row.attempts >= maxChallengeAttempts || Date.parse(row.expires_at) <= Date.now() || !row.country_code) return null;
  const expected = Buffer.from(row.code_hash);
  const supplied = Buffer.from(challengeHash(code));
  const valid = expected.length === supplied.length && timingSafeEqual(expected, supplied);
  if (!valid) {
    await database.prepare("UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND attempts < ?").bind(row.id, maxChallengeAttempts).run();
    return null;
  }
  const expectedBinding = row.browser_hash ? Buffer.from(row.browser_hash) : null;
  const suppliedBinding = Buffer.from(challengeHash(binding));
  if (!expectedBinding || expectedBinding.length !== suppliedBinding.length || !timingSafeEqual(expectedBinding, suppliedBinding)) return null;
  const consumed = await database.prepare(
    "UPDATE login_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?",
  ).bind(new Date().toISOString(), row.id, new Date().toISOString()).run();
  if ((consumed.meta.changes ?? 0) !== 1) return null;
  return { email: row.email, countryCode: row.country_code };
}

export async function listRecentLoginEvents(email: string, limit = 20) {
  const account = normalizeLoginAccount(email);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await getDatabase().prepare(
    `SELECT id, outcome, country_code, risk_level, risk_reasons, created_at
     FROM login_events WHERE email = ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(account, safeLimit).all<{
    id: string;
    outcome: "success" | "failure" | "challenge" | "blocked";
    country_code: string | null;
    risk_level: LoginRiskLevel;
    risk_reasons: string;
    created_at: string;
  }>();
  return result.results.map((event) => ({
    id: event.id,
    outcome: event.outcome,
    countryCode: event.country_code,
    riskLevel: event.risk_level,
    riskReasons: safeReasons(event.risk_reasons),
    createdAt: event.created_at,
  }));
}
