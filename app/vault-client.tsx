"use client";

import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
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
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Search,
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
import jsQR from "jsqr";
import { ChangeEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { SecurityIssue } from "./lib/security-review";
import { generateTotpCode, parseTotpInput, totpLabel, totpSecondsRemaining, type TotpConfig } from "./lib/totp";
import { vaultRouteFromSearch, vaultRouteSearch, type AuditCategory, type SecurityFocus, type UserManagementTab, type VaultPage, type VaultRoute } from "./lib/vault-navigation";

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
  email: string;
  role: "admin" | "user";
};

type CredentialForm = Pick<VaultItem, "name" | "domain" | "username" | "password" | "category" | "group"> & {
  totpEntries: TotpFormEntry[];
};
type AuditIntegrity = "legacy" | "sealed" | "failed" | "unknown";
type AuditEntry = { action: string; actorEmail: string; itemId: string | null; createdAt: string; integrity?: Exclude<AuditIntegrity, "unknown"> };
type SystemUser = { email: string; role: "admin" | "user"; status: "active" | "suspended"; createdAt: string; isCurrent: boolean };
type ApprovalRequest = {
  id: string;
  action: "export_vault";
  requestedBy: string;
  status: "pending" | "approved" | "rejected" | "expired";
  approverEmail: string | null;
  expiresAt: string;
  canDecide: boolean;
  isRequester: boolean;
};
type Pagination = { page: number; pageSize: number; total: number; pageCount: number };
type VaultSecuritySummary = {
  totalItems: number;
  weakPasswordCount: number;
  reusedPasswordCount: number;
  missingTwoFactorCount: number;
  securityIssueCount: number;
  score: number;
};
type SystemUserAction = { user: SystemUser; kind: "suspend" | "delete" };
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

