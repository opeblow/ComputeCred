import { useCallback, useState } from 'react';
import { ethers } from 'ethers';

export type WalletState =
  | { status: 'disconnected'; address: null }
  | { status: 'connecting'; address: null }
  | { status: 'connected'; address: string; signer: ethers.Signer }
  | { status: 'error'; address: null; error: string };

export interface WalletHook {
  status: WalletState['status'];
  address: string | null;
  signer: ethers.Signer | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

export function useWallet(): WalletHook {
  const [state, setState] = useState<WalletState>({ status: 'disconnected', address: null });

  const connect = useCallback(async () => {
    const eth = (window as unknown as { ethereum?: ethers.Eip1193Provider }).ethereum;
    if (!eth) {
      setState({ status: 'error', address: null, error: 'No injected wallet found (MetaMask).' });
      return;
    }
    setState({ status: 'connecting', address: null });
    try {
      const browser = new ethers.BrowserProvider(eth);
      const signer = await browser.getSigner();
      const address = await signer.getAddress();
      setState({ status: 'connected', address, signer });
    } catch (err) {
      const rejected = (err as { code?: number }).code === 4001;
      setState({
        status: 'error',
        address: null,
        error: rejected ? 'Connection request was rejected.' : err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const disconnect = useCallback(() => setState({ status: 'disconnected', address: null }), []);

  return {
    status: state.status,
    address: state.address,
    signer: state.status === 'connected' ? state.signer : null,
    error: state.status === 'error' ? state.error : null,
    connect,
    disconnect,
  };
}