export interface WorkerEnv {
  proofBuilderUrl: string;
  sourceChainKey: number;
  sourceChainRpcUrl: string;
  creditcoinRpcUrl: string;
  privateKey: string;
  /** Optional separate key that signs and broadcasts proofs. Defaults to `privateKey`. */
  submitterPrivateKey?: string;
  /** Optional override of the operator address (the facility owner). Defaults to the address of
   * `privateKey`. Set this when the operator wallet differs from the signing wallet. */
  operatorAddress?: string;
  vaultAddress: string;
  marketAddress: string;
  startBlock?: number;
  pollIntervalMs: number;
  maxProofRetries: number;
  maxSubmitRetries: number;
  confirmations: number;
  dbPath: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not configured`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function numberEnv(name: string, fallback?: number): number | undefined {
  const value = process.env[name];
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return n;
}

function positiveNumberEnv(name: string, fallback: number): number {
  const n = numberEnv(name, fallback) ?? fallback;
  if (n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadEnv(): WorkerEnv {
  const vaultAddress = requireEnv('COMPUTE_CRED_VAULT_CONTRACT_ADDRESS');
  const marketAddress = requireEnv('JOB_MARKET_CONTRACT_ADDRESS');
  const privateKey = requireEnv('CREDITCOIN_WALLET_PRIVATE_KEY');
  return {
    proofBuilderUrl: requireEnv('PROOF_BUILDER_URL'),
    sourceChainKey: Number(requireEnv('SOURCE_CHAIN_KEY')),
    sourceChainRpcUrl: requireEnv('SOURCE_CHAIN_RPC_URL'),
    creditcoinRpcUrl: requireEnv('CREDITCOIN_RPC_URL'),
    privateKey,
    submitterPrivateKey: optionalEnv('WORKER_SUBMITTER_PRIVATE_KEY'),
    operatorAddress: optionalEnv('WORKER_OPERATOR_ADDRESS'),
    vaultAddress,
    marketAddress,
    startBlock: numberEnv('WORKER_START_BLOCK'),
    pollIntervalMs: numberEnv('WORKER_POLL_INTERVAL_MS', 5000) ?? 5000,
    maxProofRetries: positiveNumberEnv('WORKER_MAX_PROOF_RETRIES', 4),
    maxSubmitRetries: positiveNumberEnv('WORKER_MAX_SUBMIT_RETRIES', 3),
    confirmations: numberEnv('WORKER_CONFIRMATIONS', 1) ?? 1,
    dbPath: optionalEnv('WORKER_DB_PATH') ?? 'worker-state/computecred.sqlite',
  };
}