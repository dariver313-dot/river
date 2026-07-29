import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Check both committed and newly-created source files. A security rule that
// ignores untracked routes is especially dangerous during a release branch.
const workspaceFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const violations = [];
const secretFile = /(^|\/)\.env(?:\.|$)|\.(pem|p12|pfx|key)$/i;
const allowedExampleFiles = new Set([".env.example"]);
const secretPatterns = [
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(?:VAULT_ENCRYPTION_KEY|VAULT_AUDIT_SIGNING_KEY)\s*=\s*["']?[A-Za-z0-9_+\/=\-]{32,}/,
];

function readCheckedSource(file) {
  if (!existsSync(file)) {
    violations.push(`${file}: 安全检查引用的路由不存在`);
    return "";
  }
  return readFileSync(file, "utf8");
}

for (const file of workspaceFiles) {
  if (!existsSync(file)) continue;
  if (secretFile.test(file) && !allowedExampleFiles.has(file)) {
    violations.push(`${file}: 不应提交密钥或环境变量文件`);
    continue;
  }
  const content = readFileSync(file, "utf8");
  if (!allowedExampleFiles.has(file) && secretPatterns.some((pattern) => pattern.test(content))) {
    violations.push(`${file}: 检测到疑似密钥或访问令牌`);
  }
}

const apiRoutes = workspaceFiles.filter((file) => existsSync(file) && /^app\/api\/.+\/route\.ts$/.test(file));
for (const file of apiRoutes) {
  const source = readCheckedSource(file);
  if (!/export async function (?:POST|PATCH|PUT|DELETE)\b/.test(source)) continue;
  if (!source.includes("crossOriginRequestResponse")) violations.push(`${file}: 写接口缺少严格 CSRF 防护`);
  if (!source.includes("anonymousEdgeRateLimitResponse") && !source.includes("rateLimitResponse")) {
    violations.push(`${file}: 写接口缺少服务端限流`);
  }
}

for (const file of ["app/api/users/route.ts", "app/api/vault/items/[id]/route.ts", "app/api/embedded-origins/route.ts"]) {
  if (!readCheckedSource(file).includes("requireRecentSecurityConfirmation")) violations.push(`${file}: 敏感接口缺少近期身份确认`);
}

// 页面配置不要求额外 Google 验证码，但必须始终由当前安全会话中的
// 管理员操作；可信来源的系统范围变更则继续由其独立路由要求近期确认。
const embeddedPagesSource = readCheckedSource("app/api/embedded-pages/route.ts");
if (!embeddedPagesSource.includes("requireVaultActor") || !embeddedPagesSource.includes('actor.role !== "admin"')) {
  violations.push("app/api/embedded-pages/route.ts: 页面配置缺少管理员安全会话校验");
}

const cryptoSource = readFileSync("app/lib/vault-crypto.ts", "utf8");
if (!cryptoSource.includes("additionalData") || !cryptoSource.includes("VAULT_ENCRYPTION_KEY")) {
  violations.push("app/lib/vault-crypto.ts: 缺少 AAD 绑定或主加密密钥支持");
}

for (const retiredRoute of [
  "app/api/login-access/route.ts",
  "app/api/login-access/enroll/route.ts",
  "app/access/page.tsx",
  "app/access/enroll/page.tsx",
]) {
  if (existsSync(retiredRoute)) violations.push(`${retiredRoute}: 已移除的 IP/设备准入入口不应继续存在`);
}

const loginRiskSource = readCheckedSource("app/lib/login-risk.ts");
if (!loginRiskSource.includes("country_change") || !loginRiskSource.includes("browser_hash") || !loginRiskSource.includes("NULL, NULL, NULL")) {
  violations.push("app/lib/login-risk.ts: 国家变化挑战必须使用一次性绑定且不得保存原始 IP 或用户代理");
}
if (loginRiskSource.includes("known_country") || loginRiskSource.includes("region_changed")) {
  violations.push("app/lib/login-risk.ts: 登录风险不得回退到历史国家集或城市级判断");
}

const resetRouteSource = readCheckedSource("app/api/auth/authenticator-reset/route.ts");
if (!resetRouteSource.includes("anonymousEdgeRateLimitResponse") || !resetRouteSource.includes("beginAuthenticatorReset")) {
  violations.push("app/api/auth/authenticator-reset/route.ts: 验证器恢复入口缺少匿名限流或受控恢复流程");
}

if (violations.length > 0) {
  console.error("安全检查失败：\n" + violations.join("\n"));
  process.exit(1);
}

console.log("安全检查通过：未发现已跟踪文件中的常见密钥模式。");
