import { Contract, ethers, Wallet, LogDescription } from 'ethers';
import { vaultAbi, marketAbi } from './abis';
import { loadEnv } from './env';
import { generateProofFor, broadcastProof, shortMessage, JOB_SETTLED_TOPIC0 } from './proof';

/**
 * One-shot: given a source-chain JobSettled tx hash, generate the Attestcoin proof and register
 * the settlement on the vault. Intended for the demo flow and for replaying a missed event.
 *
 *   npm run prove-one --w worker -- --tx <txHash>
 *
 * The tx must settle a job whose operator equals CREDITCOIN_WALLET_PRIVATE_KEY's wallet.
 */
const main = async () => {
  const argIndex = process.argv.indexOf('--tx');
  const txHashArg = argIndex !== -1 ? process.argv[argIndex + 1] : process.argv[2];
  if (!txHashArg?.match(/^0x[0-9a-fA-F]{64}$/)) {
    throw new Error('usage: npm run prove-one --w worker -- --tx <0x-transaction-hash>');
  }

  const env = loadEnv();
  const ccProvider = new ethers.JsonRpcProvider(env.creditcoinRpcUrl);
  const wallet = new Wallet(env.privateKey, ccProvider);
  const vault = new Contract(env.vaultAddress, vaultAbi, wallet);

  const sourceProvider = new ethers.JsonRpcProvider(env.sourceChainRpcUrl);
  const market = new Contract(env.marketAddress, marketAbi, sourceProvider);

  const receipt = await sourceProvider.getTransactionReceipt(txHashArg);
  if (!receipt) throw new Error(`No receipt found for ${txHashArg}`);

  const logs = receipt.logs
    .map((log) => {
      try {
        return market.interface.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        return null;
      }
    })
    .filter((p): p is LogDescription => p !== null && p.name === 'JobSettled');

  if (logs.length !== 1) {
    throw new Error(`Expected exactly one JobSettled event in ${txHashArg}, found ${logs.length}`);
  }

  const [jobId, operator, buyer, grossAmount] = logs[0]!.args as unknown as [string, string, string, bigint];
  console.log(`JobSettled jobId=${jobId} operator=${operator} buyer=${buyer} gross=${grossAmount}`);
  if (operator.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `Settlement operator ${operator} is not our wallet ${wallet.address}; cannot register it.`
    );
  }
  console.log(`Topic0 check: ${logs[0]!.fragment.topicHash.toLowerCase() === JOB_SETTLED_TOPIC0 ? 'match' : 'MISMATCH'}`);

  const usedJobIds = vault.usedJobIds as unknown as (jobId: string) => Promise<boolean>;
  if (await usedJobIds(jobId)) {
    console.log(`Job ${jobId} already registered on the vault; nothing to do.`);
    return;
  }

  const proof = await generateProofFor(txHashArg, env.sourceChainKey, env.proofBuilderUrl, sourceProvider);
  const destTxHash = await broadcastProof(vault, wallet, ccProvider, proof);
  const destReceipt = await ccProvider.waitForTransaction(destTxHash, 1, 180_000);
  if (!destReceipt || destReceipt.status !== 1) {
    throw new Error(`Proof transaction ${destTxHash} did not confirm on Creditcoin`);
  }
  console.log(`Registered settlement for job ${jobId}: ${destTxHash}`);
};

main().catch((err) => {
  console.error(shortMessage(err));
  process.exit(1);
});