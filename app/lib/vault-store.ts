import { getDatabase } from "../../db";
import { parseTotpInput, toTotpConfig, type TotpConfig } from "./totp";
import { getActiveApplicationActor } from "./user-store";
import { assertVaultEncryptionReady, decryptVaultPayload, encryptVaultPayload } from "./vault-crypto";
import { assertVaultMoveAllowed, boundedText, isVaultSpace, vaultItemLimit, type VaultSpace } from "./vault-policy";
import { reviewCredentialSecurity, type SecurityIssue } from "./security-review";
import { canonicalPublicVaultId, resolveSharedPublicVault } from "./shared-public-vault";
import { auditIntegrity, verifyAuditChain, writeAuditedMutation, writeAuditEvent } from "./audit-log";
import { ClientSafeError } from "./security-errors";

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

export type ManagementAuditCategory = "all" | "project" | "user" | "embedded";

export type ManagementAuditPage = {
  audit: Array<{ action: string; actorEmail: string; itemId: string | null; createdAt: string; integrity: "legacy" | "sealed" | "failed" }>;
  chainIntegrity: "legacy" | "sealed" | "failed";
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
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
    "item_created", "item_updated", "item_published_to_public", "item_deleted", "public_secret_accessed",
    "system_user_created", "system_user_activation_resent", "system_user_activation_started", "system_user_activated", "system_user_role_changed", "system_user_status_changed", "system_user_authenticator_reset", "system_user_authenticator_recovery_started", "system_user_authenticator_recovered", "system_user_deleted",
    "profile_updated", "account_password_changed", "account_password_recovered", "account_security_email_changed", "initial_admin_initialized", "initial_admin_recovery_codes_rotated", "initial_admin_recovered",
    "embedded_origin_added", "embedded_origin_deleted", "embedded_page_created", "embedded_page_updated", "embedded_page_deleted",
  ],
  project: ["item_created", "item_updated", "item_published_to_public", "item_deleted", "public_secret_accessed"],
  user: ["system_user_created", "system_user_activation_resent", "system_user_activation_started", "system_user_activated", "system_user_role_changed", "system_user_status_changed", "system_user_authenticator_reset", "system_user_authenticator_recovery_started", "system_user_authenticator_recovered", "system_user_deleted", "profile_updated", "account_password_changed", "account_password_recovered", "account_security_email_changed", "initial_admin_initialized", "initial_admin_recovery_codes_rotated", "initial_admin_recovered"],
  embedded: ["embedded_origin_added", "embedded_origin_deleted", "embedded_page_created", "embedded_page_updated", "embedded_page_deleted"],
} as const satisfies Record<ManagementAuditCategory, readonly string[]>;

const managementAuditIntegrityCache = new Map<string, { sequence: number; headHash: string; checkedAt: number; integrity: "legacy" | "sealed" | "failed" }>();
const managementAuditIntegrityCacheTtlMs = 60_000;
const vaultSummaryCache = new Map<string, { expiresAt: number; summaries: VaultItemSummary[] }>();
const vaultSummaryCacheTtlMs = 30_000;

