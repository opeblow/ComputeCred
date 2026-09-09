# Attestcoin integration

This document explains exactly how ComputeCred uses Attestcoin, so it can be verified against the
official protocol. It mirrors the integration pattern from the gluwa `attestcoin-protocol-examples`
loan example, adapted to a revenue-financing flow.

## Source event: `JobSettled`

```solidity
event JobSettled(bytes32 indexed jobId, address indexed operator, address indexed buyer,
                 uint128 grossAmount, uint64 completedAt, bytes32 workloadCommitment);
```

- `topics[0]` = `keccak256("JobSettled(bytes32,address,address,uint128,uint64,bytes32)")`
  = `0x576d20c6973b5fc107e0f23c395df0170eaed2b08ca42f1192b69c63c0533e92`
- `topics[1]` = `jobId`, `topics[2]` = `operator` (the facility owner), `topics[3]` = `buyer`
- `data` = `abi.encode(uint128 grossAmount, uint64 completedAt, bytes32 workloadCommitment)`,
  exactly 96 bytes

The vault pins the signature in a `public constant`:

```solidity
bytes32 public constant JOB_SETTLED_EVENT_SIGNATURE =
    0x576d20c6973b5fc107e0f23c395df0170eaed2b08ca42f1192b69c63c0533e92;
```

## Proving a settlement

The worker (`worker/src`), using `@gluwa/usc-sdk` and a durable `node:sqlite` store
(`store.ts`; one row per `(chain, contract, tx, logIndex)` plus a scan checkpoint):

1. Scans `JobSettled` on the source chain (Sepolia), chunked 50 blocks to respect public RPC
   `eth_getLogs` limits. New receipts are inserted and the checkpoint advances in the same
   transaction, so a crash never re-scans confirmed scans or drops a row.
2. Locks rows for the configured operator (`WORKER_OPERATOR_ADDRESS`, or derived from the signing
   key) and skips `jobId`s already registered on the vault via the public `usedJobIds` mapping.
3. Waits for the block to be attested on Creditcoin:
   ```ts
   const builder = new proofProvider.service.ProofBuilder(chainKey, PROOF_BUILDER_URL);
   await builder.waitUntilHeightAttested(chainKey, blockNumber, 15_000, 1_200_000);
   const { data: proof } = await builder.getProof(txHash);
   ```
   `proof` = `{ chainKey, headerNumber, txIndex, txHash, txBytes,
   merkleProof: { root, siblings: [{hash, isLeft}] },
   continuityProof: { lowerEndpointDigest, roots } }`.
4. Submits it to the vault via `verifyAndRegister` (the chain-key-guarded production path — see
   below), signing with `WORKER_SUBMITTER_PRIVATE_KEY` (defaults to the operator key) and,
   optionally, broadcasting from a scoped relayer the operator authorized with `setRelayer`:

```
verifyAndRegister(
  proof.chainKey,                        // must equal the vault's expectedSourceChainKey
  proof.headerNumber,
  proof.txBytes,                         // encoded receipt (type-0 legacy encoding)
  proof.merkleProof.root,
  proof.merkleProof.siblings,
  proof.continuityProof.lowerEndpointDigest,
  proof.continuityProof.roots
)
```

`verifyAndRegister` mirrors `ASCBase.execute` (from
`@gluwa/asc-contracts/contracts/readability/ASCBase.sol`): it calls
`VERIFIER.verifyAndEmit` on the **Block Prover precompile at `0xFD2`**, computes a stable query id
from `(chainKey, blockHeight, merkleRoot, siblings)` and refuses to process the same query twice
(`processedQueries`), then calls the app hook `_processAndEmitEvent`. Unlike the inherited generic
`execute`, the vault's `verifyAndRegister` does **not** self-call `execute`, so `msg.sender` (the
operator or their authorized relayer) survives to the identity check — and it independently reverts
when `chainKey` does not match `expectedSourceChainKey`. The inherited `execute` is kept for ASC
protocol compatibility only and is not the production path (it cannot be chain-key guarded without
forking the base).

Submission completes when the reconcile pass sees the receipt on-chain (bounded by
`WORKER_CONFIRMATIONS`), falling back to the vault's `usedJobIds` mapping when a receipt was already
successful. Failed submissions are classified terminal (idempotent end-states like "already used")
or retryable against bounded budgets (`WORKER_MAX_PROOF_RETRIES`, `WORKER_MAX_SUBMIT_RETRIES`) —
all state survives worker restarts.

