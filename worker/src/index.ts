import { Contract, ethers, Wallet, EventLog } from 'ethers';
import { vaultAbi, marketAbi } from './abis';
import { loadEnv } from './env';
import { JOB_STATUS, createStore, Store, type SettlementRow } from './store';
import { generateProofFor, broadcastProof, shortMessage, isTerminalRevert } from './proof';

const MAX_LOG_BLOCK_RANGE = 50; // sepolia public RPCs cap eth_getLogs range
const CLAIM_BATCH = 50;

let shuttingDown = false;
process.on('SIGINT', () => {
  shuttingDown = true;
});
process.on('SIGTERM', () => {
  shuttingDown = true;
});

const main = async () => {
  const env = loadEnv();

  if (!env.sourceChainKey) throw new Error('SOURCE_CHAIN_KEY not set');
  if (!env.privateKey.startsWith('0x') || env.privateKey.length !== 66) {
    throw new Error('CREDITCOIN_WALLET_PRIVATE_KEY is invalid');
  }

  const store = createStore(env.dbPath);

  const operatorWallet = new Wallet(env.privateKey);
  const operatorAddress = (env.operatorAddress ?? operatorWallet.address).toLowerCase();
  const submitterWallet = new Wallet(env.submitterPrivateKey ?? env.privateKey);

  const ccProvider = new ethers.JsonRpcProvider(env.creditcoinRpcUrl);
  const signer = submitterWallet.connect(ccProvider);
  const vault = new Contract(env.vaultAddress, vaultAbi, signer);

  const sourceProvider = new ethers.JsonRpcProvider(env.sourceChainRpcUrl);
  const market = new Contract(env.marketAddress, marketAbi, sourceProvider);

  console.log(`Operator facility: ${operatorAddress}`);
  console.log(`Proof submitter:   ${signer.address}`);
  console.log(`Vault:  ${env.vaultAddress}`);
  console.log(`Market: ${env.marketAddress}`);
  console.log(`DB:     ${env.dbPath}`);

  // Clear any half-finished transitions left by a previous crash, then re-confirm anything that
  // may already be on-chain (a prior crash could have broadcast before persisting the hash).
  const released = store.releaseStale(Date.now());
  console.log(`Released ${released} stale in-flight jobs after restart.`);

  while (!shuttingDown) {
    try {
      await scanSettlements(store, market, sourceProvider, env);
    } catch (err) {
      console.error(`scan phase failed: ${shortMessage(err)}`);
    }
    try {
      await reconcile(store, vault, ccProvider, env);
    } catch (err) {
      console.error(`reconcile phase failed: ${shortMessage(err)}`);
    }
    try {
      await buildProofs(store, sourceProvider, env, operatorAddress);
    } catch (err) {
      console.error(`proof phase failed: ${shortMessage(err)}`);
    }
    try {
      await submitProofs(store, vault, signer, env);
    } catch (err) {
      console.error(`submit phase failed: ${shortMessage(err)}`);
    }

    const counts = store.countByStatus();
    const summary = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`[health] ${summary}`);

    await sleep(env.pollIntervalMs);
  }

  store.close();
  sourceProvider.destroy();
  ccProvider.destroy();
  console.log('Worker stopped.');
};

