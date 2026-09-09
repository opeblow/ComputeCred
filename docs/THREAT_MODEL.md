# Threat model

ComputeCred security thesis: **an unverifiable claim about revenue must never be able to
increase a borrower's credit line or pay down their debt.** Everything that touches the credit
policy is either proven on-chain by the Block Prover, or hard-rejected by a whitelist and exact
layout checks. The sections below walk attacker capabilities against that claim.

## 1. Attacker fabricates revenue

The vulnerable primitive is a worker that takes "you say you earned money on-chain" as truth.
We don't.

| What the attacker controls | Why it fails | Where enforced |
| --- | --- | --- |
| A fake event from a contract they deploy | `log.address_` must equal the registered `jobMarket` | `_extractSettlement` guard 4 |
| A forged transaction with no on-chain inclusion | the Block Prover precompile proves Merkle + continuity inclusion; nothing unproven reaches the app code | `verifyAndRegister` → `VERIFIER` precompile |
| Replaying one real settlement forever | `processedQueries` (query id) at the ASC layer **and** `usedJobIds` at the vault layer | `ASCBase` + `_extractSettlement` guard 10 |
| A settled job on a *different* JobMarket they own | registration is a single owner-set `registerSourceContract`; `_extractSettlement` pins topic/layout against that address | `_extractSettlement` guard 5 |
| A `JobSettled` log that is actually some other event name | decoder filters by the pinned signature constant | `EvmV1Decoder.getLogsByEventSignature` |
| A zero-amount settlement to pad the book cheaply | `grossAmount == 0` reverts | guard 7 |
| A bomb-shaped malformed payload | structural checks: one log, 4 topics, 96-byte data, valid tx type / receipt | guards 1–6, `EvmV1Decoder` |

## 2. Attacker claims someone else's revenue

Facilities are keyed to the operator. The `JobSettled` log's `operator` topic (indexed, part of the
proven receipt) must equal `msg.sender` of the registration transaction — or be an address the
operator explicitly authorized via `setRelayer` (settlements only; a relayer can never draw, repay,
or change policy). Because the topic is part of the attested data, the worker cannot swap it — no
address malleability.

| Attack | Enforced by |
| --- | --- |
| Submit another operator's settlement to my own facility | guard 9: `msg.sender == operator` (or an operator-authorized relayer only) |
| Register both sides (submit A's events to B's facility) | same guard — the operator address is the facility's identity |

## 3. Credit-policy manipulation

`facilityLimit = 50% * book`, `book = eligible − max(0, largest − 40% * eligible)`. Every input to
these numbers is a windowed, verified 30d sum computed *inside* the vault from guarded settlements —
the operator never passes an amount. Attack surface here is the freshness window arithmetic:

| Attack | Why it fails |
| --- | --- |
| Replay very old closure with high gross to inflate `lifetimeVerifiedRevenue` | data outside `[now − 30d, now + 3600]` reverts (guard 8) |
| Rapidly flip old/new timestamps to game the window | every window computation reads a monotonic clock; each event is one-time use and age-pruned via `_pruneEvents` when it falls outside the window |
| Register from a future block (future timestamp / shock) | `completedAt <= now + CLOCK_SKEW_TOLERANCE` (1h) |
| Concentration evasion with many fake buyers | a fake buyer must still produce a real attested settlement paid by a real demand-side wallet; fabricating revenue is covered in section 1 |

## 4. The worker itself

The worker signs with the operator's CC3 key (or a scoped `WORKER_SUBMITTER_PRIVATE_KEY` +
`WORKER_OPERATOR_ADDRESS`, so a hot submitter can be capped to settlement-with-authorized-relayer
only — it can never draw, repay, or change policy via the vault's `setRelayer` model). It has no
special powers beyond what the operator already has on the source chain, but defense-in-depth:

- A durable sqlite store with CAS state transitions + an atomic scan checkpoint makes restart and
  crash resume safe: a scanned chunk is deduplicated by `(chain, contract, tx, logIndex)` and the
  checkpoint only advances with the persisted rows.
- `usedJobIds(jobId)` read-before-submit to make the worker idempotent under crashes; the chain
  refuses duplicates (`processedQueries` query ids, `usedJobIds` job ids).
- The worker signs and broadcasts proofs via `verifyAndRegister`, so a malicious relay running the
  worker key can replay a past proof exactly once: the chain dedups it (query id + jobId) and the
  caller must still be the claimed operator's self or an authorized relayer.

## 5. Lender / liquidity side

- The vault cannot mint — draws move actual `TestUSDC` (6-decimals, public mint on the test token)
  held in the contract; `draw` is capped by both the facility credit line **and** current vault
  liquidity.
- There is deliberately **no liquidation log of revenue-vs-debt since verified revenue is
  credit, not repayment**: a late/defaulted operator simply cannot draw more; `outstandingDebt`
  falls only when loan tokens are actually repaid into the vault, and `lifetimeRepaid` records
  that. Under the 50% advance rate and 40% concentration haircut, revenue coverage of any draw is
  intended to be the lender protection mechanism.

## 6. What we explicitly do not claim

- **Liveness of attester / interop chain failures**: if the Block Prover never sees the block,
  the revenue never books — the worker retries but cannot force it.
- **Creditcoin block producer honesty**: we inherit the platform assumption that blocks are final
  and attested by the assigned producer.
- **Source-chain custody**: the *escrowed* job funds live in `JobMarket`; the facility operator
  depends on the buyer having actually paid (which is what the attested receipt proves after the
  fact, not before).

## 7. Operational notes

- `EVM_V1_DECODER_LIBRARY_ADDRESS` is pinned by deployment args; the decoder library address is
  part of the vault constructor, so swapping it swaps the vault.
- The gas for a failed batch reversion is minimal: all guards abort before any state mutation and
  before non-local reads, keeping the revert path cheap.