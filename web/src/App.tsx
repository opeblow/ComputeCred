import { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { bps, createVault, createSignerVault, decimal, FacilityView, getBuyerTotals, getPolicy, getRecentSettlements, Policy, short, VaultCallable } from './lib/vault';

const DEFAULT_RPC = 'https://rpc.cc3-testnet.creditcoin.network';
const DEFAULT_VAULT = import.meta.env.VITE_COMPUTE_CRED_VAULT_ADDRESS as string | undefined;
const DEFAULT_OPERATOR = import.meta.env.VITE_OPERATOR_ADDRESS as string | undefined;

export default function App() {
  const [rpcUrl, setRpcUrl] = useState(DEFAULT_RPC);
  const [vaultAddress, setVaultAddress] = useState(DEFAULT_VAULT ?? '');
  const [operatorAddress, setOperatorAddress] = useState(DEFAULT_OPERATOR ?? '');

  const provider = useMemo(() => (rpcUrl ? new ethers.JsonRpcProvider(rpcUrl) : null), [rpcUrl]);

  const [policy, setPolicy] = useState<Policy | null>(null);
  const [view, setView] = useState<FacilityView | null>(null);
  const [buyers, setBuyers] = useState<{ buyer: string; amount: bigint }[]>([]);
  const [events, setEvents] = useState<ethers.EventLog[]>([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState<string | null>(null);

  const [connected, setConnected] = useState<string | null>(null);
  const [drawAmount, setDrawAmount] = useState('');
  const [repayAmount, setRepayAmount] = useState('');

  useEffect(() => {
    if (!provider || !ethers.isAddress(vaultAddress) || !ethers.isAddress(operatorAddress)) return;
    let cancelled = false;
    const load = async () => {
      setStatus('loading');
      setError(null);
      try {
        const vault = createVault(provider, vaultAddress);
        const [p, v, b] = await Promise.all([getPolicy(vault), vault.getFacilityView(operatorAddress), getBuyerTotals(vault, operatorAddress)]);
        if (cancelled) return;
        setPolicy(p);
        setView(v);
        setBuyers(b);
        const from = (await provider.getBlockNumber()) - 5000;
        setEvents(await getRecentSettlements(vault, from, (await provider.getBlockNumber())));
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
        setStatus('error');
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [provider, vaultAddress, operatorAddress]);

  const connect = async () => {
    if (!window.ethereum) {
      setError('No injected wallet found (MetaMask). Read-only mode still works.');
      return;
    }
    try {
      const browser = new ethers.BrowserProvider(window.ethereum as ethers.Eip1193Provider);
      const signer = await browser.getSigner();
      setConnected(await signer.getAddress());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const act = async (fn: (contract: VaultCallable) => Promise<unknown>, label: string) => {
    if (!connected || !window.ethereum || !ethers.isAddress(vaultAddress)) return;
    setError(null);
    try {
      const browser = new ethers.BrowserProvider(window.ethereum as ethers.Eip1193Provider);
      const signer = await browser.getSigner();
      const vault = createSignerVault(signer, vaultAddress);
      setStatus('submitting');
      await fn(vault);
      setStatus('ready');
      setDrawAmount('');
      setRepayAmount('');
    } catch (e) {
      setError((e as Error).message ?? String(e));
      setStatus('ready');
    }
  };

  return (
    <div className="wrap">
      <header>
        <h1>ComputeCred</h1>
        <p className="sub">Proof-backed revenue financing for independent GPU operators on Creditcoin.</p>
      </header>

      <section className="config">
        <label>Creditcoin RPC
          <input value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} />
        </label>
        <label>Vault address
          <input value={vaultAddress} onChange={(e) => setVaultAddress(e.target.value)} placeholder="0x..." />
        </label>
        <label>Operator (facility owner)
          <input value={operatorAddress} onChange={(e) => setOperatorAddress(e.target.value)} placeholder="0x..." />
        </label>
        <button onClick={connect} className="btn">
          {connected ? `Connected ${short(connected)}` : 'Connect wallet (draw/repay)'}
        </button>
      </section>

      {error && <div className="error">{error}</div>}
      {status === 'loading' && <div className="note">Loading facility data…</div>}

      {policy && (
        <section className="cards">
          <div className="card">
            <span className="lbl">Advance rate</span>
            <span className="val">{bps(policy.advanceRateBps)}</span>
            <span className="desc">of eligible revenue</span>
          </div>
          <div className="card">
            <span className="lbl">Max buyer concentration</span>
            <span className="val">{bps(policy.maxBuyerConcentrationBps)}</span>
            <span className="desc">excess above this is not financed</span>
          </div>
          <div className="card">
            <span className="lbl">Operator cap</span>
            <span className="val">{decimal(policy.operatorCap)}</span>
            <span className="desc">tUSDC per operator</span>
          </div>
          <div className="card">
            <span className="lbl">Freshness window</span>
            <span className="val">{Math.round(Number(policy.freshnessWindow) / 86400)}d</span>
            <span className="desc">trailing revenue window</span>
          </div>
        </section>
      )}

      {view && view.exists && (
        <section className="facility">
          <h2>Facility · {short(operatorAddress)}</h2>
          <div className="cards">
            <div className="card big">
              <span className="lbl">Facility limit</span>
              <span className="val">{decimal(view.facilityLimit)}</span>
              <span className="desc">50% × concentration-adjusted revenue</span>
            </div>
            <div className="card big">
              <span className="lbl">Available capacity</span>
              <span className="val">{decimal(view.availableCapacity)}</span>
              <span className="desc">limit − debt</span>
            </div>
            <div className="card">
              <span className="lbl">Verified revenue (30d)</span>
              <span className="val">{decimal(view.verifiedRevenue)}</span>
              <span className="desc">raw window total</span>
            </div>
            <div className="card">
              <span className="lbl">Eligible revenue</span>
              <span className="val">{decimal(view.eligibleRevenue)}</span>
              <span className="desc">after operator cap</span>
            </div>
            <div className="card">
              <span className="lbl">Largest buyer share</span>
              <span className="val">{bps(view.largestBuyerShareBps)}</span>
              <span className="desc">of window revenue</span>
            </div>
            <div className="card">
              <span className="lbl">Concentration factor</span>
              <span className="val">{bps(view.concentrationFactorBps)}</span>
              <span className="desc">share of revenue that is financeable</span>
            </div>
            <div className="card">
              <span className="lbl">Outstanding debt</span>
              <span className="val">{decimal(view.outstandingDebt)}</span>
              <span className="desc">repaid automatically by new settlements</span>
            </div>
            <div className="card">
              <span className="lbl">Vault liquidity</span>
              <span className="val">{decimal(view.vaultLiquidity)}</span>
              <span className="desc">tUSDC available to LPs for draws</span>
            </div>
            <div className="card">
              <span className="lbl">Repaid by revenue</span>
              <span className="val">{decimal(view.lifetimeDebtRepaidByRevenue)}</span>
              <span className="desc">lifetime auto-repay</span>
            </div>
          </div>

          {connected && (
            <div className="actions">
              <input
                placeholder="draw amount (tUSDC)"
                value={drawAmount}
                onChange={(e) => setDrawAmount(e.target.value)}
              />
              <button className="btn" onClick={() => void act((v) => v.draw(parseUnits(drawAmount)), 'draw')}>
                Draw
              </button>
              <input
                placeholder="repay amount (tUSDC)"
                value={repayAmount}
                onChange={(e) => setRepayAmount(e.target.value)}
              />
              <button className="btn" onClick={() => void act((v) => v.repay(parseUnits(repayAmount)), 'repay')}>
                Repay
              </button>
            </div>
          )}
        </section>
      )}

      {view && !view.exists && <div className="note">No facility opened for this operator address yet.</div>}

      {buyers.length > 0 && (
        <section>
          <h2>Buyer revenue (30d)</h2>
          <table>
            <thead>
              <tr><th>Buyer</th><th>Amount</th><th>Share</th></tr>
            </thead>
            <tbody>
              {buyers.map(({ buyer, amount }) => (
                <tr key={buyer}>
                  <td>{short(buyer)}</td>
                  <td>{decimal(amount)}</td>
                  <td>{view && view.verifiedRevenue > 0n ? bps((amount * 10000n) / view.verifiedRevenue) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {events.length > 0 && (
        <section>
          <h2>Recent verified settlements</h2>
          <table>
            <thead>
              <tr><th>Job</th><th>Buyer</th><th>Gross</th><th>Applied</th></tr>
            </thead>
            <tbody>
              {[...events].reverse().map((e, i) => {
                const [op, jobId, buyer, gross, applied] = e.args as unknown as [string, string, string, bigint, bigint];
                return (
                  <tr key={i}>
                    <td title={jobId}>{short(jobId)}</td>
                    <td>{short(buyer)}</td>
                    <td>{decimal(gross)}</td>
                    <td>{decimal(applied)}</td>
                    <td className="muted">{op.toLowerCase() === operatorAddress.toLowerCase() ? 'this operator' : short(op)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function parseUnits(v: string): bigint {
  try {
    return ethers.parseUnits(v, 6);
  } catch {
    return 0n;
  }
}