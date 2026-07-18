import assert from "node:assert/strict";
import test from "node:test";

import { secureHeaders, secureJson } from "../app/lib/response-security.ts";
import { reviewCredentialSecurity } from "../app/lib/security-review.ts";
import { generateTotpCode, parseTotpInput } from "../app/lib/totp.ts";
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
  assert.throws(() => boundedText("x".repeat(121), "name"), /不能超过 120/);
  assert.throws(() => boundedText("x".repeat(1_025), "password", { trim: false }), /不能超过 1024/);
  assert.throws(() => boundedText("x".repeat(61), "category"), /不能超过 60/);
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
