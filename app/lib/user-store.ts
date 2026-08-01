import { getDatabase } from "../../db";
import { assertSystemUserChangeAllowed, assertSystemUserDeletionAllowed, assertSystemUserStatusTransitionAllowed } from "./system-user-policy";
import { writeAuditedMutation } from "./audit-log";
import { sharedAuditVaultId } from "./embedded-audit";
import { accountDisplayName, isValidLoginAccount, normalizeLoginAccount } from "./identity";
import { initialAdminAccount } from "./initial-admin";
import { isAuthSessionOnline } from "./user-presence";
import { issueAccountToken } from "./one-time-tokens";
import { securityEmailConfigured, securityEmailReady, sendAccountActivation, sendAuthenticatorResetCode } from "./security-email";
import { normalizeProfileDisplayName, profileAvatarStyle, profileDisplayName, type AccountProfile } from "./profile";
import { ClientSafeError } from "./security-errors";

export type AppRole = "admin" | "user";
export type AppUserStatus = "pending" | "active" | "suspended" | "frozen";

export type AppActor = {
  email: string;
  role: AppRole;
};

export type ManagedAppUser = AppActor & {
  status: AppUserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  isOnline: boolean;
  isCurrent: boolean;
};

export type ManagedUsersPage = {
  users: ManagedAppUser[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
};

export type ManagedAuthenticatorReset = {
  user: ManagedAppUser;
  delivery: "email";
  expiresAt: string;
};

type AppUserRow = {
  email: string;
  role: AppRole;
  status: AppUserStatus;
  must_change_password: number;
  security_email: string | null;
  security_email_verified_at: string | null;
  display_name: string | null;
  avatar_style: string | null;
  created_at: string;
  last_login_at: string | null;
};

const maxSystemUsers = 100;
let primaryAdminInitialization: Promise<void> | null = null;

function normalizedEmail(value: string) {
  return normalizeLoginAccount(value);
}

function isValidEmail(value: string) {
  return isValidLoginAccount(value);
}

function configuredPrimaryAdminEmail() {
  return initialAdminAccount();
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
  return getDatabase().prepare(
    "SELECT email, role, status, must_change_password, security_email, security_email_verified_at, display_name, avatar_style, created_at, last_login_at FROM app_users WHERE email = ? LIMIT 1",
  ).bind(normalizedEmail(email)).first<AppUserRow>();
}

function accountProfile(row: Pick<AppUserRow, "email" | "display_name" | "avatar_style">): AccountProfile {
  return {
    displayName: profileDisplayName(row.display_name, accountDisplayName(row.email)),
    avatarStyle: profileAvatarStyle(row.avatar_style),
  };
}

async function configurePrimaryAdmin() {
  const email = configuredPrimaryAdminEmail();
  if (!email) return;

  const database = getDatabase();
  await database.prepare(
    `INSERT INTO app_users (email, role, status, created_by)
     VALUES (?, 'admin', 'active', ?)
     ON CONFLICT(email) DO UPDATE SET role = 'admin', status = 'active', updated_at = CURRENT_TIMESTAMP`,
  ).bind(email, email).run();
  await database.prepare(
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
  return existing?.status === "active" && Boolean(existing.security_email_verified_at)
    ? { email: existing.email, role: existing.role }
    : null;
}

export async function isActiveApplicationUser(email: string) {
  const user = await findUser(email);
  return Boolean(user && user.status === "active");
}

export async function hasVerifiedSecurityEmail(email: string) {
  const user = await findUser(email);
  return Boolean(user && user.status === "active" && user.security_email && user.security_email_verified_at);
}

export async function getActiveApplicationActor(email: string): Promise<AppActor | null> {
  const user = await findUser(email);
  return user?.status === "active" ? { email: user.email, role: user.role } : null;
}

export async function getApplicationProfile(email: string): Promise<AccountProfile | null> {
  const user = await findUser(email);
  return user?.status === "active" ? accountProfile(user) : null;
}

export async function updateApplicationProfile(email: string, input: { displayName: unknown; avatarStyle: unknown }): Promise<AccountProfile | null> {
  const account = normalizedEmail(email);
  const displayName = normalizeProfileDisplayName(input.displayName);
  if (!displayName) throw new ClientSafeError("昵称需为 1–32 个字符，且不能包含控制字符。");
  const avatarStyle = profileAvatarStyle(input.avatarStyle);
  const current = await findUser(account);
  if (!current || current.status !== "active") return null;

  const database = getDatabase();
  await writeAuditedMutation(await sharedAuditVaultId(account), account, "profile_updated", account, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active'", values: [account] },
    commitPrerequisite: {
      sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'active' AND display_name = ? AND avatar_style = ?",
      values: [account, displayName, avatarStyle],
    },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `UPDATE app_users SET display_name = ?, avatar_style = ?, updated_at = CURRENT_TIMESTAMP
       WHERE email = ? AND status = 'active' AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(displayName, avatarStyle, account, ...guard.values, guard.auditEventId)],
  });

  return { displayName, avatarStyle };
}

/** A provisioned user cannot read vault data until they replace the one-time password. */
export async function isPasswordChangeRequired(email: string) {
  const user = await findUser(email);
  return Boolean(user && user.status === "active" && user.must_change_password === 1);
}

export async function countActiveApplicationUsers() {
  const result = await getDatabase().prepare(
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
  const pageSize = Math.max(1, Math.min(100, Math.floor(options.pageSize ?? 20)));
  const query = typeof options.query === "string" ? options.query.trim().toLowerCase().slice(0, 120) : "";
  const where = query ? "WHERE LOWER(email) LIKE ?" : "";
  const parameters = query ? [`%${query}%`] : [];
  const database = getDatabase();
  const count = await database.prepare(`SELECT COUNT(*) AS count FROM app_users ${where}`).bind(...parameters).first<{ count: number }>();
  const total = count?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(boundedPage(options.page), pageCount);
  const offset = (page - 1) * pageSize;
  const result = await database.prepare(
    `SELECT email, role, status, must_change_password, security_email, security_email_verified_at, created_at, last_login_at FROM app_users ${where}
     ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at ASC, email ASC LIMIT ? OFFSET ?`,
  ).bind(...parameters, pageSize, offset).all<AppUserRow>();
  const onlineSessions = await database.prepare(
    "SELECT email, expires_at, last_active_at, revoked_at FROM auth_sessions WHERE revoked_at IS NULL",
  ).all<{ email: string; expires_at: string; last_active_at: string; revoked_at: string | null }>();
  const onlineEmails = new Set(onlineSessions.results.filter((session) => isAuthSessionOnline({
    expiresAt: session.expires_at,
    lastActiveAt: session.last_active_at,
    revokedAt: session.revoked_at,
  })).map((session) => session.email));

  return {
    users: result.results.map((user) => ({
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: timeLabel(user.created_at),
      lastLoginAt: user.last_login_at,
      isOnline: user.status === "active" && onlineEmails.has(user.email),
      isCurrent: user.email === current,
    })),
    pagination: { page, pageSize, total, pageCount },
  };
}

async function requireAdmin(actorEmail: string) {
  const actor = await findUser(actorEmail);
  if (!actor || actor.status !== "active" || actor.role !== "admin") {
    throw new ClientSafeError("只有管理员可以管理系统用户。", 403, "ADMIN_REQUIRED");
  }
  return actor;
}

function inputRole(value: unknown): AppRole {
  if (value === "admin" || value === "user") return value;
  throw new ClientSafeError("系统角色无效。");
}

function inputStatus(value: unknown): AppUserStatus {
  if (value === "pending" || value === "active" || value === "suspended" || value === "frozen") return value;
  throw new ClientSafeError("账户状态无效。");
}

function toManagedUser(row: AppUserRow, actorEmail: string): ManagedAppUser {
  return {
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: timeLabel(row.created_at),
    lastLoginAt: row.last_login_at,
    isOnline: false,
    isCurrent: row.email === normalizedEmail(actorEmail),
  };
}

async function activationDeliveryMode(allowManualActivation: boolean) {
  if (!securityEmailConfigured()) {
    if (!allowManualActivation) throw new ClientSafeError("创建用户前请先配置安全邮箱通知服务。", 503, "SECURITY_EMAIL_UNAVAILABLE");
    return "manual" as const;
  }
  if (!await securityEmailReady()) throw new ClientSafeError("安全邮箱服务不可用，请检查配置后重试。", 503, "SECURITY_EMAIL_UNAVAILABLE");
  return "email" as const;
}

export async function createManagedUser(actorEmail: string, input: Record<string, unknown>) {
  const actor = await requireAdmin(actorEmail);
  const email = typeof input.email === "string" ? normalizedEmail(input.email) : "";
  if (!isValidEmail(email)) throw new ClientSafeError("请输入有效的登录账号（邮箱或英文数字组合）。");
  const role = inputRole(input.role);
  const securityEmail = typeof input.securityEmail === "string" ? input.securityEmail.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(securityEmail)) throw new ClientSafeError("请填写接收安全确认码的邮箱。");
  const allowManualActivation = process.env.NODE_ENV !== "production" || process.env.DJMIMA_ALLOW_MANUAL_ACTIVATION_CODES === "1";
  const delivery = await activationDeliveryMode(allowManualActivation);
  const database = getDatabase();
  try {
    await writeAuditedMutation(await sharedAuditVaultId(actor.email), actor.email, "system_user_created", email, {
      auditOrder: "before",
      auditPrerequisite: { sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE email = ?)", values: [email] },
      commitPrerequisite: {
        sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'pending' AND security_email = ? AND security_email_verified_at IS NULL",
        values: [email, securityEmail],
      },
      expectedChanges: 1,
      statements: (guard) => [database.prepare(
        `INSERT INTO app_users (email, role, status, security_email, security_email_verified_at, must_change_password, created_by)
         SELECT ?, ?, 'pending', ?, NULL, 0, ?
         WHERE (SELECT COUNT(*) FROM app_users) < ?
           AND NOT EXISTS (SELECT 1 FROM app_users WHERE email = ?)
           AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(email, role, securityEmail, actor.email, maxSystemUsers, email, ...guard.values, guard.auditEventId)],
    });
  } catch (error) {
    const existing = await findUser(email);
    if (existing) throw new ClientSafeError("该用户已存在，可直接调整其角色或状态。", 409, "USER_EXISTS");
    throw error;
  }

  const created = await findUser(email);
  if (!created) throw new Error("用户创建失败，请重试。");
  const activation = await issueAccountToken({
    email,
    purpose: "activation",
    createdBy: actor.email,
    lifetimeMs: 24 * 60 * 60_000,
  });
  if (delivery === "email") {
    try {
      await sendAccountActivation({ to: securityEmail, code: activation.code, expiresAt: activation.expiresAt });
    } catch {
      throw new ClientSafeError("用户已创建，但激活邮件发送失败。请检查邮件服务后在用户列表中重新发送激活码。", 503, "ACTIVATION_DELIVERY_FAILED");
    }
    return { user: toManagedUser(created, actor.email), activation: { delivery: "email" as const, expiresAt: activation.expiresAt } };
  }
  // This is for local preview or an explicit, controlled break-glass deployment
  // setting only; production otherwise requires the configured mail transport.
  return { user: toManagedUser(created, actor.email), activation: { delivery: "manual" as const, code: activation.code, expiresAt: activation.expiresAt } };
}

