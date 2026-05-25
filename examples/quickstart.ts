/**
 * x402-hive quickstart — add a Hive audit layer to any x402 payment in 15 lines.
 *
 * Run:  npx tsx examples/quickstart.ts
 */
import { HiveX402Adapter } from "../src/index.js";
import * as shod from "@hive-protocol/sdk/shod";

const issuerSk = new Uint8Array(32);
crypto.getRandomValues(issuerSk);

const adapter = new HiveX402Adapter({
  issuerSk,
  gate: shod.GateStack.default({
    dailyCapUsd: 500,
    priceWindow: [0.0001, 100],
  }),
});

// imagine you just got this back from your x402 facilitator
const payment = {
  paymentId: "0xabc123def456",
  network: "base-usdc",
  resource: "https://api.openrouter.ai/v1/chat/completions",
  amount: "1450000", // 1.45 USDC
  decimals: 6,
};

const result = await adapter.attest(payment);
console.log("HAHS receipt:", result.receipt.receipt_id);
console.log("  amount_usd:", result.receipt.amount_usd);
console.log("  anchor:    ", result.receipt.hahs_anchor);
console.log("  SHOD:      ", result.shodResult?.short());

const verify = await HiveX402Adapter.verify(result.audit);
console.log("audit verify:", verify.ok ? "PASS" : "FAIL", verify.reasons);
