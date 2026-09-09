import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { Contract, ethers } from 'ethers';
import { ReadStore } from './store';
import { vaultAbi } from './vaultAbi';

const REPO_ROOT = resolve(__dirname, '..', '..');

function repoResolver(): (p: string) => string {
  return (p: string) => (isAbsolute(p) ? p : resolve(REPO_ROOT, p));
}

interface ApiEnv {
  port: number;
  corsOrigin: string;
  dbPath: string;
  vaultAddress: string;
  rpcUrl: string;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

function loadEnv(): ApiEnv {
  return {
    port: numberEnv('API_PORT', 8787),
    corsOrigin: process.env.API_CORS_ORIGIN ?? '*',
    dbPath: process.env.WORKER_DB_PATH
      ? repoResolver()(process.env.WORKER_DB_PATH)
      : resolve(REPO_ROOT, 'worker-state', 'computecred.sqlite'),
    vaultAddress: process.env.COMPUTE_CRED_VAULT_CONTRACT_ADDRESS ?? ethers.ZeroAddress,
    rpcUrl: process.env.CREDITCOIN_RPC_URL ?? '',
  };
}

const env = loadEnv();
const provider = env.rpcUrl ? new ethers.JsonRpcProvider(env.rpcUrl) : null;

const big = (v: bigint | boolean | string | number | null | undefined): string | null =>
  v === null || v === undefined ? null : typeof v === 'bigint' ? v.toString() : String(v);

type Result = { ok: true; data: unknown } | { ok: false; error: string };

const send = (res: ServerResponse, status: number, body: Result): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': env.corsOrigin });
  res.end(JSON.stringify(body));
};

function withStore<T>(fn: (store: ReadStore) => T): Result {
  let store: ReadStore;
  try {
    store = new ReadStore(env.dbPath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { ok: true, data: fn(store) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    store.close();
  }
}

async function facility(operator: string): Promise<Result> {
  if (!provider || !env.vaultAddress) {
    return { ok: false, error: 'CREDITCOIN_RPC_URL / COMPUTE_CRED_VAULT_CONTRACT_ADDRESS not configured' };
  }
  try {
    const vault = new Contract(env.vaultAddress, vaultAbi, provider);
    const view = await vault.getFacilityView(operator);
    const policy = await vault.getPolicy();
    const [jobMarket, settlementAsset, loanToken, expectedSourceChainKey] = await Promise.all([
      vault.jobMarket(),
      vault.settlementAsset(),
      vault.loanToken(),
      vault.expectedSourceChainKey(),
    ]);
    return {
      ok: true,
      data: {
        operator,
        facility: {
          exists: view.exists,
          verifiedRevenue: big(view.verifiedRevenue),
          eligibleRevenue: big(view.eligibleRevenue),
          facilityLimit: big(view.facilityLimit),
          concentrationFactorBps: big(view.concentrationFactorBps),
          outstandingDebt: big(view.outstandingDebt),
          availableCapacity: big(view.availableCapacity),
          vaultLiquidity: big(view.vaultLiquidity),
          largestBuyerShareBps: big(view.largestBuyerShareBps),
          lastVerifiedAt: big(view.lastVerifiedAt),
          lifetimeVerifiedRevenue: big(view.lifetimeVerifiedRevenue),
          lifetimeRepaid: big(view.lifetimeRepaid),
          eventCount: big(view.eventCount),
        },
        policy: {
          advanceRateBps: big(policy.advanceRateBps),
          maxBuyerConcentrationBps: big(policy.maxBuyerConcentrationBps),
          operatorCap: big(policy.operatorCap),
          freshnessWindow: big(policy.freshnessWindow),
        },
        source: { jobMarket, settlementAsset, loanToken, expectedSourceChainKey: big(expectedSourceChainKey) },
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function health(): Promise<Result> {
  const db = withStore((store) => store.health());
  let chain: unknown = null;
  if (provider) {
    try {
      chain = { headHeight: await provider.getBlockNumber() };
    } catch (err) {
      chain = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return {
    ok: true,
    data: {
      db,
      chain,
      configured: { vault: env.vaultAddress, rpc: !!env.rpcUrl, cors: env.corsOrigin },
    },
  };
}

function numParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': env.corsOrigin,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    send(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  const q = url.searchParams;
  let result: Result;
  switch (url.pathname) {
    case '/health':
      result = await health();
      break;
    case '/settlements':
      result = withStore((store) =>
        store.settlements({
          operator: q.get('operator') ?? undefined,
          status: q.get('status') ?? undefined,
          cursor: numParam(q.get('cursor')),
          limit: numParam(q.get('limit')),
        })
      );
      break;
    case '/proof-status':
      result = withStore((store) => store.proofStatus({ operator: q.get('operator') ?? undefined }));
      break;
    case '/facility': {
      const operator = q.get('operator');
      if (!operator) {
        send(res, 400, { ok: false, error: 'operator query parameter is required' });
        return;
      }
      result = await facility(operator.toLowerCase());
      break;
    }
    case '/activity':
      result = withStore((store) =>
        store.recentActivity({ operator: q.get('operator') ?? undefined, limit: numParam(q.get('limit')) })
      );
      break;
    default:
      result = { ok: false, error: `no such route: ${url.pathname}` };
  }

  if (result.ok) {
    send(res, 200, result);
  } else {
    const status = /facility|operator|round/i.test(result.error) ? 400 : 404;
    send(res, result.error.includes('not configured') ? 503 : status, result);
  }
});

server.listen(env.port, () => {
  console.log(`ComputeCred API listening on http://localhost:${env.port}`);
  console.log(`  db:      ${env.dbPath}`);
  console.log(`  vault:   ${env.vaultAddress}`);
  console.log(`  rpc:     ${env.rpcUrl || '(not configured)'}`);
  console.log(`  cors:    ${env.corsOrigin}`);
});