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

The worker (`worker/src`), using `@gluwa/usc-sdk`:

1. Watches `JobSettled` on the source chain (Sepolia), chunked 50 blocks to respect public RPC
   `eth_getLogs` limits.
2. Skips events where the operator isn't the worker's CC3 wallet (each CC3 wallet is its own
   operator), and skips `jobId`s already on the vault via the public `usedJobIds` mapping.
3. Waits for the block to be attested on Creditcoin:
   ```ts
   const builder = new proofProvider.service.ProofBuilder(chainKey, PROOF_BUILDER_URL);
   await builder.waitUntilHeightAttested(chainKey, blockNumber, 15_000, 1_200_000);
   const { data: proof } = await builder.getProof(txHash);
   ```
   `proof` = `{ chainKey, headerNumber, txIndex, txHash, txBytes,
   merkleProof: { root, siblings: [{hash, isLeft}] },
   continuityProof: { lowerEndpointDigest, roots } }`.
4. Submits it to the vault as `ASCBase.execute`:

```
execute(
  0,                        // VaultAction.RegisterSettlement
  proof.chainKey,
  proof.headerNumber,
  proof.txBytes,            // encoded receipt (type-0 legacy encoding)
  proof.merkleProof.root,
  proof.merkleProof.siblings,
  proof.continuityProof.lowerEndpointDigest,
  proof.continuityProof.roots
)
```

`ASCBase.execute` (from `@gluwa/asc-contracts/contracts/readability/ASCBase.sol`) calls
`VERIFIER.verifyAndEmit` on the **Block Prover precompile at `0xFD2`**, computes a stable query id
from `(chainKey, blockHeight, merkleRoot, siblings, txIndex)` and refuses to process the same
query twice (`processedQueries`), then calls the app hook `_processAndEmitEvent`.

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
9. `msg.sender == operator` (topics[2]) → "operator mismatch"
10. `usedJobIds[jobId] == false` → "job already used"

## Automated debt repayment

`_processAndEmitEvent` applies each settlement as a payment-in-kind first:

```solidity
uint256 debtPayment = min(amount, outstandingDebt);
outstandingDebt -= debtPayment;
revenueApplied = amount - debtPayment;
// revenueApplied rolls into the 30-day windowed book
```

So `verifyAndRegister` is not a dashboard sync — it is a state transition: the receipt pays down
your facility loan before it grows your borrowing capacity, with zero trust in the borrower's
reporting.

## Environment

| Variable | Value |
| --- | --- |
| `SOURCE_CHAIN_RPC_URL` | Sepolia RPC |
| `SOURCE_CHAIN_KEY` | `1` (Ethereum/Sepolia on Creditcoin) |
| `CREDITCOIN_RPC_URL` | `https://rpc.cc3-testnet.creditcoin.network` |
| `PROOF_BUILDER_URL` | `https://prover.cc3-testnet.creditcoin.network` |
| `EVM_V1_DECODER_LIBRARY_ADDRESS` | `0x04B9ae8562D8Cc5bbbBbBB759080dDC30B56D18B` |
| `CREDITCOIN_WALLET_PRIVATE_KEY` | the operator wallet on CC3 (also funds Sepolia side) |

## Things we deliberately did not hand-roll

- **Block inclusion + continuity**: the dedicated Creditcoin Block Prover precompile `0xFD2`
  (`NativeQueryVerifier`) — we never parse a chain by hand.
- **Tx encoding**: `EvmV1Decoder`/`asc-contracts` — the encoded transaction format is versioned
  (recently type 0 legacy), so decoding is done by the official library.
- **Attestation wait + proof fetch**: `ProofBuilder` service wrapper with its cache-aware
  `waitUntilHeightAttested`.