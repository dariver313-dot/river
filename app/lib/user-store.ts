import { getD1 } from "../../db";

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

type AppUserRow = {
  email: string;
  role: AppRole;
  status: AppUserStatus;
  created_at: string;
};

function normalizedEmail(value: string) {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

export async function ensureApplicationUser(email: string): Promise<AppActor | null> {
  const normalized = normalizedEmail(email);
  const existing = await findUser(normalized);
  if (existing) {
    return existing.status === "active" ? { email: existing.email, role: existing.role } : null;
  }

  const d1 = getD1();
  await d1.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('initial_admin', ?)",
  ).bind(normalized).run();
  const bootstrap = await d1.prepare(
    "SELECT value FROM app_settings WHERE key = 'initial_admin' LIMIT 1",
  ).first<{ value: string }>();

  if (bootstrap?.value !== normalized) return null;

  await d1.prepare(
    "INSERT OR IGNORE INTO app_users (email, role, status, created_by) VALUES (?, 'admin', 'active', ?)",
  ).bind(normalized, normalized).run();
  return { email: normalized, role: "admin" };
}

export async function isActiveApplicationUser(email: string) {
  const user = await findUser(email);
  return Boolean(user && user.status === "active");
}

export async function listManagedUsers(actorEmail: string): Promise<ManagedAppUser[]> {
  const current = normalizedEmail(actorEmail);
  const result = await getD1().prepare(
    "SELECT email, role, status, created_at FROM app_users ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at ASC",
  ).all<AppUserRow>();

  return result.results.map((user) => ({
    email: user.email,
    role: user.role,
    status: user.status,
    createdAt: timeLabel(user.created_at),
    isCurrent: user.email === current,
  }));
}

async function requireAdmin(actorEmail: string) {
  const actor = await findUser(actorEmail);
  if (!actor || actor.status !== "active" || actor.role !== "admin") {
    throw new Error("只有管理员可以管理系统用户。");
  }
  return actor;
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
  if (await findUser(email)) throw new Error("该用户已存在，可直接调整其角色或状态。");

  const role = inputRole(input.role);
  const d1 = getD1();
  await d1.prepare(
    "INSERT INTO app_users (email, role, status, created_by) VALUES (?, ?, 'active', ?)",
  ).bind(email, role, actor.email).run();

  const created = await findUser(email);
  if (!created) throw new Error("用户创建失败，请重试。");
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
  const isCurrentActor = current.email === actor.email;

  if (isCurrentActor && (nextRole !== "admin" || nextStatus !== "active")) {
    throw new Error("不能降低或停用自己的管理员账户。");
  }

  const removesActiveAdmin = current.role === "admin" && current.status === "active"
    && (nextRole !== "admin" || nextStatus !== "active");
  if (removesActiveAdmin) {
    const admins = await getD1().prepare(
      "SELECT COUNT(*) AS count FROM app_users WHERE role = 'admin' AND status = 'active'",
    ).first<{ count: number }>();
    if ((admins?.count ?? 0) <= 1) throw new Error("系统至少需要保留一位有效管理员。");
  }

  const d1 = getD1();
  await d1.prepare(
    "UPDATE app_users SET role = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
  ).bind(nextRole, nextStatus, current.email).run();
  const updated = await findUser(current.email);
  if (!updated) throw new Error("用户更新失败，请重试。");
  return toManagedUser(updated, actor.email);
}
