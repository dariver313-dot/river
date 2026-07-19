import { getD1 } from "../../db";
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
  sensitive: { windowMs: 10 * 60_000, userLimit: 8, ipLimit: 14 },
  audit: { windowMs: 60_000, userLimit: 90, ipLimit: 150 },
  maintenance: { windowMs: 10 * 60_000, userLimit: 60, ipLimit: 80 },
};
const edgePolicies = {
  read: { windowMs: 60_000, limit: 240 },
  write: { windowMs: 60_000, limit: 90 },
};
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
  const d1 = getD1();
  const now = Date.now();
  if (now - lastCleanupAt > 15 * 60_000) {
    lastCleanupAt = now;
    // 仅保留近期窗口。延迟清理不会改变限流结果，且避免不同 IP 长期累积占用 D1。
    await d1.prepare("DELETE FROM request_rate_limits WHERE expires_at < ?").bind(now - 60 * 60_000).run();
  }
  const windowStartedAt = Math.floor(now / policy.windowMs) * policy.windowMs;
  const expiresAt = windowStartedAt + policy.windowMs;
  const hash = await opaqueKey(key);
  await d1.prepare(
    `INSERT INTO request_rate_limits (key_hash, window_started_at, request_count, expires_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(key_hash) DO UPDATE SET
       request_count = CASE WHEN request_rate_limits.window_started_at < excluded.window_started_at THEN 1 ELSE request_rate_limits.request_count + 1 END,
       window_started_at = excluded.window_started_at,
       expires_at = excluded.expires_at,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(hash, windowStartedAt, expiresAt).run();

  const current = await d1.prepare(
    "SELECT request_count, expires_at FROM request_rate_limits WHERE key_hash = ? LIMIT 1",
  ).bind(hash).first<{ request_count: number; expires_at: number }>();
  return { count: current?.request_count ?? 1, retryAfterSeconds: Math.max(1, Math.ceil(((current?.expires_at ?? expiresAt) - now) / 1_000)) };
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
