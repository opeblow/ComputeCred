# Security Policy

ComputeCred handles money movement (credit draws and repayments) and relies on
cryptographic attestation from the Creditcoin Block Prover. Security issues are
taken seriously — please report them privately.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Email the maintainer directly:

- Mobolaji Opeyemi Bolatito — `opeblow2021@gmail.com`

Please include:

1. A description of the vulnerability and its impact.
2. Steps to reproduce (or a proof-of-concept).
3. Affected contracts/files and the minimum severity you believe applies.
4. Any suggested mitigation, if you have one.

You will receive an acknowledgment within 3 business days. We ask that you do
not disclose the issue publicly until we have shipped a fix and you have had a
chance to review it.

## Scope

In scope:

- Everything under `contracts/contracts/` (the vault, market, token, harnesses).
- The worker (`worker/src/`) — specifically the proof/proof-encoding path.
- The CreditCoin attestation wiring (the `ASCBase` precompile call).

Out of scope (platform assumptions, documented in `docs/THREAT_MODEL.md`):

- Liveness/finality of the Creditcoin block producers and Block Prover.
- Compromise of the operator's private keys on either chain.

## Security model (summary)

The core invariant: **an unverifiable claim about revenue can never increase a
borrower's credit line or pay down their debt.** It is enforced by:

- `ASCBase.execute` requiring a valid Block Prover attestation for every event
  registration and rejecting duplicate query ids.
- `_extractSettlement` guard chain (registered emitter, one `JobSettled` log,
  topic arity, exact 96-byte data layout, nonzero gross, freshness window,
  operator identity, one-time `jobId`).

See [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) for the full analysis.

## Supported versions

Only the current `main` branch and tagged releases from it are supported with
security fixes.

## Disclosure

We follow a 90-day coordinated disclosure window after a fix is released.