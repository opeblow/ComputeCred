import type { CSSProperties, ReactNode } from 'react';

export function Card({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`card ${className}`} style={style}>
      {children}
    </div>
  );
}

export function Stat({ label, value, hint, mono, flash }: { label: string; value: string; hint?: string; mono?: boolean; flash?: boolean }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${mono ? 'mono' : ''} ${flash ? 'flash' : ''}`}>{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Button({
  children,
  variant = 'primary',
  size,
  disabled,
  onClick,
  type = 'button',
  title,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'outline' | 'danger';
  size?: 'sm';
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  title?: string;
}) {
  return (
    <button
      type={type}
      className={`btn ${variant !== 'primary' ? ` ${variant}` : ''}${size ? ` ${size}` : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" role="status" />;
}

export function Skeleton({ width = '100%', height = 16 }: { width?: string | number; height?: string | number }) {
  return (
    <div
      className="skeleton"
      style={{ width: typeof width === 'number' ? `${width}px` : width, height: typeof height === 'number' ? `${height}px` : height }}
    />
  );
}

export function EmptyState({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="state-box">
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-2)' }}>{title}</div>
      {hint && <div style={{ maxWidth: 420 }}>{hint}</div>}
      {children}
    </div>
  );
}

export function Banner({ tone, children }: { tone: 'info' | 'warning' | 'error' | 'success'; children: ReactNode }) {
  return <div className={`banner ${tone}`}>{children}</div>;
}

export function Meter({ value, max, tone }: { value: bigint; max: bigint; tone?: 'warning' | 'danger' }) {
  const pct = max > 0n ? Math.min(100, Number((value * 100n) / max)) : 0;
  const cls = tone ?? (pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : '');
  return (
    <div className="meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className={cls} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Address({ value, className }: { value: string; className?: string }) {
  return <span className={`mono ${className ?? ''}`}>{shortAddressLocal(value)}</span>;
}

function shortAddressLocal(a: string): string {
  if (!a) return '—';
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function Kv({ title, value, mono }: { title: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="kv-row">
      <div className="kv-key">{title}</div>
      <div className={`kv-val ${mono ? 'mono' : ''}`}>{value}</div>
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  return (
    <button
      className="copy-btn"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => {});
      }}
    >
      copy
    </button>
  );
}