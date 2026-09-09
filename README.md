# ComputeCred

**Proof-backed revenue financing for independent GPU operators.**

Independent GPU operators serve jobs on an Ethereum-side job marketplace where demand-side
buyers post escrowed jobs, operators bid, and a settled job pays out. ComputeCred turns that
cash flow into a **bounded, revolving credit facility on Creditcoin** — the operator can borrow
against verified revenue without showing bank statements, and lenders can underwrite against
cryptographically proven receipts instead of dashboards.

The trick is **Attestcoin**: the vault never trusts the operator's word about revenue. A durable
worker watches `JobSettled` payments on the source chain (Ethereum Sepolia), asks the Creditcoin
**Block Prover** to attest the block, and submits a Merkle + continuity proof to a Creditcoin
*Application Smart Contract* that decodes the receipt on-chain, rejects fakes/replays, and then
applies a fully deterministic credit policy.

```
 Ethereum Sepolia                          Creditcoin CC3 testnet
 ──────────────────                        ────────────────────────
 JobMarket (ERC-20 escrow)
   createJob()──────────────┐
   payAndSettle(jobId)      │ JobSettled(jobId, operator, buyer,  │
   buyer pays settlement  tx│            gross, completedAt, hash) │
   token; escrow pays       │                                      │
   the operator on settle   ▼                                      │
                  ┌───────────────────┐    jobId + tx hash         ▼
                  │ ComputeCred       │ ───────────────────► ┌──────────────────────────┐
                  │ worker (durable)  │  wait for attestation │ Vault (ASC on Creditcoin)│
                  │  sqlite jobs +    │  BlockProver.getProof │  VERIFIER.verifyAndEmit  │
                  │  checkpoint       │  merkle + continuity  │  decode + strict validate│
                  │  -> buildProof    │                       │  -> credit revenue only  │
                  │  -> verifyAndReg- │                       │  facilityLimit drawn     │
                  │     ister         │                       │  from tUSDC liquidity   │
                  └───────────────────┘                       │  operator draw/repay     │
                                                              └──────────────────────────┘
```

Each `JobSettled` must be **cryptographically attested** before it counts as revenue. The vault
inherits `ASCBase` (the Attestcoin Smart Contract base), which calls the Block Prover precompile,
rejects replays by query id, and hands the proven transaction to a strict decoder:

| Check | Defense |
| ----- | ------- |
| transaction proven + deduped by block prover | no fabricated payment, no double-spend of a receipt |
| receipt status == 1 (success) | failed payments are not revenue |
| emitter == registered `jobMarket` + `settlementAsset` | a random contract can't mint revenue |
| event signature == `JobSettled(...)` | only the settlement event is revenue |
| topic arity and 96-byte data layout | no malformed infections |
| `grossAmount > 0` | zero-amount dust can't inflate the book |
| `msg.sender == operator` (or an authorized relayer for that operator) | you can only claim your own facility |
| `jobId` used once (`usedJobIds`) | a settled job books revenue exactly once |
| timestamp within `[now - freshnessWindow, now + 1h]` | stale/future claims are rejected |
| source chain key matches `expectedSourceChainKey` | proofs from the wrong chain are refused |
| freshness window, pruned event storage | revenue decays out of the window |

### Credit policy (deterministic, on-chain)

```
eligible      = min(sum of windowed verified revenue, operatorCap)
largest       = largest single-buyer windowed amount, capped to `eligible`
excess        = max(0, largest − maxBuyerConcentration% × eligible)
facilityLimit = advanceRate × (eligible − excess)
draw          ≤ facilityLimit − outstandingDebt, and vault liquidity allows it
```

Verified revenue **is credit, never repayment**. The vault never receives source-chain proceeds, so
`outstandingDebt` decreases only through `repay()` — an actual transfer of loan tokens (tUSDC) into
the vault. A settlement books `lifetimeVerifiedRevenue` and grows the eligible base; it does not
touch debt. The read-layer API + dashboard keep both numbers explicit instead of shoehorning
receipts into a repayment.

