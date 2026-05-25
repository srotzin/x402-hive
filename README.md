# x402-hive

A drop-in adapter that adds a **Hive audit layer** to any [x402](https://www.x402.org)
payment in 15 lines. Your facilitator does not need to know it exists.

```
npm install x402-hive
```

## Why

x402 settles the dollar. It does not produce:

- a tamper-evident receipt the enterprise compliance team can defend,
- a zero-knowledge proof that the spend satisfied a policy,
- a pre-flight gate that physically blocks overruns.

x402-hive bolts all three onto every x402 payment without touching the
facilitator. The output is a `HAHS` receipt (always) plus an optional
`SpectralZK` sidecar and `SHOD` pre-flight report. Store it in S3, Datadog,
or any internal ledger.

## Quickstart

```typescript
import { HiveX402Adapter } from "x402-hive";
import * as shod from "@hive-protocol/sdk/shod";

const adapter = new HiveX402Adapter({
  issuerSk,                                       // 32-byte Ed25519 seed
  gate: shod.GateStack.default({                  // optional pre-flight
    dailyCapUsd: 500,
    priceWindow: [0.0001, 100],
  }),
});

// your existing x402 flow, unchanged
const payment = await yourFacilitator.charge({ ... });

// attach the audit layer
const { receipt, spectralProof, audit } = await adapter.attest({
  paymentId: payment.txHash,
  network: "base-usdc",
  resource: payment.resource,
  amount: payment.amount,
  decimals: 6,
});

// `audit` is what you ship to your auditor / S3 / SIEM
```

## What you get

| Output            | What it proves                                                            |
|-------------------|---------------------------------------------------------------------------|
| `HAHS` receipt    | Issuer signed the exact `(amount, recipient, symbol, anchor)` tuple.      |
| `SpectralZK` proof | The spend satisfied a private policy — without revealing the policy.     |
| `SHOD` pre-flight | The six gates (allowlist / daily cap / per-recipient / price window /     |
|                   | trust tier / anomaly) all passed before the signing key was used.         |

Every artifact verifies offline in ~50ms with `HiveX402Adapter.verify(audit)`.

## Compatible with

- Any facilitator that conforms to the [x402 spec](https://github.com/coinbase/x402)
- PayAI, x402-py, x402-rs, Coinbase x402-cdp, custom in-house facilitators
- Coinbase AgentKit, LangGraph, CrewAI, Vercel AI SDK, OpenAI Agents SDK

## Status

`v0.1.0` — early but stable. Cross-language byte-compatible with
[hive-py](https://github.com/srotzin/hive-py) — a receipt signed in Python
verifies in TypeScript and vice versa.

## License

MIT.

---

Hive Civilization · https://thehiveryiq.com · ops@thehiveryiq.com
