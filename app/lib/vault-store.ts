import { getD1 } from "../../db";
import { parseTotpInput, toTotpConfig, type TotpConfig } from "./totp";
import { countActiveApplicationUsers, getActiveApplicationActor } from "./user-store";
import { decryptVaultPayload, encryptVaultPayload } from "./vault-crypto";
import { assertVaultMoveAllowed, boundedText, isVaultSpace, type VaultSpace } from "./vault-policy";
import { reviewCredentialSecurity, type SecurityIssue } from "./security-review";

export type VaultItemType = "登录" | "卡片" | "安全笔记";
export type VaultStrength = "安全" | "一般" | "风险";
export type VaultTotp = { label: string; config: TotpConfig };

export type VaultCredential = {
  id: string;
  name: string;
  domain: string;
  username: string;
  password: string;
  category: string;
  type: VaultItemType;
  group: VaultSpace;
  updated: string;
  strength: VaultStrength;
  twoFactor: boolean;
  favorite: boolean;
  brand: string;
  note: string;
  totps: VaultTotp[];
  canEdit: boolean;
  sharedBy?: string;
};

export type VaultItemSummary = Omit<VaultCredential, "password" | "note" | "totps"> & {
  passwordLength: number;
  hasTotp: boolean;
  securityIssues: SecurityIssue[];
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

type StoredCredential = Omit<VaultCredential, "id" | "group" | "updated" | "canEdit" | "sharedBy" | "category" | "totps"> & {
  // 分类随加密项目一起存储；旧项目解密时没有该字段，也应可继续读取。
  category?: string;
  totps?: VaultTotp[];
  // 兼容已经加密保存的单个验证器配置。
  totp?: TotpConfig;
};
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

function totpEntryLabel(value: unknown, index: number) {
  return boundedText(value, "totpLabel") || (index === 0 ? "登录验证器" : `验证器 ${index + 1}`);
}

function parseTotpEntries(input: Record<string, unknown>): VaultTotp[] {
  if (Array.isArray(input.totpEntries)) {
    if (input.totpEntries.length > 3) throw new Error("每个项目最多保存 3 个验证器。");
    const entries: VaultTotp[] = [];
    const secrets = new Set<string>();

    input.totpEntries.forEach((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("验证器配置无效。请重新输入 Setup Key 或二维码内容。");
      }
      const source = value as Record<string, unknown>;
      const raw = typeof source.value === "string" ? source.value.trim() : typeof source.totpInput === "string" ? source.totpInput.trim() : "";
      if (raw.length > 4_096) throw new Error("验证器配置内容过长。请粘贴 Setup Key 或完整二维码内容。");
      const config = raw ? parseTotpInput(raw) : toTotpConfig(source.config);
      if (!config) return;
      if (secrets.has(config.secret)) throw new Error("同一个验证器密钥只能添加一次。");
      secrets.add(config.secret);
      entries.push({ label: totpEntryLabel(source.label, index), config });
    });
    return entries;
  }

  const legacyInput = typeof input.totpInput === "string" ? input.totpInput.trim() : "";
  if (legacyInput.length > 4_096) throw new Error("验证器配置内容过长。请粘贴 Setup Key 或完整二维码内容。");
  const legacy = input.removeTotp === true ? undefined : legacyInput ? parseTotpInput(legacyInput) : toTotpConfig(input.totp);
  return legacy ? [{ label: "登录验证器", config: legacy }] : [];
}

