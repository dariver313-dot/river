"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

export type TablePaginationState = {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
};

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

export function TablePagination({ pagination, onChange, label }: { pagination: TablePaginationState; onChange: (page: number) => void; label: string }) {
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
