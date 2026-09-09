import { useRecentActivity, useVerifiedEvents } from '../../../hooks/useFacility';
import { useConfig } from '../../../hooks/useConfig';
import { decimal, shortHash, statusMeta, timeAgo } from '../../../lib/format';
import { Card, Badge, EmptyState, Banner, Skeleton } from '../../../components/ui/primitives';
import { ConfigGate } from '../../../components/ui/ConfigGate';

export default function ActivityPage() {
  const { config } = useConfig();
  const api = useRecentActivity(50);
  const onChain = useVerifiedEvents(50);

  const operatorConfigured = !!config.operatorAddress;
  const records = (api.data ?? []) as { id: number; jobId: string; txHash: string; completedAt: string | bigint | number; gross: string; status: string; updatedAt: number }[];
  const verified = (onChain.data ?? []) as { args?: readonly unknown[]; blockNumber: number; transactionHash: string; blockTimestamp?: bigint }[];

  return (
    <div className="stack">
      {!operatorConfigured ? (
        <ConfigGate title="Operator not configured">Set the operator address in Settings to view activity for this facility.</ConfigGate>
      ) : api.isError ? (
        <Banner tone="warning">
          Read-layer API unavailable — showing on-chain activity only. Start the api workspace or check API_URL.
        </Banner>
      ) : null}

      <div className="split">
        <Card>
          <div className="section-title">
            <h2>Lifecycle activity</h2>
            {api.isLoading && <span className="muted small">loading…</span>}
          </div>
          {api.isLoading ? (
            <div className="stack">
              <Skeleton height={38} />
              <Skeleton height={38} />
              <Skeleton height={38} />
            </div>
          ) : records.length === 0 ? (
            <EmptyState title="No activity yet" hint="Once the worker proves and registers settlements, the lifecycle appears here." />
          ) : (
            <div className="stack">
              {records.slice(0, 30).map((r) => {
                const m = statusMeta(r.status);
                const isConfirmed = r.status === 'confirmed';
                return (
                  <div key={r.id} className="flex-between" style={{ gap: 'var(--sp-3)' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="flex" style={{ gap: 'var(--sp-2)' }}>
                        <Badge tone={m.tone}>{m.label}</Badge>
                        <span className="mono small">{shortHash(r.jobId, 10)}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {decimal(r.gross)} tUSDC · {timeAgo(r.updatedAt)}
                      </div>
                    </div>
                    {isConfirmed ? (
                      <span className="amount-in small">✓ recognized</span>
                    ) : r.status.includes('fail') ? (
                      <span className="amount-out small">needs retry</span>
                    ) : (
                      <span className="small muted">processing</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <div className="section-title">
            <h2>On-chain settlements</h2>
            {onChain.isLoading && <span className="muted small">loading…</span>}
          </div>
          {onChain.isLoading ? (
            <div className="stack">
              <Skeleton height={38} />
              <Skeleton height={38} />
              <Skeleton height={38} />
            </div>
          ) : verified.length === 0 ? (
            <EmptyState title="No on-chain settlements yet" hint="SettlementVerified events for this operator appear after proof registration." />
          ) : (
            <div className="stack">
              {verified.slice(0, 20).map((ev, i) => {
                const a = ev.args as readonly unknown[] | undefined;
                const srcTx = (a?.[1] as string) ?? '';
                const srcJob = (a?.[2] as string) ?? '';
                return (
                  <div key={i} className="flex-between" style={{ gap: 'var(--sp-3)' }}>
                    <div>
                      <div className="flex" style={{ gap: 'var(--sp-2)' }}>
                        <Badge tone="success">verified</Badge>
                        <span className="mono small">{shortHash(srcJob, 12)}</span>
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        block #{ev.blockNumber} · {shortHash(ev.transactionHash)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="muted small mt-3" style={{ marginBottom: 0 }}>
            SettlementVerified records reflect successful on-chain proof registration by the vault contract.
          </p>
        </Card>
      </div>
    </div>
  );
}