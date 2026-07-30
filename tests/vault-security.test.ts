import assert from "node:assert/strict";
import test from "node:test";

import { crossOriginRequestResponse, secureHeaders, secureJson } from "../app/lib/response-security.ts";
import { maxJsonRequestBytes, readLimitedJsonObject } from "../app/lib/request-validation.ts";
import { reviewCredentialSecurity } from "../app/lib/security-review.ts";
import { canonicalPublicVaultId, resolveSharedPublicVault } from "../app/lib/shared-public-vault.ts";
import { assertSystemUserChangeAllowed, assertSystemUserDeletionAllowed, assertSystemUserStatusTransitionAllowed } from "../app/lib/system-user-policy.ts";
import { generateTotpCode, parseTotpInput } from "../app/lib/totp.ts";
import { vaultRouteFromSearch, vaultRouteSearch } from "../app/lib/vault-navigation.ts";
import { assertVaultMoveAllowed, boundedText } from "../app/lib/vault-policy.ts";
import { isValidLoginAccount, normalizeLoginAccount } from "../app/lib/identity.ts";
import { vaultItemLimit } from "../app/lib/vault-policy.ts";
import { normalizeEmbeddedOrigin, normalizeEmbeddedPageUrl } from "../app/lib/embedded-page-policy.ts";
import { isAuthSessionOnline, onlineActivityWindowMs } from "../app/lib/user-presence.ts";
import { safeInternalPath } from "../app/lib/safe-navigation.ts";
import { normalizeProfileDisplayName, profileAvatarStyle, profileDisplayName } from "../app/lib/profile.ts";
import { resolveLoginRiskMode } from "../app/lib/login-risk-mode.ts";
import { requestClientIp } from "../app/lib/request-ip.ts";

test("公共项目不会被静默移入个人项目", () => {
  assert.throws(
    () => assertVaultMoveAllowed("公共", "个人", true),
    /公共项目不能移入个人项目/,
  );
});

test("只有管理员能将个人项目设为公共项目", () => {
  assert.throws(
    () => assertVaultMoveAllowed("个人", "公共", false),
    /只有管理员/,
  );
  assert.doesNotThrow(() => assertVaultMoveAllowed("个人", "公共", true));
});

test("敏感字段有明确的长度边界", () => {
  assert.equal(boundedText("  example.com  ", "domain", { required: true }), "example.com");
  assert.equal(boundedText(" 部门一 ", "category"), "部门一");
  assert.equal(boundedText(" 登录验证器 ", "totpLabel"), "登录验证器");
  assert.throws(() => boundedText("x".repeat(121), "name"), /不能超过 120/);
  assert.throws(() => boundedText("x".repeat(1_025), "password", { trim: false }), /不能超过 1024/);
  assert.throws(() => boundedText("x".repeat(61), "category"), /不能超过 60/);
  assert.throws(() => boundedText("x".repeat(41), "totpLabel"), /不能超过 40/);
});

test("个人资料仅接受受控昵称和预设头像样式", () => {
  assert.equal(normalizeProfileDisplayName("  大江   用户  "), "大江 用户");
  assert.equal(normalizeProfileDisplayName("\u0000无效"), null);
  assert.equal(normalizeProfileDisplayName("x".repeat(33)), null);
  assert.equal(profileDisplayName("\u0000旧昵称", "默认名称"), "默认名称");
  assert.equal(profileAvatarStyle("violet"), "violet");
  assert.equal(profileAvatarStyle("uploaded-image"), "sage");
});

