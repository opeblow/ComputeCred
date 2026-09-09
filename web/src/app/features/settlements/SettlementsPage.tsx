import { useState } from 'react';
import { useSettlements } from '../../../hooks/useFacility';
import { useConfig } from '../../../hooks/useConfig';
import type { SettlementRecord } from '../../../lib/api';
import { decimal, formatDate, shortHash, statusMeta } from '../../../lib/format';
import { Card, Badge, EmptyState, Banner, Skeleton } from '../../../components/ui/primitives';
import { ConfigGate } from '../../../components/ui/ConfigGate';
import { EvidenceDrawer } from '../../../components/EvidenceDrawer';

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'retryable_failure', label: 'Retrying' },
  { key: 'terminal_failure', label: 'Needs attention' },
  { key: 'pending', label: 'In pipeline' },
];

function matches(record: SettlementRecord, filter: string): boolean {
  if (!filter) return true;
  if (filter === 'confirmed' || filter === 'retryable_failure' || filter === 'terminal_failure') return record.status === filter;
  if (filter === 'pending') return !['confirmed', 'retryable_failure', 'terminal_failure'].includes(record.status);
  return false;
}

export default function SettlementsPage() {
  const { config } = useConfig();
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data, isLoading, isError, isFetching } = useSettlements({
    status: filter === 'pending' ? undefined : filter || undefined,
    cursor,
  });

  const operatorConfigured = !!config.operatorAddress;
  const visible = (data?.records ?? []) as SettlementRecord[];
  const records = visible;
  const selected = records.find((r) => r.id === selectedId) ?? null;

  const clearFilter = (f: string) => {
    setFilter(f);
    setCursor(undefined);
  };

  return (
    <div className="stack">
      {!operatorConfigured ? (
        <ConfigGate title="Operator not configured">Set the operator address in Settings to see your settlements.</ConfigGate>
      ) : (
        <>
          <div className="flex-between">
            <div className="chips">
              {FILTERS.map((f) => (
                <button key={f.key} className={`chip ${filter === f.key ? 'active' : ''}`} onClick={() => clearFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
            {isFetching && <span className="muted small">refreshing…</span>}
          </div>

          {isError ? (
            <Banner tone="error">
              Could not load settlements. Is the read-layer API running and pointed at the right database?
            </Banner>
          ) : isLoading ? (
            <div className="stack">
              <Skeleton height={44} />
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          ) : records.length === 0 ? (
            <Card>
              <EmptyState title="No settlements found" hint="Settlements are recorded when the source chain reports a JobSettled event the worker proves and registers on the vault." />
            </Card>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Job</th>
                    <th>Gross</th>
                    <th>Completed</th>
                    <th>Attempts</th>
                    <th>Source tx</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => {
                    const m = statusMeta(r.status);
                    return (
                      <tr key={r.id} className="row-link" onClick={() => setSelectedId(r.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelectedId(r.id)}>
                        <td>
                          <Badge tone={m.tone}>{m.label}</Badge>
                        </td>
                        <td className="mono">{shortHash(r.jobId, 12)}</td>
                        <td>{decimal(r.gross)} tUSDC</td>
                        <td>{formatDate(r.completedAt)}</td>
                        <td>{r.retries}</td>
                        <td className="mono small muted">{r.txHash ? shortHash(r.txHash, 8) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {data?.nextCursor && (
            <div className="flex" style={{ justifyContent: 'center' }}>
              <button className="btn outline" onClick={() => setCursor(data.nextCursor!)}>
                Load more
              </button>
            </div>
          )}
        </>
      )}

      {selected && <EvidenceDrawer record={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}