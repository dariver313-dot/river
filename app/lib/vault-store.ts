import { getD1 } from "../../db";
import { parseTotpInput, toTotpConfig, type TotpConfig } from "./totp";
import { countActiveApplicationUsers, getActiveApplicationActor } from "./user-store";
import { activeVaultEncryptionKeyId, assertVaultEncryptionReady, decryptVaultPayload, encryptVaultPayload } from "./vault-crypto";
import { assertVaultMoveAllowed, boundedText, isVaultSpace, vaultItemLimit, type VaultSpace } from "./vault-policy";
import { reviewCredentialSecurity, type SecurityIssue } from "./security-review";
import { canonicalPublicVaultId, resolveSharedPublicVault } from "./shared-public-vault";
import { auditIntegrity, verifyAuditChain, writeAuditEvent } from "./audit-log";

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

export type VaultListOptions = {
  page?: number;
  pageSize?: number;
  query?: string;
  space?: VaultSpace | "全部";
  category?: string;
  collection?: "all" | "security";
  securityFocus?: "all" | SecurityIssue;
  sortOrder?: "updated" | "name";
};

export type ManagementAuditCategory = "all" | "project" | "user" | "export";

export type ManagementAuditPage = {
  audit: Array<{ action: string; actorEmail: string; itemId: string | null; createdAt: string; integrity: "legacy" | "sealed" | "failed" }>;
  chainIntegrity: "legacy" | "sealed" | "failed";
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
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
  key_id: string | null;
  encryption_version: number | null;
  created_at: string;
  updated_at: string;
};

type AuditEventRow = {
  id: string;
  vault_id: string;
  action: string;
  actor_email: string;
  item_id: string | null;
  created_at: string;
  signature: string | null;
  signature_key_id: string | null;
  event_version: number;
  sequence: number | null;
  previous_hash: string | null;
  chain_hash: string | null;
};

const managementAuditActions = {
  all: [
    "item_created", "item_updated", "item_published_to_public", "item_deleted",
    "system_user_created", "system_user_role_changed", "system_user_status_changed", "system_user_deleted",
    "export_approval_requested", "export_approved", "export_rejected", "vault_exported",
  ],
  project: ["item_created", "item_updated", "item_published_to_public", "item_deleted"],
  user: ["system_user_created", "system_user_role_changed", "system_user_status_changed", "system_user_deleted"],
  export: ["export_approval_requested", "export_approved", "export_rejected", "vault_exported"],
} as const satisfies Record<ManagementAuditCategory, readonly string[]>;

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

async function findSharedPublicVault(): Promise<AccessibleVault | null> {
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
  const selected = resolveSharedPublicVault(configured?.value, existing ? [existing] : []);
  if (!selected) return null;

  // 站点迁移或人工清理可能留下指向已删除密码库的旧设置。只要存在有效的
  // 公共密码库，就以最早创建的项目恢复唯一映射，避免公共项目整体不可见。
  await d1.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('shared_public_vault', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(selected.id).run();
  return { id: selected.id, ownerEmail: selected.owner_email, kind: selected.kind, role: "owner" };
}

async function ensureSharedPublicVault(adminEmail: string): Promise<AccessibleVault> {
  const actor = await getActiveApplicationActor(adminEmail);
  if (!actor || actor.role !== "admin") throw new Error("公共密码库只能由管理员初始化。");

  const existing = await findSharedPublicVault();
  if (existing) return existing;

  const d1 = getD1();
  await d1.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_email, kind, name) VALUES (?, ?, 'public', '公共密码库')",
  ).bind(canonicalPublicVaultId, adminEmail).run();
  await d1.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('shared_public_vault', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(canonicalPublicVaultId).run();

  const shared = await findSharedPublicVault();
  if (!shared) throw new Error("无法初始化公共密码库。");
  return shared;
}

async function accessibleVaults(email: string): Promise<AccessibleVault[]> {
  const actor = await getActiveApplicationActor(email);
  if (!actor) throw new Error("当前系统账户未启用。");

  const personalVault = await ensureOwnedVault(email, "personal");
  const publicVault = await findSharedPublicVault();

  return [
    personalVault,
    ...(publicVault ? [{
      id: publicVault.id,
      ownerEmail: publicVault.ownerEmail,
      kind: publicVault.kind,
      role: (actor.role === "admin" ? "owner" : "viewer") as VaultRole,
    }] : []),
  ];
}

