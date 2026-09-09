import { motion, AnimatePresence } from 'motion/react';
import { useEffect } from 'react';
import type { SettlementRecord } from '../lib/api';
import { decimal, formatDate, shortAddress, shortHash, statusMeta } from '../lib/format';
import { Badge, CopyButton, Kv } from './ui/primitives';
import { TransactionSteps, type StepDef } from './TransactionSteps';
import type { StepStatus } from '../hooks/useSendSequence';

interface EvidenceDrawerProps {
  record: SettlementRecord;
  onClose: () => void;
}

const VERIFY_STEPS: StepDef[] = [
  { key: 'receipt', title: 'Source receipt', sub: 'JobSettled on the job market, proven at block height by Creditcoin' },
  { key: 'proof', title: 'Inclusion + continuity proof', sub: 'Merkle inclusion from the proven block, linked by continuity roots' },
  { key: 'validated', title: 'Strict validation on the vault', sub: 'Status: success, emitter, event, amount, freshness, claimant' },
  { key: 'applied', title: 'Revenue recognition applied', sub: 'On-chain credit policy grows the eligible base' },
];

export function EvidenceDrawer({ record, onClose }: EvidenceDrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta = statusMeta(record.status);

  const isConfirmed = record.status === 'confirmed';
  const isFailed = record.status.includes('fail');
  const progress = isConfirmed
    ? VERIFY_STEPS.length
    : isFailed
      ? 3
      : record.status === 'detected'
        ? 0
        : record.status === 'awaiting_attestation'
          ? 1
          : record.status === 'proof_ready'
            ? 2
            : 3;
  const status: StepStatus = isConfirmed ? 'done' : isFailed ? 'failed' : 'running';

  return (
    <AnimatePresence>
      <motion.div
        className="drawer-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        data-testid="drawer-backdrop"
      />
      <motion.aside
        className="drawer"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'tween', duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
        role="dialog"
        aria-modal="true"
      >
        <div className="drawer-header">
          <div>
            <div className="flex" style={{ gap: 8 }}>
              <Badge tone={meta.tone}>{meta.label}</Badge>
              <span className="mono small muted">{shortHash(record.jobId, 10)}</span>
            </div>
            <p className="muted small mt-1" style={{ margin: '6px 0 0' }}>
              Verification evidence for settlement <span className="mono">{shortHash(record.txHash)}</span>
            </p>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <section className="mt-4">
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Verification state</h3>
          <TransactionSteps steps={VERIFY_STEPS} progress={progress} status={status} failedAt={isFailed ? 3 : null} txHash={record.destTxHash} />
        </section>

        <div className="divider" />

        <section>
          <h3 style={{ fontSize: 14, marginBottom: 4 }}>Settlement</h3>
          <div className="kv">
            <Kv title="Job id" value={<><span className="mono">{shortHash(record.jobId, 14)}</span> <CopyButton text={record.jobId} /></>} mono />
            <Kv title="Gross amount" value={`${decimal(record.gross)} tUSDC`} />
            <Kv title="Completed" value={formatDate(record.completedAt)} />
            <Kv title="Buyer" value={<><span className="mono">{shortAddress(record.buyer)}</span> <CopyButton text={record.buyer} /></>} mono />
            <Kv title="Operator" value={<><span className="mono">{shortAddress(record.operator)}</span> <CopyButton text={record.operator} /></>} mono />
          </div>
        </section>

        <div className="divider" />

        <section>
          <h3 style={{ fontSize: 14, marginBottom: 4 }}>Source &amp; proof</h3>
          <div className="kv">
            <Kv
              title="Source tx"
              value={record.txHash ? <><span className="mono">{shortHash(record.txHash, 12)}</span> <CopyButton text={record.txHash} /></> : '—'}
              mono
            />
            <Kv title="Source block" value={`#${record.blockNumber}`} />
            <Kv
              title="Creditcoin tx"
              value={record.destTxHash ? <><span className="mono">{shortHash(record.destTxHash, 12)}</span> <CopyButton text={record.destTxHash} /></> : '—'}
              mono
            />
            <Kv title="Attempts" value={String(record.retries)} />
            {record.lastError && <Kv title="Last error" value={<span className="mono small">{record.lastError}</span>} />}
          </div>
        </section>

        {record.status.includes('fail') && record.lastError && (
          <div className="mt-4">
            <div className="banner warning">
              This settlement needs attention before it can be recognized as revenue. Errors retry
              for a bounded number of attempts, then pause for an operator check.
            </div>
          </div>
        )}
      </motion.aside>
    </AnimatePresence>
  );
}