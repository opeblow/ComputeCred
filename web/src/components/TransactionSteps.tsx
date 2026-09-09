import { motion, AnimatePresence } from 'motion/react';
import type { StepStatus } from '../hooks/useSendSequence';
import { shortHash } from '../lib/format';

export interface StepDef {
  key: string;
  title: string;
  sub?: string;
}

function stepState(index: number, progress: number, status: StepStatus, failedAt: number | null): 'done' | 'active' | 'todo' | 'failed' {
  if (status === 'failed') return failedAt === index ? 'failed' : index < (failedAt ?? 0) ? 'done' : 'todo';
  if (status === 'idle') return 'todo';
  if (status === 'running') return index < progress ? 'done' : index === progress ? 'active' : 'todo';
  return 'done';
}

export function TransactionSteps({
  steps,
  progress,
  status,
  failedAt,
  txHash,
}: {
  steps: StepDef[];
  progress: number;
  status: StepStatus;
  failedAt: number | null;
  txHash?: string | null;
}) {
  return (
    <ol className="steps">
      {steps.map((step, i) => {
        const st = stepState(i, progress, status, failedAt);
        return (
          <li key={step.key} className={`step ${st}`}>
            <span className="step-tail">
              <span className="step-ic">{st === 'done' ? '✓' : st === 'failed' ? '!' : i + 1}</span>
            </span>
            <div>
              <div className="step-title">{step.title}</div>
              <div className="step-sub">
                {st === 'active' && (step.sub ?? 'Waiting for this step to confirm on-chain.')}
                {st === 'done' && i === steps.length - 2 && txHash && step.key === 'approve' && 'approved'}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function TxResultBanner({
  status,
  txHash,
  error,
  rejected,
  label,
}: {
  status: StepStatus;
  txHash: string | null;
  error: string | null;
  rejected: boolean;
  label?: string;
}) {
  return (
    <AnimatePresence>
      {status === 'done' && (
        <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} key="ok">
          <div className="banner success">
            <div>
              {label ?? 'Confirmed on-chain. The dashboard has been refreshed with the latest state.'}
              {txHash && <div className="mono small mt-1">{shortHash(txHash, 12)}</div>}
            </div>
          </div>
        </motion.div>
      )}
      {status === 'failed' && (
        <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} key="err">
          <div className="banner error">
            {rejected ? 'Transaction was rejected in your wallet — nothing was sent.' : error ?? 'Transaction failed.'}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}