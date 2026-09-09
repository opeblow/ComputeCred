import { useState } from 'react';
import { ethers } from 'ethers';
import { useFacility } from '../../../hooks/useFacility';
import { useConfig } from '../../../hooks/useConfig';
import { useWallet } from '../../../hooks/useWallet';
import { useSendSequence, type TxStep } from '../../../hooks/useSendSequence';
import { createSignerVault } from '../../../lib/vault';
import { LoanToken } from '../../../lib/token';
import { decimal, bps, shortAddress } from '../../../lib/format';
import { parseAmount, amountError } from '../../../lib/validate';
import {
  Card,
  Stat,
  Banner,
  Button,
  Badge,
  EmptyState,
  Meter,
  Kv,
  Spinner,
  Skeleton,
} from '../../../components/ui/primitives';
import { TransactionSteps, TxResultBanner, type StepDef } from '../../../components/TransactionSteps';

type Kind = 'draw' | 'repay' | 'liquidity';

const KIND_LABEL: Record<Kind, string> = { draw: 'Draw', repay: 'Repay', liquidity: 'Provide liquidity' };
const KIND_FN: Record<Kind, keyof ReturnType<typeof createSignerVault>> = {
  draw: 'draw',
  repay: 'repay',
  liquidity: 'provideLiquidity',
};

export default function FacilityPage() {
  const { config } = useConfig();
  const wallet = useWallet();
  const { snapshot, isLoading, isError, isEnabled } = useFacility();
  const [action, setAction] = useState<Kind | null>(null);

  if (!isEnabled) {
    return (
      <Card>
        <EmptyState title="Operator not configured">
          <p>Set the operator address and vault address in Settings to load the facility.</p>
        </EmptyState>
      </Card>
    );
  }

  const view = snapshot?.view;

  if (isLoading || !view) {
    return (
      <div className="split">
        <Card>
          <SkeletonLayout />
        </Card>
        <Card>
          <SkeletonLayout />
        </Card>
      </div>
    );
  }

  const exists = view.exists;

  return (
    <div className="stack">
      {isError && <Banner tone="error">Could not load the facility state.</Banner>}
      {!wallet.signer && <Banner tone="info">Connect your wallet in the sidebar to run facility actions.</Banner>}

      <div className="grid-4">
        <Card>
          <Stat label="Verified revenue" value={`${decimal(view.verifiedRevenue)} tUSDC`} hint="lifetime revenue proven on-chain" mono />
        </Card>
        <Card>
          <Stat label="Eligible base" value={`${decimal(view.eligibleRevenue)} tUSDC`} hint="after concentration + cap checks" mono />
        </Card>
        <Card>
          <Stat label="Facility limit" value={`${decimal(view.facilityLimit)} tUSDC`} mono flash />
        </Card>
        <Card>
          <Stat label="Outstanding debt" value={`${decimal(view.outstandingDebt)} tUSDC`} hint={`repaid ${decimal(view.lifetimeRepaid)} lifetime`} mono />
        </Card>
      </div>

      <div className="split">
        <Card>
          <div className="section-title">
            <h2>Utilization</h2>
            <span className="mono small muted">
              {util(view)} · {decimal(view.availableCapacity)} tUSDC available
            </span>
          </div>
          <Meter value={view.outstandingDebt} max={view.facilityLimit} />
          <div className="flex mt-3">
            {exists ? (
              wallet.signer && (
                <>
                  <Button onClick={() => setAction('draw')} disabled={view.outstandingDebt >= view.facilityLimit || view.vaultLiquidity === 0n}>
                    Draw
                  </Button>
                  <Button variant="outline" onClick={() => setAction('liquidity')}>
                    Provide liquidity
                  </Button>
                  <Button variant="outline" onClick={() => setAction('repay')} disabled={view.outstandingDebt === 0n}>
                    Repay
                  </Button>
                </>
              )
            ) : (
              wallet.signer && <OpenFacilityButton /> 
            )}
          </div>
          {exists && wallet.signer && (
            <p className="muted small mt-3" style={{ marginBottom: 0 }}>
              Draws consume available capacity; debt only decreases by an actual tUSDC repayment into the loan reserve.
            </p>
          )}
        </Card>

        <Card>
          <div className="section-title">
            <h2>Policy</h2>
            {exists && <Badge tone="success">facility open</Badge>}
          </div>
          {snapshot?.policy ? (
            <div className="kv">
              <Kv title="Advance rate" value={bps(snapshot.policy.advanceRateBps)} />
              <Kv title="Max buyer concentration" value={bps(snapshot.policy.maxBuyerConcentrationBps)} />
              <Kv title="Operator cap" value={snapshot.policy.operatorCap === 0n ? 'unlimited' : `${decimal(snapshot.policy.operatorCap)} tUSDC`} />
              <Kv title="Driver" value={shortAddress(config.operatorAddress)} />
              <Kv title="Largest buyer share" value={`${bps(view.largestBuyerShareBps)} of verified revenue`} />
              <Kv title="Last verified" value={view.lastVerifiedAt === 0n ? '—' : new Date(Number(view.lastVerifiedAt) * 1000).toLocaleString()} />
            </div>
          ) : (
            <Skeleton height={120} />
          )}
        </Card>
      </div>

      {action && (
        <MoneyDialog
          kind={action}
          onClose={() => setAction(null)}
          canUse={action === 'draw' ? view.availableCapacity : action === 'repay' ? view.outstandingDebt : null}
        />
      )}
    </div>
  );
}

