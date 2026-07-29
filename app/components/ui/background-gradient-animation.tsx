"use client";

import { useId, useRef } from "react";
import { cn } from "@/lib/utils";

type BackgroundGradientAnimationProps = {
  children: React.ReactNode;
  className?: string;
  containerClassName?: string;
  interactive?: boolean;
};

/**
 * A locally scoped, light-theme adaptation of Aceternity UI's Background Gradient
 * Animation. The scoped variables avoid leaking visual state into the rest of the app.
 * Source: https://ui.aceternity.com/components/background-gradient-animation
 */
export function BackgroundGradientAnimation({ children, className, containerClassName, interactive = true }: BackgroundGradientAnimationProps) {
  const gradientRef = useRef<HTMLDivElement>(null);
  const filterId = `aceternity-goo-${useId().replace(/:/g, "")}`;

  function followPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (!interactive || !gradientRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    gradientRef.current.style.setProperty("--pointer-x", `${event.clientX - rect.left}px`);
    gradientRef.current.style.setProperty("--pointer-y", `${event.clientY - rect.top}px`);
  }

  return (
    <div className={cn("aceternity-gradient", containerClassName)} onPointerMove={followPointer}>
      <svg className="aceternity-gradient-filter" aria-hidden="true">
        <defs>
          <filter id={filterId}>
            <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8" result="goo" />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
      </svg>
      <div className={cn("aceternity-gradient-content", className)}>{children}</div>
      <div ref={gradientRef} className="aceternity-gradient-blobs" style={{ filter: `url(#${filterId}) blur(36px)` }} aria-hidden="true">
        <span className="aceternity-gradient-blob aceternity-gradient-first" />
        <span className="aceternity-gradient-blob aceternity-gradient-second" />
        <span className="aceternity-gradient-blob aceternity-gradient-third" />
        <span className="aceternity-gradient-blob aceternity-gradient-fourth" />
        <span className="aceternity-gradient-blob aceternity-gradient-fifth" />
        {interactive && <span className="aceternity-gradient-pointer" />}
      </div>
    </div>
  );
}