function storedTotpEntries(payload: StoredCredential): VaultTotp[] {
  const source = Array.isArray(payload.totps)
    ? payload.totps
    : payload.totp ? [{ label: "登录验证器", config: payload.totp }] : [];
  return source.slice(0, 3).map((entry, index) => {
    const config = toTotpConfig(entry?.config);
    if (!config) throw new Error("验证器配置无效。");
    return { label: totpEntryLabel(entry?.label, index), config };
  });
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
  const name = boundedText(input.name, "name", { required: true });
  const domain = normalizeDomain(boundedText(input.domain, "domain", { required: true }));
  const username = boundedText(input.username, "username", { required: true });
  const password = boundedText(input.password, "password", { trim: false, required: true });
  const category = boundedText(input.category, "category");
  const type = isItemType(input.type) ? input.type : "登录";
  const totps = parseTotpEntries(input);

  if (!name || !domain || !username || !password) {
    throw new Error("名称、网址、用户名和密码不能为空。");
  }

  return {
    name,
    domain,
    username,
    password,
    category,
    type,
    strength: strengthFor(password),
    twoFactor: Boolean(input.twoFactor) || totps.length > 0,
    favorite: Boolean(input.favorite),
    brand: boundedText(input.brand, "brand") || "new",
    note: boundedText(input.note, "note"),
    ...(totps.length > 0 ? { totps } : {}),
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

async function ensureSharedPublicVault(seedEmail: string): Promise<AccessibleVault> {
  const d1 = getD1();
  const configured = await d1.prepare(
    "SELECT value FROM app_settings WHERE key = 'shared_public_vault' LIMIT 1",
  ).first<{ value: string }>();
  if (configured?.value) {
    const vault = await d1.prepare(
      "SELECT id, owner_email, kind FROM vaults WHERE id = ? AND kind = 'public' LIMIT 1",
    ).bind(configured.value).first<{ id: string; owner_email: string; kind: VaultKind }>();
    if (vault) return { id: vault.id, ownerEmail: vault.owner_email, kind: vault.kind, role: "owner" };
  }

  const existing = await d1.prepare(
    "SELECT id, owner_email, kind FROM vaults WHERE kind = 'public' ORDER BY created_at ASC LIMIT 1",
  ).first<{ id: string; owner_email: string; kind: VaultKind }>();
  const candidate = existing ?? await ensureOwnedVault(seedEmail, "public");
  await d1.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('shared_public_vault', ?)",
  ).bind(candidate.id).run();

  const selected = await d1.prepare(
    "SELECT value FROM app_settings WHERE key = 'shared_public_vault' LIMIT 1",
  ).first<{ value: string }>();
  const vaultId = selected?.value ?? candidate.id;
  const vault = await d1.prepare(
    "SELECT id, owner_email, kind FROM vaults WHERE id = ? AND kind = 'public' LIMIT 1",
  ).bind(vaultId).first<{ id: string; owner_email: string; kind: VaultKind }>();
  if (!vault) throw new Error("无法初始化公共密码库。");
  return { id: vault.id, ownerEmail: vault.owner_email, kind: vault.kind, role: "owner" };
}

async function accessibleVaults(email: string): Promise<AccessibleVault[]> {
  const actor = await getActiveApplicationActor(email);
  if (!actor) throw new Error("当前系统账户未启用。");

  const personalVault = await ensureOwnedVault(email, "personal");
  await ensureSharedPublicVault(email);
  const publicVaults = await getD1().prepare(
    "SELECT id, owner_email, kind FROM vaults WHERE kind = 'public' ORDER BY created_at ASC",
  ).all<{ id: string; owner_email: string; kind: VaultKind }>();

  return [
    personalVault,
    ...publicVaults.results.map((vault) => ({
      id: vault.id,
      ownerEmail: vault.owner_email,
      kind: vault.kind,
      role: (actor.role === "admin" ? "owner" : "viewer") as VaultRole,
    })),
  ];
}

async function vaultForSpace(email: string, space: VaultSpace) {
  return space === "个人" ? ensureOwnedVault(email, "personal") : ensureSharedPublicVault(email);
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
  const credential = { ...payload };
  delete credential.totp;
  delete credential.totps;
  return {
    id: row.id,
    ...credential,
    category: payload.category ?? "",
    totps: storedTotpEntries(payload),
    group: vault.kind === "personal" ? "个人" : "公共",
    updated: timeLabel(row.updated_at),
    canEdit: canWrite(vault.role),
    ...(vault.kind === "public" && vault.ownerEmail ? { sharedBy: vault.ownerEmail } : {}),
  };
}

function toSummary(credential: VaultCredential, securityIssues: SecurityIssue[] = []): VaultItemSummary {
  return {
    id: credential.id,
    name: credential.name,
    domain: credential.domain,
    username: credential.username,
    category: credential.category,
    type: credential.type,
    group: credential.group,
    updated: credential.updated,
    strength: credential.strength,
    twoFactor: credential.twoFactor,
    favorite: credential.favorite,
    brand: credential.brand,
    canEdit: credential.canEdit,
    ...(credential.sharedBy ? { sharedBy: credential.sharedBy } : {}),
    passwordLength: credential.password.length,
    hasTotp: credential.totps.length > 0,
    securityIssues,
  };
}

export async function listVaultData(email: string) {
  const d1 = getD1();
  const vaultAccess = await accessibleVaults(email);
  const items: Array<{ value: VaultCredential; updatedAt: string }> = [];

  for (const vault of vaultAccess) {
    const result = await d1.prepare(
      "SELECT id, vault_id, ciphertext, iv, created_at, updated_at FROM vault_items WHERE vault_id = ? ORDER BY updated_at DESC",
    ).bind(vault.id).all<VaultItemRow>();

    for (const row of result.results) {
      try {
        const payload = await decryptVaultPayload<StoredCredential>({ ciphertext: row.ciphertext, iv: row.iv });
        items.push({ value: toCredential(row, payload, vault), updatedAt: row.updated_at });
      } catch {
        throw new Error("无法读取已加密的密码库数据。");
      }
    }
  }

  const publicVaults = vaultAccess.filter((vault) => vault.kind === "public");
  const auditResults = await Promise.all(publicVaults.map((vault) => d1.prepare(
    "SELECT action, actor_email, item_id, created_at FROM audit_events WHERE vault_id = ? ORDER BY created_at DESC LIMIT 20",
  ).bind(vault.id).all<{ action: string; actor_email: string; item_id: string | null; created_at: string }>()));
  const audit = auditResults
    .flatMap((result) => result.results)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, 20);

  return {
    items: items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((item) => item.value),
    publicUserCount: await countActiveApplicationUsers(),
    audit: audit.map((event) => ({ action: event.action, actorEmail: event.actor_email, itemId: event.item_id, createdAt: timeLabel(event.created_at) })),
    approvals: await listApprovalRequests(email),
  };
}

