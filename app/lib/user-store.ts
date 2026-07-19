import { getD1 } from "../../db";
import { assertAuthTotpEncryptionReady, encryptAuthTotpSecret } from "./auth-totp-crypto";
import { hashLoginPassword } from "./auth-password";
import { assertSystemUserChangeAllowed, assertSystemUserDeletionAllowed } from "./system-user-policy";
import { writeAuditEvent } from "./audit-log";
import { parseTotpInput } from "./totp";

export type AppRole = "admin" | "user";
export type AppUserStatus = "active" | "suspended";

export type AppActor = {
  email: string;
  role: AppRole;
};

export type ManagedAppUser = AppActor & {
  status: AppUserStatus;
  createdAt: string;
  isCurrent: boolean;
};

export type ManagedUsersPage = {
  users: ManagedAppUser[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
};

type AppUserRow = {
  email: string;
  role: AppRole;
  status: AppUserStatus;
  created_at: string;
};

type UserRuntimeEnv = {
  PRIMARY_ADMIN_EMAIL?: string;
};

const maxSystemUsers = 100;
let primaryAdminInitialization: Promise<void> | null = null;

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function configuredPrimaryAdminEmail() {
  const email = (process.env as UserRuntimeEnv).PRIMARY_ADMIN_EMAIL;
  const normalized = email ? normalizedEmail(email) : "";
  return isValidEmail(normalized) ? normalized : null;
}

function timeLabel(value: string) {
  const timestamp = Date.parse(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(timestamp)) return "已创建";
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚创建";
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  if (elapsedMinutes < 1_440) return `${Math.floor(elapsedMinutes / 60)} 小时前`;
  return `${Math.floor(elapsedMinutes / 1_440)} 天前`;
}

async function findUser(email: string) {
  return getD1().prepare(
    "SELECT email, role, status, created_at FROM app_users WHERE email = ? LIMIT 1",
  ).bind(normalizedEmail(email)).first<AppUserRow>();
}

async function configurePrimaryAdmin() {
  const email = configuredPrimaryAdminEmail();
  if (!email) return;

  const d1 = getD1();
  await d1.prepare(
    `INSERT INTO app_users (email, role, status, created_by)
     VALUES (?, 'admin', 'active', ?)
     ON CONFLICT(email) DO UPDATE SET role = 'admin', status = 'active', updated_at = CURRENT_TIMESTAMP`,
  ).bind(email, email).run();
  await d1.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('initial_admin', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(email).run();
}

function ensureConfiguredPrimaryAdmin() {
  if (primaryAdminInitialization) return primaryAdminInitialization;
  const initialization = configurePrimaryAdmin();
  primaryAdminInitialization = initialization;
  void initialization.catch(() => {
    if (primaryAdminInitialization === initialization) primaryAdminInitialization = null;
  });
  return initialization;
}

export async function ensureApplicationUser(email: string): Promise<AppActor | null> {
  const normalized = normalizedEmail(email);
  // 管理员身份必须来自部署环境的明确配置，不能把首位访问者当作默认管理员。
  if (!configuredPrimaryAdminEmail()) return null;

  await ensureConfiguredPrimaryAdmin();
  const existing = await findUser(normalized);
  return existing?.status === "active" ? { email: existing.email, role: existing.role } : null;
}

export async function isActiveApplicationUser(email: string) {
  const user = await findUser(email);
  return Boolean(user && user.status === "active");
}

export async function getActiveApplicationActor(email: string): Promise<AppActor | null> {
  const user = await findUser(email);
  return user?.status === "active" ? { email: user.email, role: user.role } : null;
}

export async function countActiveApplicationUsers() {
  const result = await getD1().prepare(
    "SELECT COUNT(*) AS count FROM app_users WHERE status = 'active'",
  ).first<{ count: number }>();
  return result?.count ?? 0;
}

function boundedPage(value: number | undefined) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(100_000, Math.floor(value ?? 1)));
}

