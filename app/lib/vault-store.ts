import { getD1 } from "../../db";
import { parseTotpInput, toTotpConfig, type TotpConfig } from "./totp";
import { decryptVaultPayload, encryptVaultPayload } from "./vault-crypto";

export type VaultSpace = "个人" | "公共";
export type VaultItemType = "登录" | "卡片" | "安全笔记";
export type VaultStrength = "安全" | "一般" | "风险";

export type VaultCredential = {
  id: string;
  name: string;
  domain: string;
  username: string;
  password: string;
  type: VaultItemType;
  group: VaultSpace;
  updated: string;
  strength: VaultStrength;
  twoFactor: boolean;
  favorite: boolean;
  brand: string;
  note: string;
  totp?: TotpConfig;
  canEdit: boolean;
  sharedBy?: string;
};

export type ApprovalRequest = {
  id: string;
  action: "export_vault";
  requestedBy: string;
  status: "pending" | "approved" | "rejected" | "expired";
  approverEmail: string | null;
  expiresAt: string;
  canDecide: boolean;
  isRequester: boolean;
};

type StoredCredential = Omit<VaultCredential, "id" | "group" | "updated" | "canEdit" | "sharedBy">;
type VaultKind = "personal" | "public";
type VaultRole = "owner" | "editor" | "viewer";

type AccessibleVault = {
  id: string;
  ownerEmail: string;
  kind: VaultKind;
  role: VaultRole;
};

type VaultItemRow = {
  id: string;
  vault_id: string;
  ciphertext: string;
  iv: string;
  created_at: string;
  updated_at: string;
};

function isSpace(value: unknown): value is VaultSpace {
  return value === "个人" || value === "公共";
}

function isItemType(value: unknown): value is VaultItemType {
  return value === "登录" || value === "卡片" || value === "安全笔记";
}