export async function listVaultSummaryData(email: string) {
  const data = await listVaultData(email);
  const issuesByItem = reviewCredentialSecurity(data.items);
  return { ...data, items: data.items.map((item) => toSummary(item, issuesByItem.get(item.id) ?? [])) };
}

export async function createVaultItem(email: string, input: Record<string, unknown>) {
  const space = isVaultSpace(input.group) ? input.group : "个人";
  const actor = await getActiveApplicationActor(email);
  if (!actor) throw new Error("当前系统账户未启用。");
  if (space === "公共" && actor.role !== "admin") {
    throw new Error("公共项目仅允许管理员新建。");
  }
  const vault = await vaultForSpace(email, space);
  const payload = storedPayload(input);
  const encrypted = await encryptVaultPayload(payload);
  const id = crypto.randomUUID();
  const d1 = getD1();

  await d1.prepare(
    "INSERT INTO vault_items (id, vault_id, ciphertext, iv) VALUES (?, ?, ?, ?)",
  ).bind(id, vault.id, encrypted.ciphertext, encrypted.iv).run();
  await writeAudit(vault.id, email, "item_created", id);

  return { id, ...payload, category: payload.category ?? "", totps: payload.totps ?? [], group: space, updated: "刚刚更新", canEdit: space === "个人" || actor.role === "admin" } satisfies VaultCredential;
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

  const currentSpace: VaultSpace = vault.kind === "personal" ? "个人" : "公共";
  const nextSpace = isVaultSpace(input.group) ? input.group : currentSpace;
  const actor = await getActiveApplicationActor(email);
  assertVaultMoveAllowed(currentSpace, nextSpace, actor?.role === "admin");

  const destination = nextSpace === currentSpace ? vault : await vaultForSpace(email, nextSpace);
  const payload = storedPayload(input);
  const encrypted = await encryptVaultPayload(payload);
  const d1 = getD1();

  await d1.prepare(
    "UPDATE vault_items SET vault_id = ?, ciphertext = ?, iv = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(destination.id, encrypted.ciphertext, encrypted.iv, item.id).run();
  await writeAudit(destination.id, email, nextSpace !== currentSpace ? "item_published_to_public" : "item_updated", item.id);

  return { id: item.id, ...payload, category: payload.category ?? "", totps: payload.totps ?? [], group: nextSpace, updated: "刚刚更新", canEdit: nextSpace === "个人" || actor?.role === "admin" } satisfies VaultCredential;
}

export async function getVaultItem(email: string, itemId: string) {
  const { item, vault } = await findItemAccess(email, itemId);
  try {
    const payload = await decryptVaultPayload<StoredCredential>({ ciphertext: item.ciphertext, iv: item.iv });
    return toCredential(item, payload, vault);
  } catch {
    throw new Error("无法读取已加密的项目数据。");
  }
}

export async function deleteVaultItem(email: string, itemId: string) {
  const { item, vault } = await findItemAccess(email, itemId);
  if (!canWrite(vault.role)) throw new Error("你只有查看权限，无法删除该项目。");

  const d1 = getD1();
  await d1.prepare("DELETE FROM vault_items WHERE id = ?").bind(item.id).run();
  await writeAudit(vault.id, email, "item_deleted", item.id);
}

export async function listApprovalRequests(email: string): Promise<ApprovalRequest[]> {
  const d1 = getD1();
  const publicVault = await ensureSharedPublicVault(email);
  const approvals: ApprovalRequest[] = [];

  {
    const result = await d1.prepare(
      "SELECT id, requested_by, action, status, approver_email, expires_at FROM approval_requests WHERE vault_id = ? AND status IN ('pending', 'approved') ORDER BY created_at DESC LIMIT 20",
    ).bind(publicVault.id).all<{ id: string; requested_by: string; action: "export_vault"; status: "pending" | "approved"; approver_email: string | null; expires_at: string }>();

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
        canDecide: approval.status === "pending" && approval.requested_by !== email,
        isRequester: approval.requested_by === email,
      });
    }
  }

  return approvals;
}

