"use client";

import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Clock3,
  Copy,
  CreditCard,
  Edit3,
  Eye,
  EyeOff,
  FileKey2,
  Globe2,
  ImageUp,
  KeyRound,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
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
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { SecurityIssue } from "./lib/security-review";
import { generateTotpCode, parseTotpInput, totpLabel, totpSecondsRemaining, type TotpConfig } from "./lib/totp";

type Strength = "安全" | "一般" | "风险";
type ItemType = "登录" | "卡片" | "安全笔记";
type Space = "全部" | "个人" | "公共";
type Collection = "all" | "security";
type Page = "vault" | "profile" | "users";
type SecurityFocus = "all" | SecurityIssue;

type VaultItem = {
  id: string;
  name: string;
  domain: string;
  username: string;
  password: string;
  type: ItemType;
  group: string;
  updated: string;
  strength: Strength;
  twoFactor: boolean;
  favorite: boolean;
  brand: string;
  note: string;
  totp?: TotpConfig;
  canEdit: boolean;
  sharedBy?: string;
};

type VaultItemSummary = Omit<VaultItem, "password" | "note" | "totp"> & {
  passwordLength: number;
  hasTotp: boolean;
  securityIssues: SecurityIssue[];
};

type Viewer = {
  displayName: string;
  email: string;
  role: "admin" | "user";
};

type CredentialForm = Pick<VaultItem, "name" | "domain" | "username" | "password" | "group"> & {
  totpInput: string;
  removeTotp: boolean;
};
type AuditEntry = { action: string; actorEmail: string; itemId: string | null; createdAt: string };
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

const filters = ["全部", "登录"] as const;
const spaceFilters = ["全部", "个人", "公共"] as const;