export async function listManagedUsers(actorEmail: string, options: { page?: number; pageSize?: number; query?: string } = {}): Promise<ManagedUsersPage> {
  const current = normalizedEmail(actorEmail);
  const pageSize = 20;
  const query = typeof options.query === "string" ? options.query.trim().toLowerCase().slice(0, 120) : "";
  const where = query ? "WHERE LOWER(email) LIKE ?" : "";
  const parameters = query ? [`%${query}%`] : [];
  const d1 = getD1();
  const count = await d1.prepare(`SELECT COUNT(*) AS count FROM app_users ${where}`).bind(...parameters).first<{ count: number }>();
  const total = count?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(boundedPage(options.page), pageCount);
  const offset = (page - 1) * pageSize;
  const result = await d1.prepare(
    `SELECT email, role, status, created_at FROM app_users ${where}
     ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at ASC, email ASC LIMIT ? OFFSET ?`,
  ).bind(...parameters, pageSize, offset).all<AppUserRow>();

  return {
    users: result.results.map((user) => ({
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: timeLabel(user.created_at),
      isCurrent: user.email === current,
    })),
    pagination: { page, pageSize, total, pageCount },
  };
}

async function requireAdmin(actorEmail: string) {
  const actor = await findUser(actorEmail);
  if (!actor || actor.status !== "active" || actor.role !== "admin") {
    throw new Error("只有管理员可以管理系统用户。");
  }
  return actor;
}

async function writeSystemAudit(actorEmail: string, action: string, subjectEmail: string) {
  const d1 = getD1();
  const sharedVault = await d1.prepare(
    "SELECT value FROM app_settings WHERE key = 'shared_public_vault' LIMIT 1",
  ).first<{ value: string }>();
  if (!sharedVault?.value) return;

  await writeAuditEvent(sharedVault.value, actorEmail, action, subjectEmail);
}

function inputRole(value: unknown): AppRole {
  if (value === "admin" || value === "user") return value;
  throw new Error("系统角色无效。");
}

function inputStatus(value: unknown): AppUserStatus {
  if (value === "active" || value === "suspended") return value;
  throw new Error("账户状态无效。");
}

function toManagedUser(row: AppUserRow, actorEmail: string): ManagedAppUser {
  return {
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: timeLabel(row.created_at),
    isCurrent: row.email === normalizedEmail(actorEmail),
  };
}

export async function createManagedUser(actorEmail: string, input: Record<string, unknown>) {
  const actor = await requireAdmin(actorEmail);
  const email = typeof input.email === "string" ? normalizedEmail(input.email) : "";
  if (!isValidEmail(email)) throw new Error("请输入有效的用户邮箱。");
  const role = inputRole(input.role);
  const password = typeof input.password === "string" ? input.password : "";
  const passwordHash = await hashLoginPassword(password);
  const authTotpSecret = typeof input.authTotpSecret === "string" ? input.authTotpSecret.trim() : "";
  if (!authTotpSecret) throw new Error("请为该用户生成登录验证器。");
  const authTotp = parseTotpInput(authTotpSecret);
  if (authTotp.digits !== 6) throw new Error("系统登录仅支持 6 位 Google 验证器代码。");
  await assertAuthTotpEncryptionReady();
  const encryptedTotpSecret = await encryptAuthTotpSecret(email, authTotp.secret);
  const d1 = getD1();
  const inserted = await d1.prepare(
    `INSERT INTO app_users (email, role, status, password_hash, auth_totp_secret, created_by)
     SELECT ?, ?, 'active', ?, ?, ?
     WHERE (SELECT COUNT(*) FROM app_users) < ?
       AND NOT EXISTS (SELECT 1 FROM app_users WHERE email = ?)`,
  ).bind(email, role, passwordHash, encryptedTotpSecret, actor.email, maxSystemUsers, email).run();
  if ((inserted.meta.changes ?? 0) !== 1) {
    const existing = await findUser(email);
    throw new Error(existing ? "该用户已存在，可直接调整其角色或状态。" : "系统用户数量已达到安全上限。");
  }

  const created = await findUser(email);
  if (!created) throw new Error("用户创建失败，请重试。");
  await writeSystemAudit(actor.email, "system_user_created", email);
  return toManagedUser(created, actor.email);
}