Concentration is a **haircut, not a hard floor**: the share of the largest buyer above the
concentration limit (e.g. 40%) of the eligible base is simply not financed. A single-client
operator still books revenue (and can draw the advance rate on the post-haircut book immediately),
and as they diversify their line grows to the full advance rate.

| Revenue mix (30d) | eligible | haircut on largest | book | limit @ 50% |
| ----------------- | -------- | ------------------ | ---- | ----------- |
| one buyer, 400k | 400k | 240k | 160k | **80k** |
| 600k / 400k | 1.0M | 200k | 800k | **400k** |
| 400k / 300k / 300k | 1.0M | 0 | 1.0M | **500k** |

## Repository structure

```
ComputeCred/
├── .github/workflows/
│   ├── ci.yml                 # CI: install → compile → typecheck → tests → build → demo
│   └── release.yml            # CD: tag v* → verify → build bundle → GitHub Release
├── contracts/                 # Hardhat workspace (Solidity 0.8.x, evm shanghai, viaIR)
│   ├── contracts/
│   │   ├── ComputeCredVault.sol   # ASC + deterministic credit policy (core; the financial engine)
│   │   ├── JobMarket.sol          # Sepolia marketplace settling in an ERC-20 settlement token
│   │   ├── TestUSDC.sol           # CC3 test-USD loan token (6 decimals)
│   │   ├── mocks/MockERC20.sol    # configurable-decimals settlement token for tests
│   │   └── harness/               # precompile bypass harness + receipt encoder for local tests
│   ├── test/vault.test.ts         # 39-test credit-policy + validation suite
│   ├── hardhat.config.ts
│   └── package.json
├── worker/                    # Durable Attestcoin proof worker (TypeScript, tsx)
│   └── src/
│       ├── store.ts           # node:sqlite jobs + checkpoint; CAS transitions; restart-safe
│       ├── index.ts           # scanSettlements → buildProofs → submitProofs → reconcile loop
│       ├── proof.ts           # ProofBuilder wrapper + buildVerifyData + broadcastProof
│       ├── prove-single.ts    # one-shot CLI for a single tx
│       ├── env.ts             # typed .env loader (submitter/operator split, retries, db path)
│       └── *.test.ts          # 9 tests: encoding, terminal-revert classification, store semantics
├── api/                       # Read-only REST layer over the worker sqlite store
│   └── src/
│       ├── store.ts           # ReadStore: paginated settlements, proof status, activity
│       ├── vaultAbi.ts        # minimal vault ABI for /facility + verified events
│       ├── server.ts          # node:http: /health /settlements /proof-status /facility /activity
│       └── query.test.ts      # 3 tests against a temp sqlite db
├── web/                       # Vite + React premium dashboard (react-router + react-query)
│   ├── src/
│   │   ├── app/               # AppShell (sidebar/topbar) + Overview/Facility/Settlements/
│   │   │                      #   Buyers/Activity/Settings pages
│   │   ├── components/        # EvidenceDrawer (verification-state steps), TransactionSteps, ui/
│   │   ├── hooks/             # useWallet, useFacility (react-query), useSendSequence, useConfig
│   │   ├── lib/               # vault (ethers v6), api client, token helpers, format, validate
│   │   └── styles/            # design tokens + globals (classic light, WCAG AA)
│   ├── vite.config.ts
│   ├── index.html
│   └── package.json
├── scripts/
│   ├── demo.mjs               # one-command demo: test suite + credit-policy tour
│   └── build-report.mjs       # release artifact manifest
├── docs/
│   ├── ATTESTCOIN_INTEGRATION.md  # proof pipeline, event layout, env, SDK wiring
│   └── THREAT_MODEL.md            # attack surface + defense mapping
├── .env.example               # chain/contract/secrets template (copy to .env)
├── .gitignore
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE                    # MIT
├── SECURITY.md
└── package.json               # npm workspaces + orchestration scripts
```

## Run it