function clearVaultSummaryCache() {
  vaultSummaryCache.clear();
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

function totpEntryLabel(value: unknown, index: number) {
  return boundedText(value, "totpLabel") || (index === 0 ? "登录验证器" : `验证器 ${index + 1}`);
}

function parseTotpEntries(input: Record<string, unknown>): VaultTotp[] {
  if (Array.isArray(input.totpEntries)) {
    if (input.totpEntries.length > 3) throw new ClientSafeError("每个项目最多保存 3 个验证器。");
    const entries: VaultTotp[] = [];
    const secrets = new Set<string>();

    input.totpEntries.forEach((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ClientSafeError("验证器配置无效。请重新输入 Setup Key 或二维码内容。");
      }
      const source = value as Record<string, unknown>;
      const raw = typeof source.value === "string" ? source.value.trim() : typeof source.totpInput === "string" ? source.totpInput.trim() : "";
      if (raw.length > 4_096) throw new ClientSafeError("验证器配置内容过长。请粘贴 Setup Key 或完整二维码内容。");
      let config: TotpConfig | undefined;
      try {
        config = raw ? parseTotpInput(raw) : toTotpConfig(source.config);
      } catch {
        throw new ClientSafeError("验证器配置无效。请重新输入 Setup Key 或二维码内容。");
      }
      if (!config) return;
      if (secrets.has(config.secret)) throw new ClientSafeError("同一个验证器密钥只能添加一次。");
      secrets.add(config.secret);
      entries.push({ label: totpEntryLabel(source.label, index), config });
    });
    return entries;
  }

  const legacyInput = typeof input.totpInput === "string" ? input.totpInput.trim() : "";
  if (legacyInput.length > 4_096) throw new ClientSafeError("验证器配置内容过长。请粘贴 Setup Key 或完整二维码内容。");
  let legacy: TotpConfig | undefined;
  try {
    legacy = input.removeTotp === true ? undefined : legacyInput ? parseTotpInput(legacyInput) : toTotpConfig(input.totp);
  } catch {
    throw new ClientSafeError("验证器配置无效。请重新输入 Setup Key 或二维码内容。");
  }
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
    throw new ClientSafeError("名称、网址、用户名和密码不能为空。");
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
  const database = getDatabase();
  const existing = await database.prepare(
    "SELECT id, owner_email, kind FROM vaults WHERE owner_email = ? AND kind = ? LIMIT 1",
  ).bind(email, kind).first<{ id: string; owner_email: string; kind: VaultKind }>();

  if (existing) return { id: existing.id, ownerEmail: existing.owner_email, kind: existing.kind, role: "owner" };

  const id = crypto.randomUUID();
  const name = kind === "personal" ? "个人工作区" : "公共工作区";
  try {
    await database.prepare(
      "INSERT INTO vaults (id, owner_email, kind, name) VALUES (?, ?, ?, ?)",
    ).bind(id, email, kind, name).run();
  } catch {
    const createdByAnotherRequest = await database.prepare(
      "SELECT id, owner_email, kind FROM vaults WHERE owner_email = ? AND kind = ? LIMIT 1",
    ).bind(email, kind).first<{ id: string; owner_email: string; kind: VaultKind }>();
    if (createdByAnotherRequest) {
      return { id: createdByAnotherRequest.id, ownerEmail: createdByAnotherRequest.owner_email, kind: createdByAnotherRequest.kind, role: "owner" };
    }
    throw new Error("无法创建工作区。");
  }

  return { id, ownerEmail: email, kind, role: "owner" };
}

