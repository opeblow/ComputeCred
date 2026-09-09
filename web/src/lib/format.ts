const DECIMALS = 6;

export function decimal(value: bigint | string | number): string {
  const v = BigInt(value);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  const s = abs.toString().padStart(DECIMALS + 1, '0');
  const whole = s.slice(0, s.length - DECIMALS).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-DECIMALS).replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}

export function bps(value: bigint | string | number): string {
  return `${(Number(value) / 100).toFixed(2)}%`;
}

/** bigint fraction in bps, e.g. share(40n, 100n) -> "40.00%". guards zeroes. */
export function share(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) return '0.00%';
  return bps((numerator * 10000n) / denominator);
}

export function shortAddress(a: string): string {
  if (!a || a.length < 10) return a ?? '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function shortHash(h: string, chars = 8): string {
  if (!h || h.length < 2 * chars + 3) return h ?? '';
  return `${h.slice(0, chars)}…${h.slice(-chars)}`;
}

export function formatDate(unixSeconds: bigint | string | number): string {
  const v = Number(unixSeconds);
  if (!v) return '—';
  return new Date(v * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timeAgo(unixMs: number): string {
  const diff = Date.now() - unixMs;
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export const STATUS_META: Record<
  string,
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent' }
> = {
  detected: { label: 'Detected on source', tone: 'neutral' },
  awaiting_attestation: { label: 'Awaiting attestation', tone: 'info' },
  proof_ready: { label: 'Proof ready', tone: 'info' },
  submitting: { label: 'Submitting', tone: 'accent' },
  submitted: { label: 'Broadcast to vault', tone: 'accent' },
  confirmed: { label: 'Confirmed on-chain', tone: 'success' },
  retryable_failure: { label: 'Retrying', tone: 'warning' },
  terminal_failure: { label: 'Requires attention', tone: 'danger' },
};

export function statusMeta(s: string) {
  return STATUS_META[s] ?? { label: s, tone: 'neutral' as const };
}