import { Link } from 'react-router-dom';
import { useFacility, useProofStatus, useRecentActivity } from '../../../hooks/useFacility';
import { Card, Stat, Skeleton, Badge, EmptyState, Banner } from '../../../components/ui/primitives';
import { decimal, bps, shortHash, statusMeta, timeAgo } from '../../../lib/format';
import { useConfig } from '../../../hooks/useConfig';
import type { Policy } from '../../../lib/vault';

function policyRate(policy: Policy | null | undefined): bigint {
  return policy?.advanceRateBps ?? 0n;
}

export default function OverviewPage() {
  const { config } = useConfig();
  const { snapshot, isLoading, isError, isEnabled } = useFacility();
  const proof = useProofStatus();
  const activity = useRecentActivity(12);

  if (!isEnabled) {
    return (
      <Card>
        <EmptyState title="Operator not configured">
          <p>Set the operator address and vault address in Settings to load the facility.</p>
          <Link to="/settings" className="btn">
            Open settings
          </Link>
        </EmptyState>
      </Card>
    );
  }

  const view = snapshot?.view;

  return (
    <div className="stack">
      {isError && <Banner tone="error">Could not load the facility. {view ? '' : 'Check the vault/operator addresses.'}</Banner>}

      <div>
        <h2 style={{ fontSize: 15, margin: '0 0 var(--sp-2)' }}>Financing position</h2>
        <div className="grid-4">
          {isLoading || !view ? (
            <>
              <Skeleton height={72} />
              <Skeleton height={72} />
              <Skeleton height={72} />
              <Skeleton height={72} />
            </>
          ) : (
            <>
              <Card>
                <Stat label="Eligible revenue" value={`${decimal(view.eligibleRevenue)} tUSDC`} hint={`${bps(policyRate(snapshot?.policy))} advance rate`} />
              </Card>
              <Card>
                <Stat label="Facility limit" value={`${decimal(view.facilityLimit)} tUSDC`} hint={`utilization ${util(view)}`} mono flash />
              </Card>
              <Card>
                <Stat label="Outstanding" value={`${decimal(view.outstandingDebt)} tUSDC`} hint="repay to reduce" />
              </Card>
              <Card>
                <Stat label="Available" value={`${decimal(view.availableCapacity)} tUSDC`} hint={`liquidity ${decimal(view.vaultLiquidity)}`} />
              </Card>
            </>
          )}
        </div>
      </div>

      <div className="split">
        <Card style={{ gridColumn: 'span 1' }}>
          <div className="section-title">
            <h2>Proof pipeline</h2>
            <Link className="link-btn" to="/settlements">
              View all →
            </Link>
          </div>
          {proof.isLoading ? (
            <Skeleton height={10} />
          ) : proof.isError ? (
            <Banner tone="warning">Proof status unavailable — is the API running?</Banner>
          ) : (
            <ProofPipeline counts={(proof.data ?? []) as { status: string; count: number }[]} />
          )}
        </Card>

        <Card>
          <div className="section-title">
            <h2>Recent activity</h2>
            <Link className="link-btn" to="/activity">
              Full log →
            </Link>
          </div>
          {activity.isLoading ? (
            <div className="stack">
              <Skeleton height={16} />
              <Skeleton height={16} />
              <Skeleton height={16} />
            </div>
          ) : (activity.data ?? []).length === 0 ? (
            <EmptyState title="No activity yet" hint="Once the worker proves settlements, they appear here." />
          ) : (
            <div className="stack">
              {(activity.data ?? []).slice(0, 8).map((r) => {
                const m = statusMeta(r.status);
                return (
                  <div key={r.id} className="flex-between" style={{ gap: 'var(--sp-3)' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="mono small">{shortHash(r.jobId, 10)}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {decimal(r.gross)} tUSDC · {timeAgo(r.updatedAt)}
                      </div>
                    </div>
                    <Badge tone={m.tone}>{m.label}</Badge>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {config.vaultAddress && !config.apiUrl.includes('localhost') && (
        <Banner tone="info">Connected to API at {config.apiUrl}</Banner>
      )}
    </div>
  );
}

function util(view: { outstandingDebt: bigint; facilityLimit: bigint }): string {
  if (view.facilityLimit <= 0n) return '0%';
  return bps((view.outstandingDebt * 10000n) / view.facilityLimit);
}

function ProofPipeline({ counts }: { counts: { status: string; count: number }[] }) {
  const order = ['detected', 'awaiting_attestation', 'proof_ready', 'submitting', 'submitted', 'confirmed', 'retryable_failure', 'terminal_failure'];
  const colors: Record<string, string> = {
    detected: 'var(--muted)',
    awaiting_attestation: 'var(--info)',
    proof_ready: 'var(--info)',
    submitting: 'var(--accent)',
    submitted: 'var(--accent)',
    confirmed: 'var(--success)',
    retryable_failure: 'var(--warning)',
    terminal_failure: 'var(--danger)',
  };
  const map = new Map(counts.map((c) => [c.status, c.count]));
  const total = counts.reduce((a, c) => a + c.count, 0) || 1;
  const attention = (map.get('terminal_failure') ?? 0) + (map.get('retryable_failure') ?? 0);

  return (
    <div>
      <div className="pipeline" aria-label={`${total} settlements in pipeline`}>
        {order
          .filter((s) => (map.get(s) ?? 0) > 0)
          .map((s) => (
            <span
              key={s}
              style={{ width: `${((map.get(s) ?? 0) / total) * 100}%`, background: colors[s] ?? 'var(--muted)' }}
              title={`${s}: ${map.get(s)}`}
            />
          ))}
      </div>
      <div className="pipeline-legend">
        {order
          .filter((s) => (map.get(s) ?? 0) > 0)
          .map((s) => (
            <span key={s}>
              <span className="dot" style={{ background: colors[s] ?? 'var(--muted)' }} />
              {s.replace(/_/g, ' ')} · {map.get(s)}
            </span>
          ))}
      </div>
      {attention > 0 && (
        <div className="mt-3">
          <Banner tone="warning">
            {attention} settlement{attention === 1 ? '' : 's'} need{attention === 1 ? 's' : ''} attention.
          </Banner>
        </div>
      )}
    </div>
  );
}