/** Replaces an expired or undelivered activation code without activating the account. */
export async function resendManagedUserActivation(actorEmail: string, input: Record<string, unknown>) {
  const actor = await requireAdmin(actorEmail);
  const email = typeof input.email === "string" ? normalizedEmail(input.email) : "";
  if (!email) throw new ClientSafeError("缺少用户账号。");
  const current = await findUser(email);
  if (!current || current.status !== "pending") throw new ClientSafeError("只有待激活用户可以重新发送激活码。", 409, "USER_NOT_PENDING");
  const target = current.security_email?.trim().toLowerCase() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) throw new ClientSafeError("该用户未配置有效的安全邮箱。", 409, "USER_SECURITY_EMAIL_INVALID");
  const allowManualActivation = process.env.NODE_ENV !== "production" || process.env.DJMIMA_ALLOW_MANUAL_ACTIVATION_CODES === "1";
  const delivery = await activationDeliveryMode(allowManualActivation);
  const database = getDatabase();
  await writeAuditedMutation(await sharedAuditVaultId(actor.email), actor.email, "system_user_activation_resent", current.email, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'pending'", values: [current.email] },
    commitPrerequisite: { sql: "SELECT 1 FROM app_users WHERE email = ? AND status = 'pending'", values: [current.email] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `UPDATE app_users SET updated_at = CURRENT_TIMESTAMP
       WHERE email = ? AND status = 'pending' AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(current.email, ...guard.values, guard.auditEventId)],
  });
  const activation = await issueAccountToken({
    email: current.email,
    purpose: "activation",
    createdBy: actor.email,
    lifetimeMs: 24 * 60 * 60_000,
  });
  if (delivery === "email") {
    try {
      await sendAccountActivation({ to: target, code: activation.code, expiresAt: activation.expiresAt });
    } catch {
      throw new ClientSafeError("激活码已重新生成，但邮件发送失败。请检查邮件服务后再次重新发送。", 503, "ACTIVATION_DELIVERY_FAILED");
    }
    return { user: toManagedUser(current, actor.email), activation: { delivery: "email" as const, expiresAt: activation.expiresAt } };
  }
  return { user: toManagedUser(current, actor.email), activation: { delivery: "manual" as const, code: activation.code, expiresAt: activation.expiresAt } };
}

export async function updateManagedUser(actorEmail: string, input: Record<string, unknown>) {
  const actor = await requireAdmin(actorEmail);
  const email = typeof input.email === "string" ? normalizedEmail(input.email) : "";
  if (!email) throw new ClientSafeError("缺少用户邮箱。");

  const current = await findUser(email);
  if (!current) throw new ClientSafeError("未找到该用户。", 404, "USER_NOT_FOUND");
  const nextRole = input.role === undefined ? current.role : inputRole(input.role);
  const nextStatus = input.status === undefined ? current.status : inputStatus(input.status);
  assertSystemUserStatusTransitionAllowed(current.status, nextStatus);
  const removesActiveAdmin = current.role === "admin" && current.status === "active"
    && (nextRole !== "admin" || nextStatus !== "active");
  const database = getDatabase();
  const activeAdmins = removesActiveAdmin
    ? await database.prepare(
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
  if (nextRole === current.role && nextStatus === current.status) return toManagedUser(current, actor.email);
  const action = nextStatus !== current.status ? "system_user_status_changed" : "system_user_role_changed";
  const now = new Date().toISOString();
  try {
    await writeAuditedMutation(await sharedAuditVaultId(actor.email), actor.email, action, current.email, {
      auditOrder: "before",
      auditPrerequisite: {
        sql: "SELECT 1 FROM app_users WHERE email = ? AND role = ? AND status = ?",
        values: [current.email, current.role, current.status],
      },
      commitPrerequisite: {
        sql: "SELECT 1 FROM app_users WHERE email = ? AND role = ? AND status = ?",
        values: [current.email, nextRole, nextStatus],
      },
      expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1,
      statements: (guard) => [
        database.prepare(
          `UPDATE app_users
           SET role = ?, status = ?, updated_at = CURRENT_TIMESTAMP
           WHERE email = ? AND role = ? AND status = ?
             AND (? = 0 OR (SELECT COUNT(*) FROM app_users WHERE role = 'admin' AND status = 'active') > 1)
             AND ${guard.conditionSql}
             AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
        ).bind(nextRole, nextStatus, current.email, current.role, current.status, removesActiveAdmin ? 1 : 0, ...guard.values, guard.auditEventId),
        database.prepare(
          `UPDATE auth_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
           AND ? = 1 AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND role = ? AND status = ?)
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
        ).bind(now, current.email, current.status === "active" && nextStatus !== "active" ? 1 : 0, ...guard.values, current.email, nextRole, nextStatus, guard.auditEventId),
        database.prepare(
          `UPDATE security_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
           AND ? = 1 AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND role = ? AND status = ?)
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
        ).bind(now, current.email, current.status === "active" && nextStatus !== "active" ? 1 : 0, ...guard.values, current.email, nextRole, nextStatus, guard.auditEventId),
      ],
    });
  } catch (error) {
    if (removesActiveAdmin) throw new ClientSafeError("系统至少需要保留一位有效管理员。", 409, "ACTIVE_ADMIN_REQUIRED");
    throw error;
  }
  const updated = await findUser(current.email);
  if (!updated) throw new Error("用户更新失败，请重试。");
  return toManagedUser(updated, actor.email);
}

