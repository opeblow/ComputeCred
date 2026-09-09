import { useState } from 'react';
import { useConfig } from '../../../hooks/useConfig';
import { Card, Button, Banner } from '../../../components/ui/primitives';

export default function SettingsPage() {
  const { config, setConfig } = useConfig();
  const [rpcUrl, setRpc] = useState(config.rpcUrl);
  const [vaultAddress, setVault] = useState(config.vaultAddress);
  const [operatorAddress, setOperator] = useState(config.operatorAddress);
  const [apiUrl, setApi] = useState(config.apiUrl);
  const dirty =
    rpcUrl !== config.rpcUrl ||
    vaultAddress !== config.vaultAddress ||
    operatorAddress !== config.operatorAddress ||
    apiUrl !== config.apiUrl;

  const save = () => {
    setConfig({ rpcUrl: rpcUrl.trim(), vaultAddress: vaultAddress.trim(), operatorAddress: operatorAddress.trim(), apiUrl: apiUrl.trim() });
  };

  return (
    <div className="stack">
      <Card>
        <h2 style={{ fontSize: 16, margin: '0 0 var(--sp-3)' }}>Runtime</h2>
        <p className="muted small">
          Settings are persisted to local storage. Changing them reloads the application state with the new RPC/API/operator. No credentials are
          stored here.
        </p>
        <div className="split">
          <div className="field">
            <label htmlFor="rpc">RPC URL</label>
            <input id="rpc" className="input mono" value={rpcUrl} onChange={(e) => setRpc(e.target.value)} placeholder="https://rpc.cc3-testnet.creditcoin.network" />
          </div>
          <div className="field">
            <label htmlFor="vault">ComputeCredVault address</label>
            <input id="vault" className="input mono" value={vaultAddress} onChange={(e) => setVault(e.target.value)} placeholder="0x…" />
          </div>
        </div>
        <div className="split mt-3">
          <div className="field">
            <label htmlFor="operator">Operator address</label>
            <input id="operator" className="input mono" value={operatorAddress} onChange={(e) => setOperator(e.target.value)} placeholder="0x…" />
          </div>
          <div className="field">
            <label htmlFor="api">API origin</label>
            <input id="api" className="input mono" value={apiUrl} onChange={(e) => setApi(e.target.value)} placeholder="http://localhost:8787" />
          </div>
        </div>
        <div className="flex mt-4" style={{ justifyContent: 'flex-end' }}>
          <Button disabled={!dirty} onClick={save}>
            {dirty ? 'Apply' : 'Saved'}
          </Button>
        </div>
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, margin: '0 0 var(--sp-3)' }}>Sources</h2>
        <div className="kv">
          <div className="kv-row">
            <div className="kv-key">operator address</div>
            <div className="kv-val mono small">{config.operatorAddress || 'unset'}</div>
          </div>
          <div className="kv-row">
            <div className="kv-key">vault address</div>
            <div className="kv-val mono small">{config.vaultAddress || 'unset'}</div>
          </div>
          <div className="kv-row">
            <div className="kv-key">rpc url</div>
            <div className="kv-val mono small">{config.rpcUrl || 'unset'}</div>
          </div>
          <div className="kv-row">
            <div className="kv-key">api url</div>
            <div className="kv-val mono small">{config.apiUrl || 'unset'}</div>
          </div>
        </div>
      </Card>

      <Banner tone="info">
        The submitter private key lives in the worker environment. The web frontend never sees or handles signing keys.
      </Banner>
    </div>
  );
}