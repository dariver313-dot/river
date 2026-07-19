import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const violations = [];
const secretFile = /(^|\/)\.env(?:\.|$)|\.(pem|p12|pfx|key)$/i;
const secretPatterns = [
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(?:VAULT_ENCRYPTION_KEY|VAULT_AUDIT_SIGNING_KEY)\s*=\s*["']?[A-Za-z0-9_+\/=\-]{32,}/,
];

const protectedWriteRoutes = [
  "app/api/security/session/route.ts",
  "app/api/users/route.ts",
  "app/api/vault/approvals/route.ts",
  "app/api/vault/audit/route.ts",
  "app/api/vault/crypto-rotation/route.ts",
  "app/api/vault/export/route.ts",
  "app/api/vault/items/route.ts",
  "app/api/vault/items/[id]/route.ts",
];

for (const file of tracked) {
  if (secretFile.test(file)) {
    violations.push(`${file}: 不应提交密钥或环境变量文件`);
    continue;
  }
  const content = readFileSync(file, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    violations.push(`${file}: 检测到疑似密钥或访问令牌`);
  }
}

for (const file of protectedWriteRoutes) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("crossOriginRequestResponse")) violations.push(`${file}: 写接口缺少严格 CSRF 防护`);
  if (!source.includes("rateLimitResponse")) violations.push(`${file}: 写接口缺少服务端限流`);
}

for (const file of ["app/api/users/route.ts", "app/api/vault/approvals/route.ts", "app/api/vault/crypto-rotation/route.ts", "app/api/vault/export/route.ts", "app/api/vault/items/[id]/route.ts"]) {
  if (!readFileSync(file, "utf8").includes("requireRecentSecurityConfirmation")) violations.push(`${file}: 敏感接口缺少近期身份确认`);
}

const cryptoSource = readFileSync("app/lib/vault-crypto.ts", "utf8");
if (!cryptoSource.includes("additionalData") || !cryptoSource.includes("VAULT_ACTIVE_ENCRYPTION_KEY")) {
  violations.push("app/lib/vault-crypto.ts: 缺少 AAD 绑定或双密钥轮换支持");
}

if (violations.length > 0) {
  console.error("安全检查失败：\n" + violations.join("\n"));
  process.exit(1);
}

console.log("安全检查通过：未发现已跟踪文件中的常见密钥模式。");
