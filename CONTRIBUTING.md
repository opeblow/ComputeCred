# Contributing to ComputeCred

Thanks for taking the time to contribute. ComputeCred is a proof-backed revenue
financing system on Creditcoin — the reference logic lives in Solidity and gets
attested by real ELF/NativeQueryVerifier precompile calls, so the bar for
"looks right" is deliberately high.

## Code of conduct

By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ground rules

1. **Never weaken the proof path.** Every revenue-increasing path must be gated
   behind the attested `JobSettled` receipt and the strict decode guards in
   `ComputeCredVault._extractSettlement`. Anything that skips the Block Prover
   round-trip is a vulnerability, not an optimization.
2. **Deterministic policy only.** Credit parameters (`advanceRateBps`,
   `maxBuyerConcentrationBps`, `operatorCap`, freshness window) live on-chain in
   the vault, never in the worker or UI.
3. **Tests accompany every contract change.** `contracts/test/vault.test.ts`
   covers happy path, replays, decoding failures, freshness, concentration and
   access control. New guards need a new failing-then-passing test.
4. **No secrets in source.** Keys live only in `.env` (see `.env.example`).
   `.env` is ignored; never commit it.
5. **`artifacts/` is generated.** A fresh checkout needs `npm run contracts:compile`
   before worker/web tooling that imports ABIs (already run via `npm run prepare`).

## Setting up

```bash
git clone https://github.com/opeblow/ComputeCred.git
cd ComputeCred
npm install        # installs workspaces and compiles contracts via `prepare`

npm run typecheck        # contracts + worker + web
npm run contracts:test   # 25-test credit-policy suite (local EVM, offline)
npm run worker:test      # decode / ABI / execute-encoding tests
npm run web:build        # production dashboard bundle
npm run demo             # test suite + credit-policy tour
```

The full proof pipeline additionally needs a live CC3 Testnet + Sepolia setup —
see [README](./README.md#run-it) and [docs/ATTESTCOIN_INTEGRATION.md](./docs/ATTESTCOIN_INTEGRATION.md).

## Development workflow

1. Create a branch: `git checkout -b feat/whatever`.
2. Make atomic changes with a clear commit message (below).
3. Run the full verification gate before pushing:
   ```bash
   npm run contracts:compile && npm run typecheck && npm run contracts:test && npm run worker:test && npm run web:build
   ```
4. Open a PR against `main` describing *what* and *why*.

CI runs the same gate on every push/PR — a red CI blocks merge.

## Commit messages

Keep them distinct and descriptive. Conventional-commit style is used:

```
contracts: add zero-gross guard to _extractSettlement
web: show concentration haircut in facility view
worker: dedupe resubmitted proofs via usedJobIds prescreen
```

Write body lines when the change is non-obvious (why, alternatives considered).

## Deploying

Tags starting with `v` (e.g. `v0.1.0`) trigger the Release workflow, which runs
full verification and publishes a GitHub Release with the web bundle. Actual
contract deployment to CC3 is a manual, key-gated step — see
[docs/ATTESTCOIN_INTEGRATION.md](./docs/ATTESTCOIN_INTEGRATION.md#environment).

## Reporting issues / vulnerabilities

Feature requests and bugs go in [Issues](../../issues). Security-sensitive
reports should **not** go in a public issue — see [SECURITY.md](./SECURITY.md).