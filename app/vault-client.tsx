"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clipboard,
  Clock3,
  Copy,
  CreditCard,
  Edit3,
  Eye,
  EyeOff,
  FileKey2,
  ImageUp,
  KeyRound,
  LayoutPanelLeft,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  ShieldEllipsis,
  Smartphone,
  Trash2,
  UserCog,
  UserRound,
  UsersRound,
  WandSparkles,
  X,
} from "lucide-react";
import { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { AdminTableLoading, AdminTableState } from "./components/admin-table-state";
import { TablePagination } from "./components/table-pagination";
import { Spotlight } from "./components/ui/spotlight";
import { SurfaceSelect, type SurfaceSelectOption } from "./components/surface-select";
import { EmbeddedPagesWorkspace } from "./embedded/embedded-pages-client";
import { EmbeddedPageManagerContent } from "./embedded/manage/embedded-page-manager";
import type { SecurityIssue } from "./lib/security-review";
import { generateTotpCode, parseTotpInput, totpLabel, totpSecondsRemaining, type TotpConfig } from "./lib/totp";
import { vaultRouteFromSearch, vaultRouteSearch, type AuditCategory, type SecurityFocus, type UserManagementTab, type VaultPage, type VaultRoute } from "./lib/vault-navigation";
import { profileAvatarStyles, type ProfileAvatarStyle } from "./lib/profile";

type Strength = "安全" | "一般" | "风险";
type ItemType = "登录" | "卡片" | "安全笔记";
type Space = "全部" | "个人" | "公共";
type Collection = "all" | "security";
type SortOrder = "updated" | "name";
type VaultTotp = { label: string; config: TotpConfig };
type TotpFormEntry = { id: string; label: string; value: string; config?: TotpConfig };

type VaultItem = {
  id: string;
  name: string;
  domain: string;
  username: string;
  password: string;
  category: string;
  type: ItemType;
  group: string;
  updated: string;
  strength: Strength;
  twoFactor: boolean;
  favorite: boolean;
  brand: string;
  note: string;
  totps: VaultTotp[];
  canEdit: boolean;
  sharedBy?: string;
};

type VaultItemSummary = Omit<VaultItem, "password" | "note" | "totps"> & {
  passwordLength: number;
  hasTotp: boolean;
  securityIssues: SecurityIssue[];
};

type Viewer = {
  displayName: string;
  avatarStyle: ProfileAvatarStyle;
  email: string;
  role: "admin" | "user";
  isInitialAdmin: boolean;
};

type CredentialForm = Pick<VaultItem, "name" | "domain" | "username" | "password" | "category" | "group"> & {
  totpEntries: TotpFormEntry[];
};
type AuditIntegrity = "legacy" | "sealed" | "failed" | "unknown";
type AuditEntry = { action: string; actorEmail: string; itemId: string | null; createdAt: string; integrity?: Exclude<AuditIntegrity, "unknown"> };
type SystemUser = { email: string; role: "admin" | "user"; status: "pending" | "active" | "suspended" | "frozen"; createdAt: string; lastLoginAt: string | null; isOnline: boolean; isCurrent: boolean };
type EmbeddedNavigationPage = { id: string; name: string };
type SystemUserProvisioning = { account: string; delivery: "email" | "manual"; expiresAt: string; code?: string };
type AuthenticatorRecovery = { account: string; delivery: "email"; expiresAt: string };
type DeleteTarget = Pick<VaultItem, "id" | "name" | "username" | "type" | "group">;
type Pagination = { page: number; pageSize: number; total: number; pageCount: number };

type VaultSecuritySummary = {
  totalItems: number;
  weakPasswordCount: number;
  reusedPasswordCount: number;
  missingTwoFactorCount: number;
  securityIssueCount: number;
  score: number;
};
type SystemUserAction = { user: SystemUser; kind: "suspend" | "activate" | "delete" | "role" | "reset-authenticator" | "resend-activation"; role?: "admin" | "user" };
type PendingPublicPublish = { item?: VaultItem; form: CredentialForm };

const emptyPagination: Pagination = { page: 1, pageSize: 20, total: 0, pageCount: 1 };
const emptySecuritySummary: VaultSecuritySummary = {
  totalItems: 0,
  weakPasswordCount: 0,
  reusedPasswordCount: 0,
  missingTwoFactorCount: 0,
  securityIssueCount: 0,
  score: 0,
};

function parseStoredTime(value: string) {
  return Date.parse(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
}

function relativeTime(value: string | null) {
  if (!value) return "从未登录";
  const timestamp = parseStoredTime(value);
  if (Number.isNaN(timestamp)) return value;
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;
  if (elapsedMinutes < 1_440) return `${Math.floor(elapsedMinutes / 60)} 小时前`;
  return `${Math.floor(elapsedMinutes / 1_440)} 天前`;
}

function exactTime(value: string | null) {
  if (!value) return "从未登录";
  const timestamp = parseStoredTime(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", hour12: false }).format(timestamp);
}

function systemUserStatusLabel(status: SystemUser["status"]) {
  if (status === "pending") return "待激活";
  if (status === "active") return "已启用";
  if (status === "frozen") return "已冻结";
  return "已停用";
}

function endCurrentSecuritySession(returnTo = "/login") {
  void Promise.allSettled([
    fetch("/api/security/session", {
      method: "DELETE",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    }),
    fetch("/api/auth/logout", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    }),
  ]).finally(() => window.location.assign(returnTo));
}

const spaceFilters = ["全部", "个人", "公共"] as const;
const auditCategoryOptions = [
  { value: "all", label: "全部操作" },
  { value: "project", label: "公共项目" },
  { value: "user", label: "系统用户" },
  { value: "embedded", label: "内嵌页面" },
] as const satisfies readonly SurfaceSelectOption<AuditCategory>[];

function auditIntegrityLabel(value: AuditIntegrity) {
  if (value === "sealed") return "审计链完整";
  if (value === "failed") return "审计链校验失败，请立即停止敏感操作";
  if (value === "legacy") return "含历史未签名记录";
  return "正在校验审计链";
}

function newTotpFormEntry(index = 0, config?: TotpConfig, label?: string): TotpFormEntry {
  return { id: crypto.randomUUID(), label: label ?? (index === 0 ? "登录验证器" : `验证器 ${index + 1}`), value: "", ...(config ? { config } : {}) };
}

function emptyCredentialForm(): CredentialForm {
  return { name: "", domain: "", username: "", password: "", category: "", group: "个人", totpEntries: [newTotpFormEntry()] };
}

function generateStrongPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-";
  const required = ["A", "a", "2", "!"];
  const values = crypto.getRandomValues(new Uint32Array(16));
  const password = [...required, ...Array.from(values, (value) => alphabet[value % alphabet.length])];
  for (let index = password.length - 1; index > 0; index -= 1) {
    const swap = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
    [password[index], password[swap]] = [password[swap], password[index]];
  }
  return password.join("");
}

function BrandMark({ item }: { item: Pick<VaultItem, "name" | "brand" | "type"> }) {
  const initials = item.name.slice(0, 1).toUpperCase();
  return (
    <span className={`brand-mark brand-${item.brand}`} aria-hidden="true">
      {item.type === "卡片" ? <CreditCard size={19} /> : item.type === "安全笔记" ? <FileKey2 size={19} /> : initials}
    </span>
  );
}

function StrengthBadge({ strength }: { strength: Strength }) {
  const Icon = strength === "风险" ? AlertTriangle : strength === "一般" ? Clock3 : ShieldCheck;
  return (
    <span className={`strength strength-${strength}`}>
      <Icon size={14} aria-hidden="true" />
      {strength}
    </span>
  );
}

const securityIssueCopy: Record<SecurityIssue, { label: string; detail: string }> = {
  weak_password: { label: "密码长度不足", detail: "少于 14 位" },
  reused_password: { label: "密码重复", detail: "用于多个项目" },
  missing_two_factor: { label: "未开启双重验证", detail: "未配置验证器" },
};

function SecurityIssueBadges({ issues }: { issues: SecurityIssue[] }) {
  return <div className="security-issue-badges">{issues.map((issue) => <span className={`security-issue security-issue-${issue}`} key={issue}>{securityIssueCopy[issue].label}</span>)}</div>;
}

function useDebouncedValue(value: string, delay = 250) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return debouncedValue;
}

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T | null> {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(response.ok ? "服务器返回了无法识别的数据，请重新加载。" : fallback);
  }
}

