/**
 * x402-hive — drop-in adapter that emits a Hive HAHS receipt and SpectralZK
 * sidecar for every x402 payment.
 *
 * Usage:
 *   const hive = new HiveX402Adapter({ issuerSk, policy });
 *   const payment = await x402.charge({ ... });        // your existing flow
 *   const proof = await hive.attest(payment);          // adds audit layer
 *
 * The adapter is stateless and additive. Your x402 facilitator does not need
 * to know it exists. The receipt + ZK sidecar can be posted to any audit
 * sink (S3, Datadog, an internal ledger, or thehiveryiq.com/canon/sink).
 */
import * as hahs from "@hive-protocol/sdk/hahs";
import * as spectralzk from "@hive-protocol/sdk/spectralzk";
import * as shod from "@hive-protocol/sdk/shod";

export const ADAPTER_VERSION = "0.2.0";

/**
 * 5-bps audit-envelope fee. Routed to the Hive treasury wallet on Base.
 * USDC, USDT, USDP, USDS, DAI, and other ERC-20 stablecoins accepted.
 * This is the cost of the audit layer. The underlying x402 payment is
 * unchanged. The clip is a separate transfer that the adapter records on
 * the receipt under `settlement_meta.hive_fee_bps`.
 */
export const HIVE_TREASURY_WALLET = "0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E";
export const HIVE_FEE_BPS = 5;

export interface HiveFeeInstruction {
  treasury: string;
  bps: number;
  /** Fee amount in the same smallest-unit base as the underlying payment. */
  amount: string;
  /** Decimals of the underlying payment, repeated for the caller's convenience. */
  decimals: number;
  network: string;
  payable_with: string;
}

export function computeHiveFee(payment: X402Payment): HiveFeeInstruction {
  const amt = typeof payment.amount === "string" ? BigInt(payment.amount) : BigInt(Math.round(payment.amount));
  // 5 bps = 5 / 10000. Integer math against the smallest-unit amount.
  const fee = (amt * BigInt(HIVE_FEE_BPS)) / 10000n;
  return {
    treasury: HIVE_TREASURY_WALLET,
    bps: HIVE_FEE_BPS,
    amount: fee.toString(),
    decimals: payment.decimals,
    network: payment.network,
    payable_with: "USDC, USDT, USDP, USDS, DAI on Base",
  };
}

/** Minimal shape of an x402 payment we need to mint a HAHS receipt. */
export interface X402Payment {
  /** x402 payment id, transaction hash, or facilitator-specific id. */
  paymentId: string;
  /** Chain + asset, e.g. "base-usdc". */
  network: string;
  /** Counterparty resource being paid for (URL or DID). */
  resource: string;
  /** Amount in smallest unit (e.g. USDC has 6 decimals). */
  amount: string | number;
  /** Decimal places of `amount` (e.g. 6 for USDC). */
  decimals: number;
  /** Optional facilitator response payload to staple onto the receipt. */
  facilitatorResponse?: unknown;
}

export interface HiveX402AdapterOpts {
  /** 32-byte Ed25519 seed used to sign HAHS receipts. */
  issuerSk: Uint8Array;
  /** Optional SHOD policy to pre-flight every payment. */
  gate?: shod.GateStack;
  /** Optional SpectralZK config — if supplied, a sidecar proof is emitted. */
  spectral?: {
    issuerSk: Uint8Array;
    policyId: string;
    constraints: spectralzk.Constraint[];
    actionAttr: string;
  };
  /** SIU symbol to record on the receipt. Default 'X402-PAYMENT'. */
  symbol?: string;
  /**
   * Hive API key. Determines receipt tier (free/pro/scale/enterprise) and
   * whether anchored receipts can be requested. Without a key, every receipt
   * is free-tier and carries the upgrade footer.
   */
  apiKey?: string;
  /** Request an anchored receipt for paid tiers. Default false. */
  anchor?: boolean;
}

export interface AttestationResult {
  receipt: hahs.HahsReceipt;
  spectralProof?: spectralzk.SpectralProof;
  shodResult?: shod.GateResult;
  hiveFee: HiveFeeInstruction;
  /** Combined audit payload — what you store or POST upstream. */
  audit: {
    adapter: string;
    payment_id: string;
    network: string;
    resource: string;
    receipt: hahs.HahsReceipt;
    hive_fee: HiveFeeInstruction;
    proof?: spectralzk.SpectralProof;
  };
}

export class HiveX402Adapter {
  constructor(public readonly opts: HiveX402AdapterOpts) {}

  /**
   * Attach a Hive audit layer to a completed x402 payment. Returns a HAHS
   * receipt (always), plus an optional SpectralZK proof and SHOD pre-flight
   * report if those were configured.
   */
  async attest(payment: X402Payment): Promise<AttestationResult> {
    const amountUsd = decimalAmount(payment.amount, payment.decimals);

    let shodResult: shod.GateResult | undefined;
    if (this.opts.gate) {
      shodResult = this.opts.gate.evaluate({
        recipient: payment.resource,
        amountUsd,
      });
      if (!shodResult.ok) {
        throw new Error("SHOD pre-flight failed: " + shodResult.short());
      }
    }

    const hiveFee = computeHiveFee(payment);

    const receipt = await hahs.issue({
      symbol: this.opts.symbol ?? "X402-PAYMENT",
      units: 1,
      amountUsd,
      recipient: payment.resource,
      issuerSk: this.opts.issuerSk,
      hahsAnchor: `${payment.network}:${payment.paymentId}`,
      settlement: payment.network,
      apiKey: this.opts.apiKey,
      anchor: this.opts.anchor,
    });

    let spectralProof: spectralzk.SpectralProof | undefined;
    if (this.opts.spectral) {
      const cents = Math.round(amountUsd * 100);
      spectralProof = await spectralzk.prove(
        this.opts.spectral.issuerSk,
        this.opts.spectral.policyId,
        this.opts.spectral.constraints,
        { attr: this.opts.spectral.actionAttr, value: cents },
      );
    }

    return {
      receipt,
      spectralProof,
      shodResult,
      hiveFee,
      audit: {
        adapter: `x402-hive/${ADAPTER_VERSION}`,
        payment_id: payment.paymentId,
        network: payment.network,
        resource: payment.resource,
        receipt,
        hive_fee: hiveFee,
        ...(spectralProof ? { proof: spectralProof } : {}),
      },
    };
  }

  /** Verify a stored attestation later (e.g. during audit replay). */
  static async verify(audit: AttestationResult["audit"]): Promise<{ ok: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const r1 = await hahs.verify(audit.receipt);
    if (!r1.ok) reasons.push(`HAHS: ${r1.reason}`);
    if (audit.proof) {
      const r2 = await spectralzk.verify(audit.proof);
      if (!r2.ok) reasons.push(`SpectralZK: ${r2.reason}`);
    }
    return { ok: reasons.length === 0, reasons };
  }
}

function decimalAmount(amount: string | number, decimals: number): number {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return n / Math.pow(10, decimals);
}

// Re-export the SDK surface for convenience.
export { hahs, spectralzk, shod };
