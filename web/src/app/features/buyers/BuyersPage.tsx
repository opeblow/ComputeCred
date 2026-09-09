import { Link } from 'react-router-dom';
import { useFacility } from '../../../hooks/useFacility';
import { decimal, bps, shortAddress, share } from '../../../lib/format';
import { Card, Skeleton, EmptyState, Banner, Meter, Badge } from '../../../components/ui/primitives';
import { ConfigGate } from '../../../components/ui/ConfigGate';

export default function BuyersPage() {
  const { snapshot, isLoading, isError, isEnabled } = useFacility();

  if (!isEnabled) {
    return (
      <ConfigGate title="Operator not configured">Set the operator address and vault address in Settings to load buyer totals.</ConfigGate>
    );
  }

  if (isError) {
    return <Banner tone="error">Could not load buyer concentration data.</Banner>;
  }

  if (isLoading || !snapshot) {
    return (
      <div className="stack">
        <Skeleton height={60} />
        <Skeleton height={48} />
        <Skeleton height={48} />
      </div>
    );
  }

  const view = snapshot.view;
  if (!view) return <Banner tone="warning">Facility not open — no buyer data to show yet.</Banner>;
  const totals = snapshot.buyers;
  const sorted = [...totals].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const total = sorted.reduce((acc, b) => acc + b.amount, 0n);
  const capBps = snapshot.policy?.maxBuyerConcentrationBps ?? 0n;

  return (
    <div className="stack">
      {view.largestBuyerShareBps > capBps && capBps > 0n && (
        <Banner tone="warning">
          The largest buyer exceeds the {bps(capBps)} concentration cap — revenue beyond the cap is excluded from the eligible base until the split
          improves. Diversify revenue to raise your facility limit.
        </Banner>
      )}

      <div className="grid-4">
        <Card>
          <span className="stat"><span className="stat-label">Distinct buyers</span><span className="stat-value mono">{sorted.length}</span></span>
        </Card>
        <Card>
          <span className="stat"><span className="stat-label">Verified revenue</span><span className="stat-value mono">{decimal(view.verifiedRevenue)} tUSDC</span></span>
        </Card>
        <Card>
          <span className="stat"><span className="stat-label">Largest share</span><span className="stat-value mono">{bps(view.largestBuyerShareBps)}</span></span>
        </Card>
        <Card>
          <span className="stat"><span className="stat-label">Concentration cap</span><span className="stat-value mono">{capBps > 0n ? bps(capBps) : 'unset'}</span></span>
        </Card>
      </div>

      <Card>
        <div className="section-title">
          <h2>Revenue by buyer</h2>
          <span className="muted small">tap a row to copy the address</span>
        </div>
        {sorted.length === 0 ? (
          <EmptyState title="No buyers yet" hint="Once settlements are verified for this operator, buyer revenue will appear here." />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Buyer</th>
                  <th>Verified revenue</th>
                  <th>Share</th>
                  <th>Against cap</th>
                  <th>Bars</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => {
                  const pct = share(b.amount, total);
                  const shareBpsOfVerified = total > 0n ? (b.amount * 10000n) / view.verifiedRevenue : 0n;
                  const over = capBps > 0n && shareBpsOfVerified > capBps;
                  return (
                    <tr key={b.buyer} className="row-link" onClick={() => void navigator.clipboard?.writeText(b.buyer).catch(() => {})} title="Copy address">
                      <td className="mono">{shortAddress(b.buyer)}</td>
                      <td>{decimal(b.amount)} tUSDC</td>
                      <td>{pct}</td>
                      <td>{over ? <BadgeInline tone="warning">over cap</BadgeInline> : <BadgeInline tone="success">ok</BadgeInline>}</td>
                      <td style={{ width: '24%' }}>
                        <Meter value={b.amount} max={capBps > 0n && view.verifiedRevenue > 0n ? (capBps * view.verifiedRevenue) / 10000n : b.amount} tone={over ? 'danger' : undefined} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small mt-3" style={{ marginBottom: 0 }}>
          Concentration is measured against verified revenue; amounts beyond the cap are excluded from the eligible base.
        </p>
      </Card>

      <p className="muted small">
        <Link className="link-btn" to="/app/settlements">See the settlements feeding these totals →</Link>
      </p>
    </div>
  );
}

function BadgeInline({ tone, children }: { tone: 'success' | 'warning'; children: React.ReactNode }) {
  return <Badge tone={tone}>{children}</Badge>;
}