const spaceFilters = ["全部", "个人", "公共"] as const;
const auditCategoryOptions = [
  { value: "all", label: "全部操作" },
  { value: "project", label: "公共项目" },
  { value: "user", label: "系统用户" },
  { value: "export", label: "数据导出" },
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

function BrandMark({ item }: { item: VaultItem }) {
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
  weak_password: { label: "密码长度不足", detail: "建议使用至少 14 位的随机密码" },
  reused_password: { label: "密码重复", detail: "同一密码正用于多个项目" },
  missing_two_factor: { label: "未开启双重验证", detail: "建议在服务网站开启验证器保护" },
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

function pageNumbers(currentPage: number, pageCount: number) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const candidates = [1, currentPage - 1, currentPage, currentPage + 1, pageCount]
    .filter((page, index, values) => page >= 1 && page <= pageCount && values.indexOf(page) === index)
    .sort((left, right) => left - right);
  const values: Array<number | "ellipsis"> = [];
  candidates.forEach((page, index) => {
    const previous = candidates[index - 1];
    if (previous && page - previous > 1) values.push("ellipsis");
    values.push(page);
  });
  return values;
}

function PaginationControls({ pagination, onChange, label }: { pagination: Pagination; onChange: (page: number) => void; label: string }) {
  if (pagination.total === 0) return null;
  return <nav className="pagination" aria-label={`${label}分页`}>
    <span className="pagination-summary">第 {pagination.page} / {pagination.pageCount} 页，共 {pagination.total} 项</span>
    <div className="pagination-controls">
      <button type="button" className="pagination-button pagination-step" onClick={() => onChange(pagination.page - 1)} disabled={pagination.page === 1}><ChevronLeft size={15} aria-hidden="true" /><span>上一页</span></button>
      {pageNumbers(pagination.page, pagination.pageCount).map((page, index) => page === "ellipsis"
        ? <span className="pagination-ellipsis" key={`ellipsis-${index}`} aria-hidden="true">…</span>
        : <button type="button" className={`pagination-button ${page === pagination.page ? "is-current" : ""}`} key={page} onClick={() => onChange(page)} aria-current={page === pagination.page ? "page" : undefined}>{page}</button>)}
      <button type="button" className="pagination-button pagination-step" onClick={() => onChange(pagination.page + 1)} disabled={pagination.page === pagination.pageCount}><span>下一页</span><ChevronRight size={15} aria-hidden="true" /></button>
    </div>
  </nav>;
}

type SurfaceSelectOption<T extends string> = { value: T; label: string };

function SurfaceSelect<T extends string>({
  id,
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
}: {
  id: string;
  ariaLabel: string;
  value: T;
  options: readonly SurfaceSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  const moveSelection = (direction: 1 | -1) => {
    const currentIndex = Math.max(0, options.findIndex((option) => option.value === value));
    const nextIndex = (currentIndex + direction + options.length) % options.length;
    onChange(options[nextIndex].value);
  };

  return (
    <div className={`surface-select ${compact ? "is-compact" : ""} ${isOpen ? "is-open" : ""}`} ref={rootRef}>
      <button
        id={id}
        type="button"
        className="surface-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={`${id}-options`}
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveSelection(event.key === "ArrowDown" ? 1 : -1);
            setIsOpen(true);
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setIsOpen((current) => !current);
          }
        }}
      >
        <span>{selected.label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {isOpen && <div id={`${id}-options`} className="surface-select-options" role="listbox" aria-label={ariaLabel}>
        {options.map((option) => <button key={option.value} type="button" className={option.value === value ? "is-selected" : ""} role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setIsOpen(false); }}>
          <span>{option.label}</span>{option.value === value && <Check size={15} aria-hidden="true" />}
        </button>)}
      </div>}
    </div>
  );
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
  return <div className="vault-loading-rows" role="status" aria-label="正在读取密码库">
    <span className="sr-only">正在读取密码库</span>
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
  return <div className="user-table-loading" role="status" aria-label="正在读取系统用户">
    <span className="sr-only">正在读取系统用户</span>
    <div className="user-table-loading-head" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <Skeleton className="skeleton-line skeleton-line-label" key={index} />)}</div>
    {Array.from({ length: 3 }, (_, index) => <div className="user-table-loading-row" key={index} aria-hidden="true"><Skeleton className="skeleton-line skeleton-line-title" /><Skeleton className="skeleton-status" /><Skeleton className="skeleton-status" /><Skeleton className="skeleton-time" /><Skeleton className="skeleton-line skeleton-line-copy" /></div>)}
  </div>;
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
  publicUserCount,
  approvals,
  isSaving,
  onOpenSecurity,
  onRequestExportApproval,
  onDecideExportApproval,
  onDownloadApprovedExport,
  onRestartSecuritySession,
  keyRotationRemaining,
  onRotateEncryption,
}: {
  viewer: Viewer;
  viewerInitial: string;
  isLoading: boolean;
  securityScore: number;
  securityIssueCount: number;
  publicUserCount: number;
  approvals: ApprovalRequest[];
  isSaving: boolean;
  onOpenSecurity: () => void;
  onRequestExportApproval: () => void;
  onDecideExportApproval: (id: string, decision: "approved" | "rejected") => void;
  onDownloadApprovedExport: (id: string) => void;
  onRestartSecuritySession: () => void;
  keyRotationRemaining: number | null;
  onRotateEncryption: () => void;
}) {
  const isAdmin = viewer.role === "admin";
  const hasOwnPendingExport = approvals.some((approval) => approval.isRequester && approval.status === "pending");
  return (
    <section className="profile-page" aria-labelledby="profile-page-title">
      <div className="profile-hero">
        <span className="profile-avatar" aria-hidden="true">{viewerInitial}</span>
        <div className="profile-hero-copy"><span className="eyebrow">账户资料</span><h2 id="profile-page-title">{viewer.displayName}</h2><p title={viewer.email}>{viewer.email}</p></div>
        <span className={`role-badge role-${viewer.role}`}>{isAdmin ? "管理员" : "普通用户"}</span>
      </div>

      <div className="profile-layout">
        <section className="profile-card" aria-labelledby="profile-account-title">
          <div className="profile-card-heading"><span className="profile-card-icon"><UserRound size={18} /></span><div><h3 id="profile-account-title">基本信息</h3><p>账号信息由当前登录账户提供</p></div></div>
          <dl className="profile-details">
            <div><dt>账号名称</dt><dd>{viewer.displayName}</dd></div>
            <div><dt>登录邮箱</dt><dd title={viewer.email}>{viewer.email}</dd></div>
            <div><dt>身份来源</dt><dd>ChatGPT 账号登录</dd></div>
          </dl>
        </section>

        <section className="profile-card" aria-labelledby="profile-permission-title">
          <div className="profile-card-heading"><span className="profile-card-icon"><UsersRound size={18} /></span><div><h3 id="profile-permission-title">项目权限</h3><p>权限随系统角色自动生效</p></div></div>
          <div className="profile-permission-list">
            <div><span>个人项目</span><strong>仅你可查看和管理</strong></div>
            <div><span>公共项目</span><strong>{isAdmin ? "可查看并配置公共项目" : "可查看公共项目"}</strong></div>
            <div><span>系统用户</span><strong>{isAdmin ? "可创建、调整与停用用户" : "由管理员统一维护"}</strong></div>
          </div>
        </section>

        <section className="profile-card profile-security-card" aria-labelledby="profile-security-title">
          <div className="profile-card-heading"><span className="profile-card-icon"><ShieldCheck size={18} /></span><div><h3 id="profile-security-title">账户安全</h3><p>基础安全与会话保护状态</p></div></div>
          <div className="profile-security-summary"><div><strong>{isLoading ? <Skeleton className="skeleton-score" /> : securityScore}</strong><span>基础安全评分</span></div><p>{isLoading ? <Skeleton className="skeleton-line skeleton-line-profile" /> : securityIssueCount === 0 ? "未发现需要处理的基础风险" : `${securityIssueCount} 条基础风险待处理`}</p></div>
          <div className="profile-security-footer"><span>服务端和当前设备均会在空闲 15 分钟后结束会话</span><button type="button" className="secondary-button" onClick={onOpenSecurity} disabled={isLoading}>{isLoading ? "正在读取安全状态" : "查看安全检查"}</button></div>
        </section>

        <section className="profile-card profile-data-security-card" aria-labelledby="profile-data-security-title">
          <div className="profile-card-heading"><span className="profile-card-icon"><Archive size={18} /></span><div><h3 id="profile-data-security-title">数据与安全</h3><p>导出敏感数据前需要另一位已启用用户确认</p></div></div>
          <aside className="data-security-note" role="note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>双人确认导出</strong><span>导出文件包含你的个人项目和全部公共项目的明文信息；确认有效期为 10 分钟。</span></div></aside>
          <div className="data-security-actions">
            {isLoading ? <Skeleton className="skeleton-button" /> : <button type="button" className="secondary-button" onClick={onRestartSecuritySession} disabled={isSaving}><ShieldCheck size={17} />重新验证登录</button>}
            {!isLoading && <p className="data-security-empty">敏感操作仅在重新验证后的 10 分钟内可用。</p>}
            {isLoading ? null : publicUserCount > 1 && !hasOwnPendingExport ? <button type="button" className="secondary-button" onClick={onRequestExportApproval} disabled={isSaving}><Archive size={17} />发起导出确认</button> : publicUserCount <= 1 ? <p className="data-security-empty">请先由管理员创建并启用另一位系统用户，才能使用双人确认导出。</p> : <p className="data-security-empty">你的导出确认正在等待另一位已启用用户批准。</p>}
            {isAdmin && <button type="button" className="secondary-button" onClick={onRotateEncryption} disabled={isSaving}><RefreshCw size={17} />{keyRotationRemaining && keyRotationRemaining > 0 ? `继续迁移（剩余 ${keyRotationRemaining}）` : "迁移加密密钥"}</button>}
          </div>
          {isAdmin && <p className="data-security-empty">密钥迁移每次最多处理 50 个项目；请先重新验证登录，再执行或继续迁移。</p>}
          <div className="data-security-requests">
            <div className="data-security-section-title"><h4>当前导出请求</h4><span>{isLoading ? "正在读取" : approvals.length > 0 ? `${approvals.length} 条` : "暂无"}</span></div>
            {isLoading ? <div className="approval-list" aria-label="正在读取导出请求"><div className="approval-row" aria-hidden="true"><div><Skeleton className="skeleton-line skeleton-line-title" /><Skeleton className="skeleton-line skeleton-line-copy" /></div><Skeleton className="skeleton-button" /></div></div> : approvals.length > 0 ? <div className="approval-list">{approvals.map((approval) => (
              <div className="approval-row" key={approval.id}>
                <div><strong>{approval.isRequester ? "你的导出确认" : `${approval.requestedBy} 请求导出确认`}</strong><span>{approvalStatusLabel(approval)}</span></div>
                <div className="approval-actions">
                  {approval.canDecide && <><button type="button" className="secondary-button" onClick={() => onDecideExportApproval(approval.id, "rejected")} disabled={isSaving}>拒绝</button><button type="button" className="primary-button" onClick={() => onDecideExportApproval(approval.id, "approved")} disabled={isSaving}>批准</button></>}
                  {approval.isRequester && approval.status === "approved" && <button type="button" className="primary-button" onClick={() => onDownloadApprovedExport(approval.id)} disabled={isSaving}><Archive size={17} />下载副本</button>}
                  {approval.isRequester && approval.status === "pending" && <span className="approval-pending">等待另一位用户批准</span>}
                </div>
              </div>
            ))}</div> : <p className="data-security-empty">当前没有需要处理的导出请求。</p>}
          </div>
        </section>
      </div>
    </section>
  );
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
      <p className="totp-entry-intro">默认保留一个登录验证器。只有不同用途需要独立验证码时，再添加新的验证器。</p>
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
      <p>不使用摄像头。图片仅在当前浏览器解析，保存时只会加密写入验证器密钥。</p>
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
    export_approval_requested: "发起了导出确认",
    export_approved: "批准了密码库导出",
    export_rejected: "拒绝了密码库导出",
    vault_exported: "导出了密码库",
    system_user_created: "创建了系统用户",
    system_user_role_changed: "调整了系统用户角色",
    system_user_status_changed: "调整了系统用户状态",
    system_user_deleted: "删除了系统用户",
  };
  return labels[action] ?? "执行了安全操作";
}

