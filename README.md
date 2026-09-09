# ComputeCred

**Proof-backed revenue financing for independent GPU operators.**

Independent GPU operators serve jobs on an Ethereum-side job marketplace where demand-side
buyers post escrowed jobs, operators bid, and a settled job pays out. ComputeCred turns that
cash flow into a **bounded, revolving credit facility on Creditcoin** — the operator can borrow
against verified revenue without showing bank statements, and lenders can underwrite against
cryptographically proven receipts instead of dashboards.

The trick is **Attestcoin**: the vault never trusts the operator's word about revenue. A worker
watches `JobSettled` payments on the source chain (Ethereum Sepolia), asks the Creditcoin **Block
Prover** to attest the block, and submits a Merkle + continuity proof to a Creditcoin
*Application Smart Contract* that decodes the receipt on-chain, rejects fakes/replays, and then
applies a fully deterministic credit policy.

```
 Ethereum Sepolia                          Creditcoin CC3 testnet
 ──────────────────                        ────────────────────────
 JobMarket
   createJob(esc)──────────┐
   payAndSettle(jobId)     │ JobSettled(jobId, operator, buyer,  │
   emits job settled       │            gross, completedAt, hash) │
                           ▼                                      │
                  ┌──────────────────┐    jobId + tx hash        ▼
                  │ ComputeCred      │ ───────────────────► ┌─────────────────────────────┐
                  │ worker           │  wait for attestation │ Vault (ASC on Creditcoin)   │
                  │  poll JobSettled │  ProofBuilder.getProof│  VERIFIER.verifyAndEmit      │
                  │  -> getProof     │  merkle + continuity  │  decode + strict validate    │
                  │  -> submit proof │  proof                │  auto-repay then credit      │
                  └──────────────────┘                       │  facilityLimit = 50% of      │
                                                             │    concentration-adjusted    │
                                                     tUSDC ◄─│    eligible revenue          │
                                                       │     │  operator draw/repay         │
                                                       │     └─────────────────────────────┘
                                           Creditcoin test-USD + CTC,
                                           LPs provide liquidity backing draws
```

Each `JobSettled` must be **cryptographically attested** before it counts as revenue. The vault
inherits `ASCBase` (the Attestcoin Smart Contract base), which calls the Block Prover precompile,
rejects replays by query id, and hands the proven transaction to a strict decoder:

| Check | Defense |
| ----- | ------- |
| transaction proven + deduped by block prover | no fabricated payment, no double-spend of a receipt |
| receipt status == 1 (success) | failed payments are not revenue |
| emitter == registered `jobMarket` | a random contract can't mint revenue |
| event signature == `JobSettled(...)` | only the settlement event is revenue |
| topic arity and 96-byte data layout | no malformed infections |
| `grossAmount > 0` | zero-amount dust can't inflate the book |
| `msg.sender == operator` (topics[2]) | you can only claim your own facility |
| `jobId` used once (`usedJobIds`) | a settled job books revenue exactly once |
| timestamp within `[now - 30d, now + 1h]` | stale/future claims are rejected |
| freshness window, pruned storage | revenue decays out of the 30-day window |

### Credit policy (deterministic, on-chain)

```
eligibleRevenue = min(sum of windowed verified revenue, operatorCap)
book            = eligibleRevenue − max(0, largestBuyer − 40% × eligibleRevenue)
facilityLimit   = 50% × book
draw            ≤ facilityLimit − outstandingDebt, and vault liquidity allows it
auto-repay      = every new settlement first pays accrued debt, then adds revenue
```

Concentration is a **haircut, not a hard floor**: the share of the largest buyer above 40% of the
eligible base is simply not financed. A single-client operator still books revenue (and can draw
20% of it immediately), and as they diversify their line grows to the full 50%.

| Revenue mix (30d) | eligible | book | limit |
| ----------------- | -------- | ---- | ----- |
| one buyer, 400k | 400k | 160k | **80k** |
| 600k / 400k | 1.0M | 800k | **400k** |
| 400k / 300k / 300k | 1.0M | 1.0M | **500k** |

## Repository structure