// -----------------------------------------------------------------------------
// Phase 1 - scan. Durability rule: the checkpoint only advances past blocks whose
// JobSettled events are durably persisted. A failed chunk leaves the checkpoint
// behind and is rescanned next poll (INSERT OR IGNORE => idempotent). This is the
// fix for "the scanner advanced past blocks whose submissions failed".
// -----------------------------------------------------------------------------
async function scanSettlements(
  store: Store,
  market: Contract,
  provider: ethers.JsonRpcProvider,
  env: ReturnType<typeof loadEnv>
): Promise<void> {
  const latest = await provider.getBlockNumber();
  const ckpt = store.getCheckpoint();
  const from = ckpt ? ckpt.fromBlock : env.startBlock ?? Math.max(latest, 0);
  if (from > latest) return;

  if (!ckpt && env.startBlock !== undefined && env.startBlock > latest) {
    console.log(`WORKER_START_BLOCK ${env.startBlock} is ahead of head ${latest}; waiting.`);
    return;
  }

  let start = from;
  let chunkSize = MAX_LOG_BLOCK_RANGE;
  while (start <= latest && !shuttingDown) {
    const end = Math.min(start + chunkSize - 1, latest);
    try {
      const events = await market.queryFilter('JobSettled', start, end);
      const rows: SettlementRow[] = events
        .filter((e): e is EventLog => e instanceof EventLog && e.args !== undefined)
        .map((e) => {
          const [jobId, operator, buyer, grossAmount, completedAt] = e.args as unknown as [
            string,
            string,
            string,
            bigint,
            bigint,
          ];
          return {
            chainKey: env.sourceChainKey,
            contractAddress: env.marketAddress,
            txHash: e.transactionHash.toLowerCase(),
            logIndex: e.index ?? 0,
            jobId: String(jobId),
            operator: String(operator).toLowerCase(),
            buyer: String(buyer).toLowerCase(),
            gross: grossAmount.toString(),
            completedAt: completedAt.toString(),
            blockNumber: e.blockNumber,
          };
        });
      store.commitScan(rows, end);
      if (rows.length > 0) console.log(`  indexed ${rows.length} JobSettled (blocks ${start}-${end})`);
      start = end + 1;
      chunkSize = MAX_LOG_BLOCK_RANGE;
    } catch (err) {
      console.error(`scan chunk ${start}-${end} failed: ${shortMessage(err)}`);
      if (chunkSize > 1) {
        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
        await sleep(10_000);
      } else {
        console.error(`scan block ${start} persistently failing; checkpoint stays behind.`);
        return;
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Phase 2 - proofs. Attestation on CC3 testnet takes minutes, so rings sit in
// awaiting_attestation until the block prover has the source block cached.
// -----------------------------------------------------------------------------
async function buildProofs(
  store: Store,
  sourceProvider: ethers.JsonRpcProvider,
  env: ReturnType<typeof loadEnv>,
  operatorAddress: string
): Promise<void> {
  store.claimForProofing(operatorAddress, CLAIM_BATCH);

  const pending = store.jobs({ status: JOB_STATUS.AWAITING_ATTESTATION, limit: CLAIM_BATCH });
  for (const job of pending) {
    if (shuttingDown) break;
    try {
      const proof = await generateProofFor(job.txHash, env.sourceChainKey, env.proofBuilderUrl, sourceProvider);
      store.setProofReady(job.id, JSON.stringify(proof));
      console.log(`proof ready for job ${job.jobId}`);
    } catch (err) {
      const message = shortMessage(err);
      if (job.retries >= env.maxProofRetries || isTerminalProofError(message)) {
        store.markTerminal(job.id, message);
        console.error(`job ${job.jobId} terminal (proof): ${message}`);
      } else {
        store.markRetryable(job.id, message);
        console.warn(`job ${job.jobId} proof ${job.retries + 1}/${env.maxProofRetries} failed: ${message}`);
      }
    }
  }

  const retryable = store.jobs({ status: JOB_STATUS.RETRYABLE_FAILURE, limit: CLAIM_BATCH });
  for (const job of retryable) {
    if (job.retries >= env.maxProofRetries) continue;
    if (store.claimToAwaiting(job.id)) console.log(`reawakening job ${job.jobId} for another proof attempt`);
  }
}

function isTerminalProofError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('not found') ||
    m.includes('invalid transaction') ||
    m.includes('not yet mined') ||
    m.includes('dropped')
  );
}

// -----------------------------------------------------------------------------
// Phase 3 - submission. Each job is claimed atomically (proof_ready -> submitting)
// so a crash/restart hoist can never double-broadcast. The dest tx hash is
// persisted immediately after broadcast; proof of confirmation comes from
// reconciliation, and "already processed" reverts are treated as success.
// -----------------------------------------------------------------------------
async function submitProofs(
  store: Store,
  vault: Contract,
  signer: ethers.Signer,
  env: ReturnType<typeof loadEnv>
): Promise<void> {
  const ready = store.jobs({ status: JOB_STATUS.PROOF_READY, limit: CLAIM_BATCH });
  for (const job of ready) {
    if (shuttingDown) break;
    if (!job.proof) continue;
    if (!store.claimToSubmitting(job.id)) continue;

    const proof = JSON.parse(job.proof);
    try {
      const destTxHash = await broadcastProof(vault, signer, signer.provider as ethers.JsonRpcProvider, proof);
      store.setSubmittingDest(job.id, destTxHash);
      console.log(`submitted job ${job.jobId} -> CC tx ${destTxHash}`);
    } catch (err) {
      const message = shortMessage(err);
      if (isTerminalRevert(message)) {
        const alreadyOnChain = /already (used|processed)/.test(message);
        if (alreadyOnChain) {
          store.markConfirmed(job.id);
          console.log(`job ${job.jobId} was already confirmed on-chain (${message}).`);
        } else {
          store.submitFailed(job.id, message, JOB_STATUS.TERMINAL_FAILURE);
          console.error(`job ${job.jobId} terminal (submit): ${message}`);
        }
      } else if (job.retries >= env.maxSubmitRetries) {
        store.submitFailed(job.id, message, JOB_STATUS.RETRYABLE_FAILURE);
        console.error(`job ${job.jobId} parked after ${env.maxSubmitRetries} submit attempts: ${message}`);
      } else {
        store.submitFailed(job.id, message, JOB_STATUS.PROOF_READY);
        console.warn(`job ${job.jobId} resubmit later (${job.retries + 1}/${env.maxSubmitRetries}): ${message}`);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Phase 4 - reconciliation. Brings the local view in line with the chain:
//   * submitted + dest tx mined ok  => confirmed
//   * submitted + tx dropped        => back to proof_ready
//   * job id already used on vault  => confirmed (idempotent second witness)
// -----------------------------------------------------------------------------
async function reconcile(
  store: Store,
  vault: Contract,
  ccProvider: ethers.JsonRpcProvider,
  env: ReturnType<typeof loadEnv>
): Promise<void> {
  const inFlight = store.jobs({ status: JOB_STATUS.SUBMITTED, limit: CLAIM_BATCH });
  for (const job of inFlight) {
    if (shuttingDown) break;
    if (!job.destTxHash) continue;

    try {
      const receipt = await ccProvider.getTransactionReceipt(job.destTxHash);
      if (receipt) {
        if (receipt.status === 1) {
          store.markConfirmed(job.id);
          console.log(`confirmation: job ${job.jobId} mined in CC tx ${job.destTxHash}`);
        } else {
          store.resubmitJob(job.id, 'on-chain revert (failed CC transaction)', JOB_STATUS.PROOF_READY);
          console.warn(`confirmation: job ${job.jobId} reverted on-chain; resubmitting.`);
        }
        continue;
      }

      // Not mined yet: check whether it left the mempool entirely.
      const tx = await ccProvider.getTransaction(job.destTxHash);
      if (!tx) {
        if (job.retries >= env.maxSubmitRetries) {
          store.resubmitJob(job.id, 'transaction left mempool without a receipt', JOB_STATUS.RETRYABLE_FAILURE);
        } else {
          store.resubmitJob(job.id, 'transaction left mempool without a receipt', JOB_STATUS.PROOF_READY);
          console.warn(`job ${job.jobId} CC tx ${job.destTxHash} dropped; back to proof_ready.`);
        }
      } else {
        console.log(`job ${job.jobId} CC tx ${job.destTxHash} still pending in mempool.`);
      }
    } catch (err) {
      console.error(`reconcile lookup for ${job.destTxHash} failed: ${shortMessage(err)}`);
    }
  }

  // Belt-and-suspenders: if the job id is already recorded on the vault, we're done regardless of
  // our local receipt bookkeeping (e.g. a previous worker process handled it).
  const unsettled = store.jobs({
    status: [JOB_STATUS.PROOF_READY, JOB_STATUS.SUBMITTING, JOB_STATUS.RETRYABLE_FAILURE],
    limit: CLAIM_BATCH,
  });
  for (const job of unsettled) {
    try {
      const used = await (vault.usedJobIds as unknown as (jobId: string) => Promise<boolean>)(job.jobId);
      if (used) {
        store.markConfirmed(job.id);
        console.log(`job ${job.jobId} confirmed via vault.usedJobIds.`);
      }
    } catch (err) {
      console.error(`usedJobIds(${job.jobId}) call failed: ${shortMessage(err)}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('Worker crashed:', shortMessage(err));
  process.exit(1);
});