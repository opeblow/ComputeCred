import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ethers } from 'ethers';

const DEFAULT_RPC = 'https://rpc.cc3-testnet.creditcoin.network';

export interface Config {
  rpcUrl: string;
  vaultAddress: string;
  operatorAddress: string;
  apiUrl: string;
}

const STORAGE_KEY = 'computecred.config.v1';

function load(): Config {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  if (saved) {
    try {
      return { ...defaults(), ...(JSON.parse(saved) as Partial<Config>) };
    } catch {
      // fall through to defaults
    }
  }
  return defaults();
}

function defaults(): Config {
  return {
    rpcUrl: DEFAULT_RPC,
    vaultAddress: (import.meta.env.VITE_COMPUTE_CRED_VAULT_ADDRESS as string | undefined) ?? '',
    operatorAddress: (import.meta.env.VITE_OPERATOR_ADDRESS as string | undefined) ?? '',
    apiUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787',
  };
}

interface ConfigCtx {
  config: Config;
  setConfig: (patch: Partial<Config>) => void;
}

const Ctx = createContext<ConfigCtx | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setState] = useState<Config>(load);

  const setConfig = useCallback((patch: Partial<Config>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const value = useMemo(() => ({ config, setConfig }), [config, setConfig]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConfig(): ConfigCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useConfig must be used inside ConfigProvider');
  return ctx;
}

export function useProvider(): { provider: ethers.JsonRpcProvider | null } {
  const { config } = useConfig();
  return useMemo(() => ({ provider: config.rpcUrl ? new ethers.JsonRpcProvider(config.rpcUrl) : null }), [config.rpcUrl]);
}