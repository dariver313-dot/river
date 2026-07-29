import { getDatabase } from "../../db";
import { secureJson } from "./response-security";

type RateLimitScope = "read" | "write" | "sensitive" | "audit" | "maintenance";

type RateLimitPolicy = {
  windowMs: number;
  userLimit: number;
  ipLimit: number;
};

const policies: Record<RateLimitScope, RateLimitPolicy> = {
  read: { windowMs: 60_000, userLimit: 120, ipLimit: 180 },
  write: { windowMs: 60_000, userLimit: 36, ipLimit: 72 },
  // A signed-in administrator may reasonably complete a user onboarding,
  // public-item cleanup and embedded-page update in one maintenance window.
  // Password/TOTP checks remain required by each sensitive route, while the
  // limit still bounds automated replay against a stolen active session.
  sensitive: { windowMs: 10 * 60_000, userLimit: 24, ipLimit: 48 },
  audit: { windowMs: 60_000, userLimit: 90, ipLimit: 150 },
  maintenance: { windowMs: 10 * 60_000, userLimit: 60, ipLimit: 80 },
};
const edgePolicies = {
  read: { windowMs: 60_000, limit: 240 },
  write: { windowMs: 60_000, limit: 90 },
};
const loginFailurePolicy = { windowMs: 10 * 60_000, accountLimit: 8, ipLimit: 24 };
let lastCleanupAt = 0;

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function opaqueKey(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(digest));
}

function clientAddress(request: Request) {
  // 自托管时端口仅绑定到本机，由宝塔 Nginx 覆盖写入 X-Real-IP；只有明确
  // 启用受信代理时才使用该值，避免把客户端伪造的转发头当作真实来源。
  if (process.env.DJMIMA_TRUST_PROXY === "1") {
    return request.headers.get("x-real-ip")?.trim() || "unavailable";
  }
  return "unavailable";
}