async function vaultForSpace(email: string, space: VaultSpace) {
  return space === "个人" ? ensureOwnedVault(email, "personal") : ensureSharedPublicVault(email);
}

function canWrite(role: VaultRole) {
  return role === "owner" || role === "editor";
}

async function writeAudit(vaultId: string, actorEmail: string, action: string, itemId?: string) {
  await writeAuditEvent(vaultId, actorEmail, action, itemId ?? null);
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
  const actor = await getActiveApplicationActor(email);
  if (!actor) throw new Error("当前系统账户未启用。");
  await assertVaultEncryptionReady();
  const vaultAccess = await accessibleVaults(email);
  const items: Array<{ value: VaultCredential; updatedAt: string }> = [];

  for (const vault of vaultAccess) {
    const space: VaultSpace = vault.kind === "personal" ? "个人" : "公共";
    const limit = vaultItemLimit(space);
    const result = await d1.prepare(
      "SELECT id, vault_id, ciphertext, iv, key_id, encryption_version, created_at, updated_at FROM vault_items WHERE vault_id = ? ORDER BY updated_at DESC LIMIT ?",
    ).bind(vault.id, limit + 1).all<VaultItemRow>();
    if (result.results.length > limit) throw new Error("密码库项目数量超过安全上限。请联系管理员处理。");

    for (const row of result.results) {
      try {
        const payload = await decryptVaultPayload<StoredCredential>(
          { ciphertext: row.ciphertext, iv: row.iv, keyId: row.key_id, encryptionVersion: row.encryption_version },
          { vaultId: row.vault_id, itemId: row.id },
        );
        items.push({ value: toCredential(row, payload, vault), updatedAt: row.updated_at });
      } catch {
        throw new Error("无法读取已加密的密码库数据。");
      }
    }
  }

  return {
    items: items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((item) => item.value),
    publicUserCount: await countActiveApplicationUsers(),
    approvals: await listApprovalRequests(email),
  };
}

