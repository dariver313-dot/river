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
  Heart,
  KeyRound,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  ShieldCheck,
  ShieldEllipsis,
  Smartphone,
  Star,
  Trash2,
  UserRound,
  UsersRound,
  WandSparkles,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Strength = "安全" | "一般" | "风险";
type ItemType = "登录" | "卡片" | "安全笔记";
type Space = "全部" | "个人" | "公共";

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
  canEdit: boolean;
  sharedBy?: string;
};

type Viewer = {
  displayName: string;
  email: string;
};

type CredentialForm = Pick<VaultItem, "name" | "domain" | "username" | "password" | "group">;
type VaultMember = { email: string; role: "editor" | "viewer"; createdAt: string };
type AuditEntry = { action: string; actorEmail: string; itemId: string | null; createdAt: string };
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

const filters = ["全部", "登录", "卡片", "安全笔记"] as const;

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

function auditLabel(action: string) {
  const labels: Record<string, string> = {
    item_created: "新增了项目",
    item_updated: "更新了项目",
    item_deleted: "删除了项目",
    member_invited: "添加了协作人",
    member_removed: "移除了协作人",
    password_revealed: "查看了密码",
    credential_copied: "复制了账号信息",
    export_approval_requested: "请求了导出批准",
    export_approved: "批准了密码库导出",
    export_rejected: "拒绝了密码库导出",
    vault_exported: "导出了密码库",
  };
  return labels[action] ?? "执行了安全操作";
}

