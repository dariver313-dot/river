"use client";

import { LayoutPanelLeft, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AdminTableState } from "../components/admin-table-state";

type EmbeddedPage = { id: string; name: string; url: string; origin: string };

type EmbeddedPagesWorkspaceProps = {
  selectedPageId?: string;
  onPageSelect?: (pageId: string) => void;
};

export function EmbeddedPagesWorkspace({ selectedPageId, onPageSelect }: EmbeddedPagesWorkspaceProps) {
  const [pages, setPages] = useState<EmbeddedPage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const selectedPageIdRef = useRef(selectedPageId);
  const onPageSelectRef = useRef(onPageSelect);
  const requestedPage = pages.find((page) => page.id === selectedPageId) ?? null;
  const current = requestedPage ?? pages.find((page) => page.id === selected) ?? pages[0] ?? null;

  useEffect(() => {
    selectedPageIdRef.current = selectedPageId;
  }, [selectedPageId]);

  useEffect(() => {
    onPageSelectRef.current = onPageSelect;
  }, [onPageSelect]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/security/session", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
      .then(async (session) => {
        if (!session.ok) throw new Error("安全会话已结束。");
        const response = await fetch("/api/embedded-pages", { cache: "no-store", credentials: "same-origin" });
        const payload = await response.json().catch(() => ({})) as { pages?: EmbeddedPage[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? "无法读取内嵌页面。");
        if (cancelled) return;
        const availablePages = payload.pages ?? [];
        const requestedPageId = selectedPageIdRef.current;
        const nextSelectedPageId = availablePages.some((page) => page.id === requestedPageId) ? requestedPageId ?? null : availablePages[0]?.id ?? null;
        setPages(availablePages);
        setSelected(nextSelectedPageId);
        if (nextSelectedPageId && nextSelectedPageId !== requestedPageId) onPageSelectRef.current?.(nextSelectedPageId);
      })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "无法读取内嵌页面。"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Reload only on an explicit request. Selection changes use the already loaded, permission-filtered list.
  }, [loadAttempt]);

  function reloadPages() {
    setLoading(true);
    setMessage("");
    setLoadAttempt((currentAttempt) => currentAttempt + 1);
  }

  return <section className="users-page embedded-workspace-page" aria-label="内嵌页面工作台">
    {loading ? <section className="users-panel embedded-workspace-panel"><AdminTableState icon={LayoutPanelLeft} title="加载中" description="正在读取页面。" /></section>
      : message ? <section className="users-panel embedded-workspace-panel"><AdminTableState tone="error" icon={LayoutPanelLeft} title="无法读取页面" description={message} action={<button type="button" className="secondary-button" onClick={reloadPages}><RefreshCw size={16} />重新加载</button>} /></section>
        : pages.length === 0 ? <section className="users-panel embedded-workspace-panel"><AdminTableState icon={LayoutPanelLeft} title="暂无数据" /></section>
          : <section className="users-panel embedded-frame-panel">
            <div className="users-toolbar embedded-frame-toolbar"><div className="users-toolbar-copy"><h2 title={current?.name}>{current?.name}</h2><span>工作台页面</span></div><div className="users-toolbar-actions embedded-frame-actions"><button type="button" className="icon-button" onClick={reloadPages} aria-label="刷新内嵌页面" title="刷新内嵌页面"><RefreshCw size={16} /></button></div></div>
            <div className="embedded-frame-content">{current && <iframe key={current.id} src={current.url} title={current.name} referrerPolicy="no-referrer" sandbox="allow-forms allow-popups allow-scripts allow-same-origin" />}</div>
          </section>}
  </section>;
}