export async function listManagementAudit(email: string, options: { page?: number; pageSize?: number; category?: ManagementAuditCategory } = {}): Promise<ManagementAuditPage> {
  const actor = await getActiveApplicationActor(email);
  if (!actor || actor.role !== "admin") throw new Error("只有管理员可以查看操作审计。");

  const publicVault = await findSharedPublicVault();
  const pageSize = boundedPageSize(options.pageSize);
  const requestedPage = boundedPage(options.page);
  const category = options.category ?? "all";
  const actions = managementAuditActions[category] ?? managementAuditActions.all;

  if (!publicVault) {
    return { audit: [], chainIntegrity: "legacy", pagination: { page: 1, pageSize, total: 0, pageCount: 1 } };
  }

  const d1 = getD1();
  const actionMarkers = actions.map(() => "?").join(", ");
  const totalRow = await d1.prepare(
    `SELECT COUNT(*) AS count FROM audit_events
     WHERE vault_id = ? AND action IN (${actionMarkers})`,
  ).bind(publicVault.id, ...actions).first<{ count: number }>();
  const total = totalRow?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const offset = (page - 1) * pageSize;
  const result = await d1.prepare(
    `SELECT id, vault_id, action, actor_email, item_id, created_at, signature, signature_key_id, event_version, sequence, previous_hash, chain_hash FROM audit_events
     WHERE vault_id = ? AND action IN (${actionMarkers})
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  ).bind(publicVault.id, ...actions, pageSize, offset).all<AuditEventRow>();

  const audit = await Promise.all(result.results.map(async (event) => ({
    action: event.action,
    actorEmail: event.actor_email,
    itemId: event.item_id,
    createdAt: timeLabel(event.created_at),
    integrity: await auditIntegrity({
      id: event.id,
      vaultId: event.vault_id,
      actorEmail: event.actor_email,
      action: event.action,
      itemId: event.item_id,
      createdAt: event.created_at,
      signature: event.signature,
      signatureKeyId: event.signature_key_id,
      eventVersion: event.event_version,
      sequence: event.sequence,
      previousHash: event.previous_hash,
      chainHash: event.chain_hash,
    }),
  })));
  const chainRows = await d1.prepare(
    `SELECT id, vault_id, action, actor_email, item_id, created_at, signature, signature_key_id, event_version, sequence, previous_hash, chain_hash
     FROM audit_events WHERE vault_id = ? AND event_version = 1 ORDER BY sequence ASC`,
  ).bind(publicVault.id).all<AuditEventRow>();
  const chainIntegrity = await verifyAuditChain(publicVault.id, chainRows.results.map((event) => ({
    id: event.id,
    vaultId: event.vault_id,
    actorEmail: event.actor_email,
    action: event.action,
    itemId: event.item_id,
    createdAt: event.created_at,
    signature: event.signature,
    signatureKeyId: event.signature_key_id,
    eventVersion: event.event_version,
    sequence: event.sequence,
    previousHash: event.previous_hash,
    chainHash: event.chain_hash,
  })));

  return {
    audit,
    chainIntegrity,
    pagination: { page, pageSize, total, pageCount },
  };
}

function boundedPage(value: number | undefined) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(100_000, Math.floor(value ?? 1)));
}

function boundedPageSize(value: number | undefined) {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(20, Math.floor(value ?? 20)));
}

function summaryMatchesQuery(item: VaultItemSummary, query: string) {
  if (!query) return true;
  return [item.name, item.domain, item.username, item.category, item.group]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

export async function listVaultSummaryData(email: string, options: VaultListOptions = {}) {
  const data = await listVaultData(email);
  const issuesByItem = reviewCredentialSecurity(data.items);
  const summaries = data.items.map((item) => toSummary(item, issuesByItem.get(item.id) ?? []));
  const categoryNames = Array.from(new Set(summaries.map((item) => item.category.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
  const spaceCounts = {
    全部: summaries.length,
    个人: summaries.filter((item) => item.group === "个人").length,
    公共: summaries.filter((item) => item.group === "公共").length,
  };
  const weakPasswordCount = summaries.filter((item) => item.securityIssues.includes("weak_password")).length;
  const reusedPasswordCount = summaries.filter((item) => item.securityIssues.includes("reused_password")).length;
  const missingTwoFactorCount = summaries.filter((item) => item.securityIssues.includes("missing_two_factor")).length;
  const securityIssueCount = summaries.reduce((count, item) => count + item.securityIssues.length, 0);
  const normalizedQuery = typeof options.query === "string" ? options.query.trim().slice(0, 120).toLocaleLowerCase() : "";
  const selectedSpace = options.space === "个人" || options.space === "公共" ? options.space : "全部";
  const selectedCategory = typeof options.category === "string" && categoryNames.includes(options.category) ? options.category : "全部";
  const selectedCollection = options.collection === "security" ? "security" : "all";
  const selectedFocus = options.securityFocus === "weak_password" || options.securityFocus === "reused_password" || options.securityFocus === "missing_two_factor"
    ? options.securityFocus
    : "all";
  const filtered = summaries.filter((item) => {
    if (selectedSpace !== "全部" && item.group !== selectedSpace) return false;
    if (selectedCategory !== "全部" && item.category !== selectedCategory) return false;
    if (selectedCollection === "security" && (item.securityIssues.length === 0 || (selectedFocus !== "all" && !item.securityIssues.includes(selectedFocus)))) return false;
    return summaryMatchesQuery(item, normalizedQuery);
  });
  const sorted = options.sortOrder === "name"
    ? [...filtered].sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id))
    : filtered;
  const pageSize = boundedPageSize(options.pageSize);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(boundedPage(options.page), pageCount);
  const offset = (page - 1) * pageSize;

  return {
    ...data,
    items: sorted.slice(offset, offset + pageSize),
    categoryNames,
    spaceCounts,
    security: {
      totalItems: summaries.length,
      weakPasswordCount,
      reusedPasswordCount,
      missingTwoFactorCount,
      securityIssueCount,
      score: summaries.length === 0 ? 0 : Math.max(0, 100 - weakPasswordCount * 14 - reusedPasswordCount * 24 - missingTwoFactorCount * 8),
    },
    pagination: { page, pageSize, total: sorted.length, pageCount },
  };
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
  const id = crypto.randomUUID();
  const encrypted = await encryptVaultPayload(payload, { vaultId: vault.id, itemId: id });
  const d1 = getD1();

  const inserted = await d1.prepare(
    `INSERT INTO vault_items (id, vault_id, ciphertext, iv, key_id, encryption_version)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM vault_items WHERE vault_id = ?) < ?`,
  ).bind(
    id,
    vault.id,
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.keyId,
    encrypted.encryptionVersion,
    vault.id,
    vaultItemLimit(space),
  ).run();
  if ((inserted.meta.changes ?? 0) !== 1) throw new Error("该密码库的项目数量已达到安全上限。");
  await writeAudit(vault.id, email, "item_created", id);

  return { id, ...payload, category: payload.category ?? "", totps: payload.totps ?? [], group: space, updated: "刚刚更新", canEdit: space === "个人" || actor.role === "admin" } satisfies VaultCredential;
}

async function findItemAccess(email: string, itemId: string) {
  const d1 = getD1();
  const item = await d1.prepare(
    "SELECT id, vault_id, ciphertext, iv, key_id, encryption_version, created_at, updated_at FROM vault_items WHERE id = ? LIMIT 1",
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
  const encrypted = await encryptVaultPayload(payload, { vaultId: destination.id, itemId: item.id });
  const d1 = getD1();

  const updated = await d1.prepare(
    `UPDATE vault_items
     SET vault_id = ?, ciphertext = ?, iv = ?, key_id = ?, encryption_version = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND (? = 0 OR (SELECT COUNT(*) FROM vault_items WHERE vault_id = ?) < ?)`,
  ).bind(
    destination.id,
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.keyId,
    encrypted.encryptionVersion,
    item.id,
    destination.id === item.vault_id ? 0 : 1,
    destination.id,
    vaultItemLimit(nextSpace),
  ).run();
  if ((updated.meta.changes ?? 0) !== 1) throw new Error("目标密码库的项目数量已达到安全上限。");
  await writeAudit(destination.id, email, nextSpace !== currentSpace ? "item_published_to_public" : "item_updated", item.id);

  return { id: item.id, ...payload, category: payload.category ?? "", totps: payload.totps ?? [], group: nextSpace, updated: "刚刚更新", canEdit: nextSpace === "个人" || actor?.role === "admin" } satisfies VaultCredential;
}

export async function getVaultItem(email: string, itemId: string) {
  const { item, vault } = await findItemAccess(email, itemId);
  try {
    const payload = await decryptVaultPayload<StoredCredential>(
      { ciphertext: item.ciphertext, iv: item.iv, keyId: item.key_id, encryptionVersion: item.encryption_version },
      { vaultId: item.vault_id, itemId: item.id },
    );
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
  const publicVault = await findSharedPublicVault();
  if (!publicVault) return [];
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
  const vault = await findSharedPublicVault();
  if (!vault) throw new Error("请先由管理员创建一项公共项目，再发起导出确认。");
  const d1 = getD1();
  if (await countActiveApplicationUsers() < 2) throw new Error("请先创建并启用另一位系统用户，再发起导出确认。");

  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const created = await d1.prepare(
    `INSERT INTO approval_requests (id, vault_id, requested_by, action, expires_at)
     SELECT ?, ?, ?, 'export_vault', ?
     WHERE NOT EXISTS (
       SELECT 1 FROM approval_requests WHERE vault_id = ? AND requested_by = ? AND status = 'pending'
     )`,
  ).bind(id, vault.id, email, expiresAt, vault.id, email).run();
  if ((created.meta.changes ?? 0) !== 1) {
    throw new Error("你已有一条等待确认的导出请求。请等待另一位用户处理，或在 10 分钟后重试。");
  }
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

  const publicVault = await findSharedPublicVault();
  if (!publicVault) throw new Error("公共密码库尚未初始化。");
  if (publicVault.id !== approval.vault_id) throw new Error("该导出确认不属于当前公共项目。");

  const decided = await d1.prepare(
    `UPDATE approval_requests
     SET status = ?, approver_email = ?, resolved_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending' AND expires_at > ?`,
  ).bind(decision, email, id, new Date().toISOString()).run();
  if ((decided.meta.changes ?? 0) !== 1) throw new Error("该导出确认已不可处理。");
  await writeAudit(approval.vault_id, email, decision === "approved" ? "export_approved" : "export_rejected");
}

