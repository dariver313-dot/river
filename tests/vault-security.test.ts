import assert from "node:assert/strict";
import test from "node:test";

import { crossOriginRequestResponse, secureHeaders, secureJson } from "../app/lib/response-security.ts";
import { maxJsonRequestBytes, readLimitedJsonObject } from "../app/lib/request-validation.ts";
import { reviewCredentialSecurity } from "../app/lib/security-review.ts";
import { canonicalPublicVaultId, resolveSharedPublicVault } from "../app/lib/shared-public-vault.ts";
import { assertSystemUserChangeAllowed, assertSystemUserDeletionAllowed } from "../app/lib/system-user-policy.ts";
import { generateTotpCode, parseTotpInput } from "../app/lib/totp.ts";
import { vaultRouteFromSearch, vaultRouteSearch } from "../app/lib/vault-navigation.ts";
import { assertVaultMoveAllowed, boundedText } from "../app/lib/vault-policy.ts";

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

test("密码库响应禁止缓存并带有浏览器安全策略", async () => {
  const headers = secureHeaders(undefined, { noStore: true });
  assert.match(headers.get("cache-control") ?? "", /no-store/);
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.match(headers.get("content-security-policy") ?? "", /default-src 'self'/);

  const response = secureJson({ ok: true });
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.deepEqual(await response.json(), { ok: true });
});

test("跨站写入或导出请求会被拒绝", async () => {
  const response = crossOriginRequestResponse(new Request("https://vault.example.test/api/vault/export", {
    headers: { Origin: "https://attacker.example.test" },
  }));
  assert.equal(response?.status, 403);
  assert.deepEqual(await response?.json(), { error: "已拒绝跨站请求。请从 djmima 页面重新操作。" });
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
  });
  assert.deepEqual(vaultRouteFromSearch("?view=users&tab=audit", false), {
    page: "vault",
    collection: "all",
    securityFocus: "all",
    userManagementTab: "users",
  });
  assert.equal(vaultRouteSearch({ page: "users", collection: "all", securityFocus: "all", userManagementTab: "audit" }), "?view=users&tab=audit");
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