async function findSharedPublicVault(): Promise<AccessibleVault | null> {
  const database = getDatabase();
  const configured = await database.prepare(
    "SELECT value FROM app_settings WHERE key = 'shared_public_vault' LIMIT 1",
  ).first<{ value: string }>();
  if (configured?.value) {
    const vault = await database.prepare(
      "SELECT id, owner_email, kind FROM vaults WHERE id = ? AND kind = 'public' LIMIT 1",
    ).bind(configured.value).first<{ id: string; owner_email: string; kind: VaultKind }>();
    if (vault) return { id: vault.id, ownerEmail: vault.owner_email, kind: vault.kind, role: "owner" };
  }

  const existing = await database.prepare(
    "SELECT id, owner_email, kind FROM vaults WHERE kind = 'public' ORDER BY created_at ASC LIMIT 1",
  ).first<{ id: string; owner_email: string; kind: VaultKind }>();
  const selected = resolveSharedPublicVault(configured?.value, existing ? [existing] : []);
  if (!selected) return null;

  // 站点迁移或人工清理可能留下指向已删除工作区的旧设置。只要存在有效的
  // 公共工作区，就以最早创建的项目恢复唯一映射，避免公共项目整体不可见。
  await database.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('shared_public_vault', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(selected.id).run();
  return { id: selected.id, ownerEmail: selected.owner_email, kind: selected.kind, role: "owner" };
}

async function ensureSharedPublicVault(adminEmail: string): Promise<AccessibleVault> {
  const actor = await getActiveApplicationActor(adminEmail);
  if (!actor || actor.role !== "admin") throw new Error("公共工作区只能由管理员初始化。");

  const existing = await findSharedPublicVault();
  if (existing) return existing;

  const database = getDatabase();
  await database.prepare(
    "INSERT OR IGNORE INTO vaults (id, owner_email, kind, name) VALUES (?, ?, 'public', '公共工作区')",
  ).bind(canonicalPublicVaultId, adminEmail).run();
  await database.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('shared_public_vault', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(canonicalPublicVaultId).run();

  const shared = await findSharedPublicVault();
  if (!shared) throw new Error("无法初始化公共工作区。");
  return shared;
}

async function accessibleVaults(email: string): Promise<AccessibleVault[]> {
  const actor = await getActiveApplicationActor(email);
  if (!actor) throw new ClientSafeError("当前系统账户未启用。", 403, "ACCOUNT_INACTIVE");

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
  const database = getDatabase();
  const actor = await getActiveApplicationActor(email);
  if (!actor) throw new ClientSafeError("当前系统账户未启用。", 403, "ACCOUNT_INACTIVE");
  await assertVaultEncryptionReady();
  const vaultAccess = await accessibleVaults(email);
  const items: Array<{ value: VaultCredential; updatedAt: string }> = [];

  for (const vault of vaultAccess) {
    const space: VaultSpace = vault.kind === "personal" ? "个人" : "公共";
    const limit = vaultItemLimit(space);
    const result = await database.prepare(
      "SELECT id, vault_id, ciphertext, iv, key_id, encryption_version, created_at, updated_at FROM vault_items WHERE vault_id = ? ORDER BY updated_at DESC LIMIT ?",
    ).bind(vault.id, limit + 1).all<VaultItemRow>();
    if (result.results.length > limit) throw new Error("项目数量超过安全上限。请联系管理员处理。");

    // WebCrypto work is asynchronous.  A small bounded batch lowers list latency
    // without starting hundreds of simultaneous decryptions for a large vault.
    for (let offset = 0; offset < result.results.length; offset += 16) {
      const batch = result.results.slice(offset, offset + 16);
      try {
        const decrypted = await Promise.all(batch.map(async (row) => ({
          row,
          payload: await decryptVaultPayload<StoredCredential>(
            { ciphertext: row.ciphertext, iv: row.iv, keyId: row.key_id, encryptionVersion: row.encryption_version },
            { vaultId: row.vault_id, itemId: row.id },
          ),
        })));
        items.push(...decrypted.map(({ row, payload }) => ({ value: toCredential(row, payload, vault), updatedAt: row.updated_at })));
      } catch {
        throw new Error("无法读取已加密的数据。");
      }
    }
  }

  return {
    items: items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((item) => item.value),
  };
}

export async function listManagementAudit(email: string, options: { page?: number; pageSize?: number; category?: ManagementAuditCategory } = {}): Promise<ManagementAuditPage> {
  const actor = await getActiveApplicationActor(email);
  if (!actor || actor.role !== "admin") throw new ClientSafeError("只有管理员可以查看操作审计。", 403, "ADMIN_REQUIRED");

  const publicVault = await findSharedPublicVault();
  const pageSize = boundedPageSize(options.pageSize);
  const requestedPage = boundedPage(options.page);
  const category = options.category ?? "all";
  const actions = managementAuditActions[category] ?? managementAuditActions.all;

  if (!publicVault) {
    return { audit: [], chainIntegrity: "legacy", pagination: { page: 1, pageSize, total: 0, pageCount: 1 } };
  }

  const database = getDatabase();
  const actionMarkers = actions.map(() => "?").join(", ");
  const totalRow = await database.prepare(
    `SELECT COUNT(*) AS count FROM audit_events
     WHERE vault_id = ? AND action IN (${actionMarkers})`,
  ).bind(publicVault.id, ...actions).first<{ count: number }>();
  const total = totalRow?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const offset = (page - 1) * pageSize;
  const result = await database.prepare(
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
  const chainState = await database.prepare(
    "SELECT last_sequence, head_hash FROM audit_chain_states WHERE vault_id = ? LIMIT 1",
  ).bind(publicVault.id).first<{ last_sequence: number; head_hash: string }>();
  const cachedIntegrity = chainState ? managementAuditIntegrityCache.get(publicVault.id) : undefined;
  let chainIntegrity: "legacy" | "sealed" | "failed";
  if (chainState && cachedIntegrity
    && cachedIntegrity.sequence === chainState.last_sequence
    && cachedIntegrity.headHash === chainState.head_hash
    && Date.now() - cachedIntegrity.checkedAt < managementAuditIntegrityCacheTtlMs) {
    chainIntegrity = cachedIntegrity.integrity;
  } else {
    const chainRows = await database.prepare(
      `SELECT id, vault_id, action, actor_email, item_id, created_at, signature, signature_key_id, event_version, sequence, previous_hash, chain_hash
       FROM audit_events WHERE vault_id = ? AND event_version = 1 ORDER BY sequence ASC`,
    ).bind(publicVault.id).all<AuditEventRow>();
    chainIntegrity = await verifyAuditChain(publicVault.id, chainRows.results.map((event) => ({
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
    if (chainState) {
      managementAuditIntegrityCache.set(publicVault.id, {
        sequence: chainState.last_sequence,
        headHash: chainState.head_hash,
        checkedAt: Date.now(),
        integrity: chainIntegrity,
      });
    }
  }

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
  const cacheKey = email.toLowerCase();
  const cached = vaultSummaryCache.get(cacheKey);
  let summaries: VaultItemSummary[];
  if (cached && cached.expiresAt > Date.now()) {
    summaries = cached.summaries;
  } else {
    const data = await listVaultData(email);
    const issuesByItem = reviewCredentialSecurity(data.items);
    summaries = data.items.map((item) => toSummary(item, issuesByItem.get(item.id) ?? []));
    vaultSummaryCache.set(cacheKey, { expiresAt: Date.now() + vaultSummaryCacheTtlMs, summaries });
  }
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
  if (!actor) throw new ClientSafeError("当前系统账户未启用。", 403, "ACCOUNT_INACTIVE");
  if (space === "公共" && actor.role !== "admin") {
    throw new ClientSafeError("公共项目仅允许管理员新建。", 403, "ADMIN_REQUIRED");
  }
  const vault = await vaultForSpace(email, space);
  const payload = storedPayload(input);
  const id = crypto.randomUUID();
  const encrypted = await encryptVaultPayload(payload, { vaultId: vault.id, itemId: id });
  const database = getDatabase();

  await writeAuditedMutation(vault.id, email, "item_created", id, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM vault_items WHERE id = ?)", values: [id] },
    commitPrerequisite: { sql: "SELECT 1 FROM vault_items WHERE id = ?", values: [id] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `INSERT INTO vault_items (id, vault_id, ciphertext, iv, key_id, encryption_version)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM vault_items WHERE vault_id = ?) < ?
         AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(
      id,
      vault.id,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.keyId,
      encrypted.encryptionVersion,
      vault.id,
      vaultItemLimit(space),
      ...guard.values,
      guard.auditEventId,
    )],
  });
  clearVaultSummaryCache();

  return { id, ...payload, category: payload.category ?? "", totps: payload.totps ?? [], group: space, updated: "刚刚更新", canEdit: space === "个人" || actor.role === "admin" } satisfies VaultCredential;
}

async function findItemAccess(email: string, itemId: string) {
  const database = getDatabase();
  const item = await database.prepare(
    "SELECT id, vault_id, ciphertext, iv, key_id, encryption_version, created_at, updated_at FROM vault_items WHERE id = ? LIMIT 1",
  ).bind(itemId).first<VaultItemRow>();
  if (!item) throw new ClientSafeError("未找到该项目。", 404, "VAULT_ITEM_NOT_FOUND");

  const vault = (await accessibleVaults(email)).find((candidate) => candidate.id === item.vault_id);
  if (!vault) throw new ClientSafeError("你没有访问该项目的权限。", 403, "VAULT_ITEM_ACCESS_DENIED");

  return { item, vault };
}

export async function getVaultItemScope(email: string, itemId: string) {
  const { item, vault } = await findItemAccess(email, itemId);
  return { vaultId: item.vault_id, group: vault.kind === "public" ? "公共" : "个人" } satisfies { vaultId: string; group: VaultSpace };
}

function assertVaultItemScopeUnchanged(item: VaultItemRow, expectedVaultId?: string) {
  if (expectedVaultId && item.vault_id !== expectedVaultId) {
    throw new ClientSafeError("项目所在工作区已变更，请刷新后重新确认操作。", 409, "VAULT_ITEM_SCOPE_CHANGED");
  }
}

export async function updateVaultItem(email: string, itemId: string, input: Record<string, unknown>, expectedVaultId?: string) {
  const { item, vault } = await findItemAccess(email, itemId);
  assertVaultItemScopeUnchanged(item, expectedVaultId);
  if (!canWrite(vault.role)) throw new ClientSafeError("你只有查看权限，无法编辑该项目。", 403, "VAULT_ITEM_READ_ONLY");

  const currentSpace: VaultSpace = vault.kind === "personal" ? "个人" : "公共";
  const nextSpace = isVaultSpace(input.group) ? input.group : currentSpace;
  const actor = await getActiveApplicationActor(email);
  assertVaultMoveAllowed(currentSpace, nextSpace, actor?.role === "admin");

  const destination = nextSpace === currentSpace ? vault : await vaultForSpace(email, nextSpace);
  const payload = storedPayload(input);
  const encrypted = await encryptVaultPayload(payload, { vaultId: destination.id, itemId: item.id });
  const database = getDatabase();

  await writeAuditedMutation(destination.id, email, nextSpace !== currentSpace ? "item_published_to_public" : "item_updated", item.id, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM vault_items WHERE id = ? AND vault_id = ?", values: [item.id, item.vault_id] },
    commitPrerequisite: {
      sql: "SELECT 1 FROM vault_items WHERE id = ? AND vault_id = ? AND ciphertext = ? AND iv = ?",
      values: [item.id, destination.id, encrypted.ciphertext, encrypted.iv],
    },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `UPDATE vault_items
       SET vault_id = ?, ciphertext = ?, iv = ?, key_id = ?, encryption_version = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND vault_id = ?
         AND (? = 0 OR (SELECT COUNT(*) FROM vault_items WHERE vault_id = ?) < ?)
         AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(
      destination.id,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.keyId,
      encrypted.encryptionVersion,
      item.id,
      item.vault_id,
      destination.id === item.vault_id ? 0 : 1,
      destination.id,
      vaultItemLimit(nextSpace),
      ...guard.values,
      guard.auditEventId,
    )],
  });
  clearVaultSummaryCache();

  return { id: item.id, ...payload, category: payload.category ?? "", totps: payload.totps ?? [], group: nextSpace, updated: "刚刚更新", canEdit: nextSpace === "个人" || actor?.role === "admin" } satisfies VaultCredential;
}

export async function getVaultItem(email: string, itemId: string) {
  const { item, vault } = await findItemAccess(email, itemId);
  try {
    const payload = await decryptVaultPayload<StoredCredential>(
      { ciphertext: item.ciphertext, iv: item.iv, keyId: item.key_id, encryptionVersion: item.encryption_version },
      { vaultId: item.vault_id, itemId: item.id },
    );
    const credential = toCredential(item, payload, vault);
    // Public credentials are shared team secrets. Record their delivery on the
    // server before returning the decrypted value so the audit chain cannot be
    // bypassed by a modified browser client. Personal vault reads stay private.
    if (vault.kind === "public") await writeAudit(vault.id, email, "public_secret_accessed", item.id);
    return credential;
  } catch {
    throw new Error("无法读取已加密的项目数据。");
  }
}

export async function deleteVaultItem(email: string, itemId: string, expectedVaultId?: string) {
  const { item, vault } = await findItemAccess(email, itemId);
  assertVaultItemScopeUnchanged(item, expectedVaultId);
  if (!canWrite(vault.role)) throw new ClientSafeError("你只有查看权限，无法删除该项目。", 403, "VAULT_ITEM_READ_ONLY");

  const database = getDatabase();
  await writeAuditedMutation(vault.id, email, "item_deleted", item.id, {
    auditOrder: "before",
    auditPrerequisite: { sql: "SELECT 1 FROM vault_items WHERE id = ? AND vault_id = ?", values: [item.id, item.vault_id] },
    commitPrerequisite: { sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM vault_items WHERE id = ?)", values: [item.id] },
    expectedChanges: 1,
    statements: (guard) => [database.prepare(
      `DELETE FROM vault_items WHERE id = ? AND vault_id = ? AND ${guard.conditionSql}
         AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ).bind(item.id, item.vault_id, ...guard.values, guard.auditEventId)],
  });
  clearVaultSummaryCache();
}
