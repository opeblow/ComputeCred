import { Contract, ethers, Wallet } from 'ethers';
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
 * Submits a proof to the vault via ASCBase.execute(action=0 RegisterSettlement). Returns the
 * transaction response so the caller can wait for it.
 */
export function buildExecuteData(vault: Contract, proof: proofProvider.ContinuityResponse): string {
  const fragment = vault.interface.getFunction(
    'execute(uint8,uint64,uint64,bytes,bytes32,tuple(bytes32,bool)[],bytes32,bytes32[])'
  );
  if (!fragment) throw new Error('vault interface has no execute function');
  return vault.interface.encodeFunctionData(fragment, [
    0, // VaultAction.RegisterSettlement
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
 * Submits a settlement proof to the vault and waits for it to mine. Reverts are surfaced with
 * their short message so the polling loop can decide whether to requeue or drop the event.
 */
export async function submitSettlementProof(
  vault: Contract,
  wallet: Wallet,
  creditcoinProvider: ethers.JsonRpcProvider,
  proof: proofProvider.ContinuityResponse
): Promise<string> {
  const data = buildExecuteData(vault, proof);
  const continuityBlocks = proof.continuityProof.roots?.length || 1;
  const gasLimit = await estimateGas(creditcoinProvider, String(vault.target), data, wallet.address, continuityBlocks);

  console.log(`Submitting RegisterSettlement proof for tx ${proof.txHash}...`);
  const tx = await wallet.sendTransaction({ to: String(vault.target), data, gasLimit });
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error(`Transaction ${tx.hash} was dropped`);
  const parsed = receipt.logs
    .map((log) => {
      try {
        return vault.interface.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === 'SettlementVerified');
  if (parsed) {
    const [operator, jobId, buyer, gross] = parsed.args as unknown as [string, string, string, bigint];
    console.log(`SettlementVerified operator=${operator} jobId=${jobId} buyer=${buyer} gross=${gross}`);
  }
  return tx.hash;
}

export function shortMessage(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return e?.shortMessage ?? e?.message ?? String(err);
}