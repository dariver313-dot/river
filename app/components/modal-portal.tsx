"use client";

import { type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Keep overlays out of page-level stacking contexts so every dialog can cover
 * the complete application shell, including the persistent sidebar.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
