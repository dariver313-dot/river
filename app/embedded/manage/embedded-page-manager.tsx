"use client";

import { AlertTriangle, Check, Edit3, Globe2, LayoutPanelLeft, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { AdminTableLoading, AdminTableState } from "../../components/admin-table-state";
import { LoadingMark } from "../../components/loading-indicator";
import { ModalPortal } from "../../components/modal-portal";
import { SurfaceSelect } from "../../components/surface-select";
import { TablePagination } from "../../components/table-pagination";

type EmbeddedPage = {
  id: string;
  name: string;
  url: string;
  origin: string;
  visibility: "all" | "admin";
  enabled: boolean;
  sortOrder: number;
  updatedAt: string;
};

type EmbeddedPageForm = Pick<EmbeddedPage, "name" | "url" | "visibility" | "enabled" | "sortOrder">;
type EmbeddedOrigin = { origin: string; createdAt: string; createdBy: string; pageCount: number };
type Pagination = { page: number; pageSize: number; total: number; pageCount: number };

const blankForm: EmbeddedPageForm = {
  name: "",
  url: "",
  visibility: "all",
  enabled: true,
  sortOrder: 0,
};

const visibilityOptions = [
  { value: "all", label: "全体用户" },
  { value: "admin", label: "仅管理员" },
] as const;
const pageSize = 10;

function formatVerificationCode(value: string) {
  return value.replace(/\D/g, "").slice(0, 6);
}

function formatManagementTime(value: string) {
  const timestamp = Date.parse(value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", hour12: false }).format(timestamp);
}

function Feedback({ tone, children }: { tone: "success" | "error"; children: string }) {
  return <p className={`embedded-management-feedback is-${tone}`} role={tone === "error" ? "alert" : "status"} aria-live="polite">{children}</p>;
}

type EmbeddedRequestError = Error & { code?: string };

function managementErrorMessage(error: unknown, fallback: string, onRecentSecurityConfirmationRequired?: () => void) {
  const requestError = error as EmbeddedRequestError;
  if (requestError?.code === "RECENT_SECURITY_CONFIRMATION_REQUIRED") {
    onRecentSecurityConfirmationRequired?.();
    return "请先完成 Google 重新验证，再次提交此操作。";
  }
  return error instanceof Error ? error.message : fallback;
}

export function EmbeddedPageManagerContent({ externalDialogOpen = false, onDialogStateChange, onPagesChanged, onRecentSecurityConfirmationRequired, serverSessionReady }: { externalDialogOpen?: boolean; onDialogStateChange?: (isOpen: boolean) => void; onPagesChanged?: () => void; onRecentSecurityConfirmationRequired?: () => void; serverSessionReady: boolean }) {
  const [pages, setPages] = useState<EmbeddedPage[]>([]);
  const [origins, setOrigins] = useState<EmbeddedOrigin[]>([]);
  const [canManageOrigins, setCanManageOrigins] = useState(false);
  const [form, setForm] = useState<EmbeddedPageForm>(blankForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRevision, setEditingRevision] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isOriginsOpen, setIsOriginsOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EmbeddedPage | null>(null);
  const [originDeleteTarget, setOriginDeleteTarget] = useState<EmbeddedOrigin | null>(null);
  const [originValue, setOriginValue] = useState("");
  const [originUserCode, setOriginUserCode] = useState("");
  const [formError, setFormError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [originError, setOriginError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize, total: 0, pageCount: 1 });
  const isDialogOpen = isFormOpen || isOriginsOpen || deleteTarget !== null || originDeleteTarget !== null;
  const editing = editingId !== null;
  const hasAllowedOrigins = origins.length > 0;
  const visiblePages = pages;

  async function request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const payload = await response.json().catch(() => ({})) as T & { error?: string; code?: string };
    if (!response.ok) {
      const error = new Error(payload.error ?? "操作未完成。") as EmbeddedRequestError;
      error.code = payload.code;
      throw error;
    }
    return payload;
  }

  async function load(page = currentPage) {
    if (!serverSessionReady) return;
    setLoading(true);
    setLoadError("");
    try {
      const response = await request<{ pages: EmbeddedPage[]; pagination: Pagination; origins: EmbeddedOrigin[]; canManageOrigins: boolean }>(`/api/embedded-pages?manage=1&page=${page}&pageSize=${pageSize}`);
      setPages(response.pages);
      setPagination(response.pagination);
      if (response.pagination.page !== page) setCurrentPage(response.pagination.page);
      setOrigins(response.origins);
      setCanManageOrigins(response.canManageOrigins);
    } catch (error) {
      setLoadError(managementErrorMessage(error, "无法读取内嵌页面配置。", onRecentSecurityConfirmationRequired));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!serverSessionReady) return;
    let cancelled = false;
    void request<{ pages: EmbeddedPage[]; pagination: Pagination; origins: EmbeddedOrigin[]; canManageOrigins: boolean }>(`/api/embedded-pages?manage=1&page=${currentPage}&pageSize=${pageSize}`)
      .then((response) => {
        if (cancelled) return;
        setPages(response.pages);
        setPagination(response.pagination);
        if (response.pagination.page !== currentPage) setCurrentPage(response.pagination.page);
        setOrigins(response.origins);
        setCanManageOrigins(response.canManageOrigins);
      })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "无法读取内嵌页面配置。"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // The initial load runs once; subsequent manual reloads use load().
  }, [currentPage, serverSessionReady]);

  useEffect(() => {
    onDialogStateChange?.(isDialogOpen);
    return () => onDialogStateChange?.(false);
  }, [isDialogOpen, onDialogStateChange]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving || externalDialogOpen) return;
      if (isFormOpen) {
        setForm(blankForm);
        setEditingId(null);
        setEditingRevision(null);
        setFormError("");
        setIsFormOpen(false);
      }
      if (isOriginsOpen) {
        setIsOriginsOpen(false);
        setOriginValue("");
        setOriginUserCode("");
        setOriginError("");
      }
      if (deleteTarget) {
        setDeleteTarget(null);
        setDeleteError("");
      }
      if (originDeleteTarget) {
        setOriginDeleteTarget(null);
        setOriginUserCode("");
        setOriginError("");
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deleteTarget, externalDialogOpen, isFormOpen, isOriginsOpen, originDeleteTarget, saving]);

  function resetForm() {
    setForm(blankForm);
    setEditingId(null);
    setEditingRevision(null);
    setFormError("");
  }

  function updateForm(changes: Partial<EmbeddedPageForm>) {
    setForm((current) => ({ ...current, ...changes }));
  }

  function closeForm() {
    if (saving) return;
    resetForm();
    setIsFormOpen(false);
  }

  function closeDeleteConfirmation(force = false) {
    if (saving && !force) return;
    setDeleteTarget(null);
    setDeleteError("");
  }

  function closeOriginsDialog() {
    if (saving) return;
    setIsOriginsOpen(false);
    setOriginValue("");
    setOriginUserCode("");
    setOriginError("");
  }

  function closeOriginDeleteConfirmation(force = false) {
    if (saving && !force) return;
    setOriginDeleteTarget(null);
    setOriginUserCode("");
    setOriginError("");
  }

  function openCreateForm() {
    if (!hasAllowedOrigins) return;
    resetForm();
    setNotice("");
    setIsFormOpen(true);
  }

  function openOriginsDialog() {
    setOriginValue("");
    setOriginUserCode("");
    setOriginError("");
    setNotice("");
    setIsOriginsOpen(true);
  }

  function openEditForm(page: EmbeddedPage) {
    setForm({ name: page.name, url: page.url, visibility: page.visibility, enabled: page.enabled, sortOrder: page.sortOrder });
    setEditingId(page.id);
    setEditingRevision(page.updatedAt);
    setFormError("");
    setNotice("");
    setIsFormOpen(true);
  }

  function openDeleteConfirmation(page: EmbeddedPage) {
    setDeleteTarget(page);
    setDeleteError("");
    setNotice("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const wasEditing = editingId !== null;
    setSaving(true);
    setFormError("");
    try {
      await request("/api/embedded-pages", {
        method: wasEditing ? "PATCH" : "POST",
        body: JSON.stringify({ ...form, id: editingId, ...(wasEditing ? { expectedUpdatedAt: editingRevision } : {}) }),
      });
      const targetPage = wasEditing ? currentPage : 1;
      if (!wasEditing) setCurrentPage(targetPage);
      await load(targetPage);
      onPagesChanged?.();
      resetForm();
      setIsFormOpen(false);
      setNotice(wasEditing ? "内嵌页面已更新。" : "内嵌页面已添加。");
    } catch (error) {
      setFormError(managementErrorMessage(error, "页面未保存。", onRecentSecurityConfirmationRequired));
    } finally {
      setSaving(false);
    }
  }

  async function deletePage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleteTarget) return;
    const target = deleteTarget;
    setSaving(true);
    setDeleteError("");
    try {
      await request("/api/embedded-pages", {
        method: "DELETE",
        body: JSON.stringify({ id: target.id }),
      });
      await load(currentPage);
      onPagesChanged?.();
      closeDeleteConfirmation(true);
      setNotice(`“${target.name}”已删除。`);
    } catch (error) {
      setDeleteError(managementErrorMessage(error, "页面未删除。", onRecentSecurityConfirmationRequired));
    } finally {
      setSaving(false);
    }
  }

  async function addOrigin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageOrigins) return;
    if (!/^\d{6}$/.test(originUserCode)) {
      setOriginError("请输入 6 位 Google 验证码。");
      return;
    }
    setSaving(true);
    setOriginError("");
    try {
      const response = await request<{ origins: EmbeddedOrigin[] }>("/api/embedded-origins", {
        method: "POST",
        body: JSON.stringify({ origin: originValue, userCode: originUserCode }),
      });
      setOrigins(response.origins);
      setOriginValue("");
      setOriginUserCode("");
      setNotice("可信来源已添加。");
    } catch (error) {
      setOriginError(managementErrorMessage(error, "可信来源未添加。", onRecentSecurityConfirmationRequired));
    } finally {
      setSaving(false);
    }
  }

  async function deleteOrigin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!originDeleteTarget) return;
    if (!/^\d{6}$/.test(originUserCode)) {
      setOriginError("请输入 6 位 Google 验证码。");
      return;
    }
    const target = originDeleteTarget;
    setSaving(true);
    setOriginError("");
    try {
      const response = await request<{ origins: EmbeddedOrigin[] }>("/api/embedded-origins", {
        method: "DELETE",
        body: JSON.stringify({ origin: target.origin, userCode: originUserCode }),
      });
      setOrigins(response.origins);
      closeOriginDeleteConfirmation(true);
      setNotice(`“${target.origin}”已从可信来源中移除。`);
    } catch (error) {
      setOriginError(managementErrorMessage(error, "可信来源未删除。", onRecentSecurityConfirmationRequired));
    } finally {
      setSaving(false);
    }
  }

  return <>
    <section className="users-page embedded-management-page" aria-labelledby="embedded-management-title">
      <section className="users-panel embedded-management-panel" aria-busy={loading || saving}>
        <div className="users-toolbar">
          <div className="users-toolbar-copy"><h2 id="embedded-management-title">页面配置</h2><span>{loading ? "正在读取页面" : `本页 ${visiblePages.length} 个，共 ${pagination.total} 个页面`}</span></div>
          <div className="users-toolbar-actions"><button type="button" className="secondary-button" onClick={openOriginsDialog} disabled={!serverSessionReady || loading || saving}><Globe2 size={16} />可信来源</button><button type="button" className="primary-button" onClick={openCreateForm} disabled={!serverSessionReady || loading || saving || !hasAllowedOrigins} title={hasAllowedOrigins ? undefined : "需先配置可信来源"}><Plus size={16} />添加页面</button></div>
        </div>

        {notice && <Feedback tone="success">{notice}</Feedback>}
        {!loading && !loadError && !hasAllowedOrigins && <p className="users-access-warning users-access-warning-compact embedded-management-source-warning" role="note"><AlertTriangle size={16} aria-hidden="true" /><span>{pages.length > 0 ? "未配置可信来源，无法新增页面。" : "未配置可信 HTTPS 来源。"}</span></p>}
        {loading ? <AdminTableLoading label="正在读取内嵌页面配置" columns={6} />
          : loadError ? <AdminTableState tone="error" icon={AlertTriangle} title="无法读取页面配置" description={loadError} action={<button type="button" className="secondary-button" onClick={() => void load()}><RefreshCw size={15} />重新加载</button>} />
            : pages.length === 0 ? <AdminTableState icon={LayoutPanelLeft} title="暂无数据" />
              : <><div className="system-user-table-wrap embedded-management-table-wrap">
                <table className="system-user-table embedded-management-table">
                  <thead><tr><th scope="col">页面</th><th scope="col">范围</th><th scope="col">状态</th><th scope="col">排序</th><th scope="col">最后更新</th><th scope="col">管理</th></tr></thead>
                  <tbody>{visiblePages.map((page) => <tr key={page.id}>
                    <td data-label="页面"><div className="embedded-page-identity"><strong>{page.name}</strong><span title={page.url}>{page.url}</span></div></td>
                    <td data-label="范围"><b className={`role-badge ${page.visibility === "all" ? "role-admin" : "role-user"}`}>{page.visibility === "all" ? "全体用户" : "仅管理员"}</b></td>
                    <td data-label="状态"><b className={`status-badge status-${page.enabled ? "active" : "suspended"}`}>{page.enabled ? "已启用" : "已停用"}</b></td>
                    <td data-label="排序"><span className="system-user-created">{page.sortOrder}</span></td>
                    <td data-label="最后更新"><time className="system-user-created" title={formatManagementTime(page.updatedAt)}>{formatManagementTime(page.updatedAt)}</time></td>
                    <td data-label="管理"><div className="system-user-actions"><button type="button" className="secondary-button" onClick={() => openEditForm(page)} disabled={saving || !hasAllowedOrigins} title={hasAllowedOrigins ? undefined : "需先配置可信来源"}><Edit3 size={15} />编辑</button><button type="button" className="secondary-button user-delete-button" onClick={() => openDeleteConfirmation(page)} disabled={saving}><Trash2 size={15} />删除</button></div></td>
                  </tr>)}</tbody>
                </table>
              </div>
              <TablePagination pagination={pagination} onChange={setCurrentPage} label="内嵌页面" />
              </>}
      </section>
    </section>

    {isFormOpen && <ModalPortal><div className="modal-layer" role="presentation" aria-hidden={externalDialogOpen || undefined} inert={externalDialogOpen || undefined}>
      <section className="modal credential-modal embedded-page-form-modal" role="dialog" aria-modal={externalDialogOpen ? undefined : true} aria-labelledby="embedded-page-form-title">
        <header><div><span className="modal-icon">{editing ? <Edit3 size={20} /> : <Plus size={20} />}</span><div><h2 id="embedded-page-form-title">{editing ? "编辑页面" : "添加页面"}</h2><p>按可见范围发布</p></div></div><button type="button" className="icon-button" onClick={closeForm} aria-label="关闭页面配置" disabled={saving}><X size={20} /></button></header>
        <form className="modal-form" onSubmit={save}>
          <div className="modal-body embedded-management-form-body">
            {formError && <Feedback tone="error">{formError}</Feedback>}
            <div className="embedded-management-form-grid">
              <label>页面名称<input required autoFocus={!editing} value={form.name} onChange={(event) => updateForm({ name: event.target.value })} maxLength={120} placeholder="例如：数据看板" /></label>
              <div className="field-control embedded-management-visibility-field"><span>可见范围</span><SurfaceSelect id="embedded-visibility" ariaLabel="页面可见范围" value={form.visibility} onChange={(visibility) => updateForm({ visibility })} options={visibilityOptions} /></div>
              <div className="embedded-management-source-row">
                <label>内嵌地址<input required type="url" value={form.url} onChange={(event) => updateForm({ url: event.target.value })} placeholder="https://example.com/dashboard" /><small>仅限已配置的 HTTPS 来源。</small></label>
                <label>显示顺序<input type="number" min="0" max="100000" value={form.sortOrder} onChange={(event) => updateForm({ sortOrder: Number(event.target.value) })} /><small>数值越小越靠前。</small></label>
              </div>
              <label className="embedded-management-checkbox"><input type="checkbox" checked={form.enabled} onChange={(event) => updateForm({ enabled: event.target.checked })} /><span><strong>启用页面</strong><small>停用后不在工作台显示。</small></span></label>
            </div>
            <aside className="access-setup-note embedded-management-note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>当前可信来源</strong><p className="embedded-management-allowed-origins">{origins.map((item) => item.origin).join("、")}</p></div></aside>
          </div>
          <footer className="modal-footer"><button type="button" className="secondary-button" onClick={closeForm} disabled={saving}>取消</button><button type="submit" className="primary-button" disabled={saving}>{saving ? <LoadingMark className="button-loading-mark" /> : <Check size={17} />}{saving ? "正在保存" : editing ? "保存页面" : "添加页面"}</button></footer>
        </form>
      </section>
    </div></ModalPortal>}

    {isOriginsOpen && <ModalPortal><div className="modal-layer" role="presentation" aria-hidden={externalDialogOpen || undefined} inert={externalDialogOpen || undefined}>
      <section className="modal credential-modal embedded-origins-modal" role="dialog" aria-modal={externalDialogOpen ? undefined : true} aria-labelledby="embedded-origins-title">
        <header><div><span className="modal-icon"><Globe2 size={20} /></span><div><h2 id="embedded-origins-title">可信来源</h2><p>仅列出的 HTTPS 域名可用于内嵌。</p></div></div><button type="button" className="icon-button" onClick={closeOriginsDialog} aria-label="关闭可信来源" disabled={saving}><X size={20} /></button></header>
        <form className="modal-form" onSubmit={addOrigin}>
          <div className="modal-body embedded-origins-body">
            {originError && <Feedback tone="error">{originError}</Feedback>}
            {canManageOrigins ? <><label>可信 HTTPS 来源<input required autoFocus value={originValue} onChange={(event) => { setOriginValue(event.target.value); setOriginError(""); }} placeholder="https://reports.example.com" /><small>仅填写来源，不含路径或参数。</small></label><label>Google 验证码<input required value={originUserCode} onChange={(event) => { setOriginUserCode(formatVerificationCode(event.target.value)); setOriginError(""); }} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label><aside className="access-setup-note embedded-management-note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>系统范围设置</strong><p>变更来源时：新增新来源，逐页更新后，再移除旧来源。</p></div></aside></> : <aside className="access-setup-note embedded-management-note" role="note"><ShieldCheck size={17} aria-hidden="true" /><div><strong>仅初始管理员可维护</strong><p>你可以查看并使用现有来源。</p></div></aside>}
            <div className="system-user-table-wrap embedded-origins-table-wrap"><table className="system-user-table embedded-origins-table"><thead><tr><th scope="col">可信来源</th><th scope="col">添加信息</th><th scope="col">管理</th></tr></thead><tbody>{origins.length ? origins.map((item) => <tr key={item.origin}><td data-label="可信来源"><div className="embedded-origin-meta"><strong>{item.origin}</strong><span>{item.pageCount > 0 ? `已关联 ${item.pageCount} 个页面` : "暂无关联页面"}</span></div></td><td data-label="添加信息"><div className="embedded-origin-meta"><span title={item.createdBy}>{item.createdBy}</span><time title={formatManagementTime(item.createdAt)}>{formatManagementTime(item.createdAt)}</time></div></td><td data-label="管理">{canManageOrigins ? <button type="button" className="secondary-button user-delete-button" onClick={() => { setOriginUserCode(""); setOriginError(""); setIsOriginsOpen(false); setOriginDeleteTarget(item); }} disabled={saving || item.pageCount > 0} title={item.pageCount > 0 ? "请先迁移或删除关联页面" : undefined}><Trash2 size={15} />移除</button> : <span className="current-user">仅查看</span>}</td></tr>) : <tr><td colSpan={3}><p className="embedded-origins-empty">暂无可信来源。</p></td></tr>}</tbody></table></div>
          </div>
          <footer className="modal-footer"><button type="button" className="secondary-button" onClick={closeOriginsDialog} disabled={saving}>关闭</button>{canManageOrigins && <button type="submit" className="primary-button" disabled={saving}>{saving ? <LoadingMark className="button-loading-mark" /> : <Plus size={17} />}{saving ? "正在添加" : "添加来源"}</button>}</footer>
        </form>
      </section>
    </div></ModalPortal>}

    {deleteTarget && <ModalPortal><div className="modal-layer" role="presentation" aria-hidden={externalDialogOpen || undefined} inert={externalDialogOpen || undefined}>
      <section className="modal danger-modal" role="dialog" aria-modal={externalDialogOpen ? undefined : true} aria-labelledby="embedded-page-delete-title">
        <header><div><span className="modal-icon danger-icon"><AlertTriangle size={20} /></span><div><h2 id="embedded-page-delete-title">删除页面？</h2><p>此操作不可恢复。</p></div></div><button type="button" className="icon-button" onClick={() => closeDeleteConfirmation()} aria-label="关闭删除确认" disabled={saving}><X size={20} /></button></header>
        <form className="modal-form" onSubmit={deletePage}>
          <div className="modal-body">
            <div className="delete-summary"><strong>{deleteTarget.name}</strong><span>{deleteTarget.origin}</span></div>
            <p className="delete-description">删除后，该页面不再显示在工作台。</p>
            {deleteError && <Feedback tone="error">{deleteError}</Feedback>}
          </div>
          <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => closeDeleteConfirmation()} disabled={saving}>取消</button><button type="submit" className="danger-button" disabled={saving}>{saving ? <LoadingMark className="button-loading-mark" /> : <Trash2 size={17} />}{saving ? "正在删除" : "删除页面"}</button></footer>
        </form>
      </section>
    </div></ModalPortal>}

    {originDeleteTarget && <ModalPortal><div className="modal-layer" role="presentation" aria-hidden={externalDialogOpen || undefined} inert={externalDialogOpen || undefined}>
      <section className="modal danger-modal" role="dialog" aria-modal={externalDialogOpen ? undefined : true} aria-labelledby="embedded-origin-delete-title">
        <header><div><span className="modal-icon danger-icon"><AlertTriangle size={20} /></span><div><h2 id="embedded-origin-delete-title">移除可信来源？</h2><p>此操作不可恢复。</p></div></div><button type="button" className="icon-button" onClick={() => closeOriginDeleteConfirmation()} aria-label="关闭移除可信来源确认" disabled={saving}><X size={20} /></button></header>
        <form className="modal-form" onSubmit={deleteOrigin}>
          <div className="modal-body"><div className="delete-summary"><strong>{originDeleteTarget.origin}</strong><span>系统范围可信来源</span></div><p className="delete-description">{originDeleteTarget.pageCount > 0 ? `当前关联 ${originDeleteTarget.pageCount} 个页面，请先迁移或删除。` : "移除后，该来源不能再用于新增或编辑页面。"}</p>{originError && <Feedback tone="error">{originError}</Feedback>}<label>Google 验证码<input required autoFocus value={originUserCode} onChange={(event) => { setOriginUserCode(formatVerificationCode(event.target.value)); setOriginError(""); }} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" /></label></div>
          <footer className="modal-footer"><button type="button" className="secondary-button" onClick={() => closeOriginDeleteConfirmation()} disabled={saving}>取消</button><button type="submit" className="danger-button" disabled={saving}><Trash2 size={17} />{saving ? "正在移除" : "移除来源"}</button></footer>
        </form>
      </section>
    </div></ModalPortal>}
  </>;
}
