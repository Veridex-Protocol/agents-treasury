/**
 * @module @veridex/agents-treasury/sanctions
 *
 * Counterparty screening interfaces and built-in providers. Real
 * deployments plug in a vendor (Chainalysis, TRM, Elliptic) by
 * implementing {@link SanctionScreener}. The provider runs before
 * policy evaluation and short-circuits any blocked counterparty.
 */

import type { Counterparty, SanctionScreening } from '../types';

export interface SanctionScreener {
  readonly id: string;
  screen(counterparty: Counterparty): Promise<SanctionScreening>;
}

/** Always returns `clear`. Useful for tests and demo flows. */
export class NoopSanctionScreener implements SanctionScreener {
  readonly id = 'noop';
  async screen(_cp: Counterparty): Promise<SanctionScreening> {
    return {
      verdict: 'clear',
      reasons: ['noop screener'],
      provider: this.id,
      evaluatedAt: Date.now(),
    };
  }
}

/** Block any counterparty whose `id` or `address` matches the denylist. */
export class DenylistSanctionScreener implements SanctionScreener {
  readonly id = 'denylist';
  constructor(private readonly denied: ReadonlySet<string>) {}

  async screen(cp: Counterparty): Promise<SanctionScreening> {
    const hit =
      this.denied.has(cp.id) ||
      this.denied.has(cp.address) ||
      (cp.address && this.denied.has(cp.address.toLowerCase()));
    return {
      verdict: hit ? 'blocked' : 'clear',
      reasons: hit ? [`counterparty matched denylist: ${cp.id}`] : [],
      provider: this.id,
      evaluatedAt: Date.now(),
    };
  }
}

/** Allow only counterparties whose `id` or `address` is on the allowlist. */
export class AllowlistSanctionScreener implements SanctionScreener {
  readonly id = 'allowlist';
  constructor(private readonly allowed: ReadonlySet<string>) {}

  async screen(cp: Counterparty): Promise<SanctionScreening> {
    const hit = this.allowed.has(cp.id) || this.allowed.has(cp.address);
    return {
      verdict: hit ? 'clear' : 'blocked',
      reasons: hit ? [] : [`counterparty not on allowlist: ${cp.id}`],
      provider: this.id,
      evaluatedAt: Date.now(),
    };
  }
}

/** Compose multiple screeners; the first non-clear verdict wins. */
export class CompositeSanctionScreener implements SanctionScreener {
  readonly id: string;
  constructor(private readonly screeners: SanctionScreener[]) {
    this.id = `composite[${screeners.map((s) => s.id).join(',')}]`;
  }

  async screen(cp: Counterparty): Promise<SanctionScreening> {
    const reasons: string[] = [];
    for (const s of this.screeners) {
      const r = await s.screen(cp);
      reasons.push(...r.reasons);
      if (r.verdict !== 'clear') {
        return { ...r, reasons, provider: this.id };
      }
    }
    return {
      verdict: 'clear',
      reasons,
      provider: this.id,
      evaluatedAt: Date.now(),
    };
  }
}
