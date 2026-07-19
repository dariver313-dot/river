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

if (violations.length > 0) {
  console.error("安全检查失败：\n" + violations.join("\n"));
  process.exit(1);
}

console.log("安全检查通过：未发现已跟踪文件中的常见密钥模式。");
