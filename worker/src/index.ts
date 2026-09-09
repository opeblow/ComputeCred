import { Contract, ethers, Wallet, EventLog } from 'ethers';
import { vaultAbi, marketAbi } from './abis';
import { loadEnv } from './env';
import { generateProofFor, submitSettlementProof, shortMessage } from './proof';

const MAX_LOG_BLOCK_RANGE = 50; // sepolia public RPCs cap eth_getLogs range
const MAX_PROCESSED_TXS = 1000;

let shuttingDown = false;
process.on('SIGINT', () => {
  shuttingDown = true;
});
process.on('SIGTERM', () => {
  shuttingDown = true;
});

type UsedJobIdsGetter = (jobId: string) => Promise<boolean>;

const main = async () => {
  const env = loadEnv();

  if (!env.sourceChainKey) {
    throw new Error('SOURCE_CHAIN_KEY not set');
  }
  if (!env.privateKey.startsWith('0x') || env.privateKey.length !== 66) {
    throw new Error('CREDITCOIN_WALLET_PRIVATE_KEY is invalid');
  }

  const ccProvider = new ethers.JsonRpcProvider(env.creditcoinRpcUrl);
  const wallet = new Wallet(env.privateKey, ccProvider);
  const vault = new Contract(env.vaultAddress, vaultAbi, wallet);
  const usedJobIds = vault.usedJobIds as unknown as UsedJobIdsGetter;

  const sourceProvider = new ethers.JsonRpcProvider(env.sourceChainRpcUrl);
  const market = new Contract(env.marketAddress, marketAbi, sourceProvider);

  console.log(`Wallet: ${wallet.address}`);
  console.log(`Vault: ${env.vaultAddress}`);
  console.log(`Market: ${env.marketAddress}`);
  console.log(`Proof builder: ${env.proofBuilderUrl}`);

  const currentSourceBlock = await sourceProvider.getBlockNumber();
  let fromBlock = env.startBlock ?? currentSourceBlock;
  if (fromBlock < currentSourceBlock) {
    console.log(`Backfilling JobSettled events from block ${fromBlock}`);
  } else {
    fromBlock = currentSourceBlock;
  }

  const processedTxs = new Set<string>();

  while (!shuttingDown) {
    const newFrom = await pollSettlements(
      market, vault, usedJobIds, wallet, sourceProvider, ccProvider, env, fromBlock, processedTxs
    );
    fromBlock = newFrom;
    if (processedTxs.size > MAX_PROCESSED_TXS) {
      console.log(`Clearing processed tx cache (${processedTxs.size} entries)`);
      processedTxs.clear();
    }
    await sleep(env.pollIntervalMs);
  }

  sourceProvider.destroy();
  ccProvider.destroy();
  console.log('Worker stopped.');
};

async function pollSettlements(
  market: Contract,
  vault: Contract,
  usedJobIds: UsedJobIdsGetter,
  wallet: Wallet,
  sourceProvider: ethers.JsonRpcProvider,
  ccProvider: ethers.JsonRpcProvider,
  env: ReturnType<typeof loadEnv>,
  fromBlock: number,
  processedTxs: Set<string>
): Promise<number> {
  const currentBlock = await market.runner?.provider?.getBlockNumber();
  if (!currentBlock || currentBlock < fromBlock) return fromBlock;

  let start = fromBlock;
  let chunkSize = MAX_LOG_BLOCK_RANGE;
  while (start <= currentBlock) {
    const end = Math.min(start + chunkSize - 1, currentBlock);
    try {
      const events = await market.queryFilter('JobSettled', start, end);
      for (const event of events) {
        if (event instanceof EventLog) {
          await handleSettlement(market, vault, usedJobIds, wallet, sourceProvider, ccProvider, env, event, processedTxs);
        }
      }
      start = end + 1;
      chunkSize = MAX_LOG_BLOCK_RANGE;
    } catch (err) {
      console.error(`Error polling JobSettled (blocks ${start}-${end}): ${shortMessage(err)}`);
      if (chunkSize > 1) {
        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
        await sleep(10_000);
      } else {
        start = end + 1;
        chunkSize = MAX_LOG_BLOCK_RANGE;
        await sleep(10_000);
      }
    }
  }
  return currentBlock + 1;
}

async function handleSettlement(
  market: Contract,
  vault: Contract,
  usedJobIds: UsedJobIdsGetter,
  wallet: Wallet,
  sourceProvider: ethers.JsonRpcProvider,
  ccProvider: ethers.JsonRpcProvider,
  env: ReturnType<typeof loadEnv>,
  event: EventLog,
  processedTxs: Set<string>
): Promise<void> {
  const txHash = event.transactionHash;
  if (processedTxs.has(txHash)) return;

  const [jobId, operator, buyer, grossAmount] = event.args as unknown as [string, string, string, bigint];

  console.log(`JobSettled jobId=${jobId} operator=${operator} buyer=${buyer} gross=${grossAmount} tx=${txHash}`);

  // Each Creditcoin wallet is the operator for its own facility.
  if (operator.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log(`Operator ${operator} is not our wallet; skipping.`);
    processedTxs.add(txHash);
    return;
  }

  // On-chain dedup: the vault marks every proven job id as used. If it answers true, someone
  // (us, or a previous run) already proved this settlement.
  let used = false;
  try {
    used = await usedJobIds(jobId);
  } catch (err) {
    console.error(`usedJobIds(${jobId}) call failed: ${shortMessage(err)}`);
  }
  if (used) {
    console.log(`Job ${jobId} already registered on the vault; skipping.`);
    processedTxs.add(txHash);
    return;
  }

  try {
    const proof = await generateProofFor(txHash, env.sourceChainKey, env.proofBuilderUrl, sourceProvider);

    if (await usedJobIds(jobId)) {
      console.log(`Job ${jobId} was registered while we proved it; skipping.`);
      processedTxs.add(txHash);
      return;
    }

    const resp = await submitSettlementProof(vault, wallet, ccProvider, proof);
    console.log(`Registered settlement for job ${jobId}, tx ${resp}`);
    processedTxs.add(txHash);
  } catch (err) {
    const message = shortMessage(err);
    if (message.includes('job already used') || message.includes('Query already processed')) {
      console.log(`Job ${jobId} already processed (${message}); skipping.`);
      processedTxs.add(txHash);
      return;
    }
    console.error(`Failed to register settlement for job ${jobId} (${txHash}): ${message}`);
    // Proof submission failed for a reason other than an ended state; requeue it. We do not add
    // to processedTxs so the next poll retries, matching the event's replay-on-revert behavior.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('Worker crashed:', shortMessage(err));
  process.exit(1);
});