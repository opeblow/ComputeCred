import { Link } from 'react-router-dom';

const DOCS_URL = 'https://github.com/opeblow/ComputeCred';

const STEPS = [
  {
    n: '01',
    title: 'Watch the source chain',
    body: 'Every settlement a buyer settles on JobMarket emits a JobSettled event on Sepolia. The worker indexes it durably into its sqlite store — checkpoint-safe across restarts.',
  },
  {
    n: '02',
    title: 'Prove it with Attestcoin',
    body: 'For each receipt the worker builds a chain-of-custody proof of the settlement. Proofs are built off-chain, so verifying them on Creditcoin stays cheap.',
  },
  {
    n: '03',
    title: 'Register on the vault',
    body: 'verifyAndRegister records the verified settlement on ComputeCredVault. Your eligible-revenue credit line grows with every proof that lands.',
  },
];

const PILLARS = [
  {
    icon: '◈',
    title: 'Attestcoin-proofed',
    body: 'Every financing increment is backed by a cryptographic proof of settled revenue — not a promise.',
  },
  {
    icon: '◉',
    title: 'Creditcoin-native',
    body: 'The vault lives on Creditcoin CC3 and settles in tUSDC. One type-safe ledger for facility, verifications and debt.',
  },
  {
    icon: '◐',
    title: 'Self-serve credit',
    body: 'Draw against your line immediately and repay when you choose. Revenue is credit — it is never auto-repaid.',
  },
];

export default function LandingPage() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-wrap landing-nav-inner">
          <Link to="/app" className="landing-brand">
            <img className="landing-logo" src="/logo.svg" alt="" width={36} height={36} />
            <span className="landing-wordmark">ComputeCred</span>
            <span className="badge accent">CC3 testnet</span>
          </Link>
          <div className="landing-nav-links">
            <a className="landing-link" href={DOCS_URL} target="_blank" rel="noreferrer">
              Read the docs
            </a>
            <Link className="btn" to="/app">
              Open the dashboard
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-wrap">
            <p className="landing-eyebrow">Proof-backed revenue financing for GPU operators</p>
            <h1 className="landing-h1">
              Borrow against verified revenue,
              <br />
              not promises.
            </h1>
            <p className="landing-sub">
              ComputeCred turns your proven settlement history on the source chain into an on-chain credit line on Creditcoin —
              every dollar you can borrow is backed by a cryptographic proof, not a spreadsheet.
            </p>
            <div className="landing-cta">
              <Link className="btn landing-cta-primary" to="/app">
                Open the dashboard
              </Link>
              <a className="btn secondary" href={DOCS_URL} target="_blank" rel="noreferrer">
                Read the docs
              </a>
            </div>
          </div>
        </section>

        <section className="landing-section landing-wrap">
          <div className="landing-grid-3">
            {PILLARS.map((p) => (
              <div className="card landing-pillar" key={p.title}>
                <div className="landing-pillar-icon">{p.icon}</div>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-section landing-wrap">
          <div className="landing-section-head">
            <h2 className="landing-h2">How it works</h2>
            <p className="landing-muted">From settled receipt to registered credit, the pipeline never touches your keys.</p>
          </div>
          <div className="landing-grid-3">
            {STEPS.map((s) => (
              <div className="card landing-step" key={s.n}>
                <div className="landing-step-n">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-section landing-wrap">
          <div className="landing-policy">
            <div className="landing-policy-copy">
              <p className="landing-eyebrow">Underwriting, in one line</p>
              <h2 className="landing-h2">Your limit is your verified revenue, haircut for concentration.</h2>
              <p className="landing-muted">
                The vault computes eligibility from a 30-day window of registered proofs, caps it at the operator cap, then applies the
                advance rate and a concentration haircut. Revenue is <em>credit</em> — it grows your line and it is never used to repay
                automatically. Outstanding debt only falls when you choose to repay.
              </p>
            </div>
            <div className="card landing-policy-formula">
              <div className="mono landing-formula">
                <div>limit = advanceRate ×</div>
                <div>&nbsp;&nbsp;(eligible − concentrationHaircut)</div>
              </div>
              <dl className="landing-formula-legend">
                <div>
                  <dt>eligible</dt>
                  <dd>min(30d verified revenue, operator cap)</dd>
                </div>
                <div>
                  <dt>haircut</dt>
                  <dd>max(0, largest buyer − maxConcentration × eligible)</dd>
                </div>
                <div>
                  <dt>advanceRate</dt>
                  <dd>share of eligible you can finance, in bps</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section className="landing-section landing-wrap">
          <div className="card landing-cta-band">
            <div>
              <h2 className="landing-h2">See your facility</h2>
              <p className="landing-muted">
                Watch settlements move through the proof pipeline, review buyer concentration, and draw against your line. Runs against a
                local read-layer API plus the CC3 testnet RPC — no wallet required to browse.
              </p>
            </div>
            <div className="landing-cta-band-actions">
              <Link className="btn landing-cta-primary" to="/app">
                Launch the app
              </Link>
              <Link className="btn outline" to="/app/settings">
                Set your operator &amp; vault
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-wrap landing-footer-inner">
          <div className="landing-brand">
            <img className="landing-logo" src="/logo.svg" alt="" width={28} height={28} />
            <span className="landing-wordmark">ComputeCred</span>
          </div>
          <div className="landing-footer-links">
            <span className="landing-muted">Creditcoin CC3 testnet · Sepolia source chain</span>
            <a className="landing-link" href={DOCS_URL} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}