function auditScopeLabel(action: string) {
  if (action.startsWith("system_user_")) return "系统用户";
  if (action.startsWith("export_") || action === "vault_exported") return "数据导出";
  return "公共项目";
}

function AuditEventRow({ entry }: { entry: AuditEntry }) {
  const scope = auditScopeLabel(entry.action);
  const Icon = scope === "系统用户" ? UserCog : scope === "数据导出" ? FileKey2 : KeyRound;
  const tone = scope === "系统用户" ? "user" : scope === "数据导出" ? "export" : "project";
  return <li>
    <span className={`audit-event-icon is-${tone}`} aria-hidden="true"><Icon size={16} /></span>
    <div className="audit-event-copy"><strong>{auditLabel(entry.action)}</strong><span>{scope}</span></div>
    <span className="audit-event-actor" title={entry.actorEmail}>{entry.actorEmail}</span>
    <time>{entry.createdAt}</time>
  </li>;
}

function approvalStatusLabel(approval: ApprovalRequest) {
  if (approval.status === "approved") return `已由 ${approval.approverEmail ?? "另一位用户"} 批准`;
  if (approval.status === "rejected") return "已被拒绝";
  if (approval.status === "expired") return "已失效";
  return `剩余有效期：${approval.expiresAt}`;
}

export default function VaultClient({ viewer }: { viewer: Viewer }) {
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
  const [deleteTarget, setDeleteTarget] = useState<VaultItemSummary | null>(null);
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
  const [publicUserCount, setPublicUserCount] = useState(0);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditChainIntegrity, setAuditChainIntegrity] = useState<AuditIntegrity>("unknown");
  const [keyRotationRemaining, setKeyRotationRemaining] = useState<number | null>(null);
  const [auditCategory, setAuditCategory] = useState<AuditCategory>("all");
  const [auditCurrentPage, setAuditCurrentPage] = useState(1);
  const [auditPagination, setAuditPagination] = useState<Pagination>(emptyPagination);
  const [isAuditLoading, setIsAuditLoading] = useState(false);
  const [auditLoadError, setAuditLoadError] = useState<string | null>(null);
  const [auditLoadAttempt, setAuditLoadAttempt] = useState(0);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [systemUsers, setSystemUsers] = useState<SystemUser[]>([]);
  const [systemUserEmail, setSystemUserEmail] = useState("");
  const [systemUserRole, setSystemUserRole] = useState<"admin" | "user">("user");
  const [userManagementTab, setUserManagementTab] = useState<UserManagementTab>("users");
  const [userQuery, setUserQuery] = useState("");
  const [isUsersLoading, setIsUsersLoading] = useState(false);
  const [userLoadError, setUserLoadError] = useState<string | null>(null);
  const [userCurrentPage, setUserCurrentPage] = useState(1);
  const [userPagination, setUserPagination] = useState<Pagination>(emptyPagination);
  const [userLoadAttempt, setUserLoadAttempt] = useState(0);
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
  const activeDialogKey = pendingPublicPublish ? "publish" : deleteTarget ? "delete" : systemUserAction ? "system-user-action" : showUserCreateDialog ? "user-create" : editingItem ? "edit" : showAdd ? "add" : null;
  const isModalOpen = activeDialogKey !== null;
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
      if (!cancelled) window.location.assign("/signout-with-chatgpt?return_to=%2Flogin");
    });
    return () => { cancelled = true; };
  }, []);

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
      if (moveFocus) focusMainContent();
    };

    syncFromAddress();
    const onPopState = () => syncFromAddress(true);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isAdmin]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
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
        setShowUserCreateDialog(false);
        setSystemUserAction(null);
        setMobileNav(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [page]);

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
    const trapFocus = (event: KeyboardEvent) => {
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
          publicUserCount?: number;
          approvals?: ApprovalRequest[];
          categoryNames?: string[];
          spaceCounts?: Record<Space, number>;
          security?: VaultSecuritySummary;
          pagination?: Pagination;
          error?: string;
        }>(response, "无法读取密码库。");
        if (!response.ok) throw new Error(payload?.error ?? "无法读取密码库。");
        if (!payload) throw new Error("服务器没有返回密码库数据，请重新加载。");
        if (cancelled) return;

        const loadedItems = payload.items ?? [];
        setItems(loadedItems);
        setPublicUserCount(payload.publicUserCount ?? 0);
        setApprovals(payload.approvals ?? []);
        setCategoryNames(payload.categoryNames ?? []);
        setSpaceCounts(payload.spaceCounts ?? { 全部: 0, 个人: 0, 公共: 0 });
        setSecuritySummary(payload.security ?? emptySecuritySummary);
        const nextPagination = payload.pagination ?? emptyPagination;
        setVaultPagination(nextPagination);
        setVaultCurrentPage((current) => current === nextPagination.page ? current : nextPagination.page);
        setSelectedId((current) => loadedItems.some((item) => item.id === current) ? current : loadedItems[0]?.id ?? null);
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "无法读取密码库。";
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
    void fetch("/api/security/session", {
      method: "DELETE",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    }).finally(() => window.location.assign("/signout-with-chatgpt?return_to=%2Flogin"));
  }

  function restartSecuritySession() {
    void fetch("/api/security/session", {
      method: "DELETE",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    }).finally(() => window.location.assign("/signout-with-chatgpt?return_to=%2F%3Freauth%3D1"));
  }

  async function requestVault<T>(path: string, init: RequestInit) {
    const response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const payload = response.status === 204 ? null : await readJsonResponse<T & { error?: string }>(response, "操作未完成，请稍后重试。");
    if (response.status === 401 && path !== "/api/security/session") endSession();
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
      setToast(`${label}已复制，请在不需要时手动清理剪贴板`);
    } catch {
      setToast("复制失败，请手动选择内容");
    }
  }

  async function updateRemoteItem(item: VaultItem, changes: Record<string, unknown>) {
    setIsSaving(true);
    try {
      const payload = await requestVault<{ item: VaultItem }>(`/api/vault/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...item, ...changes }),
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
      setPendingPublicPublish({ form });
      return;
    }
    await saveCredential(form);
  }

  async function saveCredential(credential: CredentialForm) {
    setIsSaving(true);
    try {
      const payload = await requestVault<{ item: VaultItem }>("/api/vault/items", {
        method: "POST",
        body: JSON.stringify({ ...credential, type: "登录", twoFactor: false, favorite: false, brand: "new", note: "" }),
      });
      setVaultCurrentPage(1);
      setSelectedId(payload.item.id);
      setSelectedDetail(payload.item);
      setLoadAttempt((current) => current + 1);
      setForm(emptyCredentialForm());
      setShowNewPassword(false);
      setShowAdd(false);
      setPendingPublicPublish(null);
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
      setPendingPublicPublish({ item: editingItem, form: editForm });
      return;
    }

    await saveEditedCredential(editingItem, editForm);
  }

  async function saveEditedCredential(item: VaultItem, changes: CredentialForm) {
    try {
      await updateRemoteItem(item, changes);
      setEditingItem(null);
      setPendingPublicPublish(null);
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
      await requestVault(`/api/vault/items/${deleteTarget.id}`, { method: "DELETE" });
      setSelectedId(null);
      setSelectedDetail(null);
      setDeleteTarget(null);
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

  function handleUserManagementTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
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
    setIsSaving(true);
    try {
      await requestVault<{ user: SystemUser }>("/api/users", {
        method: "POST",
        body: JSON.stringify({ email: systemUserEmail, role: systemUserRole }),
      });
      setPublicUserCount((current) => current + 1);
      setSystemUserEmail("");
      setSystemUserRole("user");
      setShowUserCreateDialog(false);
      setUserQuery("");
      setUserCurrentPage(1);
      setUserLoadAttempt((current) => current + 1);
      setLoadAttempt((current) => current + 1);
      setToast("系统用户已创建");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法创建系统用户。");
    } finally {
      setIsSaving(false);
    }
  }

  async function updateSystemUser(user: SystemUser, changes: Partial<Pick<SystemUser, "role" | "status">>) {
    setIsSaving(true);
    try {
      await requestVault<{ user: SystemUser }>("/api/users", {
        method: "PATCH",
        body: JSON.stringify({ email: user.email, ...changes }),
      });
      if (changes.status && changes.status !== user.status) {
        setPublicUserCount((current) => Math.max(0, current + (changes.status === "active" ? 1 : -1)));
      }
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
    if (user.isCurrent) return;
    setIsSaving(true);
    try {
      await requestVault("/api/users", { method: "DELETE", body: JSON.stringify({ email: user.email }) });
      if (user.status === "active") setPublicUserCount((current) => Math.max(0, current - 1));
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

  async function confirmSystemUserAction() {
    if (!systemUserAction) return;
    const completed = systemUserAction.kind === "suspend"
      ? await updateSystemUser(systemUserAction.user, { status: "suspended" })
      : await deleteSystemUser(systemUserAction.user);
    if (completed) setSystemUserAction(null);
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

  async function requestExportApproval() {
    setIsSaving(true);
    try {
      const payload = await requestVault<{ approval: ApprovalRequest }>("/api/vault/approvals", { method: "POST" });
      setApprovals((current) => [payload.approval, ...current.filter((approval) => approval.id !== payload.approval.id)]);
      setLoadAttempt((current) => current + 1);
      setToast("已发起导出确认，有效期 10 分钟");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法发起导出确认。");
    } finally {
      setIsSaving(false);
    }
  }

  async function rotateEncryption() {
    setIsSaving(true);
    try {
      const payload = await requestVault<{ rotated: number; remaining: number; complete: boolean; activeKeyId: string }>("/api/vault/crypto-rotation", {
        method: "POST",
        body: JSON.stringify({ batchSize: 50 }),
      });
      setKeyRotationRemaining(payload.remaining);
      setToast(payload.complete ? "加密密钥迁移已完成" : `已迁移 ${payload.rotated} 个项目，剩余 ${payload.remaining} 个`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "加密密钥迁移未完成。");
    } finally {
      setIsSaving(false);
    }
  }

  async function decideExportApproval(id: string, decision: "approved" | "rejected") {
    setIsSaving(true);
    try {
      await requestVault("/api/vault/approvals", { method: "PATCH", body: JSON.stringify({ id, decision }) });
      setApprovals((current) => current.filter((approval) => approval.id !== id));
      setLoadAttempt((current) => current + 1);
      setToast(decision === "approved" ? "已批准导出确认" : "已拒绝导出确认");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法处理该请求。");
    } finally {
      setIsSaving(false);
    }
  }

  async function downloadApprovedExport(approvalId: string) {
    setIsSaving(true);
    try {
      const response = await fetch("/api/vault/export", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId }),
      });
      if (!response.ok) {
        const payload = await readJsonResponse<{ error?: string }>(response, "无法导出密码库。");
        throw new Error(payload?.error ?? "无法导出密码库。");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "djmima-vault-export.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setApprovals((current) => current.filter((approval) => approval.id !== approvalId));
      setLoadAttempt((current) => current + 1);
      setToast("已下载明文副本，请安全保管并及时删除");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "密码库未导出。");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="vault-app">
      <a className="skip-link" href="#main-content">跳到主要内容</a>

      <div className={`sidebar-backdrop ${mobileNav ? "is-visible" : ""}`} onClick={() => setMobileNav(false)} aria-hidden="true" />
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`} aria-label="主导航">
        <div className="brand-lockup">
          <span className="brand-icon" aria-hidden="true"><ShieldCheck size={22} strokeWidth={2.2} /></span>
          <div><strong>djmima</strong><span>账号与密码管理</span></div>
          <button className="icon-button sidebar-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={20} /></button>
        </div>

        <nav className="main-nav">
          <p className="nav-label">密码库</p>
          <button className={`nav-item ${page === "vault" ? "is-active" : ""}`} aria-current={page === "vault" ? "page" : undefined} onClick={openAccountManagement}><KeyRound size={18} /><span>账户管理</span><span className="nav-count">{totalItems}</span></button>

          {isAdmin && <><p className="nav-label nav-label-spaced">系统</p><button className={`nav-item ${page === "users" ? "is-active" : ""}`} aria-current={page === "users" ? "page" : undefined} onClick={() => { setMobileNav(false); openUserManagement(); }}><UserCog size={18} /><span>用户管理</span></button></>}

          <p className="nav-label nav-label-spaced">个人</p>
          <button className={`nav-item ${page === "profile" ? "is-active" : ""}`} aria-current={page === "profile" ? "page" : undefined} onClick={openProfile}><UserRound size={18} /><span>个人信息</span></button>
        </nav>

        <div className="sidebar-tip">
          <ShieldCheck size={18} aria-hidden="true" />
          <div><strong>安全会话已开启</strong><span>密码记录会加密保存</span></div>
        </div>

        <button type="button" className={`account-menu ${page === "profile" ? "is-active" : ""}`} onClick={openProfile} aria-current={page === "profile" ? "page" : undefined} aria-label="打开个人信息">
          <span className="avatar" aria-hidden="true">{viewerInitial}</span>
          <span className="account-menu-copy"><strong title={viewer.displayName}>{viewer.displayName}</strong><span title={viewer.email}>{viewer.role === "admin" ? "管理员 · " : "普通用户 · "}{viewer.email}</span></span>
          <ChevronRight className="account-menu-chevron" size={16} aria-hidden="true" />
        </button>
      </aside>

      <main ref={mainContentRef} id="main-content" className="main-shell" tabIndex={-1}>
        <header className={`topbar ${page === "profile" || (page === "users" && userManagementTab === "audit") ? "is-compact" : ""}`}>
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={21} /></button>
          <div className="page-title"><h1>{page === "profile" ? "个人信息" : page === "users" ? "用户管理" : "账户管理"}</h1><p>{page === "profile" ? "查看账户资料、系统角色、项目权限与数据安全" : page === "users" ? userManagementTab === "audit" ? "审查公共项目、系统用户与数据导出的管理操作" : "创建、调整、停用或删除系统用户" : "集中管理账号、密码与验证器代码；按风险筛选需处理账户"}</p></div>
          {page === "vault" && <div className="topbar-search">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="vault-search">搜索密码库</label>
            <input ref={searchInputRef} id="vault-search" value={query} onChange={(event) => { setQuery(event.target.value); setVaultCurrentPage(1); }} placeholder="搜索账号、网址或分类" />
            <kbd>⌘ K</kbd>
          </div>}
          {page === "users" && userManagementTab === "users" && <div className="topbar-search topbar-search-simple">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="user-search">搜索系统用户</label>
            <input id="user-search" value={userQuery} onChange={(event) => { setUserQuery(event.target.value); setUserCurrentPage(1); }} placeholder="搜索用户邮箱" />
          </div>}
          <button className="secondary-button lock-button" onClick={endSession} aria-label="结束会话" title="结束会话"><LogOut size={17} /></button>
          {page === "vault" && <button className="primary-button" onClick={() => setShowAdd(true)} disabled={isLoading || isSaving}><Plus size={18} />新建项目</button>}
          {page === "users" && userManagementTab === "users" && <button className="primary-button user-add-button" onClick={() => setShowUserCreateDialog(true)} disabled={isSaving}><Plus size={18} />添加用户</button>}
        </header>

        {page === "users" ? <section className="users-page" aria-labelledby="users-page-title">
          <section className="users-panel" aria-labelledby="users-page-title" aria-busy={userManagementTab === "users" ? isUsersLoading : isAuditLoading}>
            <div className="users-toolbar">
              <div className="users-toolbar-copy"><h2 id="users-page-title">{userManagementTab === "users" ? "系统用户" : "操作审计"}</h2><span>{userManagementTab === "users" ? isUsersLoading ? "正在读取用户" : `本页 ${systemUsers.length} 位，共 ${userPagination.total} 位用户` : isAuditLoading ? "正在读取记录" : `本页 ${audit.length} 条，共 ${auditPagination.total} 条记录`}</span></div>
              <div className="users-toolbar-actions"><div className="users-tabs" role="tablist" aria-label="用户管理内容"><button id="users-tab" type="button" role="tab" aria-selected={userManagementTab === "users"} aria-controls="users-tabpanel" tabIndex={userManagementTab === "users" ? 0 : -1} className={userManagementTab === "users" ? "is-active" : ""} onClick={() => selectUserManagementTab("users")} onKeyDown={handleUserManagementTabKeyDown}>系统用户</button><button id="audit-tab" type="button" role="tab" aria-selected={userManagementTab === "audit"} aria-controls="audit-tabpanel" tabIndex={userManagementTab === "audit" ? 0 : -1} className={userManagementTab === "audit" ? "is-active" : ""} onClick={() => selectUserManagementTab("audit")} onKeyDown={handleUserManagementTabKeyDown}>操作审计</button></div></div>
            </div>
            {userManagementTab === "users" ? <div role="tabpanel" id="users-tabpanel" aria-labelledby="users-tab">
              {isUsersLoading ? <UserTableLoading /> : userLoadError ? <div className="users-empty users-load-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><span>{userLoadError}</span><button type="button" className="secondary-button" onClick={() => setUserLoadAttempt((current) => current + 1)}>重新加载</button></div> : systemUsers.length > 0 ? <div className="system-user-table-wrap"><table className="system-user-table"><thead><tr><th scope="col">用户</th><th scope="col">角色</th><th scope="col">状态</th><th scope="col">创建时间</th><th scope="col">管理</th></tr></thead><tbody>{systemUsers.map((user) => <tr key={user.email}><td data-label="用户"><div className="system-user-identity"><strong title={user.email}>{user.email}</strong>{user.isCurrent && <span className="current-user">当前账户</span>}</div></td><td data-label="角色"><b className={`role-badge role-${user.role}`}>{user.role === "admin" ? "管理员" : "普通用户"}</b></td><td data-label="状态"><b className={`status-badge status-${user.status}`}>{user.status === "active" ? "已启用" : "已停用"}</b></td><td data-label="创建时间"><span className="system-user-created">{user.createdAt}</span></td><td data-label="管理">{user.isCurrent ? <span className="current-user">当前账户不可调整</span> : <div className="system-user-actions"><SurfaceSelect id={`role-${user.email}`} ariaLabel={`调整${user.email}的系统角色`} value={user.role} onChange={(role) => void updateSystemUser(user, { role })} options={[{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }]} disabled={isSaving} compact /><button type="button" className="secondary-button" onClick={() => user.status === "active" ? setSystemUserAction({ user, kind: "suspend" }) : void updateSystemUser(user, { status: "active" })} disabled={isSaving}>{user.status === "active" ? "停用" : "启用"}</button><button type="button" className="secondary-button user-delete-button" onClick={() => setSystemUserAction({ user, kind: "delete" })} disabled={isSaving}>删除</button></div>}</td></tr>)}</tbody></table></div> : <p className="users-empty">没有找到匹配的系统用户。</p>}
              {!isUsersLoading && <PaginationControls pagination={userPagination} onChange={setUserCurrentPage} label="系统用户" />}
            </div> : <section className="audit-panel" role="tabpanel" id="audit-tabpanel" aria-labelledby="audit-tab">
              <div className="audit-panel-header">
                <div className="audit-panel-heading">
                  <span className="audit-panel-icon" aria-hidden="true"><ShieldCheck size={18} /></span>
                  <div><h3 id="audit-panel-title">管理操作记录</h3><p>仅保留公共项目、系统用户和数据导出的管理行为；密码与验证码的查看、复制不会在此处显示。</p><p className={`audit-integrity is-${auditChainIntegrity}`} role={auditChainIntegrity === "failed" ? "alert" : "status"}>{auditIntegrityLabel(auditChainIntegrity)}</p></div>
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
              {isAuditLoading ? <AuditLogLoading /> : auditLoadError ? <div className="users-empty users-load-error" role="alert"><AlertTriangle size={18} aria-hidden="true" /><span>{auditLoadError}</span><button type="button" className="secondary-button" onClick={() => setAuditLoadAttempt((current) => current + 1)}>重新加载</button></div> : audit.length > 0 ? <>
                <div className="audit-list-head" aria-hidden="true"><span>操作</span><span>操作者</span><span>时间</span></div>
                <ul className="audit-list audit-list-panel">{audit.map((entry, index) => <AuditEventRow entry={entry} key={`${entry.action}-${entry.actorEmail}-${entry.createdAt}-${entry.itemId ?? ""}-${index}`} />)}</ul>
                <PaginationControls pagination={auditPagination} onChange={setAuditCurrentPage} label="操作审计" />
              </> : <p className="users-empty">当前筛选下没有管理记录。</p>}
            </section>}
          </section>
        </section> : page === "profile" ? <ProfileOverview viewer={viewer} viewerInitial={viewerInitial} isLoading={isLoading} securityScore={securityScore} securityIssueCount={securityIssueCount} publicUserCount={publicUserCount} approvals={approvals} isSaving={isSaving} onOpenSecurity={openSecurityReview} onRequestExportApproval={() => void requestExportApproval()} onDecideExportApproval={(id, decision) => void decideExportApproval(id, decision)} onDownloadApprovedExport={(id) => void downloadApprovedExport(id)} onRestartSecuritySession={restartSecuritySession} keyRotationRemaining={keyRotationRemaining} onRotateEncryption={() => void rotateEncryption()} /> : <>
        <section className="security-strip" aria-label="账户安全概览" aria-busy={isLoading}>
          {isLoading ? <SecurityStripLoading /> : securityIssueCount > 0 ? <button type="button" className="risk-item" onClick={() => openSecurityReview()} aria-label="查看全部账户安全检查结果">
            <span className="risk-icon risk-danger"><AlertTriangle size={17} /></span><span><strong id="security-heading">基础安全评分 {securityScore}/100</strong><small>{securityIssueCount} 条基础风险待处理</small></span><ChevronRight size={18} aria-hidden="true" />
          </button> : <div className="risk-item risk-item-static"><span className="risk-icon risk-safe">{totalItems === 0 ? <ShieldCheck size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}</span><span><strong id="security-heading">基础安全评分 {totalItems === 0 ? "—/100" : `${securityScore}/100`}</strong><small>{totalItems === 0 ? "添加账户后自动检查" : "基础检查已通过"}</small></span></div>}
          {weakPasswordCount > 0 ? <button className="risk-item" onClick={() => openSecurityReview("weak_password")}><span className="risk-icon risk-danger"><AlertTriangle size={17} /></span><span><strong>{weakPasswordCount} 个密码长度不足</strong><small>建议使用至少 14 位随机密码</small></span><ChevronRight size={18} /></button> : <div className="risk-item risk-item-static"><span className="risk-icon risk-safe"><Check size={17} /></span><span><strong>{totalItems === 0 ? "尚无账户" : "密码长度符合建议"}</strong><small>{totalItems === 0 ? "添加账户后自动检查" : "未发现少于 14 位的密码"}</small></span></div>}
          {reusedPasswordCount > 0 ? <button className="risk-item" onClick={() => openSecurityReview("reused_password")}><span className="risk-icon risk-warning"><ShieldEllipsis size={17} /></span><span><strong>{reusedPasswordCount} 个重复密码</strong><small>避免一个泄露影响多个账号</small></span><ChevronRight size={18} /></button> : <div className="risk-item risk-item-static"><span className="risk-icon risk-safe"><Check size={17} /></span><span><strong>{totalItems === 0 ? "尚无账户" : "未发现重复密码"}</strong><small>{totalItems === 0 ? "添加账户后自动检查" : "每个已保存密码均不重复"}</small></span></div>}
          {missingTwoFactorCount > 0 ? <button className="risk-item" onClick={() => openSecurityReview("missing_two_factor")}><span className="risk-icon risk-info"><Smartphone size={17} /></span><span><strong>{missingTwoFactorCount} 个未启用双重验证</strong><small>查看需处理账户</small></span><ChevronRight size={18} /></button> : <div className="risk-item risk-item-static"><span className="risk-icon risk-safe"><Check size={17} /></span><span><strong>{totalItems === 0 ? "尚无账户" : "双重验证状态正常"}</strong><small>{totalItems === 0 ? "添加账户后自动检查" : "全部账户均已开启保护"}</small></span></div>}
        </section>

        <div className="content-grid">
          <section className="vault-panel" aria-labelledby="vault-list-title" aria-busy={isLoading}>
            {collection === "security" && <div className="security-review" role="region" aria-labelledby="security-review-title">
              <div className="security-review-head"><div><span className="eyebrow">账户安全检查</span><h2 id="security-review-title">{totalItems === 0 ? "还没有可检查的账户" : securityIssueCount > 0 ? `${securityIssueCount} 条基础风险待处理` : "基础检查已通过"}</h2><p>{totalItems === 0 ? "新建账户后会自动检查密码长度、重复使用与双重验证状态。" : "检查密码长度、重复使用情况和双重验证状态。"}</p></div><button type="button" className="secondary-button" onClick={openAccountManagement}>查看全部账户</button></div>
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
                <div className="empty-state empty-state-error" role="alert"><AlertTriangle size={24} /><h3>无法读取密码库</h3><p>{loadError}</p><button className="secondary-button" onClick={() => setLoadAttempt((current) => current + 1)}>重新加载</button></div>
              ) : items.length > 0 ? items.map((item) => (
                <button key={item.id} className={`vault-row ${activeSelectedId === item.id ? "is-selected" : ""}`} onClick={() => { setSelectedId(item.id); setRevealed(false); }} aria-pressed={activeSelectedId === item.id}>
                  <div className="item-identity"><BrandMark item={item} /><span><span className="item-name-line"><strong>{item.name}</strong><b className={`space-badge ${item.group === "公共" ? "is-public" : "is-personal"}`}>{item.group}</b>{item.category && <b className="category-badge">{item.category}</b>}</span><small>{item.username}</small></span></div>
                  <div>{collection === "security" ? <SecurityIssueBadges issues={item.securityIssues} /> : <StrengthBadge strength={item.strength} />}</div>
                  <span className="updated-at">{item.updated}</span>
                  <span className="row-chevron"><ChevronRight size={18} /></span>
                </button>
              )) : (
                collection === "security" && totalItems > 0 && securityIssueCount === 0 ? <div className="empty-state empty-state-success"><ShieldCheck size={24} /><h3>基础检查已通过</h3><p>当前账户没有密码长度、重复使用或双重验证方面的基础风险。</p><button className="secondary-button" onClick={openAccountManagement}>查看全部账户</button></div> : <div className="empty-state"><Search size={24} /><h3>{totalItems === 0 ? "密码库尚未添加项目" : collection === "security" ? "没有符合当前风险条件的账户" : "没有找到匹配项目"}</h3><p>{totalItems === 0 ? "从第一个账号开始，建立加密保存的密码库。" : collection === "security" ? "可调整范围、分类或风险条件继续查看。" : "可调整搜索、范围或分类继续查看。"}</p><button className="secondary-button" onClick={() => { if (totalItems === 0) setShowAdd(true); else clearVaultFilters(); }}>{totalItems === 0 ? "新建项目" : "清除筛选"}</button></div>
              )}
            </div>
            {!isLoading && !loadError && <PaginationControls pagination={vaultPagination} onChange={setVaultCurrentPage} label="账户" />}
          </section>

          {isLoading || isDetailLoading ? <DetailPanelLoading /> : selected ? (
          <aside className="detail-panel" aria-labelledby="detail-title">
            <div className="detail-head">
              <div className="detail-brand"><BrandMark item={selected} /><div><span className="eyebrow">{selected.type}</span><div className="detail-title-line"><h2 id="detail-title">{selected.name}</h2><b className={`space-badge ${selected.group === "公共" ? "is-public" : "is-personal"}`}>{selected.group}</b></div>{selected.domain.includes(".") ? <a href={`https://${selected.domain}`} target="_blank" rel="noreferrer">{selected.domain}<ArrowUpRight size={14} /></a> : <span className="detail-domain">{selected.domain}</span>}{selected.category && <span className="detail-category">分类：{selected.category}</span>}</div></div>
              <div className="detail-actions">
                {selected.canEdit ? <button className="icon-button" onClick={() => openEdit(selected)} aria-label={`编辑${selected.name}`} disabled={isSaving}><Edit3 size={18} /></button> : <span className="detail-read-only" title="公共项目仅管理员可编辑或删除"><Eye size={15} aria-hidden="true" />只读</span>}
              </div>
            </div>

            {selected.group === "公共" && <div className="public-access-note"><UsersRound size={17} aria-hidden="true" /><div><strong>所有已启用用户可查看</strong><span>{selected.canEdit ? "你是管理员，可管理该公共项目。" : "仅管理员可编辑或删除该公共项目。"}</span></div></div>}

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
              {selected.canEdit && <button className="secondary-button detail-delete-button" onClick={() => setDeleteTarget(selected)} disabled={isSaving}><Trash2 size={16} />删除项目</button>}
            </div>
          </aside>
          ) : totalItems > 0 ? (
            <aside className="detail-panel detail-empty" aria-live="polite">
              {items.length === 0 ? <><Search size={25} aria-hidden="true" /><h2>没有符合条件的项目</h2><p>调整搜索、范围、分类或风险条件后继续查看。</p><button className="secondary-button" onClick={clearVaultFilters}>清除筛选</button></> : <><AlertTriangle size={25} aria-hidden="true" /><h2>无法读取项目详情</h2><p>{detailError ?? "请重新选择该项目。"}</p><button className="secondary-button" onClick={() => setDetailAttempt((current) => current + 1)}>重新读取</button></>}
            </aside>
          ) : (
            <aside className="detail-panel detail-empty" aria-label="空密码库">
              <Archive size={25} aria-hidden="true" />
              <h2>密码库为空</h2>
              <p>新建一个项目，开始整理你的登录信息。</p>
              <div className="onboarding-note" role="note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>首次配置</strong><span>填写账号密码；如网站开启 Google Authenticator，可粘贴 Setup Key 或读取配置二维码图片。</span></div></div>
              <button className="primary-button" onClick={() => setShowAdd(true)}><Plus size={18} />新建项目</button>
            </aside>
          )}
        </div>
        </>}
      </main>

      {showAdd && (
        <div className="modal-layer" role="presentation">
          <section className="modal credential-modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
            <header><div><span className="modal-icon"><KeyRound size={20} /></span><div><h2 id="add-title">添加登录信息</h2><p>保存后以加密形式写入你的密码库</p></div></div><button className="icon-button" onClick={() => setShowAdd(false)} aria-label="关闭"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={submitCredential}>
              <div className="modal-body credential-modal-body">
              <div className="credential-form-pair"><label>名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：公司邮箱" autoFocus /></label><label>网站地址<input required value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} placeholder="example.com" inputMode="url" /></label></div>
              <label>分类（可选）<input list="credential-category-options" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} placeholder="例如：部门一" maxLength={60} /><small>可输入新名称；分类会随加密项目保存，用于搜索和筛选。</small></label>
              <datalist id="credential-category-options">{categoryNames.map((name) => <option value={name} key={name} />)}</datalist>
              <label>用户名<input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="name@example.com" autoComplete="username" /></label>
              <label>密码<div className="form-password"><input required type={showNewPassword ? "text" : "password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="输入或生成强密码" autoComplete="new-password" /><button type="button" className="password-visibility" onClick={() => setShowNewPassword((current) => !current)} aria-label={showNewPassword ? "隐藏输入的密码" : "显示输入的密码"}>{showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" onClick={generatePassword}><WandSparkles size={16} />生成</button></div><small>建议至少 14 位，并混合字母、数字和符号。</small></label>
              <TotpEntryFields entries={form.totpEntries} formId="add" isReading={isReadingTotp} onChange={(id, changes) => updateTotpEntry("add", id, changes)} onAdd={() => addTotpEntry("add")} onRemove={(id) => removeTotpEntry("add", id)} onReadImage={(event, id) => void importTotpFromImage(event, "add", id)} />
              <div className="field-control"><span>可见范围</span><SurfaceSelect id="add-space" ariaLabel="可见范围" value={form.group} onChange={(group) => setForm({ ...form, group })} options={[{ value: "个人", label: "个人项目" }, ...(isAdmin ? [{ value: "公共", label: "公共项目" }] : [])]} />{form.group === "公共" && <p className="inline-access-note"><UsersRound size={16} aria-hidden="true" /><span>所有已启用用户都可查看账号、密码和验证码；保存前会再次确认发布。</span></p>}</div>
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => setShowAdd(false)} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><Plus size={17} />{isSaving ? "正在保存" : "添加项目"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {editingItem && (
        <div className="modal-layer" role="presentation">
          <section className="modal credential-modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <header><div><span className="modal-icon"><Edit3 size={20} /></span><div><h2 id="edit-title">编辑项目</h2><p>变更会重新加密后保存</p></div></div><button className="icon-button" onClick={() => setEditingItem(null)} aria-label="关闭编辑"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={submitEditCredential}>
              <div className="modal-body credential-modal-body">
              <div className="credential-form-pair"><label>名称<input required value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} autoFocus /></label><label>网站地址<input required value={editForm.domain} onChange={(event) => setEditForm({ ...editForm, domain: event.target.value })} inputMode="url" /></label></div>
              <label>分类（可选）<input list="credential-category-options" value={editForm.category} onChange={(event) => setEditForm({ ...editForm, category: event.target.value })} placeholder="例如：部门一" maxLength={60} /><small>可输入新名称；分类会随加密项目保存，用于搜索和筛选。</small></label>
              <datalist id="credential-category-options">{categoryNames.map((name) => <option value={name} key={name} />)}</datalist>
              <label>用户名<input required value={editForm.username} onChange={(event) => setEditForm({ ...editForm, username: event.target.value })} autoComplete="username" /></label>
              <label>密码<div className="form-password"><input required type={showEditPassword ? "text" : "password"} value={editForm.password} onChange={(event) => setEditForm({ ...editForm, password: event.target.value })} autoComplete="new-password" /><button type="button" className="password-visibility" onClick={() => setShowEditPassword((current) => !current)} aria-label={showEditPassword ? "隐藏输入的密码" : "显示输入的密码"}>{showEditPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" onClick={generateEditPassword}><WandSparkles size={16} />生成</button></div><small>建议至少 14 位，并混合字母、数字和符号。</small></label>
              <TotpEntryFields entries={editForm.totpEntries} formId="edit" isReading={isReadingTotp} onChange={(id, changes) => updateTotpEntry("edit", id, changes)} onAdd={() => addTotpEntry("edit")} onRemove={(id) => removeTotpEntry("edit", id)} onReadImage={(event, id) => void importTotpFromImage(event, "edit", id)} />
              <div className="field-control"><span>可见范围</span><SurfaceSelect id="edit-space" ariaLabel="可见范围" value={editForm.group} onChange={(group) => setEditForm({ ...editForm, group })} options={[{ value: "个人", label: "个人项目" }, ...(isAdmin ? [{ value: "公共", label: "公共项目" }] : [])]} disabled={editingItem.group === "公共"} />{editingItem.group === "公共" ? <p className="inline-access-note"><UsersRound size={16} aria-hidden="true" /><span>所有已启用用户都可查看该项目；公共范围由管理员维护。</span></p> : null}</div>
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => setEditingItem(null)} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><Check size={17} />{isSaving ? "正在保存" : "保存变更"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {pendingPublicPublish && (
        <div className="modal-layer" role="presentation">
          <section className="modal user-create-modal" role="dialog" aria-modal="true" aria-labelledby="publish-public-title">
            <header><div><span className="modal-icon"><UsersRound size={20} /></span><div><h2 id="publish-public-title">{pendingPublicPublish.item ? "发布为公共项目？" : "新建公共项目？"}</h2><p>保存后将由所有已启用用户查看</p></div></div><button className="icon-button" type="button" onClick={() => setPendingPublicPublish(null)} aria-label="关闭公共发布确认"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (pendingPublicPublish.item) void saveEditedCredential(pendingPublicPublish.item, pendingPublicPublish.form); else void saveCredential(pendingPublicPublish.form); }}>
              <div className="modal-body">
                <div className="delete-summary publish-summary"><strong>{pendingPublicPublish.form.name}</strong><span>{pendingPublicPublish.form.username} · 公共项目</span></div>
                <p className="delete-description">所有已启用的系统用户都能查看这条项目的账号、密码和验证器代码；只有管理员可以继续编辑或删除。</p>
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => setPendingPublicPublish(null)} disabled={isSaving}>返回编辑</button><button type="submit" className="primary-button" disabled={isSaving}><UsersRound size={17} />{isSaving ? "正在发布" : "确认发布"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-layer" role="presentation">
          <section className="modal danger-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <header><div><span className="modal-icon danger-icon"><AlertTriangle size={20} /></span><div><h2 id="delete-title">删除项目？</h2><p>请确认你不再需要这条登录信息</p></div></div><button className="icon-button" onClick={() => setDeleteTarget(null)} aria-label="关闭删除确认"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={(event) => { event.preventDefault(); deleteCredential(); }}>
              <div className="modal-body">
              <div className="delete-summary"><strong>{deleteTarget.name}</strong><span>{deleteTarget.username} · {deleteTarget.type}</span></div>
              <p className="delete-description">删除后会从加密密码库中移除，操作记录会保留在审计日志中。</p>
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)} disabled={isSaving}>取消</button><button type="submit" className="danger-button" disabled={isSaving}><Trash2 size={17} />{isSaving ? "正在删除" : "删除项目"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {showUserCreateDialog && page === "users" && isAdmin && (
        <div className="modal-layer" role="presentation">
          <section className="modal user-create-modal" role="dialog" aria-modal="true" aria-labelledby="create-system-user-title">
            <header><div><span className="modal-icon"><UserCog size={20} /></span><div><h2 id="create-system-user-title">添加系统用户</h2><p>创建后可在用户管理页继续调整角色与状态</p></div></div><button className="icon-button" type="button" onClick={() => setShowUserCreateDialog(false)} aria-label="关闭添加用户"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={createSystemUser}>
              <div className="modal-body">
              <label>登录邮箱（必须）<input required type="email" value={systemUserEmail} onChange={(event) => setSystemUserEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" autoFocus /><small>请填写对方用于登录 ChatGPT、并在站点访问控制中获授权的同一邮箱。</small></label>
              <div className="field-control"><span>系统角色</span><SurfaceSelect id="new-user-role" ariaLabel="系统角色" value={systemUserRole} onChange={setSystemUserRole} options={[{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }]} /></div>
              <aside className="access-setup-note" role="note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>邮箱就是该用户的登录身份</strong><p>系统用户创建成功后，请在站点访问控制中允许该邮箱访问；不支持使用单独的用户名登录。</p></div></aside>
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => setShowUserCreateDialog(false)} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><UserCog size={17} />{isSaving ? "正在创建" : "创建用户"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {systemUserAction && isAdmin && (
        <div className="modal-layer" role="presentation">
          <section className="modal user-create-modal" role="dialog" aria-modal="true" aria-labelledby="system-user-action-title">
            <header><div><span className="modal-icon danger-icon"><AlertTriangle size={20} /></span><div><h2 id="system-user-action-title">{systemUserAction.kind === "delete" ? "删除系统用户？" : "停用系统用户？"}</h2><p>{systemUserAction.kind === "delete" ? "此操作会移除该用户及其个人密码库" : "用户可在之后由管理员重新启用"}</p></div></div><button className="icon-button" type="button" onClick={() => setSystemUserAction(null)} aria-label="关闭用户操作确认"><X size={20} /></button></header>
            <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void confirmSystemUserAction(); }}>
              <div className="modal-body">
                <div className="delete-summary"><strong>{systemUserAction.user.email}</strong><span>{systemUserAction.user.role === "admin" ? "管理员" : "普通用户"} · {systemUserAction.user.status === "active" ? "已启用" : "已停用"}</span></div>
                <p className="delete-description">{systemUserAction.kind === "delete" ? "删除后将移除其系统访问和个人密码库数据，且无法恢复。公共项目与既有审计记录不会受到影响。" : "停用后该用户将不能再访问密码库；其个人项目和公共项目数据会保留，之后可以重新启用。"}</p>
              </div>
              <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => setSystemUserAction(null)} disabled={isSaving}>取消</button><button type="submit" className="danger-button" disabled={isSaving}>{systemUserAction.kind === "delete" ? <Trash2 size={17} /> : <UserCog size={17} />}{isSaving ? "正在处理" : systemUserAction.kind === "delete" ? "删除用户" : "确认停用"}</button></footer>
            </form>
          </section>
        </div>
      )}

      <div className={`toast ${toast ? "is-visible" : ""}`} role="status" aria-live="polite"><Clipboard size={17} />{toast}</div>
    </div>
  );
}
