export interface WorkerEnv {
  proofBuilderUrl: string;
  sourceChainKey: number;
  sourceChainRpcUrl: string;
  creditcoinRpcUrl: string;
  privateKey: string;
  vaultAddress: string;
  marketAddress: string;
  startBlock?: number;
  pollIntervalMs: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is not configured`);
  }
  return value;
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

export function loadEnv(): WorkerEnv {
  const vaultAddress = requireEnv('COMPUTE_CRED_VAULT_CONTRACT_ADDRESS');
  const marketAddress = requireEnv('JOB_MARKET_CONTRACT_ADDRESS');
  const privateKey = requireEnv('CREDITCOIN_WALLET_PRIVATE_KEY');
  return {
    proofBuilderUrl: requireEnv('PROOF_BUILDER_URL'),
    sourceChainKey: requireEnv('SOURCE_CHAIN_KEY') ? Number(requireEnv('SOURCE_CHAIN_KEY')) : NaN,
    sourceChainRpcUrl: requireEnv('SOURCE_CHAIN_RPC_URL'),
    creditcoinRpcUrl: requireEnv('CREDITCOIN_RPC_URL'),
    privateKey,
    vaultAddress,
    marketAddress,
    startBlock: numberEnv('WORKER_START_BLOCK'),
    pollIntervalMs: numberEnv('WORKER_POLL_INTERVAL_MS', 5000) ?? 5000,
  };
}