export async function updateManagedUser(actorEmail: string, input: Record<string, unknown>) {
  const actor = await requireAdmin(actorEmail);
  const email = typeof input.email === "string" ? normalizedEmail(input.email) : "";
  if (!email) throw new Error("缺少用户邮箱。");

  const current = await findUser(email);
  if (!current) throw new Error("未找到该用户。");
  const nextRole = input.role === undefined ? current.role : inputRole(input.role);
  const nextStatus = input.status === undefined ? current.status : inputStatus(input.status);
  const removesActiveAdmin = current.role === "admin" && current.status === "active"
    && (nextRole !== "admin" || nextStatus !== "active");
  const d1 = getD1();
  const activeAdmins = removesActiveAdmin
    ? await d1.prepare(
      "SELECT COUNT(*) AS count FROM app_users WHERE role = 'admin' AND status = 'active'",
    ).first<{ count: number }>()
    : null;
  assertSystemUserChangeAllowed({
    actorEmail: actor.email,
    target: { email: current.email, role: current.role, status: current.status },
    configuredPrimaryAdminEmail: configuredPrimaryAdminEmail(),
    nextRole,
    nextStatus,
    activeAdminCount: activeAdmins?.count ?? Number.MAX_SAFE_INTEGER,
  });
  const updatedResult = removesActiveAdmin
    ? await d1.prepare(
      `UPDATE app_users
       SET role = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE email = ?
         AND (SELECT COUNT(*) FROM app_users WHERE role = 'admin' AND status = 'active') > 1`,
    ).bind(nextRole, nextStatus, current.email).run()
    : await d1.prepare(
      "UPDATE app_users SET role = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
    ).bind(nextRole, nextStatus, current.email).run();
  if ((updatedResult.meta.changes ?? 0) !== 1) {
    throw new Error(removesActiveAdmin ? "系统至少需要保留一位有效管理员。" : "用户更新失败，请重试。");
  }
  if (current.status === "active" && nextStatus === "suspended") {
    await d1.batch([
      d1.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL").bind(new Date().toISOString(), current.email),
      d1.prepare("UPDATE security_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL").bind(new Date().toISOString(), current.email),
    ]);
  }
  if (nextRole !== current.role) await writeSystemAudit(actor.email, "system_user_role_changed", current.email);
  if (nextStatus !== current.status) await writeSystemAudit(actor.email, "system_user_status_changed", current.email);
  const updated = await findUser(current.email);
  if (!updated) throw new Error("用户更新失败，请重试。");
  return toManagedUser(updated, actor.email);
}

export async function deleteManagedUser(actorEmail: string, input: Record<string, unknown>) {
  const actor = await requireAdmin(actorEmail);
  const email = typeof input.email === "string" ? normalizedEmail(input.email) : "";
  if (!email) throw new Error("缺少用户邮箱。");

  const current = await findUser(email);
  if (!current) throw new Error("未找到该用户。");
  const admins = current.role === "admin" && current.status === "active"
    ? await getD1().prepare(
      "SELECT COUNT(*) AS count FROM app_users WHERE role = 'admin' AND status = 'active'",
    ).first<{ count: number }>()
    : null;
  assertSystemUserDeletionAllowed({
    actorEmail: actor.email,
    target: { email: current.email, role: current.role, status: current.status },
    configuredPrimaryAdminEmail: configuredPrimaryAdminEmail(),
    activeAdminCount: admins?.count ?? Number.MAX_SAFE_INTEGER,
  });

  const d1 = getD1();
  const personalVaults = await d1.prepare(
    "SELECT id FROM vaults WHERE owner_email = ? AND kind = 'personal'",
  ).bind(current.email).all<{ id: string }>();
  const statements = personalVaults.results.flatMap((vault) => [
    d1.prepare("DELETE FROM vault_items WHERE vault_id = ?").bind(vault.id),
    d1.prepare("DELETE FROM vault_members WHERE vault_id = ?").bind(vault.id),
    d1.prepare("DELETE FROM approval_requests WHERE vault_id = ?").bind(vault.id),
    d1.prepare("DELETE FROM vaults WHERE id = ?").bind(vault.id),
  ]);
  statements.push(
    d1.prepare("DELETE FROM vault_members WHERE email = ?").bind(current.email),
    d1.prepare("DELETE FROM approval_requests WHERE requested_by = ? OR approver_email = ?").bind(current.email, current.email),
    d1.prepare("DELETE FROM auth_sessions WHERE email = ?").bind(current.email),
    d1.prepare("DELETE FROM security_sessions WHERE email = ?").bind(current.email),
    d1.prepare("DELETE FROM app_users WHERE email = ?").bind(current.email),
  );
  await d1.batch(statements);
  await writeSystemAudit(actor.email, "system_user_deleted", current.email);
}