function SkeletonLayout() {
  return (
    <div className="stack">
      <Skeleton height={18} />
      <Skeleton height={40} />
      <Skeleton height={18} />
      <Skeleton height={40} />
    </div>
  );
}

function util(view: { outstandingDebt: bigint; facilityLimit: bigint }): string {
  if (view.facilityLimit <= 0n) return '0%';
  return bps((view.outstandingDebt * 10000n) / view.facilityLimit);
}

function OpenFacilityButton() {
  const { config } = useConfig();
  const wallet = useWallet();
  const seq = useSendSequence();
  const running = seq.state.status === 'running';

  return (
    <div>
      <Button
        disabled={running}
        onClick={() => {
          const signer = wallet.signer;
          if (!signer) return;
          const vault = createSignerVault(signer, config.vaultAddress);
          const step: TxStep = {
            label: 'Open facility',
            sub: 'Sign the transaction to open a facility for this operator.',
            run: () => vault.openFacility() as Promise<ethers.ContractTransactionResponse>,
          };
          void seq.run([step]);
        }}
      >
        {running && <Spinner size={14} />}
        {running ? 'Opening…' : 'Open facility'}
      </Button>
      <p className="muted small mt-2" style={{ marginBottom: 0, maxWidth: 420 }}>
        Opening a facility registers this operator with the vault and enables draws against verified revenue.
      </p>
      <TxResultBanner status={seq.state.status} txHash={seq.state.txHash} error={seq.state.error} rejected={seq.state.rejected} />
    </div>
  );
}

function MoneyDialog({ kind, onClose, canUse }: { kind: Kind; onClose: () => void; canUse: bigint | null }) {
  const { config } = useConfig();
  const wallet = useWallet();
  const seq = useSendSequence();
  const [amount, setAmount] = useState('');

  const reqErr = amountError(amount, { required: true, max: canUse ?? undefined });
  const parsed = parseAmount(amount, 6);
  const running = seq.state.status === 'running';
  const done = seq.state.status === 'done';

  const hint =
    kind === 'draw'
      ? 'The vault sends the loan tokens from reserves, up to your available capacity.'
      : kind === 'repay'
        ? 'Repayment is an actual tUSDC transfer into the vault — the only way to reduce outstanding debt.'
        : 'Deposit loan tokens into vault reserves; they back draws for this facility.';

  const go = async () => {
    const signer = wallet.signer;
    if (!signer || reqErr || parsed === null) return;
    const vault = createSignerVault(signer, config.vaultAddress);
    const owner = await signer.getAddress();
    const steps: TxStep[] = [];
    const needsApproval = kind === 'repay' || kind === 'liquidity';
    if (needsApproval) {
      const loan = new LoanToken(signer, await vault.loanToken());
      const approval = await loan.ensureApproval(owner, config.vaultAddress, parsed);
      if (approval) {
        steps.push({ label: 'Approve tUSDC', sub: 'Authorize the vault to pull loan tokens.', run: async () => approval });
      }
    }
    steps.push({
      label: KIND_LABEL[kind],
      sub: `Confirm the ${KIND_LABEL[kind].toLowerCase()} in your wallet.`,
      run: () => (vault[KIND_FN[kind]] as (amount: bigint) => Promise<ethers.ContractTransactionResponse>)(parsed),
    });
    await seq.run(steps);
  };

  const defs: StepDef[] =
    kind === 'draw'
      ? [{ key: 'draw', title: 'Draw', sub: 'Confirm the draw in your wallet.' }]
      : [
          { key: 'approve', title: 'Approve tUSDC', sub: 'Appears when the vault needs an allowance.' },
          { key: 'op', title: KIND_LABEL[kind], sub: 'Confirm the transaction in your wallet.' },
        ];

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="flex-between">
          <h2 style={{ fontSize: 16 }}>{KIND_LABEL[kind]}</h2>
          <button className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="muted small mt-2">{hint}</p>

        <div className="field mt-4">
          <label htmlFor="amount">Amount (tUSDC)</label>
          <input
            id="amount"
            className={`input mono ${reqErr ? 'invalid' : ''}`}
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            disabled={running}
            onChange={(e) => setAmount(e.target.value)}
          />
          {reqErr && <div className="input-err">{reqErr}</div>}
          <div className="muted small">{canUse !== null ? `Available: ${decimal(canUse)} tUSDC` : 'Pulled from your tUSDC balance.'}</div>
        </div>

        <div className="mt-4">
          <TransactionSteps steps={defs} progress={seq.state.progress} status={seq.state.status} failedAt={seq.state.failedAt} txHash={seq.state.txHash} />
        </div>

        <TxResultBanner status={seq.state.status} txHash={seq.state.txHash} error={seq.state.error} rejected={seq.state.rejected} />

        <div className="flex mt-4" style={{ justifyContent: 'flex-end' }}>
          {running ? (
            <Button disabled>
              <Spinner size={14} /> Sending
            </Button>
          ) : done ? (
            <Button
              variant="secondary"
              onClick={() => {
                seq.reset();
                onClose();
              }}
            >
              Done
            </Button>
          ) : (
            <Button onClick={() => void go()} disabled={!!reqErr || parsed === null}>
              {KIND_LABEL[kind]}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}