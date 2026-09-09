export interface SettlementRecord {
  id: number;
  chainKey: number;
  contractAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  jobId: string;
  operator: string;
  buyer: string;
  gross: string;
  completedAt: string;
  status: string;
  retries: number;
  lastError: string | null;
  destTxHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SettlementsPage {
  records: SettlementRecord[];
  nextCursor: number | null;
}

export interface ProofStatusCount {
  status: string;
  count: number;
}

const base = (): string => (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base()}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`API ${path} responded ${res.status}`);
  }
  const body = (await res.json()) as { ok: boolean; data: T; error?: string };
  if (!body.ok) throw new Error(body.error ?? `API ${path} failed`);
  return body.data;
}

export function fetchSettlements(opts: {
  operator: string;
  status?: string;
  cursor?: number;
  limit?: number;
}): Promise<SettlementsPage> {
  const q = new URLSearchParams({ operator: opts.operator });
  if (opts.status) q.set('status', opts.status);
  if (opts.cursor) q.set('cursor', String(opts.cursor));
  if (opts.limit) q.set('limit', String(opts.limit));
  return get<SettlementsPage>(`/settlements?${q}`);
}

export function fetchProofStatus(operator: string): Promise<ProofStatusCount[]> {
  return get<ProofStatusCount[]>(`/proof-status?operator=${encodeURIComponent(operator)}`);
}

export function fetchActivity(operator: string, limit = 30): Promise<SettlementRecord[]> {
  return get<SettlementRecord[]>(`/activity?operator=${encodeURIComponent(operator)}&limit=${limit}`);
}