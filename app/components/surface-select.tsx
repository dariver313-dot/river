"use client";

import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

export type SurfaceSelectOption<T extends string> = {
  value: T;
  label: string;
};

type SurfaceSelectProps<T extends string> = {
  id: string;
  ariaLabel: string;
  value: T;
  options: readonly SurfaceSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  compact?: boolean;
};

/**
 * A shared application menu. Native select option popovers are rendered by the
 * operating system and cannot follow the application's visual system.
 */
export function SurfaceSelect<T extends string>({
  id,
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  compact = false,
}: SurfaceSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const listboxId = `${id}-options`;

  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, []);

  function choose(nextValue: T) {
    onChange(nextValue);
    setIsOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  function chooseByOffset(offset: number) {
    const currentIndex = Math.max(0, options.findIndex((option) => option.value === value));
    const nextIndex = Math.min(Math.max(currentIndex + offset, 0), options.length - 1);
    const next = options[nextIndex];
    if (next && next.value !== value) onChange(next.value);
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (isOpen) chooseByOffset(1);
      else setIsOpen(true);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (isOpen) chooseByOffset(-1);
      else setIsOpen(true);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      const first = options[0];
      if (first) chooseByOffset(-options.length);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const last = options[options.length - 1];
      if (last) chooseByOffset(options.length);
    }
  }

  return <span ref={rootRef} className={`surface-select ${compact ? "is-compact" : ""} ${isOpen ? "is-open" : ""}`}>
    <button ref={triggerRef} id={id} type="button" className="surface-select-control" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={isOpen} aria-controls={listboxId} onClick={() => setIsOpen((open) => !open)} onKeyDown={onTriggerKeyDown} disabled={disabled}>
      <span>{selected?.label ?? "请选择"}</span>
      <ChevronDown className="surface-select-icon" size={16} aria-hidden="true" />
    </button>
    {isOpen && <span id={listboxId} className="surface-select-options" role="listbox" aria-label={ariaLabel}>
      {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "is-selected" : ""} onClick={() => choose(option.value)}><span>{option.label}</span>{option.value === value && <Check size={15} aria-hidden="true" />}</button>)}
    </span>}
  </span>;
}