export async function exportVaultData(email: string, approvalId: string) {
  const d1 = getD1();
  const publicVault = await findSharedPublicVault();
  if (!publicVault) throw new Error("公共密码库尚未初始化。");
  const data = await listVaultData(email);
  const consumed = await d1.prepare(
    `UPDATE approval_requests
     SET status = 'expired', resolved_at = CURRENT_TIMESTAMP
     WHERE id = ? AND vault_id = ? AND requested_by = ? AND status = 'approved' AND expires_at > ?`,
  ).bind(approvalId, publicVault.id, email, new Date().toISOString()).run();
  if ((consumed.meta.changes ?? 0) !== 1) {
    throw new Error("该导出请求尚未获得另一位用户的有效批准。");
  }

  await writeAudit(publicVault.id, email, "vault_exported");
  return { exportedAt: new Date().toISOString(), items: data.items };
}

export async function rotateVaultEncryption(email: string, input: Record<string, unknown>) {
  const actor = await getActiveApplicationActor(email);
  if (!actor || actor.role !== "admin") throw new Error("只有管理员可以执行密钥轮换。");
  await assertVaultEncryptionReady();

  const requestedBatchSize = typeof input.batchSize === "number" ? Math.floor(input.batchSize) : 50;
  const batchSize = Math.max(1, Math.min(50, requestedBatchSize));
  const activeKeyId = await activeVaultEncryptionKeyId();
  const d1 = getD1();
  const candidates = await d1.prepare(
    `SELECT id, vault_id, ciphertext, iv, key_id, encryption_version, created_at, updated_at
     FROM vault_items
     WHERE encryption_version < 2 OR encryption_version IS NULL OR key_id IS NULL OR key_id <> ?
     ORDER BY updated_at ASC
     LIMIT ?`,
  ).bind(activeKeyId, batchSize).all<VaultItemRow>();

  let rotated = 0;
  for (const item of candidates.results) {
    let payload: StoredCredential;
    try {
      payload = await decryptVaultPayload<StoredCredential>(
        { ciphertext: item.ciphertext, iv: item.iv, keyId: item.key_id, encryptionVersion: item.encryption_version },
        { vaultId: item.vault_id, itemId: item.id },
      );
    } catch {
      throw new Error("存在无法读取的加密项目，已停止密钥轮换。请恢复可用的历史密钥后重试。");
    }
    const encrypted = await encryptVaultPayload(payload, { vaultId: item.vault_id, itemId: item.id });
    const updated = await d1.prepare(
      `UPDATE vault_items
       SET ciphertext = ?, iv = ?, key_id = ?, encryption_version = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND vault_id = ?`,
    ).bind(encrypted.ciphertext, encrypted.iv, encrypted.keyId, encrypted.encryptionVersion, item.id, item.vault_id).run();
    if ((updated.meta.changes ?? 0) !== 1) throw new Error("密钥轮换时项目状态发生变化，请重新检查后继续。");
    await writeAudit(item.vault_id, actor.email, "item_reencrypted", item.id);
    rotated += 1;
  }

  const remaining = await d1.prepare(
    `SELECT COUNT(*) AS count FROM vault_items
     WHERE encryption_version < 2 OR encryption_version IS NULL OR key_id IS NULL OR key_id <> ?`,
  ).bind(activeKeyId).first<{ count: number }>();
  return { activeKeyId, rotated, remaining: remaining?.count ?? 0, complete: (remaining?.count ?? 0) === 0 };
}

export async function recordVaultAudit(email: string, input: Record<string, unknown>) {
  const action = input.action === "password_revealed" || input.action === "totp_revealed" || input.action === "credential_copied" || input.action === "totp_copied" ? input.action : null;
  const itemId = typeof input.itemId === "string" ? input.itemId : "";
  if (!action || !itemId) return;

  const { vault } = await findItemAccess(email, itemId);
  await writeAudit(vault.id, email, action, itemId);
}