export async function resetManagedUserAuthenticator(actorEmail: string, input: Record<string, unknown>): Promise<ManagedAuthenticatorReset> {
  const actor = await requireAdmin(actorEmail);
  const email = typeof input.email === "string" ? normalizedEmail(input.email) : "";
  if (!email) throw new ClientSafeError("缺少用户邮箱。");
  if (email === actor.email) throw new ClientSafeError("不能在当前会话中重置自己的登录验证器。", 409, "SELF_AUTHENTICATOR_RESET_FORBIDDEN");
  if (email === configuredPrimaryAdminEmail()) throw new ClientSafeError("初始管理员验证器由部署配置保护，请按运维恢复流程处理。", 409, "INITIAL_ADMIN_AUTHENTICATOR_PROTECTED");

  const current = await findUser(email);
  if (!current) throw new ClientSafeError("未找到该用户。", 404, "USER_NOT_FOUND");
  if (current.status !== "active") throw new ClientSafeError("请先启用该用户后再重置登录验证器。", 409, "USER_NOT_ACTIVE");
  const securityEmail = current.security_email?.trim().toLowerCase() ?? "";
  if (!current.security_email_verified_at || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(securityEmail)) {
    throw new ClientSafeError("该用户尚未验证安全邮箱，不能重置登录验证器。", 409, "USER_SECURITY_EMAIL_UNVERIFIED");
  }
  if (!securityEmailConfigured() || !await securityEmailReady()) throw new ClientSafeError("安全邮箱服务不可用，暂不能重置登录验证器。", 503, "SECURITY_EMAIL_UNAVAILABLE");
  const now = new Date().toISOString();
  const database = getDatabase();

  // Deliver the opaque recovery factor before invalidating the only working
  // authenticator. If delivery fails, the account remains exactly as it was.
  const reset = await issueAccountToken({ email: current.email, purpose: "authenticator_reset", createdBy: actor.email, lifetimeMs: 15 * 60_000 });
  try {
    await sendAuthenticatorResetCode({ to: securityEmail, code: reset.code, expiresAt: reset.expiresAt });
  } catch {
    throw new ClientSafeError("验证器恢复邮件发送失败；请检查邮件服务后重新发起重置。", 503, "AUTHENTICATOR_RESET_DELIVERY_FAILED");
  }

  await writeAuditedMutation(await sharedAuditVaultId(actor.email), actor.email, "system_user_authenticator_reset", current.email, {
    auditOrder: "before",
    auditPrerequisite: {
      sql: "SELECT 1 FROM app_users WHERE email = ? AND role = ? AND status = ?",
      values: [current.email, current.role, current.status],
    },
    commitPrerequisite: {
      sql: "SELECT 1 FROM app_users WHERE email = ? AND auth_totp_secret IS NULL",
      values: [current.email],
    },
    expectedChanges: (results) => (results[0]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      database.prepare(
        `UPDATE app_users
         SET auth_totp_secret = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE email = ? AND role = ? AND status = ?
           AND ${guard.conditionSql}
           AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(current.email, current.role, current.status, ...guard.values, guard.auditEventId),
      database.prepare(
        `UPDATE auth_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND auth_totp_secret IS NULL)
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, current.email, ...guard.values, current.email, guard.auditEventId),
      database.prepare(
        `UPDATE security_sessions SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL
         AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM app_users WHERE email = ? AND auth_totp_secret IS NULL)
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, current.email, ...guard.values, current.email, guard.auditEventId),
      database.prepare(
        `UPDATE account_tokens SET revoked_at = ?
         WHERE email = ? AND purpose = 'authenticator_reset_confirm' AND used_at IS NULL AND revoked_at IS NULL
           AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, current.email, ...guard.values, guard.auditEventId),
      database.prepare(
        `UPDATE authenticator_reset_stages SET used_at = ?
         WHERE email = ? AND used_at IS NULL
           AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(now, current.email, ...guard.values, guard.auditEventId),
    ],
  });
  const updated = await findUser(current.email);
  if (!updated) throw new Error("用户验证器重置失败，请重试。");
  return { user: toManagedUser(updated, actor.email), delivery: "email", expiresAt: reset.expiresAt };
}

export async function deleteManagedUser(actorEmail: string, input: Record<string, unknown>) {
  const actor = await requireAdmin(actorEmail);
  const email = typeof input.email === "string" ? normalizedEmail(input.email) : "";
  if (!email) throw new ClientSafeError("缺少用户邮箱。");

  const current = await findUser(email);
  if (!current) throw new ClientSafeError("未找到该用户。", 404, "USER_NOT_FOUND");
  const admins = current.role === "admin" && current.status === "active"
    ? await getDatabase().prepare(
      "SELECT COUNT(*) AS count FROM app_users WHERE role = 'admin' AND status = 'active'",
    ).first<{ count: number }>()
    : null;
  assertSystemUserDeletionAllowed({
    actorEmail: actor.email,
    target: { email: current.email, role: current.role, status: current.status },
    configuredPrimaryAdminEmail: configuredPrimaryAdminEmail(),
    activeAdminCount: admins?.count ?? Number.MAX_SAFE_INTEGER,
  });

  const database = getDatabase();
  const removingActiveAdmin = current.role === "admin" && current.status === "active";
  const targetStillCurrent = `EXISTS (
    SELECT 1 FROM app_users WHERE email = ? AND role = ? AND status = ?
      AND (? = 0 OR (SELECT COUNT(*) FROM app_users WHERE role = 'admin' AND status = 'active') > 1)
  )`;
  const targetValues = [current.email, current.role, current.status, removingActiveAdmin ? 1 : 0];
  await writeAuditedMutation(await sharedAuditVaultId(actor.email), actor.email, "system_user_deleted", current.email, {
    auditOrder: "before",
    auditPrerequisite: { sql: `SELECT 1 WHERE ${targetStillCurrent}`, values: targetValues },
    commitPrerequisite: { sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE email = ?)", values: [current.email] },
    expectedChanges: (results) => (results[results.length - 1]?.meta.changes ?? 0) === 1,
    statements: (guard) => [
      database.prepare(`DELETE FROM vault_items
        WHERE vault_id IN (SELECT id FROM vaults WHERE owner_email = ? AND kind = 'personal')
          AND ${targetStillCurrent} AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`)
        .bind(current.email, ...targetValues, ...guard.values, guard.auditEventId),
      database.prepare(`DELETE FROM vault_members
        WHERE vault_id IN (SELECT id FROM vaults WHERE owner_email = ? AND kind = 'personal')
          AND ${targetStillCurrent} AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`)
        .bind(current.email, ...targetValues, ...guard.values, guard.auditEventId),
      database.prepare(`DELETE FROM vaults
        WHERE owner_email = ? AND kind = 'personal'
          AND ${targetStillCurrent} AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`)
        .bind(current.email, ...targetValues, ...guard.values, guard.auditEventId),
      database.prepare(`DELETE FROM vault_members WHERE email = ? AND ${targetStillCurrent} AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`).bind(current.email, ...targetValues, ...guard.values, guard.auditEventId),
      database.prepare(`DELETE FROM account_tokens WHERE email = ? AND ${targetStillCurrent} AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`).bind(current.email, ...targetValues, ...guard.values, guard.auditEventId),
      database.prepare(`DELETE FROM login_challenges WHERE email = ? AND ${targetStillCurrent} AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`).bind(current.email, ...targetValues, ...guard.values, guard.auditEventId),
      database.prepare(`DELETE FROM login_events WHERE email = ? AND ${targetStillCurrent} AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`).bind(current.email, ...targetValues, ...guard.values, guard.auditEventId),
      database.prepare(`DELETE FROM auth_sessions WHERE email = ? AND ${targetStillCurrent} AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`).bind(current.email, ...targetValues, ...guard.values, guard.auditEventId),
      database.prepare(`DELETE FROM security_sessions WHERE email = ? AND ${targetStillCurrent} AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`).bind(current.email, ...targetValues, ...guard.values, guard.auditEventId),
      database.prepare(
        `DELETE FROM app_users WHERE email = ? AND role = ? AND status = ?
         AND (? = 0 OR (SELECT COUNT(*) FROM app_users WHERE role = 'admin' AND status = 'active') > 1)
         AND ${guard.conditionSql} AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(current.email, current.role, current.status, removingActiveAdmin ? 1 : 0, ...guard.values, guard.auditEventId),
    ],
  });
}
