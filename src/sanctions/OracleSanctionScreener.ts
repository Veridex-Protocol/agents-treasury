/**
 * @module @veridex/agents-treasury/sanctions/OracleSanctionScreener
 *
 * Closes the **sanctions-list drift** gap (agent_fabric_gap_analysis.md, Gap 3).
 *
 * The built-in {@link DenylistSanctionScreener} is seeded from a static set at
 * construction time. A long-running agent that initialised before an address
 * was added to (e.g.) the OFAC SDN list would keep transacting with it: the
 * denylist is frozen. {@link OracleSanctionScreener} instead queries a live
 * {@link SanctionOracle} *before each execution*, with a short TTL cache so the
 * hot path stays fast while bounding how stale a verdict can be.
 *
 * It implements {@link SanctionScreener}, so every tool that already accepts a
 * screener (transfer, escrow, x402 paywall) gets real-time gating with no
 * call-site changes — just pass an `OracleSanctionScreener`.
 *
 * Failure handling is **fail-closed by default**: if the oracle is unreachable,
 * the counterparty is blocked rather than waved through. This is configurable
 * for deployments that prefer to flag-and-continue.
 */

import type { Counterparty, SanctionScreening } from '../types';
import type { SanctionScreener } from './SanctionScreener';

/** Result returned by a live sanctions oracle for a single counterparty. */
export interface SanctionOracleResult {
  /** Whether the counterparty currently appears on a sanctions/denylist. */
  listed: boolean;
  /**
   * Severity when listed. `blocked` is a hard stop; `flagged` allows the
   * caller's policy to decide (e.g. route to manual review). Ignored when
   * `listed` is false. Defaults to `blocked`.
   */
  severity?: 'blocked' | 'flagged';
  /** Source list/provider for evidence (e.g. "ofac-sdn", "chainalysis"). */
  source?: string;
  /** Human-readable match reasons. */
  reasons?: string[];
  /** Oracle-reported freshness of the underlying list, if available. */
  asOf?: number;
}

/**
 * A live sanctions data source. Implementations wrap a vendor API or an
 * on-chain/off-chain indexer that tracks list updates in real time.
 */
export interface SanctionOracle {
  readonly id: string;
  check(query: { id: string; address: string; chain: string }): Promise<SanctionOracleResult>;
}

export interface OracleSanctionScreenerOptions {
  /**
   * How long (ms) a verdict may be reused before the oracle is re-queried.
   * Bounds worst-case list-drift staleness. Default: 60_000 (1 minute).
   */
  cacheTtlMs?: number;
  /**
   * Behaviour when the oracle throws or times out:
   * - `block` (default): fail-closed — treat as blocked.
   * - `flag`: allow but mark `flagged` for downstream review.
   * - `allow`: fail-open — treat as clear (NOT recommended for value movement).
   */
  onError?: 'block' | 'flag' | 'allow';
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

interface CacheEntry {
  screening: SanctionScreening;
  cachedAt: number;
}

/** Real-time, TTL-cached, fail-closed sanctions screener. */
export class OracleSanctionScreener implements SanctionScreener {
  readonly id: string;
  private readonly oracle: SanctionOracle;
  private readonly cacheTtlMs: number;
  private readonly onError: 'block' | 'flag' | 'allow';
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(oracle: SanctionOracle, options: OracleSanctionScreenerOptions = {}) {
    this.oracle = oracle;
    this.id = `oracle[${oracle.id}]`;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.onError = options.onError ?? 'block';
    this.now = options.now ?? Date.now;
  }

  private key(cp: Counterparty): string {
    return `${cp.chain}:${cp.address.toLowerCase()}`;
  }

  async screen(cp: Counterparty): Promise<SanctionScreening> {
    const key = this.key(cp);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached.screening;
    }

    let screening: SanctionScreening;
    try {
      const result = await this.oracle.check({ id: cp.id, address: cp.address, chain: cp.chain });
      screening = this.toScreening(result);
      // Only successful queries are cached; errors must re-query next time.
      this.cache.set(key, { screening, cachedAt: this.now() });
    } catch (err) {
      screening = this.onOracleError(cp, err);
    }
    return screening;
  }

  private toScreening(result: SanctionOracleResult): SanctionScreening {
    const provider = result.source ? `${this.id}:${result.source}` : this.id;
    if (!result.listed) {
      return { verdict: 'clear', reasons: result.reasons ?? [], provider, evaluatedAt: this.now() };
    }
    const verdict = result.severity === 'flagged' ? 'flagged' : 'blocked';
    return {
      verdict,
      reasons:
        result.reasons && result.reasons.length > 0
          ? result.reasons
          : [`counterparty listed by ${provider}`],
      provider,
      evaluatedAt: this.now(),
    };
  }

  private onOracleError(cp: Counterparty, err: unknown): SanctionScreening {
    const message = err instanceof Error ? err.message : String(err);
    const reason = `sanctions oracle unavailable (${this.id}): ${message}`;
    if (this.onError === 'allow') {
      return { verdict: 'clear', reasons: [reason], provider: this.id, evaluatedAt: this.now() };
    }
    return {
      verdict: this.onError === 'flag' ? 'flagged' : 'blocked',
      reasons: [reason, `fail-closed (onError=${this.onError}) for ${cp.id}`],
      provider: this.id,
      evaluatedAt: this.now(),
    };
  }

  /** Drop a cached verdict (e.g. on a list-update webhook) so it re-queries. */
  invalidate(cp: Counterparty): void {
    this.cache.delete(this.key(cp));
  }

  /** Clear the entire cache — forces a fresh oracle query for every counterparty. */
  clearCache(): void {
    this.cache.clear();
  }
}
