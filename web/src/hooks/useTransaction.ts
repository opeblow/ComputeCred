import { useCallback, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { useQueryClient } from '@tanstack/react-query';

export type TxStage = 'idle' | 'signing' | 'pending' | 'receipt-confirmed' | 'error';

export interface TxState {
  stage: TxStage;
  txHash: string | null;
  error: string | null;
  rejected: boolean;
  startedAt: number | null;
}

export interface TxRunner {
  stage: TxStage;
  txHash: string | null;
  error: string | null;
  rejected: boolean;
  /** Validates input, sends, waits 1 confirmation, and refreshes the dashboard queries. */
  run: (fn: () => Promise<ethers.ContractTransactionResponse>) => Promise<void>;
  reset: () => void;
}

const REFRESH_KEYS = ['facility', 'settlements', 'proof-status', 'activity', 'verified-events'];

export function useTransaction(): TxRunner {
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({
    stage: 'idle',
    txHash: null,
    error: null,
    rejected: false,
    startedAt: null,
  });
  // Serialize runs; a second click while busy is a no-op.
  const busy = useRef(false);

  const reset = useCallback(() => {
    busy.current = false;
    setState({ stage: 'idle', txHash: null, error: null, rejected: false, startedAt: null });
  }, []);

  const run = useCallback(
    async (fn: () => Promise<ethers.ContractTransactionResponse>) => {
      if (busy.current) return;
      busy.current = true;
      setState({ stage: 'signing', txHash: null, error: null, rejected: false, startedAt: Date.now() });
      try {
        const tx = await fn();
        setState((s) => ({ ...s, stage: 'pending', txHash: tx.hash }));
        const receipt = await tx.wait(1);
        if (!receipt) throw new Error('Transaction was dropped before confirmation.');
        setState({ stage: 'receipt-confirmed', txHash: tx.hash, error: null, rejected: false, startedAt: Date.now() });
        // Refresh the financial/evidence views after the tx lands.
        await Promise.all(REFRESH_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] }).catch(() => {})));
      } catch (err) {
        const e = err as { code?: number; shortMessage?: string; message?: string };
        const rejected = e?.code === 4001 || /user rejected/i.test(e?.shortMessage ?? '');
        setState({
          stage: 'error',
          txHash: state.txHash,
          error: rejected ? 'Transaction was rejected in your wallet.' : (e?.shortMessage ?? e?.message ?? String(err)),
          rejected,
          startedAt: Date.now(),
        });
      } finally {
        busy.current = false;
      }
    },
    [queryClient, state.txHash]
  );

  return { stage: state.stage, txHash: state.txHash, error: state.error, rejected: state.rejected, run, reset };
}