test("密码库响应禁止缓存并带有浏览器安全策略", async () => {
  const headers = secureHeaders(undefined, { noStore: true });
  assert.match(headers.get("cache-control") ?? "", /no-store/);
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.match(headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(headers.get("content-security-policy") ?? "", /frame-src 'self' https:/);

  const response = secureJson({ ok: true });
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.deepEqual(await response.json(), { ok: true });
});

test("内嵌来源与页面地址只接受安全的 HTTPS 格式", () => {
  assert.equal(normalizeEmbeddedOrigin("https://reports.example.test"), "https://reports.example.test");
  assert.throws(() => normalizeEmbeddedOrigin("https://reports.example.test/dashboard"), /无路径/);
  assert.throws(() => normalizeEmbeddedOrigin("http://reports.example.test"), /HTTPS/);
  assert.deepEqual(normalizeEmbeddedPageUrl("https://reports.example.test/dashboard?period=month"), {
    url: "https://reports.example.test/dashboard?period=month",
    origin: "https://reports.example.test",
  });
  assert.throws(() => normalizeEmbeddedPageUrl("http://reports.example.test/dashboard"), /HTTPS/);
});

test("内嵌页面不能指向本应用域名", () => {
  const previous = process.env.DJMIMA_PUBLIC_ORIGIN;
  process.env.DJMIMA_PUBLIC_ORIGIN = "https://djmima.example.test";
  try {
    assert.throws(() => normalizeEmbeddedOrigin("https://djmima.example.test"), /本应用域名/);
    assert.throws(() => normalizeEmbeddedPageUrl("https://djmima.example.test/embedded"), /本应用域名/);
  } finally {
    if (previous === undefined) delete process.env.DJMIMA_PUBLIC_ORIGIN;
    else process.env.DJMIMA_PUBLIC_ORIGIN = previous;
  }
});

test("用户在线状态只认可近期仍有效的会话", () => {
  const now = Date.parse("2026-07-23T06:00:00.000Z");
  assert.equal(isAuthSessionOnline({
    expiresAt: "2026-07-23T07:00:00.000Z",
    lastActiveAt: new Date(now - onlineActivityWindowMs + 1).toISOString(),
    revokedAt: null,
  }, now), true);
  assert.equal(isAuthSessionOnline({
    expiresAt: "2026-07-23T07:00:00.000Z",
    lastActiveAt: new Date(now - onlineActivityWindowMs - 1).toISOString(),
    revokedAt: null,
  }, now), false);
  assert.equal(isAuthSessionOnline({
    expiresAt: "2026-07-23T07:00:00.000Z",
    lastActiveAt: "2026-07-23T05:59:00.000Z",
    revokedAt: "2026-07-23T05:59:30.000Z",
  }, now), false);
});

test("跨站写入请求会被拒绝", async () => {
  const response = crossOriginRequestResponse(new Request("https://vault.example.test/api/vault/items", {
    headers: { Origin: "https://attacker.example.test" },
  }));
  assert.equal(response?.status, 403);
  assert.deepEqual(await response?.json(), { error: "已拒绝跨站请求。请从 djmima 页面重新操作。", code: "CSRF_REJECTED" });

  const missingOrigin = crossOriginRequestResponse(new Request("https://vault.example.test/api/vault/items", {
    headers: { "Sec-Fetch-Site": "same-origin" },
  }));
  assert.equal(missingOrigin?.status, 403);

  const missingFetchMetadata = crossOriginRequestResponse(new Request("https://vault.example.test/api/vault/items", {
    headers: { Origin: "https://vault.example.test" },
  }));
  assert.equal(missingFetchMetadata?.status, 403);

  const allowed = crossOriginRequestResponse(new Request("https://vault.example.test/api/vault/items", {
    headers: { Origin: "https://vault.example.test", "Sec-Fetch-Site": "same-origin" },
  }));
  assert.equal(allowed, null);
});

test("登录和退出跳转始终留在应用站内", () => {
  assert.equal(safeInternalPath("/embedded?page=one"), "/embedded?page=one");
  assert.equal(safeInternalPath("//attacker.example"), "/");
  assert.equal(safeInternalPath("/\\\\attacker.example"), "/");
  assert.equal(safeInternalPath("/%5C%5Cattacker.example"), "/");
  assert.equal(safeInternalPath("/%255C%255Cattacker.example"), "/");
});

test("密码库与系统用户都具有服务端数据上限", () => {
  assert.equal(vaultItemLimit("个人"), 500);
  assert.equal(vaultItemLimit("公共"), 1_000);
});

test("写入接口拒绝无效或过大的 JSON 请求", async () => {
  await assert.rejects(
    readLimitedJsonObject(new Request("https://example.test/api", { method: "POST", body: "{" })),
    /请求内容无效/,
  );
  await assert.rejects(
    readLimitedJsonObject(new Request("https://example.test/api", { method: "POST", body: JSON.stringify(["not-an-object"]) })),
    /请求内容无效/,
  );
  await assert.rejects(
    readLimitedJsonObject(new Request("https://example.test/api", { method: "POST", body: JSON.stringify({ value: "x".repeat(maxJsonRequestBytes) }) })),
    /请求内容过大/,
  );
});

test("验证器配置会被规范化且可以生成六码动态验证码", async () => {
  const config = parseTotpInput("otpauth://totp/djmima:admin?secret=JBSWY3DPEHPK3PXP&issuer=djmima");
  assert.equal(config.digits, 6);
  assert.equal(config.issuer, "djmima");
  assert.match(await generateTotpCode(config, 1_700_000_000_000), /^\d{6}$/);
});

test("安全检查会标记短密码、重复密码和缺少双重验证", () => {
  const review = reviewCredentialSecurity([
    { id: "one", password: "same-password", strength: "风险", twoFactor: false },
    { id: "two", password: "same-password", strength: "安全", twoFactor: true },
    { id: "three", password: "different-password", strength: "安全", twoFactor: false },
  ]);

  assert.deepEqual(review.get("one"), ["weak_password", "reused_password", "missing_two_factor"]);
  assert.deepEqual(review.get("two"), ["reused_password"]);
  assert.deepEqual(review.get("three"), ["missing_two_factor"]);
});

test("安全检查会将未达到推荐长度的密码列为待处理项", () => {
  const review = reviewCredentialSecurity([
    { id: "standard", password: "1234567890", strength: "一般", twoFactor: true },
  ]);

  assert.deepEqual(review.get("standard"), ["weak_password"]);
});

test("失效的公共密码库映射会回退到仍然有效的公共密码库", () => {
  const vaults = [{ id: "shared-existing" }, { id: "shared-newer" }];
  assert.equal(resolveSharedPublicVault("removed-vault", vaults)?.id, "shared-existing");
  assert.equal(resolveSharedPublicVault("shared-newer", vaults)?.id, "shared-newer");
  assert.equal(resolveSharedPublicVault(null, []), null);
  assert.equal(canonicalPublicVaultId, "djmima-shared-public-vault");
});

test("关键页面可通过 URL 恢复，非管理员不能进入用户管理", () => {
  assert.deepEqual(vaultRouteFromSearch("?view=security&focus=reused_password", true), {
    page: "vault",
    collection: "security",
    securityFocus: "reused_password",
    userManagementTab: "users",
    auditCategory: "all",
  });
  assert.deepEqual(vaultRouteFromSearch("?view=users&tab=audit", false), {
    page: "vault",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "users",
    auditCategory: "all",
  });
  assert.deepEqual(vaultRouteFromSearch("?view=users&tab=audit&audit=project", true), {
    page: "users",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "audit",
    auditCategory: "project",
  });
  assert.deepEqual(vaultRouteFromSearch("?view=users&tab=audit&audit=embedded", true), {
    page: "users",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "audit",
    auditCategory: "embedded",
  });
  assert.deepEqual(vaultRouteFromSearch("?view=login-access", true), {
    page: "vault",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "users",
    auditCategory: "all",
  });
  assert.deepEqual(vaultRouteFromSearch("?view=embedded", false), {
    page: "embedded",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "users",
    auditCategory: "all",
  });
  assert.deepEqual(vaultRouteFromSearch("?view=embedded&page=page-123", false), {
    page: "embedded",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "users",
    auditCategory: "all",
    embeddedPageId: "page-123",
  });
  assert.deepEqual(vaultRouteFromSearch("?view=embedded&manage=1", false), {
    page: "embedded",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "users",
    auditCategory: "all",
  });
  assert.deepEqual(vaultRouteFromSearch("?view=embedded-manage", false), {
    page: "vault",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "users",
    auditCategory: "all",
  });
  assert.deepEqual(vaultRouteFromSearch("?view=embedded-manage", true), {
    page: "embedded-manage",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "users",
    auditCategory: "all",
  });
  assert.deepEqual(vaultRouteFromSearch("?view=embedded&manage=1", true), {
    page: "embedded",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "users",
    auditCategory: "all",
  });
  assert.equal(vaultRouteSearch({ page: "embedded", collection: "all", securityFocus: "all", userManagementTab: "users", auditCategory: "all" }), "?view=embedded");
  assert.equal(vaultRouteSearch({ page: "embedded", collection: "all", securityFocus: "all", userManagementTab: "users", auditCategory: "all", embeddedPageId: "page-123" }), "?view=embedded&page=page-123");
  assert.equal(vaultRouteSearch({ page: "embedded-manage", collection: "all", securityFocus: "all", userManagementTab: "users", auditCategory: "all" }), "?view=embedded-manage");
  assert.equal(vaultRouteSearch({ page: "users", collection: "all", securityFocus: "all", userManagementTab: "audit", auditCategory: "project" }), "?view=users&tab=audit&audit=project");
  assert.equal(vaultRouteSearch({ page: "users", collection: "all", securityFocus: "all", userManagementTab: "audit", auditCategory: "embedded" }), "?view=users&tab=audit&audit=embedded");
});

test("用户管理始终保留有效主管理员", () => {
  const primaryAdmin = { email: "admin@example.com", role: "admin" as const, status: "active" as const };
  assert.throws(
    () => assertSystemUserChangeAllowed({
      actorEmail: primaryAdmin.email,
      target: primaryAdmin,
      configuredPrimaryAdminEmail: primaryAdmin.email,
      nextRole: "user",
      nextStatus: "active",
      activeAdminCount: 2,
    }),
    /不能降低或停用/,
  );
  assert.throws(
    () => assertSystemUserDeletionAllowed({
      actorEmail: "other@example.com",
      target: primaryAdmin,
      configuredPrimaryAdminEmail: primaryAdmin.email,
      activeAdminCount: 2,
    }),
    /不能删除/,
  );
  assert.throws(
    () => assertSystemUserChangeAllowed({
      actorEmail: "other@example.com",
      target: { email: "second@example.com", role: "admin", status: "active" },
      configuredPrimaryAdminEmail: primaryAdmin.email,
      nextRole: "user",
      nextStatus: "active",
      activeAdminCount: 1,
    }),
    /至少需要保留一位有效管理员/,
  );
});

test("待激活账户只能由激活确认流程进入已启用状态", () => {
  assert.throws(
    () => assertSystemUserStatusTransitionAllowed("pending", "suspended"),
    /待激活账户只能通过激活确认流程/,
  );
  assert.throws(
    () => assertSystemUserStatusTransitionAllowed("suspended", "pending"),
    /待激活账户只能通过激活确认流程/,
  );
  assert.doesNotThrow(() => assertSystemUserStatusTransitionAllowed("active", "suspended"));
  assert.doesNotThrow(() => assertSystemUserStatusTransitionAllowed("suspended", "active"));
});


test("登录账号支持邮箱和规范的英文数字组合", () => {
  assert.equal(normalizeLoginAccount("  Dajiang01 "), "dajiang01");
  assert.equal(isValidLoginAccount("admin@example.com"), true);
  assert.equal(isValidLoginAccount("dajiang01"), true);
  assert.equal(isValidLoginAccount("dajiang"), false);
  assert.equal(isValidLoginAccount("123dajiang"), false);
  assert.equal(isValidLoginAccount("用户01"), false);
});

test("生产环境默认强制新国家登录确认，本地预览默认仅观察", () => {
  assert.equal(resolveLoginRiskMode("production"), "enforce");
  assert.equal(resolveLoginRiskMode("development"), "observe");
});

test("请求来源只在受信反向代理下用于短期限流和本地 GeoIP", () => {
  const previous = process.env.DJMIMA_TRUST_PROXY;
  try {
    process.env.DJMIMA_TRUST_PROXY = "0";
    assert.equal(requestClientIp(new Request("https://vault.example.test/login", { headers: { "x-real-ip": "203.0.113.8" } })), null);
    process.env.DJMIMA_TRUST_PROXY = "1";
    assert.equal(requestClientIp(new Request("https://vault.example.test/login", { headers: { "x-real-ip": "203.0.113.8" } })), "203.0.113.8");
  } finally {
    if (previous === undefined) delete process.env.DJMIMA_TRUST_PROXY;
    else process.env.DJMIMA_TRUST_PROXY = previous;
  }
});
