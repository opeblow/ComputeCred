import { useCallback, useRef, useState } from 'react';
import { ethers } from 'ethers';

const CC3_CHAIN_ID = '0x913'; // 2323
const CC3_TESTNET = {
  chainId: CC3_CHAIN_ID,
  chainName: 'Creditcoin CC3 Testnet',
  nativeCurrency: { name: 'Creditcoin', symbol: 'CCC', decimals: 18 },
  rpcUrls: ['https://rpc.cc3-testnet.creditcoin.network'],
  blockExplorerUrls: ['https://creditcoin-testnet.blockscout.com'],
};

const METAMASK_DOWNLOAD = 'https://metamask.io/download/';

export type WalletState =
  | { status: 'disconnected'; address: null; noWallet: boolean }
  | { status: 'connecting'; address: null; noWallet: boolean }
  | { status: 'connected'; address: string; signer: ethers.Signer }
  | { status: 'error'; address: null; error: string; noWallet: boolean };

export interface WalletHook {
  status: WalletState['status'];
  address: string | null;
  signer: ethers.Signer | null;
  error: string | null;
  noWallet: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

function injectedProvider(): ethers.Eip1193Provider | null {
  return (window as unknown as { ethereum?: ethers.Eip1193Provider }).ethereum ?? null;
}

export function useWallet(): WalletHook {
  const [state, setState] = useState<WalletState>({ status: 'disconnected', address: null, noWallet: false });
  const openedRef = useRef(false);

  const connect = useCallback(async () => {
    const eth = injectedProvider();
    if (!eth) {
      if (!openedRef.current) {
        window.open(METAMASK_DOWNLOAD, '_blank', 'noopener,noreferrer');
        openedRef.current = true;
      }
      setState({ status: 'disconnected', address: null, noWallet: true });
      return;
    }
    setState({ status: 'connecting', address: null, noWallet: false });
    try {
      const browser = new ethers.BrowserProvider(eth);
      const signer = await browser.getSigner();
      const address = await signer.getAddress();
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CC3_CHAIN_ID }] });
      } catch (switchErr) {
        if ((switchErr as { code?: number }).code === 4902) {
          try {
            await eth.request({ method: 'wallet_addEthereumChain', params: [CC3_TESTNET] });
          } catch {
            // still connected; reads work regardless of the injection network
          }
        }
      }
      setState({ status: 'connected', address, signer });
    } catch (err) {
      const rejected = (err as { code?: number }).code === 4001;
      setState({
        status: 'error',
        address: null,
        noWallet: false,
        error: rejected ? 'Connection request was rejected.' : err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const disconnect = useCallback(
    () => setState({ status: 'disconnected', address: null, noWallet: false }),
    []
  );

  return {
    status: state.status,
    address: state.address,
    signer: state.status === 'connected' ? state.signer : null,
    error: state.status === 'error' ? state.error : null,
    noWallet: state.status !== 'connected' ? state.noWallet : false,
    connect,
    disconnect,
  };
}