function normalizeDomain(value: string) {
  return value.trim().replace(/^https?:\/\//, "");
}

function strengthFor(password: string): VaultStrength {
  if (password.length >= 14) return "安全";
  if (password.length >= 10) return "一般";
  return "风险";
}

function timeLabel(value: string) {
  const timestamp = Date.parse(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(timestamp)) return "已保存";

  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚更新";
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  if (elapsedMinutes < 1_440) return `${Math.floor(elapsedMinutes / 60)} 小时前`;
  return `${Math.floor(elapsedMinutes / 1_440)} 天前`;
}

function storedPayload(input: Record<string, unknown>): StoredCredential {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const domain = typeof input.domain === "string" ? normalizeDomain(input.domain) : "";
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const type = isItemType(input.type) ? input.type : "登录";
  const totpInput = typeof input.totpInput === "string" ? input.totpInput.trim() : "";
  const totp = input.removeTotp === true
    ? undefined
    : totpInput
      ? parseTotpInput(totpInput)
      : toTotpConfig(input.totp);

  if (!name || !domain || !username || !password) {
    throw new Error("名称、网址、用户名和密码不能为空。");
  }

  return {
    name,
    domain,
    username,
    password,
    type,
    strength: strengthFor(password),
    twoFactor: Boolean(input.twoFactor) || Boolean(totp),
    favorite: Boolean(input.favorite),
    brand: typeof input.brand === "string" && input.brand ? input.brand : "new",
    note: typeof input.note === "string" ? input.note.slice(0, 1_000) : "",
    ...(totp ? { totp } : {}),
  };
}

async function ensureOwnedVault(email: string, kind: VaultKind): Promise<AccessibleVault> {
  const d1 = getD1();
  const existing = await d1.prepare(
    "SELECT id, owner_email, kind FROM vaults WHERE owner_email = ? AND kind = ? LIMIT 1",
  ).bind(email, kind).first<{ id: string; owner_email: string; kind: VaultKind }>();

  if (existing) return { id: existing.id, ownerEmail: existing.owner_email, kind: existing.kind, role: "owner" };

  const id = crypto.randomUUID();
  const name = kind === "personal" ? "个人密码库" : "公共密码库";
  try {
    await d1.prepare(
      "INSERT INTO vaults (id, owner_email, kind, name) VALUES (?, ?, ?, ?)",
    ).bind(id, email, kind, name).run();
  } catch {
    const createdByAnotherRequest = await d1.prepare(
      "SELECT id, owner_email, kind FROM vaults WHERE owner_email = ? AND kind = ? LIMIT 1",
    ).bind(email, kind).first<{ id: string; owner_email: string; kind: VaultKind }>();
    if (createdByAnotherRequest) {
      return { id: createdByAnotherRequest.id, ownerEmail: createdByAnotherRequest.owner_email, kind: createdByAnotherRequest.kind, role: "owner" };
    }
    throw new Error("无法创建密码库。");
  }

  return { id, ownerEmail: email, kind, role: "owner" };
}

async function ensureUserVaults(email: string) {
  await Promise.all([ensureOwnedVault(email, "personal"), ensureOwnedVault(email, "public")]);
}

async function accessibleVaults(email: string): Promise<AccessibleVault[]> {
  await ensureUserVaults(email);
  const d1 = getD1();
  const result = await d1.prepare(
    `SELECT v.id, v.owner_email, v.kind,
      CASE WHEN v.owner_email = ? THEN 'owner' ELSE m.role END AS role
     FROM vaults v
     LEFT JOIN vault_members m ON m.vault_id = v.id AND m.email = ?
     WHERE v.owner_email = ? OR (v.kind = 'public' AND m.email = ?)`,
  ).bind(email, email, email, email).all<{ id: string; owner_email: string; kind: VaultKind; role: VaultRole }>();

  return result.results.map((vault) => ({
    id: vault.id,
    ownerEmail: vault.owner_email,
    kind: vault.kind,
    role: vault.role,
  }));
}

async function ownVaultForSpace(email: string, space: VaultSpace) {
  return ensureOwnedVault(email, space === "个人" ? "personal" : "public");
}

function canWrite(role: VaultRole) {
  return role === "owner" || role === "editor";
}

async function writeAudit(vaultId: string, actorEmail: string, action: string, itemId?: string) {
  const d1 = getD1();
  await d1.prepare(
    "INSERT INTO audit_events (id, vault_id, actor_email, action, item_id) VALUES (?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), vaultId, actorEmail, action, itemId ?? null).run();
}

function toCredential(row: VaultItemRow, payload: StoredCredential, vault: AccessibleVault): VaultCredential {
  return {
    id: row.id,
    ...payload,
    group: vault.kind === "personal" ? "个人" : "公共",
    updated: timeLabel(row.updated_at),
    canEdit: canWrite(vault.role),
    ...(vault.kind === "public" && vault.ownerEmail ? { sharedBy: vault.ownerEmail } : {}),
  };
}

export async function listVaultData(email: string, ownedOnly = false) {
  const d1 = getD1();
  const vaultAccess = (await accessibleVaults(email)).filter((vault) => !ownedOnly || vault.ownerEmail === email);
  const items: VaultCredential[] = [];

  for (const vault of vaultAccess) {
    const result = await d1.prepare(
      "SELECT id, vault_id, ciphertext, iv, created_at, updated_at FROM vault_items WHERE vault_id = ? ORDER BY updated_at DESC",
    ).bind(vault.id).all<VaultItemRow>();

    for (const row of result.results) {
      try {
        const payload = await decryptVaultPayload<StoredCredential>({ ciphertext: row.ciphertext, iv: row.iv });
        items.push(toCredential(row, payload, vault));
      } catch {
        throw new Error("无法读取已加密的密码库数据。");
      }
    }
  }

  const ownedPublicVault = await ownVaultForSpace(email, "公共");
  const members = await d1.prepare(
    "SELECT email, role, created_at FROM vault_members WHERE vault_id = ? ORDER BY created_at ASC",
  ).bind(ownedPublicVault.id).all<{ email: string; role: "editor" | "viewer"; created_at: string }>();

  const audit = await d1.prepare(
    "SELECT action, actor_email, item_id, created_at FROM audit_events WHERE vault_id = ? ORDER BY created_at DESC LIMIT 20",
  ).bind(ownedPublicVault.id).all<{ action: string; actor_email: string; item_id: string | null; created_at: string }>();

  return {
    items,
    members: members.results.map((member) => ({ email: member.email, role: member.role, createdAt: timeLabel(member.created_at) })),
    audit: audit.results.map((event) => ({ action: event.action, actorEmail: event.actor_email, itemId: event.item_id, createdAt: timeLabel(event.created_at) })),
    approvals: await listApprovalRequests(email),
  };
}

export async function createVaultItem(email: string, input: Record<string, unknown>) {
  const space = isSpace(input.group) ? input.group : "个人";
  const vault = await ownVaultForSpace(email, space);
  const payload = storedPayload(input);
  const encrypted = await encryptVaultPayload(payload);
  const id = crypto.randomUUID();
  const d1 = getD1();

  await d1.prepare(
    "INSERT INTO vault_items (id, vault_id, ciphertext, iv) VALUES (?, ?, ?, ?)",
  ).bind(id, vault.id, encrypted.ciphertext, encrypted.iv).run();
  await writeAudit(vault.id, email, "item_created", id);

  return { id, ...payload, group: space, updated: "刚刚更新", canEdit: true } satisfies VaultCredential;
}

async function findItemAccess(email: string, itemId: string) {
  const d1 = getD1();
  const item = await d1.prepare(
    "SELECT id, vault_id, ciphertext, iv, created_at, updated_at FROM vault_items WHERE id = ? LIMIT 1",
  ).bind(itemId).first<VaultItemRow>();
  if (!item) throw new Error("未找到该项目。");

  const vault = (await accessibleVaults(email)).find((candidate) => candidate.id === item.vault_id);
  if (!vault) throw new Error("你没有访问该项目的权限。");

  return { item, vault };
}

export async function updateVaultItem(email: string, itemId: string, input: Record<string, unknown>) {
  const { item, vault } = await findItemAccess(email, itemId);
  if (!canWrite(vault.role)) throw new Error("你只有查看权限，无法编辑该项目。");

  const nextSpace = isSpace(input.group) ? input.group : (vault.kind === "personal" ? "个人" : "公共");
  if (nextSpace !== (vault.kind === "personal" ? "个人" : "公共") && vault.role !== "owner") {
    throw new Error("只有公共空间的所有者可以移动项目。");
  }

  const destination = nextSpace === (vault.kind === "personal" ? "个人" : "公共") ? vault : await ownVaultForSpace(email, nextSpace);
  const payload = storedPayload(input);
  const encrypted = await encryptVaultPayload(payload);
  const d1 = getD1();

  await d1.prepare(
    "UPDATE vault_items SET vault_id = ?, ciphertext = ?, iv = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(destination.id, encrypted.ciphertext, encrypted.iv, item.id).run();
  await writeAudit(destination.id, email, "item_updated", item.id);

  return { id: item.id, ...payload, group: nextSpace, updated: "刚刚更新", canEdit: true } satisfies VaultCredential;
}

export async function deleteVaultItem(email: string, itemId: string) {
  const { item, vault } = await findItemAccess(email, itemId);
  if (!canWrite(vault.role)) throw new Error("你只有查看权限，无法删除该项目。");

  const d1 = getD1();
  await d1.prepare("DELETE FROM vault_items WHERE id = ?").bind(item.id).run();
  await writeAudit(vault.id, email, "item_deleted", item.id);
}

export async function inviteVaultMember(email: string, input: Record<string, unknown>) {
  const invitee = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const role = input.role === "viewer" ? "viewer" : "editor";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitee)) throw new Error("请输入有效的协作人邮箱。");
  if (invitee === email.toLowerCase()) throw new Error("不能邀请自己加入公共空间。");

  const publicVault = await ownVaultForSpace(email, "公共");
  const d1 = getD1();
  await d1.prepare(
    `INSERT INTO vault_members (vault_id, email, role) VALUES (?, ?, ?)
     ON CONFLICT(vault_id, email) DO UPDATE SET role = excluded.role`,
  ).bind(publicVault.id, invitee, role).run();
  await writeAudit(publicVault.id, email, "member_invited");

  return { email: invitee, role };
}

export async function removeVaultMember(email: string, memberEmail: string) {
  const publicVault = await ownVaultForSpace(email, "公共");
  const d1 = getD1();
  await d1.prepare("DELETE FROM vault_members WHERE vault_id = ? AND email = ?").bind(publicVault.id, memberEmail).run();
  await writeAudit(publicVault.id, email, "member_removed");
}

export async function listApprovalRequests(email: string): Promise<ApprovalRequest[]> {
  const d1 = getD1();
  const access = await accessibleVaults(email);
  const approvals: ApprovalRequest[] = [];

  for (const vault of access.filter((vault) => vault.kind === "public")) {
    const result = await d1.prepare(
      "SELECT id, requested_by, action, status, approver_email, expires_at FROM approval_requests WHERE vault_id = ? AND status IN ('pending', 'approved') ORDER BY created_at DESC LIMIT 20",
    ).bind(vault.id).all<{ id: string; requested_by: string; action: "export_vault"; status: "pending" | "approved"; approver_email: string | null; expires_at: string }>();

    for (const approval of result.results) {
      const expired = Date.parse(approval.expires_at) <= Date.now();
      if (expired) {
        await d1.prepare("UPDATE approval_requests SET status = 'expired', resolved_at = CURRENT_TIMESTAMP WHERE id = ?").bind(approval.id).run();
        continue;
      }
      approvals.push({
        id: approval.id,
        action: approval.action,
        requestedBy: approval.requested_by,
        status: approval.status,
        approverEmail: approval.approver_email,
        expiresAt: timeLabel(approval.expires_at),
        canDecide: approval.status === "pending" && approval.requested_by !== email && vault.role !== "owner",
        isRequester: approval.requested_by === email,
      });
    }
  }

  return approvals;
}

export async function requestExportApproval(email: string) {
  const vault = await ownVaultForSpace(email, "公共");
  const d1 = getD1();
  const collaborators = await d1.prepare(
    "SELECT email FROM vault_members WHERE vault_id = ? LIMIT 1",
  ).bind(vault.id).first<{ email: string }>();
  if (!collaborators) throw new Error("请先添加至少一位协作人，再请求导出批准。");

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await d1.prepare(
    "INSERT INTO approval_requests (id, vault_id, requested_by, action, expires_at) VALUES (?, ?, ?, 'export_vault', ?)",
  ).bind(id, vault.id, email, expiresAt).run();
  await writeAudit(vault.id, email, "export_approval_requested");

  return { id, action: "export_vault" as const, requestedBy: email, status: "pending" as const, approverEmail: null, expiresAt: "10 分钟内", canDecide: false, isRequester: true };
}

export async function decideApproval(email: string, id: string, decision: "approved" | "rejected") {
  const d1 = getD1();
  const approval = await d1.prepare(
    "SELECT id, vault_id, requested_by, action, status, expires_at FROM approval_requests WHERE id = ? LIMIT 1",
  ).bind(id).first<{ id: string; vault_id: string; requested_by: string; action: string; status: string; expires_at: string }>();
  if (!approval || approval.status !== "pending") throw new Error("该批准请求已不可处理。");
  if (approval.requested_by === email) throw new Error("不能批准自己的请求。");
  if (Date.parse(approval.expires_at) <= Date.now()) throw new Error("该批准请求已过期。");

  const access = (await accessibleVaults(email)).find((vault) => vault.id === approval.vault_id);
  if (!access || access.role === "owner") throw new Error("只有被邀请的协作人可以处理该请求。");

  await d1.prepare(
    "UPDATE approval_requests SET status = ?, approver_email = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(decision, email, id).run();
  await writeAudit(approval.vault_id, email, decision === "approved" ? "export_approved" : "export_rejected");
}

export async function exportVaultData(email: string, approvalId: string) {
  const d1 = getD1();
  const approval = await d1.prepare(
    "SELECT vault_id, requested_by, status, expires_at FROM approval_requests WHERE id = ? LIMIT 1",
  ).bind(approvalId).first<{ vault_id: string; requested_by: string; status: string; expires_at: string }>();
  if (!approval || approval.requested_by !== email || approval.status !== "approved" || Date.parse(approval.expires_at) <= Date.now()) {
    throw new Error("该导出请求尚未获得有效的协作人批准。");
  }

  const data = await listVaultData(email, true);
  await writeAudit(approval.vault_id, email, "vault_exported");
  return { exportedAt: new Date().toISOString(), items: data.items };
}

export async function recordVaultAudit(email: string, input: Record<string, unknown>) {
  const action = input.action === "password_revealed" || input.action === "credential_copied" || input.action === "totp_copied" ? input.action : null;
  const itemId = typeof input.itemId === "string" ? input.itemId : "";
  if (!action || !itemId) return;

  const { vault } = await findItemAccess(email, itemId);
  await writeAudit(vault.id, email, action, itemId);
}
