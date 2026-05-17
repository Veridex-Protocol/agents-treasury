/**
 * @module @veridex/agents-treasury/reputation
 *
 * Soulbound-token (SBT) reputation provider — production-ready. The
 * provider returns a normalized 0-100 risk score and an opaque attestation
 * blob that callers can embed in evidence bundles.
 *
 * Two implementations are shipped:
 *
 * - {@link StaticReputationProvider}: in-memory map, useful for tests.
 * - {@link SbtReputationProvider}: production impl that calls an SBT-aware
 *   identity client (e.g. `@veridex/sdk` IdentityRegistry). The client
 *   shape is captured by the {@link ReputationClient} interface so this
 *   module does not hard-import the SDK.
 */

export interface ReputationAttestation {
  /** Subject id (chain+address, did, or account id). */
  subjectId: string;
  /** 0-100, where lower means higher risk. */
  score: number;
  /** Issuer (e.g. SBT contract address, attestor id). */
  issuer: string;
  /** Unix-ms when attestation was issued. */
  issuedAt: number;
  /** Optional signed proof blob for evidence retention. */
  proof?: string;
}

export interface ReputationProvider {
  readonly id: string;
  /** Returns null when the subject is unknown to the provider. */
  lookup(subjectId: string): Promise<ReputationAttestation | null>;
}

/** Minimal client surface required from an SBT/identity registry. */
export interface ReputationClient {
  /** Resolve a subject to a reputation record. Returns null if absent. */
  getReputation(subjectId: string): Promise<{
    score: number;
    issuer: string;
    issuedAt: number;
    proof?: string;
  } | null>;
}

/** Production provider — reads from an injected SBT/identity client. */
export class SbtReputationProvider implements ReputationProvider {
  readonly id = 'sbt';
  constructor(private readonly client: ReputationClient) {}

  async lookup(subjectId: string): Promise<ReputationAttestation | null> {
    const r = await this.client.getReputation(subjectId);
    if (!r) return null;
    return {
      subjectId,
      score: clamp(r.score, 0, 100),
      issuer: r.issuer,
      issuedAt: r.issuedAt,
      ...(r.proof !== undefined ? { proof: r.proof } : {}),
    };
  }
}

/** In-memory provider used in tests and for fixed-allowlist scenarios. */
export class StaticReputationProvider implements ReputationProvider {
  readonly id = 'static';
  constructor(private readonly map: Map<string, ReputationAttestation>) {}

  async lookup(subjectId: string): Promise<ReputationAttestation | null> {
    return this.map.get(subjectId) ?? null;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
