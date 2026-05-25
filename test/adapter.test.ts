import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HiveX402Adapter, X402Payment } from "../src/index.js";
import * as shod from "@hive-protocol/sdk/shod";

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function sk() {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s);
  return s;
}

const samplePayment: X402Payment = {
  paymentId: "0xabc123",
  network: "base-usdc",
  resource: "https://api.openrouter.ai/v1/chat",
  amount: "1450000", // 1.45 USDC at 6 decimals
  decimals: 6,
};

test("adapter emits valid HAHS receipt for x402 payment", async () => {
  const adapter = new HiveX402Adapter({ issuerSk: sk() });
  const result = await adapter.attest(samplePayment);
  assert.equal(result.receipt.protocol, "hahs/1");
  assert.equal(result.receipt.amount_usd, "1.45");
  assert.equal(result.receipt.recipient, samplePayment.resource);
  const v = await HiveX402Adapter.verify(result.audit);
  assert.equal(v.ok, true, v.reasons.join("; "));
});

test("adapter SHOD pre-flight blocks oversized payment", async () => {
  const adapter = new HiveX402Adapter({
    issuerSk: sk(),
    gate: shod.GateStack.default({ dailyCapUsd: 1.0 }),
  });
  await assert.rejects(adapter.attest(samplePayment), /SHOD pre-flight failed/);
});

test("adapter attaches SpectralZK sidecar when configured", async () => {
  const seed = sha256(new TextEncoder().encode("x402-hive-test-spectral-seed"));
  const adapter = new HiveX402Adapter({
    issuerSk: sk(),
    spectral: {
      issuerSk: seed,
      policyId: "hive.policy.x402.spend",
      constraints: [
        { attr: "spend_cents", lo: 0, hi: 50, nonce: new Uint8Array(16).fill(1) },
        { attr: "spend_cents", lo: 51, hi: 500, nonce: new Uint8Array(16).fill(2) },
        { attr: "spend_cents", lo: 501, hi: 50000, nonce: new Uint8Array(16).fill(3) },
      ],
      actionAttr: "spend_cents",
    },
  });
  const result = await adapter.attest(samplePayment);
  assert.ok(result.spectralProof);
  const v = await HiveX402Adapter.verify(result.audit);
  assert.equal(v.ok, true, v.reasons.join("; "));
});

test("tamper detection on stored audit", async () => {
  const adapter = new HiveX402Adapter({ issuerSk: sk() });
  const result = await adapter.attest(samplePayment);
  // tamper the amount in the stored audit
  const bad = JSON.parse(JSON.stringify(result.audit));
  bad.receipt.amount_usd = "999.99";
  const v = await HiveX402Adapter.verify(bad);
  assert.equal(v.ok, false);
});