export async function requestExportApproval(email: string) {
  const vault = await ensureSharedPublicVault(email);
  const d1 = getD1();
  if (await countActiveApplicationUsers() < 2) throw new Error("请先创建并启用另一位系统用户，再发起导出确认。");

  const existing = await d1.prepare(
    "SELECT id FROM approval_requests WHERE vault_id = ? AND requested_by = ? AND status = 'pending' LIMIT 1",
  ).bind(vault.id, email).first<{ id: string }>();
  if (existing) throw new Error("你已有一条等待确认的导出请求。请等待另一位用户处理，或在 10 分钟后重试。");

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
  if (!approval || approval.status !== "pending") throw new Error("该导出确认已不可处理。");
  if (approval.requested_by === email) throw new Error("不能批准自己的导出确认。");
  if (Date.parse(approval.expires_at) <= Date.now()) throw new Error("该导出确认已过期。");

  const publicVault = await ensureSharedPublicVault(email);
  if (publicVault.id !== approval.vault_id) throw new Error("该导出确认不属于当前公共项目。");

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
    throw new Error("该导出请求尚未获得另一位用户的有效批准。");
  }

  const data = await listVaultData(email);
  await writeAudit(approval.vault_id, email, "vault_exported");
  return { exportedAt: new Date().toISOString(), items: data.items };
}

export async function recordVaultAudit(email: string, input: Record<string, unknown>) {
  const action = input.action === "password_revealed" || input.action === "totp_revealed" || input.action === "credential_copied" || input.action === "totp_copied" ? input.action : null;
  const itemId = typeof input.itemId === "string" ? input.itemId : "";
  if (!action || !itemId) return;

  const { vault } = await findItemAccess(email, itemId);
  await writeAudit(vault.id, email, action, itemId);
}