```bash
npm install              # installs workspaces; `prepare` compiles contracts for you
npm run demo             # runs the full contract test suite + prints the credit policy tour
npm run contracts:test   # 39-test suite (local EVM; no chain needed)
npm run worker:test      # worker tests: proof encoding + durable store semantics
npm run api:test         # read-layer API tests
npm run api:start        # start the read-layer API (serves the dashboard)
npm run web:dev          # dashboard (fill vault/operator addresses in the UI or .env)
```

The full proof pipeline needs live chains (Attestcoin's Block Prover only exists on CC3):

1. Copy `.env.example` → `.env`, set `CREDITCOIN_WALLET_PRIVATE_KEY` (a faucet Seed Swap wallet on
   CC3 testnet and Sepolia funded with test ETH), contract addresses, and optionally a scoped
   `WORKER_SUBMITTER_PRIVATE_KEY` + `WORKER_OPERATOR_ADDRESS`.
2. Deploy `JobMarket` (with its settlement token) on Sepolia, `TestUSDC` + `ComputeCredVault` on
   CC3, register the source contract + settlement asset, open the facility, and provide tUSDC
   liquidity.
3. Create jobs, settle them, then run `npm run worker:start` — it polls `JobSettled`, waits for
   attestation, submits `verifyAndRegister`, and confirms on-chain. State is durable in the sqlite
   store (`WORKER_DB_PATH`), so restarts resume instead of re-proving.
4. Run `npm run api:start` and open the dashboard (`npm run web:dev`) to see the proof pipeline,
   buyer concentration, and to draw/repay against verified capacity.

See `docs/ATTESTCOIN_INTEGRATION.md` for the exact proof/submission wiring and
`docs/THREAT_MODEL.md` for the security analysis.

## Tooling

- Solidity / Hardhat (solc, evmVersion shanghai, viaIR) — the low-level EVM proofs need precise
  ABI layout control, so we test against the real bytecode instead of a fork.
- `@gluwa/usc-sdk` `ProofBuilder` + `@gluwa/asc-contracts` (`ASCBase`, `EvmV1Decoder`,
  `INativeQueryVerifier`) — the official Attestcoin building blocks.
- `EventLog` layout pinned by the on-chain `JOB_SETTLED_EVENT_SIGNATURE` constant
  (`keccak256("JobSettled(bytes32,address,address,uint128,uint64,bytes32)")`).
- Worker persistence via Node's built-in `node:sqlite` (Node 22+/24); vault reads via ethers v6.
- Web: React 18 + react-router-dom + @tanstack/react-query + motion, zero CSS framework (design
  tokens + component styles in `web/src/styles/`).

## Test coverage

- `contracts/test/vault.test.ts` exercises the vault bytecode through a harness (the Block Prover
  precompile doesn't exist on Hardhat): happy-path credit math, revenue-recognition (no fictional
  repayment), replay guards, source/asset binding, receipt/event decoding failures,
  freshness/staleness, concentration haircut, cap×concentration composition, draw/repay/limit
  invariants, and access control — **39 tests, all passing**.
- `worker/src/core.test.ts` + `store.test.ts` — proof data encoding, terminal-revert
  classification (vs. retryable), restart durability, CAS state transitions, dedupe, checkpoint
  advance — **9 tests, all passing**.
- `api/src/query.test.ts` — pagination, cursor stability, proof-status rollups, activity
  ordering against a temp sqlite database — **3 tests, all passing**.

## CI/CD

- **CI** (`.github/workflows/ci.yml`) runs on every push/PR to `main`: `npm ci` → compile
  contracts → typecheck all workspaces → contract tests → worker tests → api tests → web build →
  demo. It is the same gate documented in `CONTRIBUTING.md`.
- **CD** (`.github/workflows/release.yml`) runs on `v*` tags: full verification, then creates a
  GitHub Release with the built web dashboard bundle and a build report. Contract deployment to
  CC3 remains a manual, key-gated step.

## Community

- [Contributing](CONTRIBUTING.md) — ground rules, setup, commit style, PR process.
- [Security](SECURITY.md) — how to report vulnerabilities privately.
- [Code of Conduct](CODE_OF_CONDUCT.md) — expected behavior in this project.
- [License](LICENSE) — MIT, © 2026 Mobolaji Opeyemi Bolatito.