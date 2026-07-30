"use client";

import { Inbox, type LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { LoadingIndicator } from "./loading-indicator";

type TableStateProps = {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  tone?: "empty" | "error";
};

export function AdminTableState({ title, description, icon: Icon = Inbox, action, tone = "empty" }: TableStateProps) {
  return <div className={`admin-table-state is-${tone}`} role={tone === "error" ? "alert" : "status"}>
    <div className="admin-table-state-content">
      <span className="admin-table-state-icon" aria-hidden="true"><Icon size={20} /></span>
      <div><strong>{title}</strong>{description && <p>{description}</p>}</div>
    </div>
    {action && <div className="admin-table-state-action">{action}</div>}
  </div>;
}

export function AdminTableLoading({ label, columns = 5 }: { label: string; columns?: number }) {
  return <div className="admin-table-loading" aria-busy="true" style={{ "--admin-table-columns": columns } as CSSProperties}>
    <LoadingIndicator label={label} compact className="admin-table-loading-caption" />
    <div className="admin-table-loading-head" aria-hidden="true">{Array.from({ length: columns }, (_, index) => <span className="skeleton skeleton-line skeleton-line-label" key={index} />)}</div>
    {Array.from({ length: 3 }, (_, row) => <div className="admin-table-loading-row" key={row} aria-hidden="true">{Array.from({ length: columns }, (_, column) => <span className={`skeleton ${column === 0 ? "skeleton-line skeleton-line-title" : column === columns - 1 ? "skeleton-line skeleton-line-copy" : "skeleton-status"}`} key={column} />)}</div>)}
  </div>;
}
