import { useCallback, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { useQueryClient } from '@tanstack/react-query';

export type StepStatus = 'idle' | 'running' | 'done' | 'failed';

export interface SeqState {
  status: StepStatus;
  /** Number of steps fully completed while running/done. */
  progress: number;
  /** Index of the failed step, when status === 'failed'. */
  failedAt: number | null;
  txHash: string | null;
  error: string | null;
  rejected: boolean;
}

export interface TxStep {
  label: string;
  sub?: string;
  run: () => Promise<ethers.ContractTransactionResponse>;
}

const REFRESH_KEYS = ['facility', 'settlements', 'proof-status', 'activity', 'verified-events'];

export function useSendSequence(): {
  state: SeqState;
  running: boolean;
  run: (steps: TxStep[]) => Promise<void>;
  reset: () => void;
} {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SeqState>({
    status: 'idle',
    progress: 0,
    failedAt: null,
    txHash: null,
    error: null,
    rejected: false,
  });
  const busy = useRef(false);

  const reset = useCallback(() => {
    busy.current = false;
    setState({ status: 'idle', progress: 0, failedAt: null, txHash: null, error: null, rejected: false });
  }, []);

  const run = useCallback(
    async (steps: TxStep[]) => {
      if (busy.current || steps.length === 0) return;
      busy.current = true;
      setState({ status: 'running', progress: 0, failedAt: null, txHash: null, error: null, rejected: false });

      let lastHash: string | null = null;
      try {
        for (let i = 0; i < steps.length; i += 1) {
          const tx = await steps[i]!.run();
          lastHash = tx.hash;
          setState((s) => ({ ...s, txHash: tx.hash }));
          const receipt = await tx.wait(1);
          if (!receipt) throw new Error('Transaction was dropped before confirmation.');
          setState((s) => ({ ...s, progress: i + 1 }));
        }
        setState({ status: 'done', progress: steps.length, failedAt: null, txHash: lastHash, error: null, rejected: false });
        await Promise.all(REFRESH_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] }).catch(() => {})));
      } catch (err) {
        const e = err as { code?: number; shortMessage?: string; message?: string };
        const rejected = e?.code === 4001 || /user rejected/i.test(e?.shortMessage ?? '');
        setState((s) => ({
          status: 'failed',
          progress: s.progress,
          failedAt: Math.min(s.progress, steps.length - 1),
          txHash: s.txHash,
          error: rejected ? 'Transaction was rejected in your wallet.' : (e?.shortMessage ?? e?.message ?? String(err)),
          rejected,
        }));
      } finally {
        busy.current = false;
      }
    },
    [queryClient]
  );

  return { state, running: state.status === 'running', run, reset };
}