function emptyCredentialForm(): CredentialForm {
  return { name: "", domain: "", username: "", password: "", group: "个人", totpInput: "", removeTotp: false };
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

function toItemSummary(item: VaultItem, securityIssues: SecurityIssue[] = []): VaultItemSummary {
  return {
    id: item.id,
    name: item.name,
    domain: item.domain,
    username: item.username,
    type: item.type,
    group: item.group,
    updated: item.updated,
    strength: item.strength,
    twoFactor: item.twoFactor,
    favorite: item.favorite,
    brand: item.brand,
    canEdit: item.canEdit,
    ...(item.sharedBy ? { sharedBy: item.sharedBy } : {}),
    passwordLength: item.password.length,
    hasTotp: Boolean(item.totp),
    securityIssues,
  };
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
  weak_password: { label: "密码过短", detail: "建议使用至少 14 位的随机密码" },
  reused_password: { label: "密码重复", detail: "同一密码正用于多个项目" },
  missing_two_factor: { label: "未开启双重验证", detail: "建议在服务网站开启验证器保护" },
};

function SecurityIssueBadges({ issues }: { issues: SecurityIssue[] }) {
  return <div className="security-issue-badges">{issues.map((issue) => <span className={`security-issue security-issue-${issue}`} key={issue}>{securityIssueCopy[issue].label}</span>)}</div>;
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

function ProfileOverview({
  viewer,
  viewerInitial,
  isLoading,
  securityScore,
  securityIssueCount,
  onOpenSecurity,
}: {
  viewer: Viewer;
  viewerInitial: string;
  isLoading: boolean;
  securityScore: number;
  securityIssueCount: number;
  onOpenSecurity: () => void;
}) {
  const isAdmin = viewer.role === "admin";
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
          <div className="profile-card-heading"><span className="profile-card-icon"><UsersRound size={18} /></span><div><h3 id="profile-permission-title">空间权限</h3><p>权限随系统角色自动生效</p></div></div>
          <div className="profile-permission-list">
            <div><span>个人空间</span><strong>仅你可查看和管理</strong></div>
            <div><span>公共空间</span><strong>{isAdmin ? "可查看并配置公共项目" : "可查看公共项目"}</strong></div>
            <div><span>系统用户</span><strong>{isAdmin ? "可创建、调整与停用用户" : "由管理员统一维护"}</strong></div>
          </div>
        </section>

        <section className="profile-card profile-security-card" aria-labelledby="profile-security-title">
          <div className="profile-card-heading"><span className="profile-card-icon"><ShieldCheck size={18} /></span><div><h3 id="profile-security-title">账户安全</h3><p>基础安全与会话保护状态</p></div></div>
          <div className="profile-security-summary"><div><strong>{isLoading ? "—" : securityScore}</strong><span>基础安全评分</span></div><p>{isLoading ? "正在读取密码库状态" : securityIssueCount === 0 ? "未发现需要处理的基础风险" : `${securityIssueCount} 条基础风险待处理`}</p></div>
          <div className="profile-security-footer"><span>空闲 15 分钟后自动结束会话</span><button type="button" className="secondary-button" onClick={onOpenSecurity}>查看安全检查</button></div>
        </section>
      </div>
    </section>
  );
}

function AuthenticatorCode({ config, itemId, onCopy, onReveal }: { config: TotpConfig; itemId: string; onCopy: (value: string, label: string, itemId: string) => void; onReveal: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
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
    const timer = window.setTimeout(() => setVisible(false), 30_000);
    return () => window.clearTimeout(timer);
  }, [visible]);

  const splitAt = Math.floor(config.digits / 2);
  const remaining = totpSecondsRemaining(config, now);

  return (
    <div className="totp-card">
      <div className="totp-heading"><span>验证器代码</span><small>{totpLabel(config)}</small></div>
      <div className="totp-value">
        <strong>{visible ? (error || (code ? <>{code.slice(0, splitAt)} <span>{code.slice(splitAt)}</span></> : "··· ···")) : "••• •••"}</strong>
        <button className="icon-button" onClick={() => { const next = !visible; setVisible(next); if (next) onReveal(); }} aria-label={visible ? "隐藏验证器代码" : "显示验证器代码"}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
        <button className="icon-button" onClick={() => code && onCopy(code, "验证器代码", itemId)} aria-label="复制验证器代码" disabled={!visible || !code}><Copy size={17} /></button>
      </div>
      <div className="totp-timer"><span style={{ width: `${(remaining / config.period) * 100}%` }} /><small>{remaining} 秒后刷新</small></div>
    </div>
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
    item_published_to_public: "将项目发布到了公共空间",
    item_deleted: "删除了项目",
    member_invited: "添加了协作人",
    member_removed: "移除了协作人",
    password_revealed: "查看了密码",
    totp_revealed: "查看了验证器代码",
    credential_copied: "复制了账号信息",
    totp_copied: "复制了验证器代码",
    export_approval_requested: "请求了导出批准",
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

export default function VaultClient({ viewer }: { viewer: Viewer }) {
  const [items, setItems] = useState<VaultItemSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<VaultItem | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof filters)[number]>("全部");
  const [space, setSpace] = useState<Space>("全部");
  const [collection, setCollection] = useState<Collection>("all");
  const [page, setPage] = useState<Page>("vault");
  const [securityFocus, setSecurityFocus] = useState<SecurityFocus>("all");
  const [revealed, setRevealed] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingItem, setEditingItem] = useState<VaultItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VaultItemSummary | null>(null);
  const [showSharing, setShowSharing] = useState(false);
  const [showUserCreateDialog, setShowUserCreateDialog] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [publicUserCount, setPublicUserCount] = useState(0);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [systemUsers, setSystemUsers] = useState<SystemUser[]>([]);
  const [systemUserEmail, setSystemUserEmail] = useState("");
  const [systemUserRole, setSystemUserRole] = useState<"admin" | "user">("user");
  const [userQuery, setUserQuery] = useState("");
  const [isUsersLoading, setIsUsersLoading] = useState(false);
  const [isReadingTotp, setIsReadingTotp] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [form, setForm] = useState<CredentialForm>(emptyCredentialForm);
  const [editForm, setEditForm] = useState<CredentialForm>(emptyCredentialForm);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesFilter = filter === "全部" || item.type === filter;
      const matchesSpace = space === "全部" || item.group === space;
      const matchesCollection = collection === "all"
        || (collection === "security" && item.securityIssues.length > 0 && (securityFocus === "all" || item.securityIssues.includes(securityFocus)));
      const matchesQuery = !normalized || [item.name, item.domain, item.username, item.group].some((value) => value.toLowerCase().includes(normalized));
      return matchesFilter && matchesSpace && matchesCollection && matchesQuery;
    });
  }, [collection, filter, items, query, securityFocus, space]);

  const activeSelectedId = visibleItems.some((item) => item.id === selectedId) ? selectedId : visibleItems[0]?.id ?? selectedId;
  const selected = selectedDetail?.id === activeSelectedId ? selectedDetail : null;
  const selectedSummary = items.find((item) => item.id === activeSelectedId) ?? null;
  const listTitle = collection === "security"
      ? "需处理的安全项"
      : space === "全部" ? (filter === "全部" ? "全部项目" : filter) : `${space} · ${filter === "全部" ? "全部项目" : filter}`;
  const viewerInitial = viewer.displayName.trim().slice(0, 1).toLocaleUpperCase() || "你";
  const isAdmin = viewer.role === "admin";
  const spaceCounts: Record<Space, number> = {
    全部: items.length,
    个人: items.filter((item) => item.group === "个人").length,
    公共: items.filter((item) => item.group === "公共").length,
  };
  const weakPasswordCount = items.filter((item) => item.securityIssues.includes("weak_password")).length;
  const reusedPasswordCount = items.filter((item) => item.securityIssues.includes("reused_password")).length;
  const missingTwoFactorCount = items.filter((item) => item.securityIssues.includes("missing_two_factor")).length;
  const securityIssueCount = items.reduce((count, item) => count + item.securityIssues.length, 0);
  const securityScore = items.length === 0 ? 0 : Math.max(0, 100 - weakPasswordCount * 14 - reusedPasswordCount * 24 - missingTwoFactorCount * 8);
  const visibleSystemUsers = useMemo(() => {
    const normalized = userQuery.trim().toLowerCase();
    return normalized ? systemUsers.filter((user) => user.email.toLowerCase().includes(normalized)) : systemUsers;
  }, [systemUsers, userQuery]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (page !== "vault") {
          setPage("vault");
          window.setTimeout(() => searchInputRef.current?.focus(), 0);
        } else {
          searchInputRef.current?.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        setShowAdd(false);
        setEditingItem(null);
        setDeleteTarget(null);
        setShowSharing(false);
        setShowUserCreateDialog(false);
        setMobileNav(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [page]);

  useEffect(() => {
    let cancelled = false;

    async function loadVault() {
      setIsLoading(true);
      setLoadError(null);
      try {
        const response = await fetch("/api/vault", { cache: "no-store" });
        const payload = await response.json() as { items?: VaultItemSummary[]; publicUserCount?: number; audit?: AuditEntry[]; approvals?: ApprovalRequest[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "无法读取密码库。");
        if (cancelled) return;

        const loadedItems = payload.items ?? [];
        setItems(loadedItems);
        setPublicUserCount(payload.publicUserCount ?? 0);
        setAudit(payload.audit ?? []);
        setApprovals(payload.approvals ?? []);
        setSelectedId((current) => current ?? loadedItems[0]?.id ?? null);
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

    void loadVault();
    return () => { cancelled = true; };
  }, [loadAttempt]);

  useEffect(() => {
    if (!activeSelectedId) return;

    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setSelectedDetail(null);
      setDetailError(null);
      setIsDetailLoading(true);
      setRevealed(false);
      try {
        const payload = await requestVault<{ item: VaultItem }>(`/api/vault/items/${activeSelectedId}`, { method: "GET" });
        if (!cancelled) setSelectedDetail(payload.item);
      } catch (error) {
        if (!cancelled) setDetailError(error instanceof Error ? error.message : "无法读取项目详情。");
      } finally {
        if (!cancelled) setIsDetailLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [activeSelectedId, detailAttempt]);

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
    window.location.assign("/signout-with-chatgpt?return_to=%2Flogin");
  }

  async function requestVault<T>(path: string, init: RequestInit) {
    const response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const payload = response.status === 204 ? null : await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(payload?.error ?? "操作未完成，请稍后重试。");
    return payload as T;
  }

  function recordAudit(action: "password_revealed" | "totp_revealed" | "credential_copied" | "totp_copied", itemId: string) {
    void requestVault("/api/vault/audit", { method: "POST", body: JSON.stringify({ action, itemId }) }).catch(() => undefined);
  }

  async function copyValue(value: string, label: string, itemId?: string) {
    try {
      await navigator.clipboard.writeText(value);
      if (itemId) recordAudit(label === "验证器代码" ? "totp_copied" : "credential_copied", itemId);
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
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? toItemSummary(payload.item, currentItem.securityIssues) : currentItem));
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
    setIsSaving(true);
    try {
      const payload = await requestVault<{ item: VaultItem }>("/api/vault/items", {
        method: "POST",
        body: JSON.stringify({ ...form, type: "登录", twoFactor: false, favorite: false, brand: "new", note: "" }),
      });
      setItems((current) => [toItemSummary(payload.item), ...current]);
      setSelectedId(payload.item.id);
      setSelectedDetail(payload.item);
      setLoadAttempt((current) => current + 1);
      setForm(emptyCredentialForm());
      setShowNewPassword(false);
      setShowAdd(false);
      setToast("项目已加密保存");
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
    setEditForm({ name: item.name, domain: item.domain, username: item.username, password: item.password, group: item.group, totpInput: "", removeTotp: false });
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

    if (editingItem.group === "个人" && editForm.group === "公共" && !window.confirm("发布后，所有已启用用户都能查看该项目的账号、密码和验证器代码。确定继续吗？")) return;

    try {
      await updateRemoteItem(editingItem, { ...editForm, totp: editingItem.totp });
      setEditingItem(null);
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
      const targetIndex = items.findIndex((item) => item.id === deleteTarget.id);
      const remaining = items.filter((item) => item.id !== deleteTarget.id);
      const nextSelected = remaining[targetIndex] ?? remaining[targetIndex - 1] ?? remaining[0];
      setItems(remaining);
      setSelectedId(nextSelected?.id ?? null);
      setSelectedDetail(null);
      setDeleteTarget(null);
      setRevealed(false);
      setToast(`已删除“${deleteTarget.name}”`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "项目未删除。");
    } finally {
      setIsSaving(false);
    }
  }

  async function openUserManagement() {
    if (!isAdmin) return;
    setPage("users");
    setShowUserCreateDialog(false);
    setUserQuery("");
    setIsUsersLoading(true);
    try {
      const payload = await requestVault<{ users: SystemUser[] }>("/api/users", { method: "GET" });
      setSystemUsers(payload.users);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法读取系统用户。");
    } finally {
      setIsUsersLoading(false);
    }
  }

  async function createSystemUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    try {
      const payload = await requestVault<{ user: SystemUser }>("/api/users", {
        method: "POST",
        body: JSON.stringify({ email: systemUserEmail, role: systemUserRole }),
      });
      setSystemUsers((current) => [...current, payload.user].sort((left, right) => left.role === right.role ? left.email.localeCompare(right.email) : left.role === "admin" ? -1 : 1));
      setPublicUserCount((current) => current + 1);
      setSystemUserEmail("");
      setSystemUserRole("user");
      setShowUserCreateDialog(false);
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
      const payload = await requestVault<{ user: SystemUser }>("/api/users", {
        method: "PATCH",
        body: JSON.stringify({ email: user.email, ...changes }),
      });
      setSystemUsers((current) => current.map((candidate) => candidate.email === user.email ? payload.user : candidate));
      if (changes.status && changes.status !== user.status) {
        setPublicUserCount((current) => Math.max(0, current + (changes.status === "active" ? 1 : -1)));
      }
      setToast(changes.status ? (changes.status === "suspended" ? "用户已停用" : "用户已重新启用") : "用户角色已更新");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法更新该用户。");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteSystemUser(user: SystemUser) {
    if (user.isCurrent) return;
    if (!window.confirm(`确定删除 ${user.email} 吗？\n\n该操作会移除其系统访问和个人密码库数据，且无法恢复。公共项目与系统审计记录不会受影响。`)) return;
    setIsSaving(true);
    try {
      await requestVault("/api/users", { method: "DELETE", body: JSON.stringify({ email: user.email }) });
      setSystemUsers((current) => current.filter((candidate) => candidate.email !== user.email));
      if (user.status === "active") setPublicUserCount((current) => Math.max(0, current - 1));
      setToast("系统用户已删除");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法删除该用户。");
    } finally {
      setIsSaving(false);
    }
  }

  async function importTotpFromImage(event: ChangeEvent<HTMLInputElement>, target: "add" | "edit") {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setIsReadingTotp(true);
    try {
      const totpInput = await decodeTotpImage(file);
      if (target === "add") {
        setForm((current) => ({ ...current, totpInput, removeTotp: false }));
      } else {
        setEditForm((current) => ({ ...current, totpInput, removeTotp: false }));
      }
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
      setToast("已向其他系统用户请求导出批准，有效期 10 分钟");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法请求导出批准。");
    } finally {
      setIsSaving(false);
    }
  }

  async function decideExportApproval(id: string, decision: "approved" | "rejected") {
    setIsSaving(true);
    try {
      await requestVault("/api/vault/approvals", { method: "PATCH", body: JSON.stringify({ id, decision }) });
      setApprovals((current) => current.filter((approval) => approval.id !== id));
      setToast(decision === "approved" ? "已批准导出请求" : "已拒绝导出请求");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "无法处理该请求。");
    } finally {
      setIsSaving(false);
    }
  }

  async function downloadApprovedExport(approvalId: string) {
    setIsSaving(true);
    try {
      const response = await fetch(`/api/vault/export?approvalId=${encodeURIComponent(approvalId)}`, { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json() as { error?: string };
        throw new Error(payload.error ?? "无法导出密码库。");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "shouyao-vault-export.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
          <div><strong>守钥</strong><span>个人安全中心</span></div>
          <button className="icon-button sidebar-close" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={20} /></button>
        </div>

        <nav className="main-nav">
          <p className="nav-label">密码库</p>
          <button className={`nav-item ${page === "vault" && collection === "all" && space === "全部" ? "is-active" : ""}`} aria-pressed={page === "vault" && collection === "all" && space === "全部"} onClick={() => { setPage("vault"); setCollection("all"); setSpace("全部"); setMobileNav(false); }}><KeyRound size={18} /><span>所有项目</span><span className="nav-count">{items.length}</span></button>
          <button className={`nav-item ${page === "vault" && collection === "security" ? "is-active" : ""}`} aria-pressed={page === "vault" && collection === "security"} onClick={() => { setPage("vault"); setCollection("security"); setSpace("全部"); setSecurityFocus("all"); setMobileNav(false); }}><ShieldEllipsis size={18} /><span>安全检查</span><span className="nav-alert">{securityIssueCount}</span></button>

          {isAdmin && <><p className="nav-label nav-label-spaced">系统</p><button className={`nav-item ${page === "users" ? "is-active" : ""}`} aria-pressed={page === "users"} onClick={() => { setMobileNav(false); void openUserManagement(); }}><UserCog size={18} /><span>用户管理</span></button></>}

          <p className="nav-label nav-label-spaced">账户</p>
          <button className={`nav-item ${page === "profile" ? "is-active" : ""}`} aria-pressed={page === "profile"} onClick={() => { setPage("profile"); setMobileNav(false); }}><UserRound size={18} /><span>个人信息</span></button>
        </nav>

        <div className="sidebar-tip">
          <ShieldCheck size={18} aria-hidden="true" />
          <div><strong>安全会话已开启</strong><span>密码记录会加密保存</span></div>
        </div>

        <div className="account-menu">
          <span className="avatar" aria-hidden="true">{viewerInitial}</span>
          <div><strong title={viewer.displayName}>{viewer.displayName}</strong><span title={viewer.email}>{viewer.role === "admin" ? "管理员 · " : "普通用户 · "}{viewer.email}</span></div>
          <button className="icon-button dark-icon" onClick={() => setShowSharing(true)} aria-label="公共空间说明"><MoreHorizontal size={19} /></button>
        </div>
      </aside>

      <main id="main-content" className="main-shell">
        <header className={`topbar ${page !== "vault" ? "is-compact" : ""}`}>
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={21} /></button>
          <div className="page-title"><h1>{page === "profile" ? "个人信息" : page === "users" ? "用户管理" : "密码库"}</h1><p>{page === "profile" ? "查看你的账户资料、系统角色与空间权限" : page === "users" ? "创建、调整、停用或删除系统用户" : "集中管理账号、密码与验证器代码"}</p></div>
          {page === "vault" && <div className="topbar-search">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="vault-search">搜索密码库</label>
            <input ref={searchInputRef} id="vault-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号、网址或分类" />
            <kbd>⌘ K</kbd>
          </div>}
          <button className="secondary-button lock-button" onClick={endSession}><LogOut size={17} />结束会话</button>
          {page === "vault" && <button className="primary-button" onClick={() => setShowAdd(true)} disabled={isLoading || isSaving}><Plus size={18} />新建项目</button>}
          {page === "users" && <button className="primary-button user-add-button" onClick={() => setShowUserCreateDialog(true)} disabled={isSaving}><Plus size={16} />添加用户</button>}
        </header>

        {page === "users" ? <section className="users-page" aria-labelledby="users-page-title">
          <section className="users-panel" aria-labelledby="users-page-title"><div className="users-toolbar"><div className="users-toolbar-copy"><h2 id="users-page-title">系统用户</h2><span>{isUsersLoading ? "正在读取用户" : `显示 ${visibleSystemUsers.length} / ${systemUsers.length} 位用户`}</span></div><div className="users-search"><Search size={17} aria-hidden="true" /><label className="sr-only" htmlFor="user-search">搜索系统用户</label><input id="user-search" value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="搜索邮箱" /></div></div>{isUsersLoading ? <p className="users-empty">正在读取系统用户。</p> : visibleSystemUsers.length > 0 ? <div className="system-user-table-wrap"><table className="system-user-table"><thead><tr><th scope="col">用户</th><th scope="col">角色</th><th scope="col">状态</th><th scope="col">创建时间</th><th scope="col">管理</th></tr></thead><tbody>{visibleSystemUsers.map((user) => <tr key={user.email}><td data-label="用户"><div className="system-user-identity"><strong title={user.email}>{user.email}</strong>{user.isCurrent && <span className="current-user">当前账户</span>}</div></td><td data-label="角色"><b className={`role-badge role-${user.role}`}>{user.role === "admin" ? "管理员" : "普通用户"}</b></td><td data-label="状态"><b className={`status-badge status-${user.status}`}>{user.status === "active" ? "已启用" : "已停用"}</b></td><td data-label="创建时间"><span className="system-user-created">{user.createdAt}</span></td><td data-label="管理">{user.isCurrent ? <span className="current-user">当前账户不可调整</span> : <div className="system-user-actions"><SurfaceSelect id={`role-${user.email}`} ariaLabel={`调整${user.email}的系统角色`} value={user.role} onChange={(role) => void updateSystemUser(user, { role })} options={[{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }]} disabled={isSaving} compact /><button type="button" className="secondary-button" onClick={() => { const nextStatus = user.status === "active" ? "suspended" : "active"; if (nextStatus === "suspended" && !window.confirm(`确定停用 ${user.email} 吗？`)) return; void updateSystemUser(user, { status: nextStatus }); }} disabled={isSaving}>{user.status === "active" ? "停用" : "启用"}</button><button type="button" className="secondary-button user-delete-button" onClick={() => void deleteSystemUser(user)} disabled={isSaving}>删除</button></div>}</td></tr>)}</tbody></table></div> : <p className="users-empty">没有找到匹配的系统用户。</p>}</section>
        </section> : page === "profile" ? <ProfileOverview viewer={viewer} viewerInitial={viewerInitial} isLoading={isLoading} securityScore={securityScore} securityIssueCount={securityIssueCount} onOpenSecurity={() => { setPage("vault"); setCollection("security"); setSpace("全部"); setSecurityFocus("all"); }} /> : <>
        <section className="security-strip" aria-labelledby="security-heading">
          <div className="score-block">
          <div className="score-copy"><span>基础安全评分</span><strong id="security-heading">{securityScore}<small>/100</small></strong></div>
            <div className="score-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={securityScore} aria-label={`安全评分 ${securityScore} 分`}><span style={{ width: `${securityScore}%` }} /></div>
            <p>{securityScore >= 80 ? <Check size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}{securityScore >= 80 ? "未发现需要处理的基础风险" : `${securityIssueCount} 条风险需要处理`}</p>
          </div>
          <button className="risk-item" onClick={() => { setCollection("security"); setSpace("全部"); setSecurityFocus("weak_password"); }}><span className="risk-icon risk-danger"><AlertTriangle size={17} /></span><span><strong>{weakPasswordCount} 个密码过短</strong><small>建议立即更换</small></span><ChevronRight size={18} /></button>
          <button className="risk-item" onClick={() => { setCollection("security"); setSpace("全部"); setSecurityFocus("reused_password"); }}><span className="risk-icon risk-warning"><ShieldEllipsis size={17} /></span><span><strong>{reusedPasswordCount} 个重复密码</strong><small>避免一个泄露影响多个账号</small></span><ChevronRight size={18} /></button>
          <button className="risk-item" onClick={() => { setCollection("security"); setSpace("全部"); setSecurityFocus("missing_two_factor"); }}><span className="risk-icon risk-info"><Smartphone size={17} /></span><span><strong>{missingTwoFactorCount} 个未启用双重验证</strong><small>查看需处理项目</small></span><ChevronRight size={18} /></button>
        </section>

        <div className="content-grid">
          <section className="vault-panel" aria-labelledby="vault-list-title">
            {collection === "security" && <div className="security-review" role="region" aria-labelledby="security-review-title">
              <div className="security-review-head"><div><span className="eyebrow">安全检查</span><h2 id="security-review-title">{securityIssueCount > 0 ? `${securityIssueCount} 条基础风险待处理` : "基础检查已通过"}</h2><p>检查密码长度、重复使用情况和双重验证状态。</p></div><ShieldCheck size={21} aria-hidden="true" /></div>
              <div className="security-focuses" role="group" aria-label="安全风险筛选">
                <button className={securityFocus === "all" ? "is-selected" : ""} onClick={() => setSecurityFocus("all")}>全部 {securityIssueCount}</button>
                <button className={securityFocus === "weak_password" ? "is-selected" : ""} onClick={() => setSecurityFocus("weak_password")}>密码过短 {weakPasswordCount}</button>
                <button className={securityFocus === "reused_password" ? "is-selected" : ""} onClick={() => setSecurityFocus("reused_password")}>密码重复 {reusedPasswordCount}</button>
                <button className={securityFocus === "missing_two_factor" ? "is-selected" : ""} onClick={() => setSecurityFocus("missing_two_factor")}>未开双重验证 {missingTwoFactorCount}</button>
              </div>
            </div>}
            <div className="panel-toolbar">
              <div className="toolbar-filters">
                <div className="filter-tabs" role="group" aria-label="项目范围筛选">
                  {spaceFilters.map((item) => (
                    <button key={item} className={space === item ? "is-selected" : ""} onClick={() => { setCollection("all"); setSpace(item); }}>{item}<span>{spaceCounts[item]}</span></button>
                  ))}
                </div>
                <span className="toolbar-divider" aria-hidden="true" />
                <div className="filter-tabs filter-tabs-secondary" role="group" aria-label="项目类型筛选">
                  {filters.map((item) => (
                    <button key={item} className={filter === item ? "is-selected" : ""} onClick={() => { setCollection("all"); setFilter(item); }}>{item}</button>
                  ))}
                </div>
              </div>
              <span className="sort-button">最近更新</span>
            </div>

            <div className="list-heading">
              <div><h2 id="vault-list-title">{listTitle}</h2><span>{visibleItems.length} 项</span></div>
              <span>安全状态</span><span>更新时间</span><span className="sr-only">更多操作</span>
            </div>

            <div className="vault-list">
              {isLoading ? (
                <div className="empty-state"><Clock3 size={24} /><h3>正在读取密码库</h3><p>正在加载已加密的项目。</p></div>
              ) : loadError ? (
                <div className="empty-state empty-state-error" role="alert"><AlertTriangle size={24} /><h3>无法读取密码库</h3><p>{loadError}</p><button className="secondary-button" onClick={() => setLoadAttempt((current) => current + 1)}>重新加载</button></div>
              ) : visibleItems.length > 0 ? visibleItems.map((item) => (
                <button key={item.id} className={`vault-row ${activeSelectedId === item.id ? "is-selected" : ""}`} onClick={() => { setSelectedId(item.id); setRevealed(false); }} aria-pressed={activeSelectedId === item.id}>
                  <div className="item-identity"><BrandMark item={item} /><span><span className="item-name-line"><strong>{item.name}</strong><b className={`space-badge ${item.group === "公共" ? "is-public" : "is-personal"}`}>{item.group}</b></span><small>{item.username}</small></span></div>
                  <div>{collection === "security" ? <SecurityIssueBadges issues={item.securityIssues} /> : <StrengthBadge strength={item.strength} />}</div>
                  <span className="updated-at">{item.updated}</span>
                  <span className="row-chevron"><ChevronRight size={18} /></span>
                </button>
              )) : (
                <div className="empty-state"><Search size={24} /><h3>{items.length === 0 ? "密码库尚未添加项目" : "没有找到匹配项目"}</h3><p>{items.length === 0 ? "从第一个账号开始，建立加密保存的密码库。" : "尝试搜索其他账号、网址或分类。"}</p><button className="secondary-button" onClick={() => { if (items.length === 0) setShowAdd(true); else { setQuery(""); setFilter("全部"); setCollection("all"); setSpace("全部"); } }}>{items.length === 0 ? "新建项目" : "清除筛选"}</button></div>
              )}
            </div>
          </section>

          {selected ? (
          <aside className="detail-panel" aria-labelledby="detail-title">
            <div className="detail-head">
              <div className="detail-brand"><BrandMark item={selected} /><div><span className="eyebrow">{selected.type}</span><div className="detail-title-line"><h2 id="detail-title">{selected.name}</h2><b className={`space-badge ${selected.group === "公共" ? "is-public" : "is-personal"}`}>{selected.group}</b></div><a href={selected.domain.includes(".") ? `https://${selected.domain}` : "#"} target="_blank" rel="noreferrer">{selected.domain}<ArrowUpRight size={14} /></a></div></div>
              <div className="detail-actions">
                {selected.canEdit ? <><button className="icon-button" onClick={() => openEdit(selected)} aria-label={`编辑${selected.name}`} disabled={isSaving}><Edit3 size={18} /></button><button className="icon-button destructive-icon" onClick={() => setDeleteTarget(selected)} aria-label={`删除${selected.name}`} disabled={isSaving}><Trash2 size={18} /></button></> : <span className="detail-read-only" title="公共项目仅管理员可编辑或删除"><Eye size={15} aria-hidden="true" />只读</span>}
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
              <div className="credential-statuses" aria-label="账号安全状态"><span className={`credential-status credential-status-${selected.strength}`}>{selected.strength === "安全" ? <ShieldCheck size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}密码{selected.strength}</span><span className={`credential-status ${selected.twoFactor ? "is-protected" : "is-unprotected"}`}>{selected.twoFactor ? <ShieldCheck size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}{selected.totp ? "验证器已保存" : selected.twoFactor ? "双重验证已开启" : "未开双重验证"}</span></div>
            </div>

            {selectedSummary && selectedSummary.securityIssues.length > 0 && <div className="detail-section security-findings">
              <div className="field-label"><span>需处理的安全项</span></div>
              <div className="security-finding-list">{selectedSummary.securityIssues.map((issue) => <div className={`security-finding security-finding-${issue}`} key={issue}><AlertTriangle size={16} aria-hidden="true" /><div><strong>{securityIssueCopy[issue].label}</strong><span>{securityIssueCopy[issue].detail}</span></div></div>)}</div>
            </div>}

            {selected.totp && <div className="detail-section"><AuthenticatorCode config={selected.totp} itemId={selected.id} onCopy={copyValue} onReveal={() => recordAudit("totp_revealed", selected.id)} /></div>}

            <div className="detail-section">
              <div className="field-label"><span>备注</span></div>
              <p className="note-copy">{selected.note}</p>
            </div>

            <div className="detail-footer">
              <div><Clock3 size={15} /><span>上次修改：{selected.updated}</span></div>
              <button className="open-site-button" disabled={!selected.domain.includes(".")} onClick={() => selected.domain.includes(".") && window.open(`https://${selected.domain}`, "_blank", "noopener,noreferrer")}><Globe2 size={17} />访问网站<ArrowUpRight size={15} /></button>
            </div>
          </aside>
          ) : items.length > 0 ? (
            <aside className="detail-panel detail-empty" aria-live="polite">
              {isDetailLoading ? <><Clock3 size={25} aria-hidden="true" /><h2>正在读取项目</h2><p>敏感字段仅在选中项目后按需读取。</p></> : <><AlertTriangle size={25} aria-hidden="true" /><h2>无法读取项目详情</h2><p>{detailError ?? "请重新选择该项目。"}</p><button className="secondary-button" onClick={() => setDetailAttempt((current) => current + 1)}>重新读取</button></>}
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
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
            <header><div><span className="modal-icon"><KeyRound size={20} /></span><div><h2 id="add-title">添加登录信息</h2><p>保存后以加密形式写入你的密码库</p></div></div><button className="icon-button" onClick={() => setShowAdd(false)} aria-label="关闭"><X size={20} /></button></header>
            <form onSubmit={submitCredential}>
              <label>名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：公司邮箱" autoFocus /></label>
              <label>网站地址<input required value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} placeholder="example.com" inputMode="url" /></label>
              <label>用户名<input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="name@example.com" autoComplete="username" /></label>
              <label>密码<div className="form-password"><input required type={showNewPassword ? "text" : "password"} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="输入或生成强密码" autoComplete="new-password" /><button type="button" className="password-visibility" onClick={() => setShowNewPassword((current) => !current)} aria-label={showNewPassword ? "隐藏输入的密码" : "显示输入的密码"}>{showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" onClick={generatePassword}><WandSparkles size={16} />生成</button></div><small>建议至少 14 位，并混合字母、数字和符号。</small></label>
              <div className="totp-entry">
                <label htmlFor="add-totp">二次验证码（可选）</label>
                <input id="add-totp" type="text" value={form.totpInput} onChange={(event) => setForm({ ...form, totpInput: event.target.value, removeTotp: false })} placeholder="粘贴二维码内容或 Setup Key" autoComplete="off" spellCheck="false" />
                <div className="totp-entry-actions"><label className="totp-image-button" htmlFor="add-totp-image"><ImageUp size={16} />{isReadingTotp ? "正在读取图片" : "从二维码图片读取"}</label><input id="add-totp-image" className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void importTotpFromImage(event, "add")} disabled={isReadingTotp} /></div>
                <p>不使用摄像头。图片仅在当前浏览器解析，保存时仅加密存入验证器密钥。</p>
              </div>
              <div className="field-control"><span>保存到空间</span><SurfaceSelect id="add-space" ariaLabel="保存到空间" value={form.group} onChange={(group) => setForm({ ...form, group })} options={[{ value: "个人", label: "个人空间" }, ...(isAdmin ? [{ value: "公共", label: "公共空间" }] : [])]} /></div>
              <footer><button type="button" className="secondary-button" onClick={() => setShowAdd(false)} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><Plus size={17} />{isSaving ? "正在保存" : "添加项目"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {editingItem && (
        <div className="modal-layer" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">
            <header><div><span className="modal-icon"><Edit3 size={20} /></span><div><h2 id="edit-title">编辑项目</h2><p>变更会重新加密后保存</p></div></div><button className="icon-button" onClick={() => setEditingItem(null)} aria-label="关闭编辑"><X size={20} /></button></header>
            <form onSubmit={submitEditCredential}>
              <label>名称<input required value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} autoFocus /></label>
              <label>网站地址<input required value={editForm.domain} onChange={(event) => setEditForm({ ...editForm, domain: event.target.value })} inputMode="url" /></label>
              <label>用户名<input required value={editForm.username} onChange={(event) => setEditForm({ ...editForm, username: event.target.value })} autoComplete="username" /></label>
              <label>密码<div className="form-password"><input required type={showEditPassword ? "text" : "password"} value={editForm.password} onChange={(event) => setEditForm({ ...editForm, password: event.target.value })} autoComplete="new-password" /><button type="button" className="password-visibility" onClick={() => setShowEditPassword((current) => !current)} aria-label={showEditPassword ? "隐藏输入的密码" : "显示输入的密码"}>{showEditPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" onClick={generateEditPassword}><WandSparkles size={16} />生成</button></div><small>建议至少 14 位，并混合字母、数字和符号。</small></label>
              <div className="totp-entry">
                <label htmlFor="edit-totp">二次验证码</label>
                <input id="edit-totp" type="text" value={editForm.totpInput} onChange={(event) => setEditForm({ ...editForm, totpInput: event.target.value, removeTotp: false })} placeholder={editingItem.totp ? "留空保留；输入新密钥可替换" : "粘贴二维码内容或 Setup Key"} autoComplete="off" spellCheck="false" />
                <div className="totp-entry-actions"><label className="totp-image-button" htmlFor="edit-totp-image"><ImageUp size={16} />{isReadingTotp ? "正在读取图片" : "从二维码图片读取"}</label><input id="edit-totp-image" className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void importTotpFromImage(event, "edit")} disabled={isReadingTotp} /></div>
                {editingItem.totp ? <p>当前已配置验证器。{editForm.removeTotp ? "保存后会移除。" : "留空可保留现有密钥。"} <button type="button" className="text-button" onClick={() => setEditForm({ ...editForm, removeTotp: !editForm.removeTotp, totpInput: "" })}>{editForm.removeTotp ? "撤销移除" : "移除验证器"}</button></p> : <p>不使用摄像头。图片仅在当前浏览器解析，保存时仅加密存入验证器密钥。</p>}
              </div>
              <div className="field-control"><span>保存到空间</span><SurfaceSelect id="edit-space" ariaLabel="保存到空间" value={editForm.group} onChange={(group) => setEditForm({ ...editForm, group })} options={[{ value: "个人", label: "个人空间" }, ...(isAdmin ? [{ value: "公共", label: "公共空间" }] : [])]} disabled={editingItem.group === "公共"} />{editingItem.group === "公共" && <small>公共项目保持在公共空间，避免误移除所有用户的查看权限。</small>}</div>
              <footer><button type="button" className="secondary-button" onClick={() => setEditingItem(null)} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><Check size={17} />{isSaving ? "正在保存" : "保存变更"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-layer" role="presentation">
          <section className="modal danger-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <header><div><span className="modal-icon danger-icon"><AlertTriangle size={20} /></span><div><h2 id="delete-title">删除项目？</h2><p>请确认你不再需要这条登录信息</p></div></div><button className="icon-button" onClick={() => setDeleteTarget(null)} aria-label="关闭删除确认"><X size={20} /></button></header>
            <form onSubmit={(event) => { event.preventDefault(); deleteCredential(); }}>
              <div className="delete-summary"><strong>{deleteTarget.name}</strong><span>{deleteTarget.username} · {deleteTarget.type}</span></div>
              <p className="delete-description">删除后会从加密密码库中移除，操作记录会保留在审计日志中。</p>
              <footer><button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)} disabled={isSaving}>取消</button><button type="submit" className="danger-button" disabled={isSaving}><Trash2 size={17} />{isSaving ? "正在删除" : "删除项目"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {showUserCreateDialog && page === "users" && isAdmin && (
        <div className="modal-layer" role="presentation">
          <section className="modal user-create-modal" role="dialog" aria-modal="true" aria-labelledby="create-system-user-title">
            <header><div><span className="modal-icon"><UserCog size={20} /></span><div><h2 id="create-system-user-title">添加系统用户</h2><p>创建后可在用户管理页继续调整角色与状态</p></div></div><button className="icon-button" type="button" onClick={() => setShowUserCreateDialog(false)} aria-label="关闭添加用户"><X size={20} /></button></header>
            <form onSubmit={createSystemUser}>
              <label>用户邮箱<input required type="email" value={systemUserEmail} onChange={(event) => setSystemUserEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" autoFocus /></label>
              <div className="field-control"><span>系统角色</span><SurfaceSelect id="new-user-role" ariaLabel="系统角色" value={systemUserRole} onChange={setSystemUserRole} options={[{ value: "user", label: "普通用户" }, { value: "admin", label: "管理员" }]} /></div>
              <aside className="access-setup-note" role="note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>创建后还需完成站点访问授权</strong><p>系统用户创建成功后，请在站点访问控制中允许该邮箱访问；完成后，对方登录即可使用对应权限。</p></div></aside>
              <footer><button type="button" className="secondary-button" onClick={() => setShowUserCreateDialog(false)} disabled={isSaving}>取消</button><button type="submit" className="primary-button" disabled={isSaving}><UserCog size={17} />{isSaving ? "正在创建" : "创建用户"}</button></footer>
            </form>
          </section>
        </div>
      )}

      {showSharing && (
        <div className="modal-layer" role="presentation">
          <section className="modal sharing-modal" role="dialog" aria-modal="true" aria-labelledby="sharing-title">
            <header><div><span className="modal-icon"><UsersRound size={20} /></span><div><h2 id="sharing-title">公共空间规则</h2><p>全体已启用用户可查看，配置权仅限管理员</p></div></div><button className="icon-button" onClick={() => setShowSharing(false)} aria-label="关闭公共空间说明"><X size={20} /></button></header>
            <aside className="sharing-guide" role="note"><ShieldCheck size={18} aria-hidden="true" /><div><strong>统一公共权限</strong><p>当前有 {publicUserCount} 位已启用系统用户。它们都可以查看公共账号、密码和验证器代码；只有管理员能新建、编辑、发布或删除公共项目。</p><p>开通新成员分两步：先在“用户管理”中创建并启用邮箱，再到站点访问控制中允许该邮箱访问。两步都完成后，对方才可登录。</p></div></aside>
            <div className="sharing-section">
              <div className="sharing-section-title"><h3>成员管理</h3><span>{publicUserCount} 位</span></div>
              {isAdmin ? <button type="button" className="secondary-button" onClick={() => { setShowSharing(false); void openUserManagement(); }}><UserCog size={17} />管理系统用户</button> : <p className="sharing-empty">系统用户由管理员维护；你的公共项目权限会随账户状态自动更新。</p>}
            </div>
            <div className="sharing-section approval-section">
              <div className="sharing-section-title"><h3>导出双人确认</h3><span>10 分钟有效</span></div>
              <p className="form-note">导出会生成包含明文密码的文件，包含你的个人项目及全局公共项目；必须由另一位已启用系统用户批准。</p>
              {publicUserCount > 1 && !approvals.some((approval) => approval.isRequester && approval.status === "pending") && <button type="button" className="secondary-button" onClick={requestExportApproval} disabled={isSaving}><Archive size={17} />请求导出批准</button>}
              {publicUserCount <= 1 && <p className="sharing-empty">请先创建并启用至少一位其他系统用户，才能使用双人导出确认。</p>}
              {approvals.length > 0 ? <div className="approval-list">{approvals.map((approval) => (
                <div className="approval-row" key={approval.id}>
                  <div><strong>{approval.isRequester ? "你的导出请求" : `${approval.requestedBy} 请求导出`}</strong><span>{approval.status === "approved" ? `已由 ${approval.approverEmail ?? "协作人"} 批准` : `将在 ${approval.expiresAt} 后过期`}</span></div>
                  <div className="approval-actions">
                    {approval.canDecide && <><button type="button" className="secondary-button" onClick={() => decideExportApproval(approval.id, "rejected")} disabled={isSaving}>拒绝</button><button type="button" className="primary-button" onClick={() => decideExportApproval(approval.id, "approved")} disabled={isSaving}>批准</button></>}
                    {approval.isRequester && approval.status === "approved" && <button type="button" className="primary-button" onClick={() => downloadApprovedExport(approval.id)} disabled={isSaving}><Archive size={17} />下载副本</button>}
                    {approval.isRequester && approval.status === "pending" && <span className="approval-pending">等待其他用户</span>}
                  </div>
                </div>
              ))}</div> : <p className="sharing-empty">没有待处理的导出请求。</p>}
            </div>
            <div className="sharing-section audit-section">
              <div className="sharing-section-title"><h3>最近安全记录</h3><span>最近 20 条</span></div>
              {audit.length > 0 ? <ul className="audit-list">{audit.slice(0, 5).map((entry, index) => <li key={`${entry.action}-${entry.createdAt}-${index}`}><span><strong>{entry.actorEmail}</strong>{auditLabel(entry.action)}</span><time>{entry.createdAt}</time></li>)}</ul> : <p className="sharing-empty">公共空间的关键操作会显示在这里。</p>}
            </div>
          </section>
        </div>
      )}

      <div className={`toast ${toast ? "is-visible" : ""}`} role="status" aria-live="polite"><Clipboard size={17} />{toast}</div>
    </div>
  );
}
