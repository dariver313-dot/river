import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync("app/globals.css", "utf8");
const vaultClient = readFileSync("app/vault-client.tsx", "utf8");
const activationForm = readFileSync("app/activate/activate-account-form.tsx", "utf8");
const recoveryForm = readFileSync("app/recover/password-recovery-form.tsx", "utf8");
const backupService = readFileSync("ops/selfhost/djmima-backup.service", "utf8");

test("常见笔记本宽度使用可收缩的单列工作区", () => {
  assert.doesNotMatch(css, /min-width:\s*1240px/u);
  assert.match(css, /@media \(min-width: 1081px\) and \(max-width: 1475px\)[\s\S]*?\.vault-app \.content-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
});

test("内嵌 iframe 使用确定的剩余高度网格", () => {
  assert.match(css, /\.embedded-workspace-page > \.embedded-frame-panel \{[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\);/u);
});

test("凭据表单可独立维护网站账户的双重验证状态", () => {
  assert.match(vaultClient, /checked=\{form\.twoFactor \|\| addFormHasTotp\}/u);
  assert.match(vaultClient, /checked=\{editForm\.twoFactor \|\| editFormHasTotp\}/u);
  assert.doesNotMatch(vaultClient, /JSON\.stringify\(\{ \.\.\.credential, type: "登录", twoFactor: false/u);
});

test("激活和密码恢复都要求确认新密码", () => {
  assert.match(activationForm, /activation-password-confirm/u);
  assert.match(recoveryForm, /recovery-password-confirm/u);
  assert.match(activationForm, /password !== passwordConfirmation/u);
  assert.match(recoveryForm, /password !== passwordConfirmation/u);
});

test("备份 service 从服务器本地配置读取实际应用目录", () => {
  assert.match(backupService, /EnvironmentFile=-\/etc\/default\/djmima/u);
  assert.match(backupService, /--project-directory \$\{DJMIMA_APP_DIR\}/u);
  assert.doesNotMatch(backupService, /WorkingDirectory=\/opt\/djmima/u);
});
