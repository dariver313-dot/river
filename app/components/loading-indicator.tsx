type LoadingIndicatorProps = {
  label: string;
  className?: string;
  compact?: boolean;
};

export function LoadingMark({ className = "" }: { className?: string }) {
  return <span className={`loading-mark ${className}`.trim()} aria-hidden="true"><i /><i /><i /></span>;
}

export function LoadingIndicator({ label, className = "", compact = false }: LoadingIndicatorProps) {
  return <span className={`loading-indicator${compact ? " is-compact" : ""} ${className}`.trim()} role="status">
    <LoadingMark className="loading-indicator-mark" />
    <span>{label}</span>
  </span>;
}

type LoadingStateProps = {
  title: string;
  description?: string;
  className?: string;
};

export function LoadingState({ title, description, className = "" }: LoadingStateProps) {
  return <div className={`loading-state ${className}`.trim()} role="status">
    <LoadingMark className="loading-state-mark" />
    <div><strong>{title}</strong>{description && <p>{description}</p>}</div>
  </div>;
}
