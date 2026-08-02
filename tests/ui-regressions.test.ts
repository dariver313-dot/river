import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync("app/globals.css", "utf8");
const vaultClient = readFileSync("app/vault-client.tsx", "utf8");
const activationForm = readFileSync("app/activate/activate-account-form.tsx", "utf8");
const recoveryForm = readFileSync("app/recover/password-recovery-form.tsx", "utf8");
const embeddedPageManager = readFileSync("app/embedded/manage/embedded-page-manager.tsx", "utf8");
const apiResponse = readFileSync("app/lib/api-response.ts", "utf8");
const writeApiRoutes = [
  "app/api/vault/items/route.ts",
  "app/api/vault/items/[id]/route.ts",
  "app/api/users/route.ts",
  "app/api/security/session/route.ts",
  "app/api/embedded-pages/route.ts",
  "app/api/embedded-origins/route.ts",
  "app/api/account/security-email/route.ts",
  "app/api/account/admin-recovery-codes/route.ts",
  "app/api/account/profile/route.ts",
].map((file) => readFileSync(file, "utf8"));
const backupService = readFileSync("ops/selfhost/djmima-backup.service", "utf8");
const accountLifecycleRoutes = [
  "app/api/auth/activate/route.ts",
  "app/api/auth/authenticator-reset/route.ts",
  "app/api/auth/admin-recovery/route.ts",
  "app/api/auth/password-recovery/route.ts",
  "app/api/auth/password/route.ts",
  "app/api/setup/complete/route.ts",
].map((file) => readFileSync(file, "utf8"));

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

test("个人资料安全检查不会把点击事件当作风险筛选值", () => {
  assert.match(vaultClient, /onClick=\{\(\) => onOpenSecurity\(\)\}/u);
  assert.match(vaultClient, /const selectedFocus: SecurityFocus = focus === "weak_password"/u);
  assert.doesNotMatch(vaultClient, /onClick=\{onOpenSecurity\}/u);
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

test("账号生命周期接口不会把底层异常消息直接返回浏览器", () => {
  for (const route of accountLifecycleRoutes) {
    assert.doesNotMatch(route, /secureJson\(\{ error: error instanceof Error \? error\.message/u);
    assert.match(route, /apiError\(error, 500, request\)/u);
  }
});

test("375px 个人信息页将顶部操作放到独立可收缩行", () => {
  assert.match(css, /@media \(max-width: 420px\)[\s\S]*?\.topbar\.is-compact:has\(\.profile-password-action\)[\s\S]*?grid-template-columns: auto minmax\(0, 1fr\)/u);
  assert.match(css, /\.topbar\.is-compact:has\(\.profile-password-action\) \.topbar-page-actions \{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?width: 100%;/u);
  assert.match(css, /\.profile-password-action \{[\s\S]*?min-width: 0;[\s\S]*?flex: 1 1 0;/u);
});

test("内嵌操作触发重新验证时只保留一个可交互模态框", () => {
  assert.match(vaultClient, /const activeDialogKey = showSecurityReverify \? "security-reverify" : embeddedPageDialogOpen/u);
  assert.match(vaultClient, /<EmbeddedPageManagerContent externalDialogOpen=\{showSecurityReverify\}/u);
  assert.match(vaultClient, /\{showSecurityReverify && <ModalPortal>/u);
  assert.match(vaultClient, /\[role="dialog"\]\[aria-modal="true"\]/u);
  assert.match(embeddedPageManager, /aria-hidden=\{externalDialogOpen \|\| undefined\} inert=\{externalDialogOpen \|\| undefined\}/u);
  assert.match(embeddedPageManager, /aria-modal=\{externalDialogOpen \? undefined : true\}/u);
});

test("并发编辑会随表单提交服务端版本标识", () => {
  assert.match(vaultClient, /revision: string;/u);
  assert.match(vaultClient, /JSON\.stringify\(\{ \.\.\.item, \.\.\.changes/u);
  assert.match(embeddedPageManager, /setEditingRevision\(page\.updatedAt\)/u);
  assert.match(embeddedPageManager, /expectedUpdatedAt: editingRevision/u);
});

test("创建用户邮件失败后保留错误代码并刷新已创建用户", () => {
  assert.match(vaultClient, /type VaultRequestError = Error & \{ code\?: string; requestId\?: string \}/u);
  assert.match(vaultClient, /error\.code = payload\?\.code/u);
  assert.match(vaultClient, /requestError\?\.code === "ACTIVATION_DELIVERY_FAILED"[\s\S]*?setUserLoadAttempt/u);
});

test("个人页重新读取安全概览前不会继续显示旧评分", () => {
  assert.match(vaultClient, /if \(page === "profile"\) setSecuritySummaryReady\(false\);/u);
});

test("可预期输入错误不写异常日志，未知接口异常统一返回 500", () => {
  assert.match(apiResponse, /if \(error instanceof ClientSafeError\) \{[\s\S]*?return secureJson[\s\S]*?\}\s+const internalMessage/u);
  for (const route of writeApiRoutes) assert.doesNotMatch(route, /apiError\(error, 400, request\)/u);
});

test("用户管理确认型弹窗拆分为独立展示组件", () => {
  assert.match(vaultClient, /function UserProvisioningDialog/u);
  assert.match(vaultClient, /function AuthenticatorRecoveryDialog/u);
  assert.match(vaultClient, /function SystemUserActionDialog/u);
});