async function consume(key: string, policy: RateLimitPolicy) {
  const database = getDatabase();
  const now = Date.now();
  if (now - lastCleanupAt > 15 * 60_000) {
    lastCleanupAt = now;
    // 仅保留近期窗口。延迟清理不会改变限流结果，且避免不同 IP 长期累积占用 SQLite。
    await database.prepare("DELETE FROM request_rate_limits WHERE expires_at < ?").bind(now - 60 * 60_000).run();
  }
  const windowStartedAt = Math.floor(now / policy.windowMs) * policy.windowMs;
  const expiresAt = windowStartedAt + policy.windowMs;
  const hash = await opaqueKey(key);
  await database.prepare(
    `INSERT INTO request_rate_limits (key_hash, window_started_at, request_count, expires_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(key_hash) DO UPDATE SET
       request_count = CASE WHEN request_rate_limits.window_started_at < excluded.window_started_at THEN 1 ELSE request_rate_limits.request_count + 1 END,
       window_started_at = excluded.window_started_at,
       expires_at = excluded.expires_at,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(hash, windowStartedAt, expiresAt).run();

  const current = await database.prepare(
    "SELECT request_count, expires_at FROM request_rate_limits WHERE key_hash = ? LIMIT 1",
  ).bind(hash).first<{ request_count: number; expires_at: number }>();
  return { count: current?.request_count ?? 1, retryAfterSeconds: Math.max(1, Math.ceil(((current?.expires_at ?? expiresAt) - now) / 1_000)) };
}

async function currentCount(key: string) {
  const hash = await opaqueKey(key);
  const current = await getDatabase().prepare(
    "SELECT request_count, expires_at FROM request_rate_limits WHERE key_hash = ? LIMIT 1",
  ).bind(hash).first<{ request_count: number; expires_at: number }>();
  return current && current.expires_at > Date.now() ? current : null;
}

export async function rateLimitResponse(request: Request, email: string, scope: RateLimitScope) {
  const policy = policies[scope];
  try {
    const [byUser, byIp] = await Promise.all([
      consume(`user:${scope}:${email.toLowerCase()}`, policy),
      consume(`ip:${scope}:${clientAddress(request)}`, policy),
    ]);
    const limited = byUser.count > policy.userLimit || byIp.count > policy.ipLimit;
    if (!limited) return null;

    const retryAfter = Math.max(byUser.retryAfterSeconds, byIp.retryAfterSeconds);
    return secureJson(
      { error: "请求过于频繁。请稍后再试。", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  } catch (error) {
    console.error("djmima_rate_limit_error", { path: new URL(request.url).pathname, message: error instanceof Error ? error.message : String(error) });
    // 限流存储不可用时宁可短暂拒绝，也不让敏感接口在无保护状态下继续运行。
    return secureJson({ error: "安全防护暂时不可用，请稍后重试。", code: "SECURITY_CHECK_UNAVAILABLE" }, { status: 503 });
  }
}

export async function anonymousEdgeRateLimitResponse(request: Request) {
  const policy = request.method === "GET" || request.method === "HEAD" ? edgePolicies.read : edgePolicies.write;
  try {
    const result = await consume(`edge:${request.method}:${clientAddress(request)}`, {
      windowMs: policy.windowMs,
      userLimit: policy.limit,
      ipLimit: policy.limit,
    });
    if (result.count <= policy.limit) return null;
    return secureJson(
      { error: "请求过于频繁。请稍后再试。", code: "EDGE_RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
    );
  } catch (error) {
    console.error("djmima_edge_rate_limit_error", { path: new URL(request.url).pathname, message: error instanceof Error ? error.message : String(error) });
    return secureJson({ error: "安全防护暂时不可用，请稍后重试。", code: "EDGE_SECURITY_CHECK_UNAVAILABLE" }, { status: 503 });
  }
}

/**
 * Records only failed password/TOTP attempts, so legitimate reauthentication
 * is not throttled. Both account and source address are limited to reduce
 * password spraying and a single-account brute-force attempt.
 */
export async function failedLoginRateLimitResponse(request: Request, account: string) {
  const normalizedAccount = account.trim().toLowerCase().slice(0, 160) || "unknown";
  try {
    const [byAccount, byIp] = await Promise.all([
      consume(`login-failure:account:${normalizedAccount}`, {
        windowMs: loginFailurePolicy.windowMs,
        userLimit: loginFailurePolicy.accountLimit,
        ipLimit: loginFailurePolicy.accountLimit,
      }),
      consume(`login-failure:ip:${clientAddress(request)}`, {
        windowMs: loginFailurePolicy.windowMs,
        userLimit: loginFailurePolicy.ipLimit,
        ipLimit: loginFailurePolicy.ipLimit,
      }),
    ]);
    if (byAccount.count <= loginFailurePolicy.accountLimit && byIp.count <= loginFailurePolicy.ipLimit) return null;
    const retryAfter = Math.max(byAccount.retryAfterSeconds, byIp.retryAfterSeconds);
    return secureJson(
      { error: "登录尝试过于频繁。请稍后再试。", code: "LOGIN_RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  } catch (error) {
    console.error("djmima_login_rate_limit_error", { path: new URL(request.url).pathname, message: error instanceof Error ? error.message : String(error) });
    return secureJson({ error: "安全防护暂时不可用，请稍后重试。", code: "LOGIN_SECURITY_CHECK_UNAVAILABLE" }, { status: 503 });
  }
}

/**
 * Avoid costly password-hash verification after an account or source has
 * already exhausted its failed-login budget.  This is a read-only precheck;
 * counters still increase only after an actual failed credential attempt.
 */
export async function failedLoginRateLimitPrecheckResponse(request: Request, account: string) {
  const normalizedAccount = account.trim().toLowerCase().slice(0, 160) || "unknown";
  try {
    const [byAccount, byIp] = await Promise.all([
      currentCount(`login-failure:account:${normalizedAccount}`),
      currentCount(`login-failure:ip:${clientAddress(request)}`),
    ]);
    const accountLimited = (byAccount?.request_count ?? 0) >= loginFailurePolicy.accountLimit;
    const ipLimited = (byIp?.request_count ?? 0) >= loginFailurePolicy.ipLimit;
    if (!accountLimited && !ipLimited) return null;
    const retryAfter = Math.max(
      byAccount ? Math.max(1, Math.ceil((byAccount.expires_at - Date.now()) / 1_000)) : 0,
      byIp ? Math.max(1, Math.ceil((byIp.expires_at - Date.now()) / 1_000)) : 0,
    );
    return secureJson(
      { error: "登录尝试过于频繁。请稍后再试。", code: "LOGIN_RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  } catch (error) {
    console.error("djmima_login_rate_limit_precheck_error", { path: new URL(request.url).pathname, message: error instanceof Error ? error.message : String(error) });
    return secureJson({ error: "安全防护暂时不可用，请稍后重试。", code: "LOGIN_SECURITY_CHECK_UNAVAILABLE" }, { status: 503 });
  }
}
