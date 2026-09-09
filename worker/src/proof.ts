import { Contract, ethers } from 'ethers';
import { proofProvider } from '@gluwa/usc-sdk';

export const JOB_SETTLED_TOPIC0 =
  '0x576d20c6973b5fc107e0f23c395df0170eaed2b08ca42f1192b69c63c0533e92';

/**
 * Waits for a source tx to be mined, waits until its block is attested on Creditcoin and cached
 * by the proof builder, then fetches the Merkle + continuity proof for it.
 *
 * Attestation on CC3 testnet typically takes a few minutes; this waits up to 20 minutes.
 */
export async function generateProofFor(
  txHash: string,
  chainKey: number,
  proofBuilderUrl: string,
  sourceChainProvider: ethers.JsonRpcProvider
): Promise<proofProvider.ContinuityResponse> {
  console.log(`Waiting for ${txHash} to be mined on source chain...`);
  const receipt = await sourceChainProvider.waitForTransaction(txHash, 1, 120_000);
  if (!receipt || receipt.blockNumber == null) {
    throw new Error(`Transaction ${txHash} is not yet mined on source chain`);
  }
  const blockNumber = receipt.blockNumber;
  console.log(`Transaction ${txHash} mined in source block ${blockNumber}`);

  const proofBuilder = new proofProvider.service.ProofBuilder(chainKey, proofBuilderUrl);
  console.log(`Waiting for source block ${blockNumber} to be attested on Creditcoin...`);
  await proofBuilder.waitUntilHeightAttested(chainKey, blockNumber, 15_000, 1_200_000);

  console.log(`Source block ${blockNumber} attested. Generating proof...`);
  const result = await proofBuilder.getProof(txHash);
  if (!result.success || !result.data) {
    throw new Error(`Proof generation failed: ${result.error ?? 'unknown error'}`);
  }
  return result.data;
}

/**
 * Submits a proof to the vault via `verifyAndRegister` — the production, chain-key-guarded
 * path that preserves `msg.sender` (operator or authorized relayer). Returns the transaction
 * response hash so the caller can wait for it to mine.
 */
export function buildVerifyData(vault: Contract, proof: proofProvider.ContinuityResponse): string {
  const fragment = vault.interface.getFunction(
    'verifyAndRegister(uint64,uint64,bytes,bytes32,tuple(bytes32,bool)[],bytes32,bytes32[])'
  );
  if (!fragment) throw new Error('vault interface has no verifyAndRegister function');
  return vault.interface.encodeFunctionData(fragment, [
    proof.chainKey,
    proof.headerNumber,
    proof.txBytes,
    proof.merkleProof.root,
    proof.merkleProof.siblings,
    proof.continuityProof.lowerEndpointDigest,
    proof.continuityProof.roots,
  ]);
}

async function estimateGas(
  creditcoinProvider: ethers.JsonRpcProvider,
  vaultAddress: string,
  data: string,
  from: string,
  continuityBlocks: number
): Promise<bigint> {
  const BUFFER_PCT = 135n; // 100% + 35% buffer
  try {
    const gas = await creditcoinProvider.estimateGas({ to: vaultAddress, data, from });
    const buffered = (gas * BUFFER_PCT) / 100n;
    console.log(`Estimated gas ${gas}, using ${buffered} (with 35% buffer)`);
    return buffered;
  } catch (error: unknown) {
    // pallet-evm estimateGas does not always propagate revert reasons inside precompiles; fall
    // back to a proof-size heuristic (matching the gluwa reference examples).
    const calculated = 21000n + BigInt(continuityBlocks) * 5000n + 3000n;
    const err = shortMessage(error);
    console.warn(`Gas estimation failed (${err}); using heuristic ${calculated}`);
    return calculated;
  }
}

/**
 * Broadcasts settlement calldata (via `verifyAndRegister`) and returns the tx hash WITHOUT
 * waiting for a block. The caller persists the hash before confirmation so a crash mid-flight is
 * recovered by reconciliation; the vault's one-time job/query guards make an at-least-once final
 * outcome idempotent (a duplicate lands as "already processed").
 */
export async function broadcastProof(
  vault: Contract,
  signer: ethers.Signer,
  creditcoinProvider: ethers.JsonRpcProvider,
  proof: proofProvider.ContinuityResponse
): Promise<string> {
  const data = buildVerifyData(vault, proof);
  const continuityBlocks = proof.continuityProof.roots?.length || 1;
  const from = await signer.getAddress();
  const gasLimit = await estimateGas(creditcoinProvider, String(vault.target), data, from, continuityBlocks);

  console.log(`Broadcasting RegisterSettlement proof for tx ${proof.txHash}...`);
  const tx = await signer.sendTransaction({ to: String(vault.target), data, gasLimit });
  console.log(`Broadcast sent: ${tx.hash} (now confirmed by reconcile)`);
  return tx.hash;
}

/** Revert reasons that mean "this work is already done or can never complete" — retrying them is
 * pointless and would burn gas forever. Everything else is a transient/retryable failure. */
export function isTerminalRevert(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('already used') ||
    m.includes('already processed') ||
    m.includes('wrong source chain') ||
    m.includes('source contract not registered') ||
    m.includes('wrong source contract') ||
    m.includes('unsupported tx type') ||
    m.includes('jobsettled')
  );
}

export function shortMessage(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return e?.shortMessage ?? e?.message ?? String(err);
}