```
ComputeCred/
├── .github/
│   └── workflows/
│       ├── ci.yml                 # CI: install → compile → typecheck → tests → build → demo
│       └── release.yml            # CD: tag v* → verify → build bundle → GitHub Release
├── contracts/                     # Hardhat workspace (Solidity 0.8.30, evm shanghai, viaIR)
│   ├── contracts/
│   │   ├── ComputeCredVault.sol   # the ASC + deterministic credit policy (core)
│   │   ├── JobMarket.sol          # Sepolia source of JobSettled payments
│   │   ├── TestUSDC.sol           # CC3 test-USD liquidity token (6 decimals)
│   │   └── harness/
│   │       ├── ComputeCredVaultHarness.sol   # bypasses the Block-Prover precompile in tests
│   │       └── TxEncoder.sol                  # builds encoded receipts for the decoder path
│   ├── test/
│   │   └── vault.test.ts          # 25-test credit-policy + validation suite
│   ├── hardhat.config.ts
│   └── package.json
├── worker/                        # Attestcoin proof worker (TypeScript, tsx)
│   └── src/
│       ├── index.ts               # streaming poller: JobSettled → proof → verifyAndRegister
│       ├── proof.ts               # ProofBuilder wrapper + execute encoding + submission
│       ├── abis.ts                # typed ABIs (vault / market / verifier)
│       ├── env.ts                 # typed .env loader
│       ├── prove-single.ts        # one-shot CLI for a single tx
│       └── core.test.ts           # topic0 / decode / execute-encoding tests
├── web/                           # Vite + React dashboard
│   ├── src/
│   │   ├── App.tsx                # facility view, buyer concentration, draw/repay UI
│   │   ├── lib/vault.ts           # ethers v6 vault integration
│   │   ├── main.tsx
│   │   ├── style.css
│   │   └── vite-env.d.ts
│   ├── vite.config.ts
│   ├── index.html
│   └── package.json
├── scripts/
│   ├── demo.mjs                   # one-command demo: test suite + credit-policy tour
│   └── build-report.mjs           # release artifact manifest
├── docs/
│   ├── ATTESTCOIN_INTEGRATION.md  # proof pipeline, event layout, env, SDK wiring
│   └── THREAT_MODEL.md            # attack surface + defense mapping
├── .env.example                   # chain/contract/secrets template (copy to .env)
├── .gitignore
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE                        # MIT
├── SECURITY.md
└── package.json                   # npm workspaces + orchestration scripts
```

## Run it

```bash
npm install              # installs workspaces; `prepare` compiles contracts for you
npm run demo             # runs the full contract test suite + prints the credit policy tour
npm run contracts:test   # the 25-policy test suite (local EVM; no chain needed)
npm run web:dev          # dashboard (fill vault/operator addresses in the UI or .env)
```

The full proof pipeline needs live chains (Attestcoin's Block Prover only exists on CC3):

1. Copy `.env.example` → `.env`, set `CREDITCOIN_WALLET_PRIVATE_KEY` (a faucet Seed Swap wallet on
   CC3 testnet and Sepolia funded with test ETH).
2. Deploy `JobMarket` on Sepolia, `TestUSDC` + `ComputeCredVault` on CC3, register the source
   contract, open a facility, provide tUSDC liquidity.
3. Create jobs, settle them, then run `npm run worker:start` — it polls `JobSettled`, waits for
   attestation, and calls `verifyAndRegister` on the vault.
4. Watch revenue book and draw against it via the dashboard.

See `docs/ATTESTCOIN_INTEGRATION.md` for the exact proof/submission wiring and
`docs/THREAT_MODEL.md` for the security analysis.

## Tooling

- Solidity 0.8.28 / Hardhat (solc 0.8.30, evmVersion shanghai, viaIR) — the low-level EVM proofs
  need precise ABI layout control, so we test against the real bytecode instead of a fork.
- `@gluwa/usc-sdk` `ProofBuilder` + `@gluwa/asc-contracts` (`ASCBase`, `EvmV1Decoder`,
  `INativeQueryVerifier`) — the official Attestcoin building blocks.
- `EventLog` layout pinned by the on-chain `JOB_SETTLED_EVENT_SIGNATURE` constant
  (`keccak256("JobSettled(bytes32,address,address,uint128,uint64,bytes32)")`).

## Test coverage

`contracts/test/vault.test.ts` exercises the vault bytecode directly through a harness (the Block
Prover precompile doesn't exist on Hardhat, so the proof call happens through the precompile
boundary — see the "production bytecode" describe block): happy-path credit math, auto-repay,
replay guards, source-binding, receipt/event decoding failures, freshness/staleness, the
concentration haircut, draw/repay limits, the operator cap, and access control — 25 tests, all
passing.

## CI/CD

- **CI** (`.github/workflows/ci.yml`) runs on every push/PR to `main`: `npm ci` → compile
  contracts → typecheck all workspaces → contract tests → worker tests → web build → demo.
  It is the same gate documented in `CONTRIBUTING.md`.
- **CD** (`.github/workflows/release.yml`) runs on `v*` tags: full verification, then creates a
  GitHub Release with the built web dashboard bundle and a build report. Contract deployment to
  CC3 remains a manual, key-gated step.

## Community

- [Contributing](CONTRIBUTING.md) — ground rules, setup, commit style, PR process.
- [Security](SECURITY.md) — how to report vulnerabilities privately.
- [Code of Conduct](CODE_OF_CONDUCT.md) — expected behavior in this project.
- [License](LICENSE) — MIT, © 2026 Mobolaji Opeyemi Bolatito.