## Decoding on-chain

`ComputeCredVault._extractSettlement` uses `EvmV1Decoder` (the official library, address
`0x04B9ae8562D8Cc5bbbBbBB759080dDC30B56D18B` on CC3 Testnet) to read the proven transaction:

```solidity
EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
EvmV1Decoder.LogEntry[] memory logs =
    EvmV1Decoder.getLogsByEventSignature(receipt, JOB_SETTLED_EVENT_SIGNATURE);
```

Validation order (all revert):

1. `isValidTransactionType(txType)` → "unsupported tx type"
2. `receipt.receiptStatus == 1` → "source receipt failed"  (failed/nonexistent receipts can't be revenue)
3. exactly one matching log → "expected one JobSettled log"
4. `log.address_ == jobMarket` → "source contract not registered" / "wrong source contract"
5. `log.topics.length == 4` → "invalid JobSettled topics"
6. `log.data.length == 96` → "invalid JobSettled data"
7. `grossAmount > 0` → "zero gross amount"
8. `completedAt <= now + 3600` and `completedAt + 30d >= now` → "settlement timestamp in future" / "settlement too old"
9. `msg.sender == operator (topics[2])` or an `authorizedRelayers[operator][msg.sender]` → "operator mismatch"
10. `usedJobIds[jobId] == false` → "job already used"

## Revenue recognition (not repayment)

`_processAndEmitEvent` applies each verified settlement strictly as **revenue recognition**:

```solidity
require(msg.sender is the operator or an authorized relayer);
f.lifetimeVerifiedRevenue += ev.amount;
f.events.push(RevenueEvent(jobId, buyer, amount, settledAt));
```

```
eligible      = min(sum of in-window events, operatorCap)
facilityLimit = advanceRate × (eligible − max(0, largest − maxConcentration% × eligible))
```

It deliberately does **not** touch `outstandingDebt`. The vault never receives the source-chain
proceeds (the operator withdraws them from the JobMarket escrow), so treating a receipt as
repayment would let debt disappear without the vault's loan reserve being replenished. Debt falls
only through `repay()` — an actual transfer of tUSDC into the vault — so `verifyAndRegister` is a
state transition that grows borrowing capacity from cryptographically proven revenue, with zero
trust in the borrower's reporting, and the dashboard keeps "revenue" and "debt repaid" as distinct,
auditable numbers.

## Environment

| Variable | Value |
| --- | --- |
| `SOURCE_CHAIN_RPC_URL` | Sepolia RPC |
| `SOURCE_CHAIN_KEY` | `1` (Ethereum/Sepolia on Creditcoin) |
| `CREDITCOIN_RPC_URL` | `https://rpc.cc3-testnet.creditcoin.network` |
| `PROOF_BUILDER_URL` | `https://prover.cc3-testnet.creditcoin.network` |
| `EVM_V1_DECODER_LIBRARY_ADDRESS` | `0x04B9ae8562D8Cc5bbbBbBB759080dDC30B56D18B` |
| `CREDITCOIN_WALLET_PRIVATE_KEY` | wallet that signs worker operations on CC3 (operator by default) |
| `WORKER_SUBMITTER_PRIVATE_KEY` | optional hot wallet that signs + broadcasts proofs (relayer for the operator) |
| `WORKER_OPERATOR_ADDRESS` | optional operator facility-owner (derived from the signing key by default) |
| `WORKER_DB_PATH` | durable sqlite state (`worker-state/computecred.sqlite`) |
| `WORKER_MAX_PROOF_RETRIES` / `WORKER_MAX_SUBMIT_RETRIES` | bounded retry budgets before parking a job |
| `WORKER_CONFIRMATIONS` | confirmations a broadcast needs before a job is marked confirmed |
| `WORKER_START_BLOCK` | first source chain block to scan (JobMarket deploy block) |

## Things we deliberately did not hand-roll

- **Block inclusion + continuity**: the dedicated Creditcoin Block Prover precompile `0xFD2`
  (`NativeQueryVerifier`) — we never parse a chain by hand.
- **Tx encoding**: `EvmV1Decoder`/`asc-contracts` — the encoded transaction format is versioned
  (recently type 0 legacy), so decoding is done by the official library.
- **Attestation wait + proof fetch**: `ProofBuilder` service wrapper with its cache-aware
  `waitUntilHeightAttested`.