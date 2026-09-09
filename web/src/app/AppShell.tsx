import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useConfig } from '../hooks/useConfig';
import { useWallet } from '../hooks/useWallet';
import { shortAddress } from '../lib/format';
import { Button, Badge } from '../components/ui/primitives';

const NAV = [
  { to: '/app', label: 'Overview', icon: '◧', end: true },
  { to: '/app/facility', label: 'Facility', icon: '▤' },
  { to: '/app/settlements', label: 'Settlements', icon: '≋' },
  { to: '/app/buyers', label: 'Buyers', icon: '◍' },
  { to: '/app/activity', label: 'Activity', icon: '∿' },
  { to: '/app/settings', label: 'Settings', icon: '⚙' },
];

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Overview', sub: 'Your financing position and proof pipeline at a glance.' },
  '/facility': { title: 'Facility', sub: 'Limit, utilization and borrowing against verified revenue.' },
  '/settlements': { title: 'Settlements', sub: 'Every JobSettled receipt proven and registered on the vault.' },
  '/buyers': { title: 'Buyers', sub: 'Revenue by buyer and concentration risk.' },
  '/activity': { title: 'Activity', sub: 'Recent lifecycle events across proof building and the chain.' },
  '/settings': { title: 'Settings', sub: 'Connections, addresses and on-chain policy.' },
};

export default function AppShell() {
  const { config } = useConfig();
  const wallet = useWallet();
  const location = useLocation();
  const path = location.pathname.replace(/^\/app/, '') || '/';
  const head = TITLES[path] ?? TITLES['/']!;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/logo.svg" alt="ComputeCred" width={34} height={34} />
          <div>
            <div className="brand-name">ComputeCred</div>
            <div className="muted small">proof-backed financing</div>
          </div>
        </div>

        <div className="nav-section-label">Workspace</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <span className="nav-icon">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}

        <div className="nav-section-label">Pipeline</div>
        <div className="nav-link" style={{ pointerEvents: 'none', color: 'var(--muted)' }}>
          <span className="nav-icon">⌘</span>
          <span>{config.apiUrl.replace(/^https?:\/\//, '')}</span>
        </div>

        <div className="sidebar-footer">
          <div className="flex-between">
            <span>Operator</span>
            {config.operatorAddress ? (
              <span className="mono small">{shortAddress(config.operatorAddress)}</span>
            ) : (
              <span className="small">unset</span>
            )}
          </div>
          {wallet.status === 'connected' ? (
            <div className="flex-between mt-2">
              <Badge tone="success">wallet</Badge>
              <span className="mono small">{shortAddress(wallet.address!)}</span>
            </div>
          ) : wallet.status === 'error' && wallet.error ? (
            <div className="mt-2 stack-ghost">
              <div className="small" style={{ color: 'var(--danger)' }}>
                {wallet.error}
              </div>
              <Button variant="outline" size="sm" onClick={() => void wallet.connect()}>
                Retry
              </Button>
            </div>
          ) : wallet.noWallet ? (
            <div className="mt-2 stack-ghost">
              <div className="small muted">
                No wallet found — we opened the MetaMask download in a new tab. Install it (or any EIP-1193 wallet), then connect.
              </div>
              <div className="flex">
                <a className="btn outline sm" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
                  Get MetaMask
                </a>
                <Button variant="outline" size="sm" onClick={() => void wallet.connect()}>
                  I've installed it — connect
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 stack-ghost">
              <Button variant="outline" size="sm" onClick={() => void wallet.connect()}>
                {wallet.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
              </Button>
              <div className="small muted">Read-only browsing — a wallet is only needed to sign draw/repay/liquidity.</div>
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="page-title">
            <h1>{head.title}</h1>
            <p>{head.sub}</p>
          </div>
          <div className="flex">
            {config.vaultAddress && <Badge tone="accent">vault · {shortAddress(config.vaultAddress)}</Badge>}
            {wallet.status === 'connected' && (
              <Button variant="secondary" size="sm" onClick={wallet.disconnect}>
                {shortAddress(wallet.address!)}
              </Button>
            )}
          </div>
        </header>
        <Outlet />
      </main>
    </div>
  );
}