function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton ${className}`.trim()} aria-hidden="true" />;
}

function SecurityStripLoading() {
  return <>
    {Array.from({ length: 4 }, (_, index) => <div className="risk-item risk-item-loading" key={index} aria-hidden="true">
      <span className="risk-icon"><Skeleton className="skeleton-icon" /></span>
      <span><Skeleton className="skeleton-line skeleton-line-title" /><Skeleton className="skeleton-line skeleton-line-copy" /></span>
      <Skeleton className="skeleton-chevron" />
    </div>)}
  </>;
}

function VaultListLoading() {
  return <div className="vault-loading-rows" role="status" aria-label="正在读取项目">
    <span className="sr-only">正在读取项目</span>
    {Array.from({ length: 4 }, (_, index) => <div className="vault-row vault-row-loading" key={index} aria-hidden="true">
      <div className="item-identity"><Skeleton className="skeleton-brand" /><span className="loading-item-copy"><Skeleton className="skeleton-line skeleton-line-title" /><Skeleton className="skeleton-line skeleton-line-copy" /></span></div>
      <Skeleton className="skeleton-status" />
      <Skeleton className="skeleton-time" />
      <Skeleton className="skeleton-chevron" />
    </div>)}
  </div>;
}

function DetailPanelLoading() {
  return <aside className="detail-panel detail-panel-loading" aria-busy="true" aria-label="正在读取项目详情">
    <span className="sr-only">正在读取项目详情</span>
    <div className="detail-loading-head"><Skeleton className="skeleton-brand" /><div><Skeleton className="skeleton-line skeleton-line-copy" /><Skeleton className="skeleton-line skeleton-line-title" /><Skeleton className="skeleton-line skeleton-line-copy skeleton-line-short" /></div></div>
    <div className="detail-loading-section"><Skeleton className="skeleton-line skeleton-line-label" /><Skeleton className="skeleton-field" /></div>
    <div className="detail-loading-section"><Skeleton className="skeleton-line skeleton-line-label" /><Skeleton className="skeleton-field" /><Skeleton className="skeleton-status" /></div>
    <div className="detail-loading-section"><Skeleton className="skeleton-line skeleton-line-label" /><Skeleton className="skeleton-totp" /></div>
  </aside>;
}

function UserTableLoading() {
  return <AdminTableLoading label="正在读取系统用户" columns={7} />;
}

function AuditLogLoading() {
  return <div className="audit-log-loading" role="status" aria-label="正在读取操作审计">
    <span className="sr-only">正在读取操作审计</span>
    <div className="audit-list-head" aria-hidden="true"><span>操作</span><span>操作者</span><span>时间</span></div>
    {Array.from({ length: 4 }, (_, index) => <div className="audit-log-loading-row" key={index} aria-hidden="true"><Skeleton className="skeleton-icon" /><div><Skeleton className="skeleton-line skeleton-line-title" /><Skeleton className="skeleton-line skeleton-line-copy" /></div><Skeleton className="skeleton-line skeleton-line-copy" /><Skeleton className="skeleton-time" /></div>)}
  </div>;
}

function ProfileOverview({
  viewer,
  viewerInitial,
  isLoading,
  securityScore,
  securityIssueCount,
  isSaving,
  onOpenSecurity,
  onRestartSecuritySession,
  onOpenProfileEditor,
}: {
  viewer: Viewer;
  viewerInitial: string;
  isLoading: boolean;
  securityScore: number;
  securityIssueCount: number;
  isSaving: boolean;
  onOpenSecurity: () => void;
  onRestartSecuritySession: () => void;
  onOpenProfileEditor: () => void;
}) {
  const isAdmin = viewer.role === "admin";
  const loginMethod = "登录密码 + Google 验证器";
  const loginAccessScope = "登录地点变化时需邮箱确认";
  const systemAccessScope = viewer.isInitialAdmin ? "可管理用户与公共项目" : isAdmin ? "可管理用户与公共项目" : "无系统管理权限";
  return <section className="profile-page" aria-labelledby="profile-page-title">
    <div className="profile-hero">
      <div className="profile-identity">
        <span className={`profile-avatar profile-avatar-${viewer.avatarStyle}`} aria-hidden="true">{viewerInitial}</span>
        <div className="profile-hero-copy"><span className="eyebrow">个人资料</span><h2 id="profile-page-title">{viewer.displayName}</h2><div className="profile-account-line"><span title={viewer.email}>{viewer.email}</span><b className={`role-badge role-${viewer.role}`}>{isAdmin ? "管理员" : "普通用户"}</b></div></div>
      </div>
      <div className="profile-hero-actions">
        <button type="button" className="secondary-button profile-edit-button" onClick={onOpenProfileEditor}><Edit3 size={16} />编辑资料</button>
      </div>
    </div>
    <div className="profile-layout">
      <section className="profile-card" aria-labelledby="profile-account-title"><div className="profile-card-heading"><span className="profile-card-icon"><UserRound size={18} /></span><div><h3 id="profile-account-title">基本信息</h3><p>当前登录账户</p></div></div><div className="profile-card-body"><dl className="profile-details"><div><dt>登录账号</dt><dd title={viewer.email}>{viewer.email}</dd></div><div><dt>登录方式</dt><dd>{loginMethod}</dd></div><div><dt>访问限制</dt><dd>{loginAccessScope}</dd></div></dl></div></section>
      <section className="profile-card" aria-labelledby="profile-permission-title"><div className="profile-card-heading"><span className="profile-card-icon"><UsersRound size={18} /></span><div><h3 id="profile-permission-title">项目权限</h3><p>由系统角色决定</p></div></div><div className="profile-card-body"><div className="profile-permission-list"><div><span>个人项目</span><strong>仅自己管理</strong></div><div><span>公共项目</span><strong>{isAdmin ? "可查看和管理" : "仅查看"}</strong></div><div><span>系统范围</span><strong>{systemAccessScope}</strong></div></div></div></section>
      <section className="profile-card profile-security-card" aria-labelledby="profile-security-title"><div className="profile-card-heading"><span className="profile-card-icon"><ShieldCheck size={18} /></span><div><h3 id="profile-security-title">账户安全</h3><p>安全检查与会话状态</p></div></div><div className="profile-security-summary"><div><strong>{isLoading ? <Skeleton className="skeleton-score" /> : securityScore}</strong><span>基础安全评分</span></div><p>{isLoading ? <Skeleton className="skeleton-line skeleton-line-profile" /> : securityIssueCount === 0 ? "暂无基础风险" : `${securityIssueCount} 条风险待处理`}</p></div><div className="profile-security-footer"><span>空闲 15 分钟或最长 8 小时后重新登录</span><button type="button" className="secondary-button" onClick={onOpenSecurity} disabled={isLoading}>{isLoading ? "读取中" : "安全检查"}</button></div></section>
      <section className="profile-card profile-data-security-card" aria-labelledby="profile-data-security-title"><div className="profile-card-heading"><span className="profile-card-icon"><ShieldCheck size={18} /></span><div><h3 id="profile-data-security-title">敏感操作</h3><p>公共项目和系统管理</p></div></div><div className="profile-card-body profile-sensitive-body"><div className="profile-sensitive-actions"><button type="button" className="secondary-button" onClick={onRestartSecuritySession} disabled={isSaving}><ShieldCheck size={17} />重新验证</button></div><p className="profile-card-note">个人项目使用当前会话；公共项目与系统操作需 Google 验证码。</p></div></section>
    </div>
  </section>;
}

function AuthenticatorCode({ entry, itemId, onCopy, onReveal }: { entry: VaultTotp; itemId: string; onCopy: (value: string, label: string, itemId: string) => void; onReveal: () => void }) {
  const { config } = entry;
  const [now, setNow] = useState(() => Date.now());
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    const syncClock = () => {
      setNow(Date.now());
      timer = window.setTimeout(syncClock, 1_016 - (Date.now() % 1_000));
    };
    syncClock();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    void generateTotpCode(config, now)
      .then((nextCode) => {
        if (!cancelled) {
          setCode(nextCode);
          setError("");
        }
      })
      .catch(() => {
        if (!cancelled) setError("无法生成验证码");
      });
    return () => { cancelled = true; };
  }, [config, now, visible]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => {
      setVisible(false);
      setCode("");
      setError("");
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [visible]);

  const splitAt = Math.floor(config.digits / 2);
  const remaining = totpSecondsRemaining(config, now);

  return (
    <div className="totp-card">
      <div className="totp-heading"><span>{entry.label}</span><small>{totpLabel(config)}</small></div>
      <div className="totp-value">
        <strong>{visible ? (error || (code ? <>{code.slice(0, splitAt)} <span>{code.slice(splitAt)}</span></> : "··· ···")) : "••• •••"}</strong>
        <div className="totp-actions">
          <button className="icon-button" onClick={() => { const next = !visible; if (next) { setNow(Date.now()); onReveal(); setVisible(true); } else { setVisible(false); setCode(""); setError(""); } }} aria-label={visible ? "隐藏验证器代码" : "显示验证器代码"}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          <button className="icon-button" onClick={() => code && onCopy(code, `${entry.label}验证码`, itemId)} aria-label={`复制${entry.label}验证码`} disabled={!visible || !code}><Copy size={17} /></button>
        </div>
      </div>
      <div className="totp-timer" role="progressbar" aria-label="验证码有效时间" aria-valuemin={0} aria-valuemax={config.period} aria-valuenow={remaining}><span style={{ width: `${(remaining / config.period) * 100}%` }} /><small>{remaining} 秒后刷新</small></div>
    </div>
  );
}

function TotpEntryFields({
  entries,
  formId,
  isReading,
  onChange,
  onAdd,
  onRemove,
  onReadImage,
}: {
  entries: TotpFormEntry[];
  formId: "add" | "edit";
  isReading: boolean;
  onChange: (id: string, changes: Pick<TotpFormEntry, "label"> | Pick<TotpFormEntry, "value">) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onReadImage: (event: ChangeEvent<HTMLInputElement>, id: string) => void;
}) {
  return (
    <fieldset className="totp-entry">
      <legend>验证器密钥 <span>（可选，最多 3 个）</span></legend>
      <p className="totp-entry-intro">最多保存 3 组验证器。</p>
      <div className="totp-entry-list">
        {entries.map((entry, index) => {
          const entryInputId = `${formId}-totp-${entry.id}`;
          const entryImageId = `${entryInputId}-image`;
          const isStored = Boolean(entry.config && !entry.value);
          return (
            <div className="totp-entry-card" key={entry.id}>
              <div className="totp-entry-card-head">
                <label htmlFor={`${entryInputId}-label`}>用途名称<input id={`${entryInputId}-label`} value={entry.label} onChange={(event) => onChange(entry.id, { label: event.target.value })} maxLength={40} /></label>
                {(entries.length > 1 || isStored || Boolean(entry.value)) && <button type="button" className="totp-remove-button" onClick={() => onRemove(entry.id)}><Trash2 size={14} />移除</button>}
              </div>
              <label className="sr-only" htmlFor={entryInputId}>{entry.label || `验证器 ${index + 1} 密钥`}</label>
              <input id={entryInputId} type="text" value={entry.value} onChange={(event) => onChange(entry.id, { value: event.target.value })} placeholder={isStored ? "留空保留；粘贴新密钥可替换" : "粘贴二维码内容或 Setup Key"} autoComplete="off" spellCheck="false" />
              <div className="totp-entry-actions"><label className="totp-image-button" htmlFor={entryImageId}><ImageUp size={16} />{isReading ? "正在读取图片" : "从二维码图片读取"}</label><input id={entryImageId} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => onReadImage(event, entry.id)} disabled={isReading} />{isStored && <span className="totp-saved-state"><ShieldCheck size={14} />已保存</span>}</div>
            </div>
          );
        })}
      </div>
      {entries.length < 3 && <button type="button" className="secondary-button totp-add-button" onClick={onAdd}><Plus size={16} />添加验证器</button>}
      <p>图片仅在当前浏览器解析。</p>
    </fieldset>
  );
}

async function decodeTotpImage(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("请选择二维码图片文件。");
  if (file.size > 5 * 1024 * 1024) throw new Error("二维码图片不能超过 5 MB。");

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("无法读取这张二维码图片。"));
      nextImage.src = objectUrl;
    });
    const scale = Math.min(1, 2_048 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器无法读取二维码图片。");
    context.drawImage(image, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    const { default: jsQR } = await import("jsqr");
    const result = jsQR(imageData.data, width, height, { inversionAttempts: "attemptBoth" });
    if (!result?.data) throw new Error("未在图片中识别到可用二维码。请尝试更清晰的原图，或手动粘贴 Setup Key。");
    parseTotpInput(result.data);
    return result.data;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function auditLabel(action: string) {
  const labels: Record<string, string> = {
    item_created: "新增了项目",
    item_updated: "更新了项目",
    item_published_to_public: "将项目设为公共项目",
    item_deleted: "删除了项目",
    member_invited: "添加了系统用户",
    member_removed: "移除了系统用户",
    password_revealed: "查看了密码",
    totp_revealed: "查看了验证器代码",
    credential_copied: "复制了账号信息",
    totp_copied: "复制了验证器代码",
    system_user_created: "创建了系统用户",
    system_user_role_changed: "调整了系统用户角色",
    system_user_status_changed: "调整了系统用户状态",
    system_user_authenticator_reset: "重置了登录验证器",
    system_user_deleted: "删除了系统用户",
    account_password_changed: "更新了登录密码",
    embedded_page_created: "添加了内嵌页面",
    embedded_page_updated: "更新了内嵌页面",
    embedded_page_deleted: "删除了内嵌页面",
    embedded_origin_added: "添加了可信来源",
    embedded_origin_deleted: "移除了可信来源",
  };
  return labels[action] ?? "执行了安全操作";
}

function auditScopeLabel(action: string) {
  if (action.startsWith("system_user_") || action === "account_password_changed") return "系统用户";
  if (action.startsWith("embedded_page_") || action.startsWith("embedded_origin_")) return "内嵌页面";
  return "公共项目";
}

function embeddedAuditDetail(action: string, itemId: string | null) {
  if (!itemId) return null;
  if (action.startsWith("embedded_origin_")) return itemId;
  try {
    const subject = JSON.parse(itemId) as { name?: unknown; origin?: unknown };
    if (typeof subject.name !== "string" || typeof subject.origin !== "string") return null;
    return `${subject.name} · ${subject.origin}`;
  } catch {
    return null;
  }
}

function AuditEventRow({ entry }: { entry: AuditEntry }) {
  const scope = auditScopeLabel(entry.action);
  const Icon = scope === "系统用户" ? UserCog : scope === "内嵌页面" ? LayoutPanelLeft : KeyRound;
  const tone = scope === "系统用户" ? "user" : scope === "内嵌页面" ? "embedded" : "project";
  const detail = scope === "内嵌页面" ? embeddedAuditDetail(entry.action, entry.itemId) : null;
  return <li>
    <span className={`audit-event-icon is-${tone}`} aria-hidden="true"><Icon size={16} /></span>
    <div className="audit-event-copy"><strong>{auditLabel(entry.action)}</strong><span>{scope}</span>{detail && <small title={detail}>{detail}</small>}</div>
    <span className="audit-event-actor" title={entry.actorEmail}>{entry.actorEmail}</span>
    <time>{entry.createdAt}</time>
  </li>;
}


export default function VaultClient({ viewer: initialViewer }: { viewer: Viewer }) {
  const [viewer, setViewer] = useState<Viewer>(initialViewer);
  const [items, setItems] = useState<VaultItemSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<VaultItem | null>(null);
  const [query, setQuery] = useState("");
  const [space, setSpace] = useState<Space>("全部");
  const [category, setCategory] = useState("全部");
  const [sortOrder, setSortOrder] = useState<SortOrder>("updated");
  const [collection, setCollection] = useState<Collection>("all");
  const [page, setPage] = useState<VaultPage>("vault");
  const [securityFocus, setSecurityFocus] = useState<SecurityFocus>("all");
  const [revealed, setRevealed] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingItem, setEditingItem] = useState<VaultItem | null>(null);
  const [pendingPublicPublish, setPendingPublicPublish] = useState<PendingPublicPublish | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [showUserCreateDialog, setShowUserCreateDialog] = useState(false);
  const [systemUserAction, setSystemUserAction] = useState<SystemUserAction | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [serverSessionReady, setServerSessionReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [vaultCurrentPage, setVaultCurrentPage] = useState(1);
  const [vaultPagination, setVaultPagination] = useState<Pagination>(emptyPagination);
  const [categoryNames, setCategoryNames] = useState<string[]>([]);
  const [spaceCounts, setSpaceCounts] = useState<Record<Space, number>>({ 全部: 0, 个人: 0, 公共: 0 });
  const [securitySummary, setSecuritySummary] = useState<VaultSecuritySummary>(emptySecuritySummary);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditChainIntegrity, setAuditChainIntegrity] = useState<AuditIntegrity>("unknown");
  const [auditCategory, setAuditCategory] = useState<AuditCategory>("all");
  const [auditCurrentPage, setAuditCurrentPage] = useState(1);
  const [auditPagination, setAuditPagination] = useState<Pagination>(emptyPagination);
  const [isAuditLoading, setIsAuditLoading] = useState(false);
  const [auditLoadError, setAuditLoadError] = useState<string | null>(null);
  const [auditLoadAttempt, setAuditLoadAttempt] = useState(0);
  const [systemUsers, setSystemUsers] = useState<SystemUser[]>([]);
  const [systemUserEmail, setSystemUserEmail] = useState("");
  const [systemUserSecurityEmail, setSystemUserSecurityEmail] = useState("");
  const [systemUserRole, setSystemUserRole] = useState<"admin" | "user">("user");
  const [publicItemCode, setPublicItemCode] = useState("");
  const [deleteItemCode, setDeleteItemCode] = useState("");
  const [systemUserCode, setSystemUserCode] = useState("");
  const [systemUserProvisioning, setSystemUserProvisioning] = useState<SystemUserProvisioning | null>(null);
  const [authenticatorRecovery, setAuthenticatorRecovery] = useState<AuthenticatorRecovery | null>(null);
  const [userManagementTab, setUserManagementTab] = useState<UserManagementTab>("users");
  const [userQuery, setUserQuery] = useState("");
  const [isUsersLoading, setIsUsersLoading] = useState(false);
  const [userLoadError, setUserLoadError] = useState<string | null>(null);
  const [userCurrentPage, setUserCurrentPage] = useState(1);
  const [userPagination, setUserPagination] = useState<Pagination>(emptyPagination);
  const [userLoadAttempt, setUserLoadAttempt] = useState(0);
  const [embeddedPageId, setEmbeddedPageId] = useState<string | undefined>();
  const [embeddedNavigationPages, setEmbeddedNavigationPages] = useState<EmbeddedNavigationPage[]>([]);
  const [embeddedNavigationAttempt, setEmbeddedNavigationAttempt] = useState(0);
  const [embeddedPageDialogOpen, setEmbeddedPageDialogOpen] = useState(false);
  const [showProfileEditor, setShowProfileEditor] = useState(false);
  const [profileDisplayNameInput, setProfileDisplayNameInput] = useState(initialViewer.displayName);
  const [profileAvatarStyleInput, setProfileAvatarStyleInput] = useState<ProfileAvatarStyle>(initialViewer.avatarStyle);
  const [showSecurityReverify, setShowSecurityReverify] = useState(false);
  const [securityReverifyCode, setSecurityReverifyCode] = useState("");
  const [securityReverifyError, setSecurityReverifyError] = useState("");
  const dialogOriginRef = useRef<HTMLElement | null>(null);
  const [isReadingTotp, setIsReadingTotp] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [form, setForm] = useState<CredentialForm>(emptyCredentialForm);
  const [editForm, setEditForm] = useState<CredentialForm>(emptyCredentialForm);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mainContentRef = useRef<HTMLElement>(null);

  const debouncedVaultQuery = useDebouncedValue(query);
  const debouncedUserQuery = useDebouncedValue(userQuery);
  const categoryOptions = useMemo(() => [{ value: "全部", label: "全部分类" }, ...categoryNames.map((value) => ({ value, label: value }))], [categoryNames]);
  const activeCategory = category === "全部" || categoryNames.includes(category) ? category : "全部";

  const activeSelectedId = items.some((item) => item.id === selectedId) ? selectedId : items[0]?.id ?? null;
  const selected = selectedDetail?.id === activeSelectedId ? selectedDetail : null;
  const selectedSummary = items.find((item) => item.id === activeSelectedId) ?? null;
  const listTitle = collection === "security"
      ? securityFocus === "all" ? "待处理账户" : securityIssueCopy[securityFocus].label
      : space === "全部" ? "全部项目" : `${space}项目`;
  const viewerInitial = viewer.displayName.trim().slice(0, 1).toLocaleUpperCase() || "你";
  const isAdmin = viewer.role === "admin";
  const activeDialogKey = embeddedPageDialogOpen ? "embedded-page" : showSecurityReverify ? "security-reverify" : showProfileEditor ? "profile-editor" : authenticatorRecovery ? "authenticator-recovery" : systemUserProvisioning ? "user-provisioning" : pendingPublicPublish ? "publish" : deleteTarget ? "delete" : systemUserAction ? "system-user-action" : showUserCreateDialog ? "user-create" : editingItem ? "edit" : showAdd ? "add" : null;
  const isModalOpen = activeDialogKey !== null;
  const pageTransitionKey = page === "users" ? `${page}-${userManagementTab}` : page;
  const { totalItems, weakPasswordCount, reusedPasswordCount, missingTwoFactorCount, securityIssueCount, score: securityScore } = securitySummary;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/security/session", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then(async (response) => {
      if (!response.ok) throw new Error("安全会话已结束。");
      if (!cancelled) {
        if (new URLSearchParams(window.location.search).get("reauth") === "1") {
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
          setToast("登录已重新验证；敏感操作可在 10 分钟内进行");
        }
        setServerSessionReady(true);
      }
    }).catch(() => {
      if (!cancelled) window.location.assign("/login");
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!serverSessionReady) return;
    let cancelled = false;
    void fetch("/api/embedded-pages", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { pages?: EmbeddedNavigationPage[] };
        if (!response.ok) throw new Error("无法读取内嵌页面。");
        if (!cancelled) setEmbeddedNavigationPages(payload.pages ?? []);
      })
      .catch(() => { if (!cancelled) setEmbeddedNavigationPages([]); });
    return () => { cancelled = true; };
  }, [embeddedNavigationAttempt, serverSessionReady]);

  useEffect(() => {
    const syncFromAddress = (moveFocus = false) => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("view") === "users" && !isAdmin) {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
      }
      const route = vaultRouteFromSearch(window.location.search, isAdmin);
      setPage(route.page);
      setCollection(route.collection);
      setSecurityFocus(route.securityFocus);
      setUserManagementTab(route.userManagementTab);
      setAuditCategory(route.auditCategory);
      setEmbeddedPageId(route.embeddedPageId);
      if (moveFocus) focusMainContent();
    };

    syncFromAddress();
    const onPopState = () => syncFromAddress(true);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isAdmin]);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (isModalOpen) return;
        if (page !== "vault") {
          setPage("vault");
          setCollection("all");
          setSpace("全部");
          setCategory("全部");
          setSortOrder("updated");
          setSecurityFocus("all");
          setVaultCurrentPage(1);
          window.history.pushState(null, "", `${window.location.pathname}${window.location.hash}`);
          window.setTimeout(() => searchInputRef.current?.focus(), 0);
        } else {
          searchInputRef.current?.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        setShowAdd(false);
        setEditingItem(null);
        setPendingPublicPublish(null);
        setDeleteTarget(null);
        setPublicItemCode("");
        setDeleteItemCode("");
        setShowUserCreateDialog(false);
        setSystemUserAction(null);
        setSystemUserCode("");
        setSystemUserProvisioning(null);
        setAuthenticatorRecovery(null);
        setShowProfileEditor(false);
        setShowSecurityReverify(false);
        setSecurityReverifyCode("");
        setSecurityReverifyError("");
        setMobileNav(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isModalOpen, page]);

  useEffect(() => {
    if (!isModalOpen) return;
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
    };
  }, [isModalOpen]);

  useEffect(() => {
    if (!isModalOpen) {
      const origin = dialogOriginRef.current;
      dialogOriginRef.current = null;
      if (origin?.isConnected) window.setTimeout(() => origin.focus({ preventScroll: true }), 0);
      return;
    }

    if (!dialogOriginRef.current && document.activeElement instanceof HTMLElement) {
      dialogOriginRef.current = document.activeElement;
    }

    const getActiveDialog = () => {
      const layers = document.querySelectorAll<HTMLElement>(".modal-layer");
      return layers.item(layers.length - 1)?.querySelector<HTMLElement>('[role="dialog"]') ?? null;
    };
    const getFocusable = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    const focusInitialControl = () => {
      const dialog = getActiveDialog();
      if (!dialog) return;
      const controls = getFocusable(dialog);
      const preferred = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus], [autofocus]");
      (preferred ?? controls[0])?.focus({ preventScroll: true });
    };
    const trapFocus = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = getActiveDialog();
      if (!dialog) return;
      const controls = getFocusable(dialog);
      if (controls.length === 0) return;
      const current = document.activeElement as HTMLElement | null;
      if (!current || !dialog.contains(current)) {
        event.preventDefault();
        controls[0].focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const focusTimer = window.setTimeout(focusInitialControl, 0);
    document.addEventListener("keydown", trapFocus);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", trapFocus);
    };
  }, [activeDialogKey, isModalOpen]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadVault() {
      setIsLoading(true);
      setLoadError(null);
      try {
        const search = new URLSearchParams({
          page: String(vaultCurrentPage),
          query: debouncedVaultQuery,
          space,
          category: activeCategory,
          collection,
          securityFocus,
          sortOrder,
        });
        const response = await fetch(`/api/vault?${search.toString()}`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) endSession();
        const payload = await readJsonResponse<{
          items?: VaultItemSummary[];
          categoryNames?: string[];
          spaceCounts?: Record<Space, number>;
          security?: VaultSecuritySummary;
          pagination?: Pagination;
          error?: string;
        }>(response, "无法读取项目。");
        if (!response.ok) throw new Error(payload?.error ?? "无法读取项目。");
        if (!payload) throw new Error("服务器没有返回项目数据，请重新加载。");
        if (cancelled) return;

        const loadedItems = payload.items ?? [];
        setItems(loadedItems);
        setCategoryNames(payload.categoryNames ?? []);
        setSpaceCounts(payload.spaceCounts ?? { 全部: 0, 个人: 0, 公共: 0 });
        setSecuritySummary(payload.security ?? emptySecuritySummary);
        const nextPagination = payload.pagination ?? emptyPagination;
        setVaultPagination(nextPagination);
        setVaultCurrentPage((current) => current === nextPagination.page ? current : nextPagination.page);
        setSelectedId((current) => loadedItems.some((item) => item.id === current) ? current : loadedItems[0]?.id ?? null);
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "无法读取项目。";
          setLoadError(message);
          setToast(message);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    if (serverSessionReady) void loadVault();
    return () => { cancelled = true; controller.abort(); };
  }, [activeCategory, collection, debouncedVaultQuery, loadAttempt, securityFocus, serverSessionReady, sortOrder, space, vaultCurrentPage]);

  useEffect(() => {
    if (!serverSessionReady || page !== "users" || userManagementTab !== "users" || !isAdmin) return;
    let cancelled = false;
    const controller = new AbortController();

    async function loadUsers() {
      setIsUsersLoading(true);
      setUserLoadError(null);
      try {
        const search = new URLSearchParams({ page: String(userCurrentPage), query: debouncedUserQuery });
        const payload = await requestVault<{ users: SystemUser[]; pagination?: Pagination }>(`/api/users?${search.toString()}`, { method: "GET", signal: controller.signal });
        if (cancelled) return;
        const nextPagination = payload.pagination ?? emptyPagination;
        setSystemUsers(payload.users ?? []);
        setUserPagination(nextPagination);
        setUserCurrentPage((current) => current === nextPagination.page ? current : nextPagination.page);
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "无法读取系统用户。";
          setUserLoadError(message);
          setToast(message);
        }
      } finally {
        if (!cancelled) setIsUsersLoading(false);
      }
    }

    void loadUsers();
    return () => { cancelled = true; controller.abort(); };
  }, [debouncedUserQuery, isAdmin, page, serverSessionReady, userCurrentPage, userLoadAttempt, userManagementTab]);

  useEffect(() => {
    if (!serverSessionReady || page !== "users" || userManagementTab !== "users" || !isAdmin) return;
    const timer = window.setInterval(() => setUserLoadAttempt((current) => current + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [isAdmin, page, serverSessionReady, userManagementTab]);

  useEffect(() => {
    if (!serverSessionReady || page !== "users" || userManagementTab !== "audit" || !isAdmin) return;
    let cancelled = false;
    const controller = new AbortController();

    async function loadAudit() {
      setIsAuditLoading(true);
      setAuditLoadError(null);
      try {
        const search = new URLSearchParams({ page: String(auditCurrentPage), category: auditCategory });
        const payload = await requestVault<{ audit: AuditEntry[]; chainIntegrity?: Exclude<AuditIntegrity, "unknown">; pagination?: Pagination }>(`/api/vault/audit-log?${search.toString()}`, { method: "GET", signal: controller.signal });
        if (cancelled) return;
        const nextPagination = payload.pagination ?? emptyPagination;
        setAudit(payload.audit ?? []);
        setAuditChainIntegrity(payload.chainIntegrity ?? "legacy");
        setAuditPagination(nextPagination);
        setAuditCurrentPage((current) => current === nextPagination.page ? current : nextPagination.page);
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "无法读取操作审计。";
          setAuditLoadError(message);
          setToast(message);
        }
      } finally {
        if (!cancelled) setIsAuditLoading(false);
      }
    }

    void loadAudit();
    return () => { cancelled = true; controller.abort(); };
  }, [auditCategory, auditCurrentPage, auditLoadAttempt, isAdmin, page, serverSessionReady, userManagementTab]);

  useEffect(() => {
    if (!serverSessionReady || !activeSelectedId) return;

    let cancelled = false;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setSelectedDetail(null);
      setDetailError(null);
      setIsDetailLoading(true);
      setRevealed(false);
      try {
        const payload = await requestVault<{ item: VaultItem }>(`/api/vault/items/${activeSelectedId}`, { method: "GET", signal: controller.signal });
        if (!cancelled) setSelectedDetail(payload.item);
      } catch (error) {
        if (!cancelled) setDetailError(error instanceof Error ? error.message : "无法读取项目详情。");
      } finally {
        if (!cancelled) setIsDetailLoading(false);
      }
    });

    return () => { cancelled = true; controller.abort(); };
  }, [activeSelectedId, detailAttempt, serverSessionReady]);

  useEffect(() => {
    let idleTimer = window.setTimeout(endSession, 15 * 60_000);
    const resetIdleTimer = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(endSession, 15 * 60_000);
    };
    const watchedEvents: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart"];
    watchedEvents.forEach((eventName) => window.addEventListener(eventName, resetIdleTimer, { passive: true }));

    return () => {
      window.clearTimeout(idleTimer);
      watchedEvents.forEach((eventName) => window.removeEventListener(eventName, resetIdleTimer));
    };
  }, []);

  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => {
      setRevealed(false);
      setToast("密码已自动隐藏");
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [revealed, activeSelectedId]);

  useEffect(() => {
    const concealOnBackground = () => {
      if (document.visibilityState === "hidden") setRevealed(false);
    };
    document.addEventListener("visibilitychange", concealOnBackground);
    return () => document.removeEventListener("visibilitychange", concealOnBackground);
  }, []);

  function endSession() {
    endCurrentSecuritySession("/login");
  }

  function restartSecuritySession() {
    setSecurityReverifyCode("");
    setSecurityReverifyError("");
    setShowSecurityReverify(true);
  }

  async function renewSecuritySession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving) return;
    if (!/^\d{6}$/.test(securityReverifyCode)) {
      setSecurityReverifyError("请输入 6 位 Google 验证码。");
      return;
    }
    setIsSaving(true);
    setSecurityReverifyError("");
    try {
      const response = await fetch("/api/security/session", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: securityReverifyCode }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
      if (response.status === 401 && payload.code === "SECURITY_SESSION_REQUIRED") {
        endCurrentSecuritySession("/login");
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? "重新验证未完成，请重试。");
      setShowSecurityReverify(false);
      setSecurityReverifyCode("");
      setToast("已重新验证；敏感操作可在 10 分钟内进行");
    } catch (error) {
      setSecurityReverifyError(error instanceof Error ? error.message : "重新验证未完成，请重试。");
    } finally {
      setIsSaving(false);
    }
  }

  async function requestVault<T>(path: string, init: RequestInit) {
    const response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const payload = response.status === 204 ? null : await readJsonResponse<T & { error?: string; code?: string }>(response, "操作未完成，请稍后重试。");
    if (response.status === 401 && payload?.code === "SECURITY_SESSION_REQUIRED" && path !== "/api/security/session") endCurrentSecuritySession("/login");
    if (payload?.code === "RECENT_SECURITY_CONFIRMATION_REQUIRED") restartSecuritySession();
    if (!response.ok) throw new Error(payload?.error ?? "操作未完成，请稍后重试。");
    return payload as T;
  }

  function recordAudit(action: "password_revealed" | "totp_revealed" | "credential_copied" | "totp_copied", itemId: string) {
    void requestVault("/api/vault/audit", { method: "POST", body: JSON.stringify({ action, itemId }) }).catch(() => undefined);
  }

  async function copyValue(value: string, label: string, itemId?: string) {
    try {
      await navigator.clipboard.writeText(value);
      if (itemId) recordAudit(label.includes("验证码") ? "totp_copied" : "credential_copied", itemId);
      setToast(`${label}已复制`);
    } catch {
      setToast("复制失败");
    }
  }

  async function updateRemoteItem(item: VaultItem, changes: Record<string, unknown>, userCode?: string) {
    setIsSaving(true);
    try {
      const payload = await requestVault<{ item: VaultItem }>(`/api/vault/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...item, ...changes, ...(userCode ? { userCode } : {}) }),
      });
      setSelectedId(payload.item.id);
      setSelectedDetail(payload.item);
      setLoadAttempt((current) => current + 1);
      return payload.item;
    } finally {
      setIsSaving(false);
    }
  }

  async function submitCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (form.group === "公共") {
      setPublicItemCode("");
      setPendingPublicPublish({ form });
      return;
    }
    await saveCredential(form);
  }

  async function saveCredential(credential: CredentialForm, userCode?: string) {
    setIsSaving(true);
    try {
      const payload = await requestVault<{ item: VaultItem }>("/api/vault/items", {
        method: "POST",
        body: JSON.stringify({ ...credential, type: "登录", twoFactor: false, favorite: false, brand: "new", note: "", ...(userCode ? { userCode } : {}) }),
      });
      setVaultCurrentPage(1);
      setSelectedId(payload.item.id);
      setSelectedDetail(payload.item);
      setLoadAttempt((current) => current + 1);
      setForm(emptyCredentialForm());
      setShowNewPassword(false);
      setShowAdd(false);
      setPendingPublicPublish(null);
      setPublicItemCode("");
      setToast(credential.group === "公共" ? "公共项目已加密保存" : "项目已加密保存");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "项目未保存。");
    } finally {
      setIsSaving(false);
    }
  }

  function generatePassword() {
    setForm((current) => ({ ...current, password: generateStrongPassword() }));
    setToast("已生成 20 位强密码");
  }

  function openEdit(item: VaultItem) {
    setEditForm({ name: item.name, domain: item.domain, username: item.username, password: item.password, category: item.category, group: item.group, totpEntries: item.totps.length > 0 ? item.totps.map((entry, index) => newTotpFormEntry(index, entry.config, entry.label)) : [newTotpFormEntry()] });
    setEditingItem(item);
    setPublicItemCode("");
    setRevealed(false);
    setShowEditPassword(false);
  }

  function generateEditPassword() {
    setEditForm((current) => ({ ...current, password: generateStrongPassword() }));
    setToast("已生成 20 位强密码");
  }

  async function submitEditCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingItem) return;

    if (editingItem.group === "个人" && editForm.group === "公共") {
      setPublicItemCode("");
      setPendingPublicPublish({ item: editingItem, form: editForm });
      return;
    }

    await saveEditedCredential(editingItem, editForm, editingItem.group === "公共" ? publicItemCode : undefined);
  }

  async function saveEditedCredential(item: VaultItem, changes: CredentialForm, userCode?: string) {
    try {
      const requiresTotp = item.group === "公共" || changes.group === "公共";
    if (requiresTotp && !/^\d{6}$/.test(userCode ?? "")) throw new Error("请输入 6 位 Google 验证码。");
      await updateRemoteItem(item, changes, userCode);
      setEditingItem(null);
      setPendingPublicPublish(null);
      setPublicItemCode("");
      setShowEditPassword(false);
      setToast("项目已加密更新");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "项目未更新。");
    }
  }

  async function deleteCredential() {
    if (!deleteTarget) return;
    setIsSaving(true);
    try {
      const requiresTotp = deleteTarget.group === "公共";
    if (requiresTotp && !/^\d{6}$/.test(deleteItemCode)) throw new Error("请输入 6 位 Google 验证码。");
      await requestVault(`/api/vault/items/${deleteTarget.id}`, { method: "DELETE", body: JSON.stringify(requiresTotp ? { userCode: deleteItemCode } : {}) });
      setSelectedId(null);
      setSelectedDetail(null);
      setDeleteTarget(null);
      setDeleteItemCode("");
      setRevealed(false);
      setLoadAttempt((current) => current + 1);
      setToast(`已删除“${deleteTarget.name}”`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "项目未删除。");
    } finally {
      setIsSaving(false);
    }
  }

  function focusMainContent() {
    window.setTimeout(() => mainContentRef.current?.focus({ preventScroll: true }), 0);
  }

  function writeRoute(next: VaultRoute, replace = false) {
    const search = vaultRouteSearch(next);
    const destination = `${window.location.pathname}${search}${window.location.hash}`;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` === destination) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", destination);
  }

  function openUserManagement() {
    if (!isAdmin) return;
    setPage("users");
    setUserManagementTab("users");
    setShowUserCreateDialog(false);
    setUserQuery("");
    setUserCurrentPage(1);
    setAuditCategory("all");
    setAuditCurrentPage(1);
    writeRoute({ page: "users", collection: "all", securityFocus: "all", userManagementTab: "users", auditCategory: "all" });
    focusMainContent();
  }

  function selectUserManagementTab(tab: UserManagementTab) {
    if (!isAdmin) return;
    setPage("users");
    setUserManagementTab(tab);
    writeRoute({ page: "users", collection: "all", securityFocus: "all", userManagementTab: tab, auditCategory: tab === "audit" ? auditCategory : "all" });
  }

  function handleUserManagementTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    selectUserManagementTab(userManagementTab === "users" ? "audit" : "users");
    window.setTimeout(() => document.getElementById(userManagementTab === "users" ? "audit-tab" : "users-tab")?.focus(), 0);
  }

  function openAccountManagement() {
    setPage("vault");
    setCollection("all");
    setSpace("全部");
    setCategory("全部");
    setSortOrder("updated");
    setSecurityFocus("all");
    setVaultCurrentPage(1);
    setMobileNav(false);
    writeRoute({ page: "vault", collection: "all", securityFocus: "all", userManagementTab: "users", auditCategory: "all" });
    focusMainContent();
  }

  function openProfile() {
    setPage("profile");
    setMobileNav(false);
    writeRoute({ page: "profile", collection: "all", securityFocus: "all", userManagementTab: "users", auditCategory: "all" });
    focusMainContent();
  }

  function openProfileEditor() {
    setProfileDisplayNameInput(viewer.displayName);
    setProfileAvatarStyleInput(viewer.avatarStyle);
    setShowProfileEditor(true);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    try {
      const payload = await requestVault<{ profile: Pick<Viewer, "displayName" | "avatarStyle"> }>("/api/account/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName: profileDisplayNameInput, avatarStyle: profileAvatarStyleInput }),
      });
      setViewer((current) => ({ ...current, ...payload.profile }));
      setShowProfileEditor(false);
      setToast("个人资料已保存");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "个人资料未保存。");
    } finally {
      setIsSaving(false);
    }
  }

  function selectEmbeddedPage(pageId: string) {
    setPage("embedded");
    setEmbeddedPageId(pageId);
    writeRoute({ page: "embedded", collection: "all", securityFocus: "all", userManagementTab: "users", auditCategory: "all", embeddedPageId: pageId }, true);
  }

  function openEmbeddedPage(pageId: string) {
    selectEmbeddedPage(pageId);
    setMobileNav(false);
    focusMainContent();
  }

  function refreshEmbeddedNavigation() {
    setEmbeddedNavigationAttempt((current) => current + 1);
  }

  function openEmbeddedPageManagement() {
    if (!isAdmin) return;
    setPage("embedded-manage");
    setMobileNav(false);
    writeRoute({ page: "embedded-manage", collection: "all", securityFocus: "all", userManagementTab: "users", auditCategory: "all" });
    focusMainContent();
  }

  function openSecurityReview(focus: SecurityFocus = "all") {
    setPage("vault");
    setCollection("security");
    setQuery("");
    setSpace("全部");
    setCategory("全部");
    setSortOrder("updated");
    setSecurityFocus(focus);
    setVaultCurrentPage(1);
    setMobileNav(false);
    writeRoute({ page: "vault", collection: "security", securityFocus: focus, userManagementTab: "users", auditCategory: "all" });
    focusMainContent();
  }

  function clearVaultFilters() {
    setQuery("");
    setSpace("全部");
    setCategory("全部");
    setSortOrder("updated");
    setSecurityFocus("all");
    setVaultCurrentPage(1);
  }

  async function createSystemUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{6}$/.test(systemUserCode)) {
      setToast("请输入 6 位 Google 验证码。");
      return;
    }
    setIsSaving(true);
    try {
      const created = await requestVault<{ user: SystemUser; activation: Omit<SystemUserProvisioning, "account"> }>("/api/users", {
        method: "POST",
        body: JSON.stringify({ email: systemUserEmail, securityEmail: systemUserSecurityEmail, role: systemUserRole, userCode: systemUserCode }),
      });
      setSystemUserProvisioning({ account: created.user.email, ...created.activation });
      setSystemUserEmail("");
      setSystemUserSecurityEmail("");
      setSystemUserCode("");
      setSystemUserRole("user");
      setShowUserCreateDialog(false);
      setUserQuery("");
      setUserCurrentPage(1);
      setUserLoadAttempt((current) => current + 1);
      setLoadAttempt((current) => current + 1);
      setToast("用户已创建，等待完成激活。");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法创建系统用户。");
    } finally {
      setIsSaving(false);
    }
  }

  async function updateSystemUser(user: SystemUser, changes: Partial<Pick<SystemUser, "role" | "status">>) {
    if (!/^\d{6}$/.test(systemUserCode)) { setToast("请输入 6 位 Google 验证码。"); return false; }
    setIsSaving(true);
    try {
      await requestVault<{ user: SystemUser }>("/api/users", {
        method: "PATCH",
        body: JSON.stringify({ email: user.email, ...changes, userCode: systemUserCode }),
      });
      setUserLoadAttempt((current) => current + 1);
      setLoadAttempt((current) => current + 1);
      setToast(changes.status ? (changes.status === "suspended" ? "用户已停用" : "用户已重新启用") : "用户角色已更新");
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法更新该用户。");
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteSystemUser(user: SystemUser) {
    if (user.isCurrent) return false;
    if (!/^\d{6}$/.test(systemUserCode)) { setToast("请输入 6 位 Google 验证码。"); return false; }
    setIsSaving(true);
    try {
      await requestVault("/api/users", { method: "DELETE", body: JSON.stringify({ email: user.email, userCode: systemUserCode }) });
      setUserLoadAttempt((current) => current + 1);
      setLoadAttempt((current) => current + 1);
      setToast("系统用户已删除");
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法删除该用户。");
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function resetSystemUserAuthenticator(user: SystemUser) {
    if (!/^\d{6}$/.test(systemUserCode)) { setToast("请输入 6 位 Google 验证码。"); return false; }
    setIsSaving(true);
    try {
      const reset = await requestVault<AuthenticatorRecovery>("/api/users", {
        method: "POST",
        body: JSON.stringify({ action: "reset_authenticator", email: user.email, userCode: systemUserCode }),
      });
      setAuthenticatorRecovery(reset);
      setUserLoadAttempt((current) => current + 1);
      setLoadAttempt((current) => current + 1);
      setToast("登录验证器已重置，旧会话已失效。");
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法重置该用户的登录验证器。");
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function resendSystemUserActivation(user: SystemUser) {
    if (!/^\d{6}$/.test(systemUserCode)) { setToast("请输入 6 位 Google 验证码。"); return false; }
    setIsSaving(true);
    try {
      const resent = await requestVault<{ user: SystemUser; activation: Omit<SystemUserProvisioning, "account"> }>("/api/users", {
        method: "POST",
        body: JSON.stringify({ action: "resend_activation", email: user.email, userCode: systemUserCode }),
      });
      setSystemUserProvisioning({ account: resent.user.email, ...resent.activation });
      setUserLoadAttempt((current) => current + 1);
      setToast("已重新发送激活码。");
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法重新发送激活码。");
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function confirmSystemUserAction() {
    if (!systemUserAction) return;
    const completed = systemUserAction.kind === "delete"
      ? await deleteSystemUser(systemUserAction.user)
      : systemUserAction.kind === "suspend"
        ? await updateSystemUser(systemUserAction.user, { status: "suspended" })
          : systemUserAction.kind === "activate"
          ? await updateSystemUser(systemUserAction.user, { status: "active" })
          : systemUserAction.kind === "resend-activation"
            ? await resendSystemUserActivation(systemUserAction.user)
          : systemUserAction.kind === "reset-authenticator"
            ? await resetSystemUserAuthenticator(systemUserAction.user)
          : systemUserAction.role
            ? await updateSystemUser(systemUserAction.user, { role: systemUserAction.role })
            : false;
    if (completed) { setSystemUserAction(null); setSystemUserCode(""); }
  }

  function updateTotpEntry(target: "add" | "edit", id: string, changes: Pick<TotpFormEntry, "label"> | Pick<TotpFormEntry, "value">) {
    const update = (current: CredentialForm) => ({ ...current, totpEntries: current.totpEntries.map((entry) => entry.id === id ? { ...entry, ...changes } : entry) });
    if (target === "add") setForm(update);
    else setEditForm(update);
  }

  function addTotpEntry(target: "add" | "edit") {
    const update = (current: CredentialForm) => ({ ...current, totpEntries: [...current.totpEntries, newTotpFormEntry(current.totpEntries.length)] });
    if (target === "add") setForm(update);
    else setEditForm(update);
  }

  function removeTotpEntry(target: "add" | "edit", id: string) {
    const update = (current: CredentialForm) => {
      const totpEntries = current.totpEntries.filter((entry) => entry.id !== id);
      return { ...current, totpEntries: totpEntries.length > 0 ? totpEntries : [newTotpFormEntry()] };
    };
    if (target === "add") setForm(update);
    else setEditForm(update);
  }

  async function importTotpFromImage(event: ChangeEvent<HTMLInputElement>, target: "add" | "edit", id: string) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setIsReadingTotp(true);
    try {
      const totpInput = await decodeTotpImage(file);
      updateTotpEntry(target, id, { value: totpInput });
      setToast("已在本地读取二维码，验证器配置将在保存时加密写入");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "二维码读取失败。");
    } finally {
      setIsReadingTotp(false);
    }
  }

  return (
    <div className="vault-app">
      <div className="vault-ambient" aria-hidden="true">
        <Spotlight className="vault-spotlight" fill="#d9eed9" />
        <Spotlight className="vault-spotlight-secondary" fill="#f3d7e2" />
      </div>

      <div className={`sidebar-backdrop ${mobileNav ? "is-visible" : ""}`} onClick={() => setMobileNav(false)} aria-hidden="true" />
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`} aria-label="主导航">
        <div className="brand-lockup">
          <span className="brand-icon" aria-hidden="true"><ShieldCheck size={22} strokeWidth={2.2} /></span>
          <div><strong>djmima</strong><span>安全工作台</span></div>
          <button className="icon-button sidebar-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={20} /></button>
        </div>

        <nav className="main-nav">
          <p className="nav-label">工作台</p>
          <button className={`nav-item ${page === "vault" ? "is-active" : ""}`} aria-current={page === "vault" ? "page" : undefined} onClick={openAccountManagement}><KeyRound size={18} /><span>账户管理</span></button>

          {isAdmin && <><p className="nav-label nav-label-spaced">系统</p><button className={`nav-item ${page === "users" ? "is-active" : ""}`} aria-current={page === "users" ? "page" : undefined} onClick={() => { setMobileNav(false); openUserManagement(); }}><UserCog size={18} /><span>用户管理</span></button><button className={`nav-item ${page === "embedded-manage" ? "is-active" : ""}`} aria-current={page === "embedded-manage" ? "page" : undefined} onClick={openEmbeddedPageManagement}><Settings2 size={18} /><span>内嵌管理</span></button></>}

          {embeddedNavigationPages.length > 0 && <><p className="nav-label nav-label-spaced">工作台</p><div className="embedded-workbench-nav" role="group" aria-label="已发布内嵌页面">{embeddedNavigationPages.map((embeddedPage) => <button key={embeddedPage.id} className={`nav-item ${page === "embedded" && embeddedPageId === embeddedPage.id ? "is-active" : ""}`} aria-current={page === "embedded" && embeddedPageId === embeddedPage.id ? "page" : undefined} onClick={() => openEmbeddedPage(embeddedPage.id)}><LayoutPanelLeft size={18} /><span title={embeddedPage.name}>{embeddedPage.name}</span></button>)}</div></>}

          <p className="nav-label nav-label-spaced">个人</p>
          <button className={`nav-item ${page === "profile" ? "is-active" : ""}`} aria-current={page === "profile" ? "page" : undefined} onClick={openProfile}><UserRound size={18} /><span>个人信息</span></button>
        </nav>

        <div className="sidebar-tip">
          <ShieldCheck size={18} aria-hidden="true" />
          <div><strong>安全会话</strong><span>已开启</span></div>
        </div>
      </aside>

      <main ref={mainContentRef} id="main-content" className="main-shell" tabIndex={-1}>
        <header className={`topbar ${page === "profile" || page === "embedded" || page === "embedded-manage" || (page === "users" && userManagementTab === "audit") ? "is-compact" : ""}`}>
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={21} /></button>
          <div className="page-title"><h1>{page === "profile" ? "个人信息" : page === "users" ? "用户管理" : page === "embedded-manage" ? "内嵌页面管理" : page === "embedded" ? "内嵌页面" : "账户管理"}</h1><p>{page === "profile" ? "账户、权限与安全状态" : page === "users" ? userManagementTab === "audit" ? "管理操作记录" : "系统用户与角色" : page === "embedded-manage" ? "可信来源与页面发布" : page === "embedded" ? "已发布页面" : "登录信息与验证器"}</p></div>
          {page === "vault" && <div className="topbar-search">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="vault-search">搜索项目</label>
            <input ref={searchInputRef} id="vault-search" value={query} onChange={(event) => { setQuery(event.target.value); setVaultCurrentPage(1); }} placeholder="搜索账号、网址或分类" />
          </div>}
          {page === "users" && userManagementTab === "users" && <div className="topbar-search topbar-search-simple">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="user-search">搜索系统用户</label>
            <input id="user-search" value={userQuery} onChange={(event) => { setUserQuery(event.target.value); setUserCurrentPage(1); }} placeholder="搜索用户邮箱" />
          </div>}
          {page === "profile" || page === "embedded" || page === "embedded-manage" ? <div className="topbar-page-actions">{page === "profile" && <>{viewer.isInitialAdmin && <a className="secondary-button profile-password-action" href="/account/admin-recovery-codes" aria-label="轮换管理员恢复码" title="轮换管理员恢复码"><KeyRound size={16} />恢复码</a>}<a className="secondary-button profile-password-action" href="/account/security-email" aria-label="管理安全邮箱" title="管理安全邮箱"><ShieldCheck size={16} />安全邮箱</a><a className="secondary-button profile-password-action" href="/account/password" aria-label="修改登录密码" title="修改登录密码"><KeyRound size={16} />修改登录密码</a></>}<button className="secondary-button lock-button" onClick={endSession} aria-label="结束会话" title="结束会话"><LogOut size={17} /></button></div> : <button className="secondary-button lock-button" onClick={endSession} aria-label="结束会话" title="结束会话"><LogOut size={17} /></button>}
          {page === "vault" && <button className="primary-button" onClick={() => setShowAdd(true)} disabled={isLoading || isSaving}><Plus size={18} />新建项目</button>}
          {page === "users" && userManagementTab === "users" && <button className="primary-button user-add-button" onClick={() => { setSystemUserCode(""); setShowUserCreateDialog(true); }} disabled={isSaving}><Plus size={18} />添加用户</button>}
        </header>

        <div className="page-view-transition" key={pageTransitionKey}>
        {page === "users" ? <section className="users-page" aria-labelledby="users-page-title">
          <section className="users-panel" aria-labelledby="users-page-title" aria-busy={userManagementTab === "users" ? isUsersLoading : isAuditLoading}>
            <div className="users-toolbar">
              <div className="users-toolbar-copy"><h2 id="users-page-title">{userManagementTab === "users" ? "系统用户" : "操作审计"}</h2><span>{userManagementTab === "users" ? isUsersLoading ? "正在读取用户" : `本页 ${systemUsers.length} 位，共 ${userPagination.total} 位用户` : isAuditLoading ? "正在读取记录" : `本页 ${audit.length} 条，共 ${auditPagination.total} 条记录`}</span></div>
              <div className="users-toolbar-actions"><div className="users-tabs" role="tablist" aria-label="用户管理内容"><button id="users-tab" type="button" role="tab" aria-selected={userManagementTab === "users"} aria-controls="users-tabpanel" tabIndex={userManagementTab === "users" ? 0 : -1} className={userManagementTab === "users" ? "is-active" : ""} onClick={() => selectUserManagementTab("users")} onKeyDown={handleUserManagementTabKeyDown}>系统用户</button><button id="audit-tab" type="button" role="tab" aria-selected={userManagementTab === "audit"} aria-controls="audit-tabpanel" tabIndex={userManagementTab === "audit" ? 0 : -1} className={userManagementTab === "audit" ? "is-active" : ""} onClick={() => selectUserManagementTab("audit")} onKeyDown={handleUserManagementTabKeyDown}>操作审计</button></div></div>
            </div>
            {userManagementTab === "users" ? <div role="tabpanel" id="users-tabpanel" aria-labelledby="users-tab">
              {isUsersLoading ? <UserTableLoading /> : userLoadError ? <AdminTableState tone="error" icon={AlertTriangle} title="无法读取系统用户" description={userLoadError} action={<button type="button" className="secondary-button" onClick={() => setUserLoadAttempt((current) => current + 1)}><RefreshCw size={15} />重新加载</button>} /> : systemUsers.length > 0 ? <div className="system-user-table-wrap"><table className="system-user-table system-user-list-table"><thead><tr><th scope="col">用户</th><th scope="col">角色</th><th scope="col">状态</th><th scope="col">在线</th><th scope="col">最近登录</th><th scope="col">创建时间</th><th scope="col">管理</th></tr></thead><tbody>{systemUsers.map((user) => <tr key={user.email}><td data-label="用户"><div className="system-user-identity"><strong title={user.email}>{user.email}</strong>{user.isCurrent && <span className="current-user">当前账户</span>}</div></td><td data-label="角色"><b className={`role-badge role-${user.role}`}>{user.role === "admin" ? "管理员" : "普通用户"}</b></td><td data-label="状态"><b className={`status-badge status-${user.status}`}>{systemUserStatusLabel(user.status)}</b></td><td data-label="在线"><span className={`presence-badge is-${user.isOnline ? "online" : "offline"}`}><i aria-hidden="true" />{user.isOnline ? "在线" : "离线"}</span></td><td data-label="最近登录"><span className="system-user-created" title={exactTime(user.lastLoginAt)}>{relativeTime(user.lastLoginAt)}</span></td><td data-label="创建时间"><span className="system-user-created">{user.createdAt}</span></td><td data-label="管理">{user.isCurrent ? <span className="current-user">当前账户不可调整</span> : <div className="system-user-actions"><SurfaceSelect id={`role-${user.email}`} ariaLabel={`调整${user.email}的系统角色`} value={user.role} onChange={(role) => { setSystemUserCode(""); setSystemUserAction({ user, kind: "role", role }); }} options={[{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }]} disabled={isSaving} compact />{user.status === "pending" ? <button type="button" className="secondary-button" onClick={() => { setSystemUserCode(""); setSystemUserAction({ user, kind: "resend-activation" }); }} disabled={isSaving}>重新发送</button> : <button type="button" className="secondary-button" onClick={() => { setSystemUserCode(""); setSystemUserAction({ user, kind: user.status === "active" ? "suspend" : "activate" }); }} disabled={isSaving}>{user.status === "active" ? "停用" : "启用"}</button>}<button type="button" className="secondary-button" onClick={() => { setSystemUserCode(""); setSystemUserAction({ user, kind: "reset-authenticator" }); }} disabled={isSaving || user.status === "pending"}>重置验证器</button><button type="button" className="secondary-button user-delete-button" onClick={() => { setSystemUserCode(""); setSystemUserAction({ user, kind: "delete" }); }} disabled={isSaving}>删除</button></div>}</td></tr>)}</tbody></table></div> : <AdminTableState icon={UsersRound} title={userQuery ? "无匹配用户" : "暂无数据"} />}
              {!isUsersLoading && <TablePagination pagination={userPagination} onChange={setUserCurrentPage} label="系统用户" />}
            </div> : <section className="audit-panel" role="tabpanel" id="audit-tabpanel" aria-labelledby="audit-tab">
              <div className="audit-panel-header">
                <div className="audit-panel-heading">
                  <span className="audit-panel-icon" aria-hidden="true"><ShieldCheck size={18} /></span>
                  <div><h3 id="audit-panel-title">管理操作记录</h3><p>公共项目、系统用户和内嵌页面操作。</p><p className={`audit-integrity is-${auditChainIntegrity}`} role={auditChainIntegrity === "failed" ? "alert" : "status"}>{auditIntegrityLabel(auditChainIntegrity)}</p></div>
                </div>
                <div className="audit-panel-actions">
                  <SurfaceSelect id="audit-category" ariaLabel="筛选操作类型" value={auditCategory} onChange={(nextCategory) => {
                    setAuditCategory(nextCategory);
                    setAuditCurrentPage(1);
                    writeRoute({ page: "users", collection: "all", securityFocus: "all", userManagementTab: "audit", auditCategory: nextCategory });
                  }} options={auditCategoryOptions} compact />
                  <button type="button" className="secondary-button audit-refresh-button" onClick={() => setAuditLoadAttempt((current) => current + 1)} disabled={isAuditLoading}><RefreshCw size={15} aria-hidden="true" />{isAuditLoading ? "刷新中" : "刷新"}</button>
                </div>
              </div>
              {isAuditLoading ? <AuditLogLoading /> : auditLoadError ? <AdminTableState tone="error" icon={AlertTriangle} title="无法读取操作审计" description={auditLoadError} action={<button type="button" className="secondary-button" onClick={() => setAuditLoadAttempt((current) => current + 1)}><RefreshCw size={15} />重新加载</button>} /> : audit.length > 0 ? <>
                <div className="audit-list-head" aria-hidden="true"><span>操作</span><span>操作者</span><span>时间</span></div>
                <ul className="audit-list audit-list-panel">{audit.map((entry, index) => <AuditEventRow entry={entry} key={`${entry.action}-${entry.actorEmail}-${entry.createdAt}-${entry.itemId ?? ""}-${index}`} />)}</ul>
                <TablePagination pagination={auditPagination} onChange={setAuditCurrentPage} label="操作审计" />
              </> : <AdminTableState icon={ShieldCheck} title="暂无数据" />}
            </section>}
          </section>
        </section> : page === "embedded-manage" ? <EmbeddedPageManagerContent onDialogStateChange={setEmbeddedPageDialogOpen} serverSessionReady={serverSessionReady} onPagesChanged={refreshEmbeddedNavigation} /> : page === "embedded" ? <EmbeddedPagesWorkspace selectedPageId={embeddedPageId} onPageSelect={selectEmbeddedPage} /> : page === "profile" ? <ProfileOverview viewer={viewer} viewerInitial={viewerInitial} isLoading={isLoading} securityScore={securityScore} securityIssueCount={securityIssueCount} isSaving={isSaving} onOpenSecurity={openSecurityReview} onRestartSecuritySession={restartSecuritySession} onOpenProfileEditor={openProfileEditor} /> : <>
        <section className="security-strip" aria-label="账户安全概览" aria-busy={isLoading}>
          {isLoading ? <SecurityStripLoading /> : securityIssueCount > 0 ? <button type="button" className="risk-item" onClick={() => openSecurityReview()} aria-label="查看全部账户安全检查结果">
            <span className="risk-icon risk-danger"><AlertTriangle size={17} /></span><span><strong id="security-heading">基础安全评分 {securityScore}/100</strong><small>{securityIssueCount} 条风险待处理</small></span><ChevronRight size={18} aria-hidden="true" />
          </button> : <div className="risk-item risk-item-static"><span className="risk-icon risk-safe">{totalItems === 0 ? <ShieldCheck size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}</span><span><strong id="security-heading">基础安全评分 {totalItems === 0 ? "—/100" : `${securityScore}/100`}</strong><small>{totalItems === 0 ? "暂无数据" : "基础检查已通过"}</small></span></div>}
          {weakPasswordCount > 0 ? <button className="risk-item" onClick={() => openSecurityReview("weak_password")}><span className="risk-icon risk-danger"><AlertTriangle size={17} /></span><span><strong>{weakPasswordCount} 个密码长度不足</strong><small>少于 14 位</small></span><ChevronRight size={18} /></button> : <div className="risk-item risk-item-static"><span className="risk-icon risk-safe"><Check size={17} /></span><span><strong>{totalItems === 0 ? "暂无账户" : "密码长度正常"}</strong><small>{totalItems === 0 ? "等待数据" : "未发现短密码"}</small></span></div>}
          {reusedPasswordCount > 0 ? <button className="risk-item" onClick={() => openSecurityReview("reused_password")}><span className="risk-icon risk-warning"><ShieldEllipsis size={17} /></span><span><strong>{reusedPasswordCount} 个重复密码</strong><small>用于多个项目</small></span><ChevronRight size={18} /></button> : <div className="risk-item risk-item-static"><span className="risk-icon risk-safe"><Check size={17} /></span><span><strong>{totalItems === 0 ? "暂无账户" : "无重复密码"}</strong><small>{totalItems === 0 ? "等待数据" : "已保存密码不重复"}</small></span></div>}
          {missingTwoFactorCount > 0 ? <button className="risk-item" onClick={() => openSecurityReview("missing_two_factor")}><span className="risk-icon risk-info"><Smartphone size={17} /></span><span><strong>{missingTwoFactorCount} 个未启用双重验证</strong><small>需配置验证器</small></span><ChevronRight size={18} /></button> : <div className="risk-item risk-item-static"><span className="risk-icon risk-safe"><Check size={17} /></span><span><strong>{totalItems === 0 ? "暂无账户" : "双重验证正常"}</strong><small>{totalItems === 0 ? "等待数据" : "全部账户已开启"}</small></span></div>}
        </section>

        <div className="content-grid">
          <section className="vault-panel" aria-labelledby="vault-list-title" aria-busy={isLoading}>
            {collection === "security" && <div className="security-review" role="region" aria-labelledby="security-review-title">
              <div className="security-review-head"><div><span className="eyebrow">账户安全检查</span><h2 id="security-review-title">{totalItems === 0 ? "暂无可检查账户" : securityIssueCount > 0 ? `${securityIssueCount} 条风险待处理` : "基础检查已通过"}</h2><p>{totalItems === 0 ? "暂无数据。" : "密码长度、重复使用与双重验证。"}</p></div><button type="button" className="secondary-button" onClick={openAccountManagement}>全部账户</button></div>
              <div className="security-focuses" role="group" aria-label="安全风险筛选">
                <button className={securityFocus === "all" ? "is-selected" : ""} aria-pressed={securityFocus === "all"} onClick={() => { setSecurityFocus("all"); setVaultCurrentPage(1); }}>全部 {securityIssueCount}</button>
                <button className={securityFocus === "weak_password" ? "is-selected" : ""} aria-pressed={securityFocus === "weak_password"} onClick={() => { setSecurityFocus("weak_password"); setVaultCurrentPage(1); }} disabled={weakPasswordCount === 0}>密码长度不足 {weakPasswordCount}</button>
                <button className={securityFocus === "reused_password" ? "is-selected" : ""} aria-pressed={securityFocus === "reused_password"} onClick={() => { setSecurityFocus("reused_password"); setVaultCurrentPage(1); }} disabled={reusedPasswordCount === 0}>密码重复 {reusedPasswordCount}</button>
                <button className={securityFocus === "missing_two_factor" ? "is-selected" : ""} aria-pressed={securityFocus === "missing_two_factor"} onClick={() => { setSecurityFocus("missing_two_factor"); setVaultCurrentPage(1); }} disabled={missingTwoFactorCount === 0}>未开双重验证 {missingTwoFactorCount}</button>
              </div>
            </div>}
            <div className="panel-toolbar">
              <div className="toolbar-selects" aria-label="账户筛选与排序">
                <div className="toolbar-select"><span>范围</span><SurfaceSelect id="vault-space-filter" ariaLabel="项目范围" value={space} onChange={(value) => { setSpace(value); setVaultCurrentPage(1); }} options={spaceFilters.map((value) => ({ value, label: `${value}${value === "全部" ? "项目" : ""} · ${spaceCounts[value]}` }))} compact /></div>
                <div className="toolbar-select toolbar-category"><span>自定义分类</span><SurfaceSelect id="vault-category-filter" ariaLabel="自定义分类" value={activeCategory} onChange={(value) => { setCategory(value); setVaultCurrentPage(1); }} options={categoryOptions} compact /></div>
                <div className="toolbar-select"><span>排序</span><SurfaceSelect id="vault-sort-order" ariaLabel="项目排序" value={sortOrder} onChange={(value) => { setSortOrder(value); setVaultCurrentPage(1); }} options={[{ value: "updated", label: "最近更新" }, { value: "name", label: "名称 A–Z" }]} compact /></div>
              </div>
            </div>

            <div className="list-heading">
              <div><h2 id="vault-list-title">{listTitle}</h2><span>共 {vaultPagination.total} 项</span></div>
              <span>安全状态</span><span>更新时间</span><span className="sr-only">更多操作</span>
            </div>

            <div className="vault-list">
              {isLoading ? (
                <VaultListLoading />
              ) : loadError ? (
                <div className="empty-state empty-state-error" role="alert"><AlertTriangle size={24} /><h3>无法读取项目</h3><p>{loadError}</p><button className="secondary-button" onClick={() => setLoadAttempt((current) => current + 1)}>重新加载</button></div>
              ) : items.length > 0 ? items.map((item) => (
                <button key={item.id} className={`vault-row ${activeSelectedId === item.id ? "is-selected" : ""}`} onClick={() => { setSelectedId(item.id); setRevealed(false); }} aria-pressed={activeSelectedId === item.id}>
                  <div className="item-identity"><BrandMark item={item} /><span><span className="item-name-line"><strong>{item.name}</strong><b className={`space-badge ${item.group === "公共" ? "is-public" : "is-personal"}`}>{item.group}</b>{item.category && <b className="category-badge">{item.category}</b>}</span><small>{item.username}</small></span></div>
                  <div>{collection === "security" ? <SecurityIssueBadges issues={item.securityIssues} /> : <StrengthBadge strength={item.strength} />}</div>
                  <span className="updated-at">{item.updated}</span>
                  <span className="row-chevron"><ChevronRight size={18} /></span>
                </button>
              )) : (
                collection === "security" && totalItems > 0 && securityIssueCount === 0 ? <div className="empty-state empty-state-success"><ShieldCheck size={24} /><h3>基础检查已通过</h3><p>未发现基础风险。</p><button className="secondary-button" onClick={openAccountManagement}>全部账户</button></div> : <div className="empty-state"><Search size={24} /><h3>{totalItems === 0 ? "暂无数据" : collection === "security" ? "无匹配风险" : "无匹配项目"}</h3>{totalItems > 0 && <p>调整筛选条件后重试。</p>}{totalItems > 0 && <button className="secondary-button" onClick={clearVaultFilters}>清除筛选</button>}</div>
              )}
            </div>
            {!isLoading && !loadError && <TablePagination pagination={vaultPagination} onChange={setVaultCurrentPage} label="账户" />}
          </section>

          {isLoading || isDetailLoading ? <DetailPanelLoading /> : selected ? (
          <aside className="detail-panel" aria-labelledby="detail-title">
            <div className="detail-head">
              <div className="detail-brand"><BrandMark item={selected} /><div><span className="eyebrow">{selected.type}</span><div className="detail-title-line"><h2 id="detail-title">{selected.name}</h2><b className={`space-badge ${selected.group === "公共" ? "is-public" : "is-personal"}`}>{selected.group}</b></div>{selected.domain.includes(".") ? <a href={`https://${selected.domain}`} target="_blank" rel="noreferrer">{selected.domain}<ArrowUpRight size={14} /></a> : <span className="detail-domain">{selected.domain}</span>}{selected.category && <span className="detail-category">分类：{selected.category}</span>}</div></div>
              <div className="detail-actions">
                {selected.canEdit ? <button className="icon-button" onClick={() => openEdit(selected)} aria-label={`编辑${selected.name}`} disabled={isSaving}><Edit3 size={18} /></button> : <span className="detail-read-only" title="公共项目仅管理员可编辑或删除"><Eye size={15} aria-hidden="true" />只读</span>}
              </div>
            </div>

            {selected.group === "公共" && <div className="public-access-note"><UsersRound size={17} aria-hidden="true" /><div><strong>全体启用用户可查看</strong><span>{selected.canEdit ? "你可管理该项目。" : "仅管理员可修改。"}</span></div></div>}

            <div className="detail-section">
              <div className="field-label"><span>用户名</span></div>
              <div className="secret-field"><span>{selected.username}</span><button className="icon-button" onClick={() => copyValue(selected.username, "用户名", selected.id)} aria-label="复制用户名"><Copy size={17} /></button></div>
            </div>

            <div className="detail-section">
              <div className="field-label"><span>密码</span><span className="password-meta">{selected.password.length} 位</span></div>
              <div className="secret-field password-field"><span className={revealed ? "password-revealed" : "password-masked"}>{revealed ? selected.password : "••••••••••••••••"}</span><button className="icon-button" onClick={() => { const next = !revealed; setRevealed(next); if (next) recordAudit("password_revealed", selected.id); }} aria-label={revealed ? "隐藏密码" : "显示密码"}>{revealed ? <EyeOff size={17} /> : <Eye size={17} />}</button><button className="icon-button" onClick={() => copyValue(selected.password, "密码", selected.id)} aria-label="复制密码"><Copy size={17} /></button></div>
              <div className="credential-statuses" aria-label="账号安全状态"><span className={`credential-status credential-status-${selected.strength}`}>{selected.strength === "安全" ? <ShieldCheck size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}密码{selected.strength}</span><span className={`credential-status ${selected.twoFactor ? "is-protected" : "is-unprotected"}`}>{selected.twoFactor ? <ShieldCheck size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}{selected.totps.length > 0 ? `已保存 ${selected.totps.length} 个验证器` : selected.twoFactor ? "双重验证已开启" : "未开双重验证"}</span></div>
            </div>

            {selectedSummary && selectedSummary.securityIssues.length > 0 && <div className="detail-section security-findings">
              <div className="field-label"><span>需处理的安全项</span></div>
              <div className="security-finding-list">{selectedSummary.securityIssues.map((issue) => <div className={`security-finding security-finding-${issue}`} key={issue}><AlertTriangle size={16} aria-hidden="true" /><div><strong>{securityIssueCopy[issue].label}</strong><span>{securityIssueCopy[issue].detail}</span></div></div>)}</div>
            </div>}

            {selected.totps.length > 0 && <div className="detail-section"><div className="field-label"><span>验证器代码</span><span className="password-meta">{selected.totps.length} 个</span></div><div className="totp-list">{selected.totps.map((entry, index) => <AuthenticatorCode entry={entry} itemId={selected.id} onCopy={copyValue} onReveal={() => recordAudit("totp_revealed", selected.id)} key={`${entry.label}-${index}`} />)}</div></div>}

            {selected.note && <div className="detail-section">
              <div className="field-label"><span>备注</span></div>
              <p className="note-copy">{selected.note}</p>
            </div>}

            <div className="detail-footer">
              <div><Clock3 size={15} /><span>上次修改：{selected.updated}</span></div>
              {selected.canEdit && <button className="secondary-button detail-delete-button" onClick={() => { setDeleteItemCode(""); setDeleteTarget(selected); }} disabled={isSaving}><Trash2 size={16} />删除项目</button>}
            </div>
          </aside>
          ) : totalItems > 0 ? (
            <aside className="detail-panel detail-empty" aria-live="polite">
              {items.length === 0 ? <><Search size={25} aria-hidden="true" /><h2>无匹配项目</h2><p>调整筛选条件后重试。</p><button className="secondary-button" onClick={clearVaultFilters}>清除筛选</button></> : <><AlertTriangle size={25} aria-hidden="true" /><h2>无法读取项目详情</h2><p>{detailError ?? "请重新选择项目。"}</p><button className="secondary-button" onClick={() => setDetailAttempt((current) => current + 1)}>重新读取</button></>}
            </aside>
          ) : (
            <aside className="detail-panel detail-empty" aria-label="项目暂无数据">
              <KeyRound size={25} aria-hidden="true" />
              <h2>暂无数据</h2>
            </aside>
          )}
        </div>
        </>}
        </div>
      </main>

      {showSecurityReverify && (
        <div className="modal-layer" role="presentation">
          <section className="modal user-create-modal" role="dialog" aria-modal="true" aria-labelledby="security-reverify-title">
            <header><div><span className="modal-icon"><ShieldCheck size={20} /></span><div><h2 id="security-reverify-title">重新验证</h2><p>输入当前 Google 验证码以继续敏感操作。</p></div></div><button className="icon-button" type="button" onClick={() => { setShowSecurityReverify(false); setSecurityReverifyCode(""); setSecurityReverifyError(""); }} aria-label="关闭重新验证"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={renewSecuritySession}>
              <div className="modal-body"><label>Google 验证码<input required autoFocus value={securityReverifyCode} onChange={(event) => setSecurityReverifyCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>{securityReverifyError && <p className="login-error" role="status">{securityReverifyError}</p>}</div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => { setShowSecurityReverify(false); setSecurityReverifyCode(""); setSecurityReverifyError(""); }} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><ShieldCheck size={17} />{isSaving ? "正在验证" : "确认验证"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {showProfileEditor && page === "profile" && (
        <div className="modal-layer" role="presentation">
          <section className="modal profile-editor-modal" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
            <header><div><span className="modal-icon"><UserRound size={20} /></span><div><h2 id="profile-editor-title">编辑个人资料</h2><p>昵称与头像样式仅用于当前账户展示。</p></div></div><button className="icon-button" type="button" onClick={() => setShowProfileEditor(false)} aria-label="关闭编辑个人资料"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={saveProfile}>
              <div className="modal-body profile-editor-body">
                <div className="profile-editor-preview">
                  <span className={`profile-avatar profile-avatar-${profileAvatarStyleInput}`} aria-hidden="true">{profileDisplayNameInput.trim().slice(0, 1).toLocaleUpperCase() || "你"}</span>
                  <div><strong>{profileDisplayNameInput.trim() || "未设置昵称"}</strong><span>{viewer.email}</span></div>
                </div>
                <label>昵称<input required autoFocus maxLength={32} value={profileDisplayNameInput} onChange={(event) => setProfileDisplayNameInput(event.target.value)} placeholder="请输入昵称" autoComplete="nickname" /><small>最多 32 个字符。</small></label>
                <div className="profile-avatar-picker"><span>头像样式</span><div role="radiogroup" aria-label="选择头像样式">{profileAvatarStyles.map((style) => <button key={style} type="button" role="radio" aria-checked={profileAvatarStyleInput === style} className={`profile-avatar-choice profile-avatar-${style} ${profileAvatarStyleInput === style ? "is-selected" : ""}`} onClick={() => setProfileAvatarStyleInput(style)}><span aria-hidden="true">{profileDisplayNameInput.trim().slice(0, 1).toLocaleUpperCase() || "你"}</span><i className="sr-only">{style}</i></button>)}</div></div>
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => setShowProfileEditor(false)} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><Check size={17} />{isSaving ? "正在保存" : "保存资料"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {showAdd && (
        <div className="modal-layer" role="presentation">
          <section className="modal credential-modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
            <header><div><span className="modal-icon"><KeyRound size={20} /></span><div><h2 id="add-title">添加登录信息</h2><p>加密保存到工作台</p></div></div><button className="icon-button" onClick={() => setShowAdd(false)} aria-label="关闭"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={submitCredential}>
              <div className="modal-body credential-modal-body">
              <div className="credential-form-pair"><label>名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：公司邮箱" autoFocus /></label><label>网站地址<input required value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} placeholder="example.com" inputMode="url" /></label></div>
              <label>分类（可选）<input list="credential-category-options" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} placeholder="例如：部门一" maxLength={60} /></label>
              <datalist id="credential-category-options">{categoryNames.map((name) => <option value={name} key={name} />)}</datalist>
              <label>用户名<input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="name@example.com" autoComplete="username" /></label>
              <label>密码<div className="form-password"><input required type={showNewPassword ? "text" : "password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="输入或生成强密码" autoComplete="new-password" /><button type="button" className="password-visibility" onClick={() => setShowNewPassword((current) => !current)} aria-label={showNewPassword ? "隐藏输入的密码" : "显示输入的密码"}>{showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" onClick={generatePassword}><WandSparkles size={16} />生成</button></div><small>至少 14 位。</small></label>
              <div className="field-control"><span>可见范围</span><SurfaceSelect id="add-space" ariaLabel="可见范围" value={form.group} onChange={(group) => setForm({ ...form, group })} options={[{ value: "个人", label: "个人项目" }, ...(isAdmin ? [{ value: "公共", label: "公共项目" }] : [])]} />{form.group === "公共" && <p className="inline-access-note"><UsersRound size={16} aria-hidden="true" /><span>全体启用用户可查看，仅管理员可修改。</span></p>}</div>
              <TotpEntryFields entries={form.totpEntries} formId="add" isReading={isReadingTotp} onChange={(id, changes) => updateTotpEntry("add", id, changes)} onAdd={() => addTotpEntry("add")} onRemove={(id) => removeTotpEntry("add", id)} onReadImage={(event, id) => void importTotpFromImage(event, "add", id)} />
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => setShowAdd(false)} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><Plus size={17} />{isSaving ? "正在保存" : "添加项目"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {editingItem && (
        <div className="modal-layer" role="presentation">
          <section className="modal credential-modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <header><div><span className="modal-icon"><Edit3 size={20} /></span><div><h2 id="edit-title">编辑项目</h2><p>变更会加密保存</p></div></div><button className="icon-button" onClick={() => { setPublicItemCode(""); setEditingItem(null); }} aria-label="关闭编辑"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={submitEditCredential}>
              <div className="modal-body credential-modal-body">
              <div className="credential-form-pair"><label>名称<input required value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} autoFocus /></label><label>网站地址<input required value={editForm.domain} onChange={(event) => setEditForm({ ...editForm, domain: event.target.value })} inputMode="url" /></label></div>
              <label>分类（可选）<input list="credential-category-options" value={editForm.category} onChange={(event) => setEditForm({ ...editForm, category: event.target.value })} placeholder="例如：部门一" maxLength={60} /></label>
              <datalist id="credential-category-options">{categoryNames.map((name) => <option value={name} key={name} />)}</datalist>
              <label>用户名<input required value={editForm.username} onChange={(event) => setEditForm({ ...editForm, username: event.target.value })} autoComplete="username" /></label>
              <label>密码<div className="form-password"><input required type={showEditPassword ? "text" : "password"} value={editForm.password} onChange={(event) => setEditForm({ ...editForm, password: event.target.value })} autoComplete="new-password" /><button type="button" className="password-visibility" onClick={() => setShowEditPassword((current) => !current)} aria-label={showEditPassword ? "隐藏输入的密码" : "显示输入的密码"}>{showEditPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" onClick={generateEditPassword}><WandSparkles size={16} />生成</button></div><small>至少 14 位。</small></label>
              <div className="field-control"><span>可见范围</span><SurfaceSelect id="edit-space" ariaLabel="可见范围" value={editForm.group} onChange={(group) => setEditForm({ ...editForm, group })} options={[{ value: "个人", label: "个人项目" }, ...(isAdmin ? [{ value: "公共", label: "公共项目" }] : [])]} disabled={editingItem.group === "公共"} />{editingItem.group === "公共" ? <p className="inline-access-note"><UsersRound size={16} aria-hidden="true" /><span>全体启用用户可查看，仅管理员可维护。</span></p> : null}</div>
              <TotpEntryFields entries={editForm.totpEntries} formId="edit" isReading={isReadingTotp} onChange={(id, changes) => updateTotpEntry("edit", id, changes)} onAdd={() => addTotpEntry("edit")} onRemove={(id) => removeTotpEntry("edit", id)} onReadImage={(event, id) => void importTotpFromImage(event, "edit", id)} />
              {editingItem.group === "公共" && <label>Google 验证码<input required value={publicItemCode} onChange={(event) => setPublicItemCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>}
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => { setPublicItemCode(""); setEditingItem(null); }} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><Check size={17} />{isSaving ? "正在保存" : "保存变更"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {pendingPublicPublish && (
        <div className="modal-layer" role="presentation">
          <section className="modal user-create-modal" role="dialog" aria-modal="true" aria-labelledby="publish-public-title">
            <header><div><span className="modal-icon"><UsersRound size={20} /></span><div><h2 id="publish-public-title">{pendingPublicPublish.item ? "发布为公共项目？" : "新建公共项目？"}</h2><p>全体启用用户可查看。</p></div></div><button className="icon-button" type="button" onClick={() => { setPublicItemCode(""); setPendingPublicPublish(null); }} aria-label="关闭公共发布确认"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (!/^\d{6}$/.test(publicItemCode)) { setToast("请输入 6 位 Google 验证码。"); return; } if (pendingPublicPublish.item) void saveEditedCredential(pendingPublicPublish.item, pendingPublicPublish.form, publicItemCode); else void saveCredential(pendingPublicPublish.form, publicItemCode); }}>
              <div className="modal-body">
                <div className="delete-summary publish-summary"><strong>{pendingPublicPublish.form.name}</strong><span>{pendingPublicPublish.form.username} · 公共项目</span></div>
                <p className="delete-description">仅管理员可继续编辑或删除。</p>
                <label>Google 验证码<input required autoFocus value={publicItemCode} onChange={(event) => setPublicItemCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => { setPublicItemCode(""); setPendingPublicPublish(null); }} disabled={isSaving}>返回编辑</button><button type="submit" className="primary-button" disabled={isSaving}><UsersRound size={17} />{isSaving ? "正在发布" : "确认发布"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-layer" role="presentation">
          <section className="modal danger-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <header><div><span className="modal-icon danger-icon"><AlertTriangle size={20} /></span><div><h2 id="delete-title">删除项目？</h2><p>此操作不可恢复。</p></div></div><button className="icon-button" onClick={() => { setDeleteItemCode(""); setDeleteTarget(null); }} aria-label="关闭删除确认"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={(event) => { event.preventDefault(); deleteCredential(); }}>
              <div className="modal-body">
              <div className="delete-summary"><strong>{deleteTarget.name}</strong><span>{deleteTarget.username} · {deleteTarget.type}</span></div>
              <p className="delete-description">{deleteTarget.group === "公共" ? "公共项目会对所有可查看用户失效。" : "项目将被移除。"}</p>
              {deleteTarget.group === "公共" && <label>Google 验证码<input required autoFocus value={deleteItemCode} onChange={(event) => setDeleteItemCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>}
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => { setDeleteItemCode(""); setDeleteTarget(null); }} disabled={isSaving}>取消</button><button type="submit" className="danger-button" disabled={isSaving}><Trash2 size={17} />{isSaving ? "正在删除" : "删除项目"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {showUserCreateDialog && page === "users" && isAdmin && (
        <div className="modal-layer" role="presentation">
          <section className="modal user-create-modal" role="dialog" aria-modal="true" aria-labelledby="create-system-user-title">
            <header><div><span className="modal-icon"><UserCog size={20} /></span><div><h2 id="create-system-user-title">添加系统用户</h2><p>用户自行设置密码和 Google 验证器。</p></div></div><button className="icon-button" type="button" onClick={() => { setSystemUserCode(""); setShowUserCreateDialog(false); }} aria-label="关闭添加用户"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={createSystemUser}>
              <div className="modal-body">
              <label>登录账号（必须）<input required type="text" value={systemUserEmail} onChange={(event) => setSystemUserEmail(event.target.value)} placeholder="name@example.com 或 dajiang01" autoComplete="username" autoFocus /><small>邮箱，或 4–32 位英文数字组合。</small></label>
              <label>安全邮箱（必须）<input required type="email" value={systemUserSecurityEmail} onChange={(event) => setSystemUserSecurityEmail(event.target.value)} placeholder="用于接收激活码和登录确认" autoComplete="email" /><small>可与登录账号不同；仅用于安全确认和恢复。</small></label>
              <div className="field-control"><span>系统角色</span><SurfaceSelect id="new-user-role" ariaLabel="系统角色" value={systemUserRole} onChange={setSystemUserRole} options={[{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }]} /></div>
              <label>Google 验证码<input required value={systemUserCode} onChange={(event) => setSystemUserCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>
              <aside className="access-setup-note" role="note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>激活方式</strong><p>系统会发送一次性激活码，用户自行设置密码和验证器。</p></div></aside>
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => { setSystemUserCode(""); setShowUserCreateDialog(false); }} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><UserCog size={17} />{isSaving ? "正在创建" : "创建用户"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {systemUserProvisioning && isAdmin && (
        <div className="modal-layer" role="presentation">
          <section className="modal user-create-modal" role="dialog" aria-modal="true" aria-labelledby="user-provisioning-title">
            <header><div><span className="modal-icon"><KeyRound size={20} /></span><div><h2 id="user-provisioning-title">用户激活</h2><p>激活码不会与密码或验证器密钥混用。</p></div></div><button className="icon-button" type="button" onClick={() => setSystemUserProvisioning(null)} aria-label="关闭用户激活提示"><X size={20} /></button></header>
            <div className="modal-body provisioning-body">
              <aside className="access-setup-note" role="note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>{systemUserProvisioning.account}</strong><p>{systemUserProvisioning.delivery === "email" ? "激活码已发送至该用户的安全邮箱。" : "本地预览未配置邮件服务；请通过安全渠道交付下方激活码。"}</p></div></aside>
              {systemUserProvisioning.delivery === "manual" && systemUserProvisioning.code && <label className="provisioning-key">一次性激活码
                <span><code>{systemUserProvisioning.code}</code><button type="button" className="icon-button" onClick={() => copyValue(systemUserProvisioning.code!, "一次性激活码")} aria-label="复制一次性激活码" title="复制激活码"><Copy size={17} /></button></span>
              </label>}
              <p className="form-hint">请在激活页输入安全码；激活码将在 {exactTime(systemUserProvisioning.expiresAt)} 失效。</p>
            </div>
            <footer className="modal-footer"><button type="button" className="primary-button" onClick={() => setSystemUserProvisioning(null)}><Check size={17} />已处理</button></footer>
          </section>
        </div>
      )}

      {authenticatorRecovery && isAdmin && (
        <div className="modal-layer" role="presentation">
          <section className="modal user-create-modal" role="dialog" aria-modal="true" aria-labelledby="authenticator-recovery-title">
            <header><div><span className="modal-icon"><KeyRound size={20} /></span><div><h2 id="authenticator-recovery-title">验证器恢复已发起</h2><p>恢复码仅发送到该用户已验证的安全邮箱。</p></div></div><button className="icon-button" type="button" onClick={() => setAuthenticatorRecovery(null)} aria-label="关闭验证器恢复提示"><X size={20} /></button></header>
            <div className="modal-body provisioning-body">
              <aside className="access-setup-note" role="note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>{authenticatorRecovery.account}</strong><p>旧验证器和全部会话已失效；用户需在 15 分钟内完成邮箱确认并重新绑定 Google 验证器。</p></div></aside>
              <p className="form-hint">恢复码不会在管理端显示，也无需人工转交。</p>
            </div>
            <footer className="modal-footer"><button type="button" className="primary-button" onClick={() => setAuthenticatorRecovery(null)}><Check size={17} />知道了</button></footer>
          </section>
        </div>
      )}

      {systemUserAction && isAdmin && (
        <div className="modal-layer" role="presentation">
          <section className="modal user-create-modal" role="dialog" aria-modal="true" aria-labelledby="system-user-action-title">
            <header><div><span className="modal-icon danger-icon"><AlertTriangle size={20} /></span><div><h2 id="system-user-action-title">{systemUserAction.kind === "delete" ? "删除系统用户？" : systemUserAction.kind === "suspend" ? "停用系统用户？" : systemUserAction.kind === "activate" ? "启用系统用户？" : systemUserAction.kind === "resend-activation" ? "重新发送激活码？" : systemUserAction.kind === "reset-authenticator" ? "重置登录验证器？" : "调整系统角色？"}</h2><p>{systemUserAction.kind === "delete" ? "个人项目将一并删除。" : systemUserAction.kind === "suspend" ? "用户将无法登录。" : systemUserAction.kind === "activate" ? "用户可重新登录。" : systemUserAction.kind === "resend-activation" ? "旧激活码会立即失效，新激活码将发送至该用户的安全邮箱。" : systemUserAction.kind === "reset-authenticator" ? "旧验证器和会话将失效。" : `调整为${systemUserAction.role === "admin" ? "管理员" : "普通用户"}。`}</p></div></div><button className="icon-button" type="button" onClick={() => { setSystemUserCode(""); setSystemUserAction(null); }} aria-label="关闭用户操作确认"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void confirmSystemUserAction(); }}>
              <div className="modal-body">
                <div className="delete-summary"><strong>{systemUserAction.user.email}</strong><span>{systemUserAction.user.role === "admin" ? "管理员" : "普通用户"} · {systemUserAction.user.status === "active" ? "已启用" : "已停用"}</span></div>
                <p className="delete-description">{systemUserAction.kind === "delete" ? "删除后无法恢复。" : systemUserAction.kind === "suspend" ? "项目数据会保留。" : systemUserAction.kind === "activate" ? "按现有登录规则访问。" : systemUserAction.kind === "resend-activation" ? "用户完成密码和验证器设置后才可登录。" : systemUserAction.kind === "reset-authenticator" ? "恢复码将发送到该用户已验证的安全邮箱。" : "权限立即生效。"}</p>
                <label>Google 验证码<input required autoFocus value={systemUserCode} onChange={(event) => setSystemUserCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label>
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => { setSystemUserCode(""); setSystemUserAction(null); }} disabled={isSaving}>取消</button><button type="submit" className="danger-button" disabled={isSaving}>{systemUserAction.kind === "delete" ? <Trash2 size={17} /> : <UserCog size={17} />}{isSaving ? "正在处理" : systemUserAction.kind === "delete" ? "删除用户" : systemUserAction.kind === "suspend" ? "确认停用" : systemUserAction.kind === "activate" ? "确认启用" : systemUserAction.kind === "resend-activation" ? "确认发送" : systemUserAction.kind === "reset-authenticator" ? "确认重置" : "确认调整"}</button></footer>
            </form>
          </section>
        </div>
      )}

      <div className={`toast ${toast ? "is-visible" : ""}`} role="status" aria-live="polite"><Clipboard size={17} />{toast}</div>
    </div>
  );
}