export default function VaultClient({ viewer }: { viewer: Viewer }) {
  const [items, setItems] = useState<VaultItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof filters)[number]>("全部");
  const [space, setSpace] = useState<Space>("全部");
  const [revealed, setRevealed] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editingItem, setEditingItem] = useState<VaultItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VaultItem | null>(null);
  const [showSharing, setShowSharing] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [toast, setToast] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"editor" | "viewer">("editor");
  const [form, setForm] = useState<CredentialForm>({ name: "", domain: "", username: "", password: "", group: "个人" });
  const [editForm, setEditForm] = useState<CredentialForm>({ name: "", domain: "", username: "", password: "", group: "个人" });

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesFilter = filter === "全部" || item.type === filter;
      const matchesSpace = space === "全部" || item.group === space;
      const matchesQuery = !normalized || [item.name, item.domain, item.username, item.group].some((value) => value.toLowerCase().includes(normalized));
      return matchesFilter && matchesSpace && matchesQuery;
    });
  }, [filter, items, query, space]);

  const activeSelectedId = visibleItems.some((item) => item.id === selectedId) ? selectedId : visibleItems[0]?.id ?? selectedId;
  const selected = items.find((item) => item.id === activeSelectedId) ?? items[0];
  const listTitle = space === "全部" ? (filter === "全部" ? "全部项目" : filter) : `${space} · ${filter === "全部" ? "全部项目" : filter}`;
  const viewerInitial = viewer.displayName.trim().slice(0, 1).toLocaleUpperCase() || "你";
  const weakPasswordCount = items.filter((item) => item.strength === "风险").length;
  const missingTwoFactorCount = items.filter((item) => !item.twoFactor).length;
  const securityScore = items.length === 0 ? 0 : Math.max(0, 100 - weakPasswordCount * 18 - missingTwoFactorCount * 5);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowAdd(false);
        setEditingItem(null);
        setDeleteTarget(null);
        setShowSharing(false);
        setMobileNav(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadVault() {
      try {
        const response = await fetch("/api/vault", { cache: "no-store" });
        const payload = await response.json() as { items?: VaultItem[]; members?: VaultMember[]; audit?: AuditEntry[]; approvals?: ApprovalRequest[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "无法读取密码库。");
        if (cancelled) return;

        const loadedItems = payload.items ?? [];
        setItems(loadedItems);
        setMembers(payload.members ?? []);
        setAudit(payload.audit ?? []);
        setApprovals(payload.approvals ?? []);
        setSelectedId((current) => current ?? loadedItems[0]?.id ?? null);
      } catch (error) {
        if (!cancelled) setToast(error instanceof Error ? error.message : "无法读取密码库。");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void loadVault();
    return () => { cancelled = true; };
  }, []);

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

  function endSession() {
    window.location.assign("/signout-with-chatgpt?return_to=%2Flogin");
  }

  async function requestVault<T>(path: string, init: RequestInit) {
    const response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const payload = response.status === 204 ? null : await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(payload?.error ?? "操作未完成，请稍后重试。");
    return payload as T;
  }

  function recordAudit(action: "password_revealed" | "credential_copied", itemId: string) {
    void requestVault("/api/vault/audit", { method: "POST", body: JSON.stringify({ action, itemId }) }).catch(() => undefined);
  }

  async function copyValue(value: string, label: string, itemId?: string) {
    try {
      await navigator.clipboard.writeText(value);
      if (itemId) recordAudit("credential_copied", itemId);
      setToast(`${label}已复制，请在不需要时手动清理剪贴板`);
    } catch {
      setToast("复制失败，请手动选择内容");
    }
  }

  async function updateRemoteItem(item: VaultItem, changes: Partial<VaultItem>) {
    setIsSaving(true);
    try {
      const payload = await requestVault<{ item: VaultItem }>(`/api/vault/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...item, ...changes }),
      });
      setItems((current) => current.map((currentItem) => currentItem.id === item.id ? payload.item : currentItem));
      setSelectedId(payload.item.id);
      return payload.item;
    } finally {
      setIsSaving(false);
    }
  }

  function toggleFavorite(item: VaultItem) {
    void updateRemoteItem(item, { favorite: !item.favorite })
      .then(() => setToast(item.favorite ? "已取消收藏" : "已添加到收藏"))
      .catch((error) => setToast(error instanceof Error ? error.message : "收藏状态未更新。"));
  }

  async function submitCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    try {
      const payload = await requestVault<{ item: VaultItem }>("/api/vault/items", {
        method: "POST",
        body: JSON.stringify({ ...form, type: "登录", twoFactor: false, favorite: false, brand: "new", note: "" }),
      });
      setItems((current) => [payload.item, ...current]);
      setSelectedId(payload.item.id);
      setForm({ name: "", domain: "", username: "", password: "", group: "个人" });
      setShowAdd(false);
      setToast("项目已加密保存");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "项目未保存。");
    } finally {
      setIsSaving(false);
    }
  }

  function generatePassword() {
    setForm((current) => ({ ...current, password: "V9@rK4!mT7#qL2xP" }));
    setToast("已生成 16 位演示密码");
  }

  function openEdit(item: VaultItem) {
    setEditForm({ name: item.name, domain: item.domain, username: item.username, password: item.password, group: item.group });
    setEditingItem(item);
    setRevealed(false);
  }

  function generateEditPassword() {
    setEditForm((current) => ({ ...current, password: "R8!vL2#nQ5@zT7mK" }));
    setToast("已生成 16 位演示密码");
  }

  async function submitEditCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingItem) return;

    try {
      await updateRemoteItem(editingItem, editForm);
      setEditingItem(null);
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
      setDeleteTarget(null);
      setRevealed(false);
      setToast(`已删除“${deleteTarget.name}”`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "项目未删除。");
    } finally {
      setIsSaving(false);
    }
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    try {
      const payload = await requestVault<{ member: VaultMember }>("/api/vault/members", {
        method: "POST",
        body: JSON.stringify({ email: memberEmail, role: memberRole }),
      });
      setMembers((current) => [...current.filter((member) => member.email !== payload.member.email), { ...payload.member, createdAt: "刚刚添加" }]);
      setMemberEmail("");
      setToast("协作人已加入公共空间");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "协作人未添加。");
    } finally {
      setIsSaving(false);
    }
  }

  async function removeMember(email: string) {
    setIsSaving(true);
    try {
      await requestVault("/api/vault/members", { method: "DELETE", body: JSON.stringify({ email }) });
      setMembers((current) => current.filter((member) => member.email !== email));
      setToast("协作人已移出公共空间");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "协作人未移除。");
    } finally {
      setIsSaving(false);
    }
  }

  async function requestExportApproval() {
    setIsSaving(true);
    try {
      const payload = await requestVault<{ approval: ApprovalRequest }>("/api/vault/approvals", { method: "POST" });
      setApprovals((current) => [payload.approval, ...current.filter((approval) => approval.id !== payload.approval.id)]);
      setToast("已向协作人请求导出批准，有效期 10 分钟");
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
          <button className={`nav-item ${space === "全部" ? "is-active" : ""}`} onClick={() => setSpace("全部")}><KeyRound size={18} /><span>所有项目</span><span className="nav-count">{items.length}</span></button>
          <button className="nav-item"><Star size={18} /><span>收藏</span><span className="nav-count">{items.filter((item) => item.favorite).length}</span></button>
          <button className="nav-item"><ShieldEllipsis size={18} /><span>安全检查</span><span className="nav-alert">3</span></button>
          <button className="nav-item"><Archive size={18} /><span>归档</span></button>

          <p className="nav-label nav-label-spaced">空间</p>
          <button className={`nav-item ${space === "个人" ? "is-active" : ""}`} onClick={() => setSpace("个人")}><UserRound size={18} /><span>个人</span></button>
          <button className={`nav-item ${space === "公共" ? "is-active" : ""}`} onClick={() => setSpace("公共")}><UsersRound size={18} /><span>公共</span></button>
        </nav>

        <div className="sidebar-tip">
          <ShieldCheck size={18} aria-hidden="true" />
          <div><strong>安全会话已开启</strong><span>密码记录会加密保存</span></div>
        </div>

        <div className="account-menu">
          <span className="avatar" aria-hidden="true">{viewerInitial}</span>
          <div><strong>{viewer.displayName}</strong><span>{viewer.email}</span></div>
          <button className="icon-button dark-icon" onClick={() => setShowSharing(true)} aria-label="公共空间设置"><MoreHorizontal size={19} /></button>
        </div>
      </aside>

      <main id="main-content" className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={21} /></button>
          <div className="page-title"><h1>密码库</h1><p>集中管理登录信息、卡片与安全笔记</p></div>
          <div className="topbar-search">
            <Search size={18} aria-hidden="true" />
            <label className="sr-only" htmlFor="vault-search">搜索密码库</label>
            <input id="vault-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号、网址或分类" />
            <kbd>⌘ K</kbd>
          </div>
          <button className="secondary-button lock-button" onClick={endSession}><LogOut size={17} />结束会话</button>
          <button className="primary-button" onClick={() => setShowAdd(true)} disabled={isLoading || isSaving}><Plus size={18} />新建项目</button>
        </header>

        <section className="security-strip" aria-labelledby="security-heading">
          <div className="score-block">
            <div className="score-copy"><span>安全评分</span><strong id="security-heading">{securityScore}<small>/100</small></strong></div>
            <div className="score-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={securityScore} aria-label={`安全评分 ${securityScore} 分`}><span style={{ width: `${securityScore}%` }} /></div>
            <p>{securityScore >= 80 ? <Check size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}{securityScore >= 80 ? "整体状况良好" : "建议处理安全项"}</p>
          </div>
          <button className="risk-item"><span className="risk-icon risk-danger"><AlertTriangle size={17} /></span><span><strong>{weakPasswordCount} 个弱密码</strong><small>建议优先更换</small></span><ChevronRight size={18} /></button>
          <button className="risk-item" onClick={() => setShowSharing(true)}><span className="risk-icon risk-warning"><UsersRound size={17} /></span><span><strong>{members.length} 位协作人</strong><small>公共空间访问权限</small></span><ChevronRight size={18} /></button>
          <button className="risk-item"><span className="risk-icon risk-info"><Smartphone size={17} /></span><span><strong>{missingTwoFactorCount} 个未启用双重验证</strong><small>提升账号防护</small></span><ChevronRight size={18} /></button>
        </section>

        <div className="content-grid">
          <section className="vault-panel" aria-labelledby="vault-list-title">
            <div className="panel-toolbar">
              <div className="filter-tabs" role="group" aria-label="项目类型筛选">
                {filters.map((item) => (
                  <button key={item} className={filter === item ? "is-selected" : ""} onClick={() => setFilter(item)}>{item}{item === "全部" && <span>{items.length}</span>}</button>
                ))}
              </div>
              <button className="sort-button">最近更新<ChevronDown size={16} /></button>
            </div>

            <div className="list-heading">
              <div><h2 id="vault-list-title">{listTitle}</h2><span>{visibleItems.length} 项</span></div>
              <span>安全状态</span><span>更新时间</span><span className="sr-only">更多操作</span>
            </div>

            <div className="vault-list">
              {isLoading ? (
                <div className="empty-state"><Clock3 size={24} /><h3>正在读取密码库</h3><p>正在加载已加密的项目。</p></div>
              ) : visibleItems.length > 0 ? visibleItems.map((item) => (
                <button key={item.id} className={`vault-row ${activeSelectedId === item.id ? "is-selected" : ""}`} onClick={() => { setSelectedId(item.id); setRevealed(false); }} aria-pressed={activeSelectedId === item.id}>
                  <div className="item-identity"><BrandMark item={item} /><span><strong>{item.name}</strong><small>{item.username}</small></span></div>
                  <div><StrengthBadge strength={item.strength} /></div>
                  <span className="updated-at">{item.updated}</span>
                  <span className="row-chevron"><ChevronRight size={18} /></span>
                </button>
              )) : (
                <div className="empty-state"><Search size={24} /><h3>{items.length === 0 ? "密码库尚未添加项目" : "没有找到匹配项目"}</h3><p>{items.length === 0 ? "从第一个账号开始，建立加密保存的密码库。" : "尝试搜索其他账号、网址或分类。"}</p><button className="secondary-button" onClick={() => { if (items.length === 0) setShowAdd(true); else { setQuery(""); setFilter("全部"); setSpace("全部"); } }}>{items.length === 0 ? "新建项目" : "清除筛选"}</button></div>
              )}
            </div>
          </section>

          {items.length > 0 ? (
          <aside className="detail-panel" aria-labelledby="detail-title">
            <div className="detail-head">
              <div className="detail-brand"><BrandMark item={selected} /><div><span className="eyebrow">{selected.type} · {selected.group}</span><h2 id="detail-title">{selected.name}</h2><a href={selected.domain.includes(".") ? `https://${selected.domain}` : "#"} target="_blank" rel="noreferrer">{selected.domain}<ArrowUpRight size={14} /></a></div></div>
              <div className="detail-actions">
                <button className={`icon-button ${selected.favorite ? "is-favorite" : ""}`} onClick={() => toggleFavorite(selected)} aria-label={selected.favorite ? "取消收藏" : "添加收藏"} disabled={!selected.canEdit || isSaving}><Heart size={19} fill={selected.favorite ? "currentColor" : "none"} /></button>
                <button className="icon-button" onClick={() => openEdit(selected)} aria-label={`编辑${selected.name}`} disabled={!selected.canEdit || isSaving}><Edit3 size={18} /></button>
                <button className="icon-button destructive-icon" onClick={() => setDeleteTarget(selected)} aria-label={`删除${selected.name}`} disabled={!selected.canEdit || isSaving}><Trash2 size={18} /></button>
              </div>
            </div>

            <div className="detail-section">
              <div className="field-label"><span>用户名</span></div>
              <div className="secret-field"><span>{selected.username}</span><button className="icon-button" onClick={() => copyValue(selected.username, "用户名", selected.id)} aria-label="复制用户名"><Copy size={17} /></button></div>
            </div>

            <div className="detail-section">
              <div className="field-label"><span>密码</span><span className="password-meta">{selected.password.length} 位</span></div>
              <div className="secret-field password-field"><span className={revealed ? "password-revealed" : "password-masked"}>{revealed ? selected.password : "••••••••••••••••"}</span><button className="icon-button" onClick={() => { const next = !revealed; setRevealed(next); if (next) recordAudit("password_revealed", selected.id); }} aria-label={revealed ? "隐藏密码" : "显示密码"}>{revealed ? <EyeOff size={17} /> : <Eye size={17} />}</button><button className="icon-button" onClick={() => copyValue(selected.password, "密码", selected.id)} aria-label="复制密码"><Copy size={17} /></button></div>
              <div className={`password-health health-${selected.strength}`}><span /><p><strong>密码{selected.strength}</strong>{selected.strength === "风险" ? "此密码可能已重复使用" : selected.strength === "一般" ? "建议在近期轮换" : "长度和复杂度符合建议"}</p></div>
            </div>

            <div className="detail-section security-detail">
              <div className="field-label"><span>账号保护</span></div>
              <div className={`protection-row ${selected.twoFactor ? "is-safe" : "needs-action"}`}>
                {selected.twoFactor ? <ShieldCheck size={20} /> : <AlertTriangle size={20} />}
                <div><strong>{selected.twoFactor ? "已开启双重验证" : "尚未开启双重验证"}</strong><span>{selected.twoFactor ? "即使密码泄露，账号仍有额外保护" : "建议前往服务网站启用验证器"}</span></div>
                <ChevronRight size={18} />
              </div>
            </div>

            <div className="detail-section">
              <div className="field-label"><span>备注</span></div>
              <p className="note-copy">{selected.note}</p>
            </div>

            <div className="detail-footer">
              <div><Clock3 size={15} /><span>上次修改：{selected.updated}</span></div>
              <button className="open-site-button" disabled={!selected.domain.includes(".")} onClick={() => selected.domain.includes(".") && window.open(`https://${selected.domain}`, "_blank", "noopener,noreferrer")}><Globe2 size={17} />访问网站<ArrowUpRight size={15} /></button>
            </div>
          </aside>
          ) : (
            <aside className="detail-panel detail-empty" aria-label="空密码库">
              <Archive size={25} aria-hidden="true" />
              <h2>密码库为空</h2>
              <p>新建一个项目，开始整理你的登录信息。</p>
              <button className="primary-button" onClick={() => setShowAdd(true)}><Plus size={18} />新建项目</button>
            </aside>
          )}
        </div>
      </main>

      {showAdd && (
        <div className="modal-layer" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="add-title">
            <header><div><span className="modal-icon"><KeyRound size={20} /></span><div><h2 id="add-title">添加登录信息</h2><p>保存后以加密形式写入你的密码库</p></div></div><button className="icon-button" onClick={() => setShowAdd(false)} aria-label="关闭"><X size={20} /></button></header>
            <form onSubmit={submitCredential}>
              <label>名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：公司邮箱" autoFocus /></label>
              <label>网站地址<input required value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} placeholder="example.com" inputMode="url" /></label>
              <label>用户名<input required value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="name@example.com" autoComplete="username" /></label>
              <label>密码<div className="form-password"><input required type="text" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="输入或生成强密码" autoComplete="new-password" /><button type="button" onClick={generatePassword}><WandSparkles size={16} />生成</button></div><small>建议至少 14 位，并混合字母、数字和符号。</small></label>
              <label>保存到空间<select value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value })}><option>个人</option><option>公共</option></select></label>
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
              <label>密码<div className="form-password"><input required type="text" value={editForm.password} onChange={(event) => setEditForm({ ...editForm, password: event.target.value })} autoComplete="new-password" /><button type="button" onClick={generateEditPassword}><WandSparkles size={16} />生成</button></div><small>建议至少 14 位，并混合字母、数字和符号。</small></label>
              <label>保存到空间<select value={editForm.group} onChange={(event) => setEditForm({ ...editForm, group: event.target.value })}><option>个人</option><option>公共</option></select></label>
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

      {showSharing && (
        <div className="modal-layer" role="presentation">
          <section className="modal sharing-modal" role="dialog" aria-modal="true" aria-labelledby="sharing-title">
            <header><div><span className="modal-icon"><UsersRound size={20} /></span><div><h2 id="sharing-title">公共空间权限</h2><p>被邀请的协作人需完成安全登录后才能访问</p></div></div><button className="icon-button" onClick={() => setShowSharing(false)} aria-label="关闭公共空间设置"><X size={20} /></button></header>
            <form onSubmit={inviteMember}>
              <label>协作人邮箱<input required type="email" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" /></label>
              <label>权限<select value={memberRole} onChange={(event) => setMemberRole(event.target.value as "editor" | "viewer")}><option value="editor">可查看和编辑</option><option value="viewer">仅查看</option></select></label>
              <p className="form-note">此操作只授予访问权限，不会向邮箱发送通知。协作人下次安全登录后即可访问公共项目。</p>
              <footer><button type="submit" className="primary-button" disabled={isSaving}><UsersRound size={17} />{isSaving ? "正在更新" : "添加协作人"}</button></footer>
            </form>
            <div className="sharing-section">
              <div className="sharing-section-title"><h3>当前协作人</h3><span>{members.length} 位</span></div>
              {members.length > 0 ? <div className="member-list">{members.map((member) => <div className="member-row" key={member.email}><div><strong>{member.email}</strong><span>{member.role === "editor" ? "可查看和编辑" : "仅查看"} · {member.createdAt}</span></div><button className="secondary-button" onClick={() => removeMember(member.email)} disabled={isSaving}>移除</button></div>)}</div> : <p className="sharing-empty">尚未添加协作人；公共空间目前只有你自己可以访问。</p>}
            </div>
            <div className="sharing-section approval-section">
              <div className="sharing-section-title"><h3>导出双人确认</h3><span>10 分钟有效</span></div>
              <p className="form-note">导出会生成包含明文密码的文件。仅可导出你自己拥有的个人和公共项目，且必须由被邀请的协作人批准。</p>
              {members.length > 0 && !approvals.some((approval) => approval.isRequester && approval.status === "pending") && <button type="button" className="secondary-button" onClick={requestExportApproval} disabled={isSaving}><Archive size={17} />请求导出批准</button>}
              {approvals.length > 0 ? <div className="approval-list">{approvals.map((approval) => (
                <div className="approval-row" key={approval.id}>
                  <div><strong>{approval.isRequester ? "你的导出请求" : `${approval.requestedBy} 请求导出`}</strong><span>{approval.status === "approved" ? `已由 ${approval.approverEmail ?? "协作人"} 批准` : `将在 ${approval.expiresAt} 后过期`}</span></div>
                  <div className="approval-actions">
                    {approval.canDecide && <><button type="button" className="secondary-button" onClick={() => decideExportApproval(approval.id, "rejected")} disabled={isSaving}>拒绝</button><button type="button" className="primary-button" onClick={() => decideExportApproval(approval.id, "approved")} disabled={isSaving}>批准</button></>}
                    {approval.isRequester && approval.status === "approved" && <button type="button" className="primary-button" onClick={() => downloadApprovedExport(approval.id)} disabled={isSaving}><Archive size={17} />下载副本</button>}
                    {approval.isRequester && approval.status === "pending" && <span className="approval-pending">等待协作人</span>}
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
