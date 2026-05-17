/**
 * @module @veridex/agents-treasury/types
 *
 * Core domain types for treasury kit: money, counterparties, proposals,
 * idempotency keys, evidence bundles, risk and sanctions screening.
 *
 * All types are framework-internal and intentionally minimal — they wrap
 * the smallest possible set of fields needed to compose with the
 * @veridex/agents policy engine, hook system, and trace pipeline.
 */

import { z } from 'zod';

// ── Money ──

/** ISO-4217 currency or chain-token symbol (e.g. "USDC", "ETH", "USD"). */
export const CurrencyCode = z.string().min(1).max(16);

/**
 * Money as a string-encoded integer in the asset's smallest unit
 * (e.g. wei for ETH, micro-USD for USD). String to preserve precision.
 */
export const Money = z.object({
  amount: z.string().regex(/^[0-9]+$/, 'amount must be a non-negative integer string'),
  currency: CurrencyCode,
  /** Decimal places of the smallest unit (e.g. 18 for ETH, 6 for USDC). */
  decimals: z.number().int().min(0).max(36),
});
export type Money = z.infer<typeof Money>;

/** Helpers for safe BigInt-based arithmetic over Money. */
export function moneyToBigInt(m: Money): bigint {
  return BigInt(m.amount);
}

export function bigIntToMoney(amount: bigint, currency: string, decimals: number): Money {
  if (amount < 0n) throw new Error('Money amount cannot be negative');
  return { amount: amount.toString(), currency, decimals };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency || a.decimals !== b.decimals) {
    throw new Error(`Cannot add ${a.currency}/${a.decimals} and ${b.currency}/${b.decimals}`);
  }
  return bigIntToMoney(moneyToBigInt(a) + moneyToBigInt(b), a.currency, a.decimals);
}

/** Convert Money to a normalized USD micro-units estimate (caller supplies FX rate in 1e6 fixed-point). */
export function moneyToUsdMicro(m: Money, usdPerUnitMicro: bigint): bigint {
  // (amount * usdPerUnitMicro) / 10^decimals
  const scale = 10n ** BigInt(m.decimals);
  return (moneyToBigInt(m) * usdPerUnitMicro) / scale;
}

// ── Counterparty ──

export const Counterparty = z.object({
  /** Stable canonical id (chain+address, did, or business id). */
  id: z.string().min(1),
  /** Human-readable label for evidence and approvals. */
  label: z.string().optional(),
  /** Chain symbol (e.g. "ethereum", "solana", "off-chain"). */
  chain: z.string().min(1),
  /** Address or account identifier on that chain. */
  address: z.string().min(1),
  /** Optional tags for policy matching (allowlist, vendor class, etc.). */
  tags: z.array(z.string()).optional(),
});
export type Counterparty = z.infer<typeof Counterparty>;

// ── Idempotency ──

/** Application-provided idempotency key (caller's responsibility to make unique). */
export const IdempotencyKey = z.string().min(8).max(128);
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

// ── Transfer proposal ──

export const TransferProposal = z.object({
  idempotencyKey: IdempotencyKey,
  from: Counterparty,
  to: Counterparty,
  amount: Money,
  memo: z.string().max(512).optional(),
  /** Optional explicit risk override (e.g. precomputed by oracle). */
  riskScore: z.number().min(0).max(100).optional(),
  /** Optional unix-seconds at-which the transfer must not execute before. */
  executeAfter: z.number().int().nonnegative().optional(),
});
export type TransferProposal = z.infer<typeof TransferProposal>;

// ── Sanctions ──

export type SanctionVerdict = 'clear' | 'flagged' | 'blocked';

export interface SanctionScreening {
  verdict: SanctionVerdict;
  reasons: string[];
  /** Provider id for evidence (e.g. "noop", "allowlist", "chainalysis"). */
  provider: string;
  evaluatedAt: number;
}

// ── Evidence ──

/** Signature algorithm used on an evidence bundle. */
export type EvidenceSigAlg = 'hmac-sha256' | 'ed25519' | 'none';

export interface EvidenceBundle {
  /** Schema version. */
  version: '1';
  /** Tenant/app id (matches relayer app context). */
  appId: string;
  /** Run id from the agent runtime. */
  runId: string;
  /** Agent id. */
  agentId: string;
  /** Unix-ms when the bundle was assembled. */
  bundledAt: number;
  /** Captured trace events (typed records, kept opaque here). */
  traces: Array<Record<string, unknown>>;
  /** Captured policy verdicts. */
  policyVerdicts: Array<Record<string, unknown>>;
  /** Captured approval requests/decisions. */
  approvals: Array<Record<string, unknown>>;
  /** Captured transfer proposals (post-policy). */
  proposals: Array<Record<string, unknown>>;
  /** On-chain tx references emitted during the run. */
  chainTxRefs: string[];
  /** Optional TEE attestation blob (base64). */
  teeAttestation?: string;
  /** Hash of the canonical bundle bytes (sha-256 hex), signed below. */
  contentHash: string;
  /** Signature over contentHash. */
  signature: string;
  /** Signature algorithm. */
  sigAlg: EvidenceSigAlg;
  /** Key id used to sign. */
  keyId: string;
}
