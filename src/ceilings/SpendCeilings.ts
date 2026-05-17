/**
 * @module @veridex/agents-treasury/ceilings
 *
 * Spend ceilings tracker — enforces rolling-window limits across
 * hourly/daily/monthly/lifetime budgets per (currency, scope).
 *
 * The tracker is queried by the treasury policy pack and recorded
 * against on transfer commit. Storage is pluggable; default impl is
 * in-memory for single-process use.
 */

import { moneyToBigInt, type Money } from '../types';

export type CeilingWindow = 'hour' | 'day' | 'month' | 'lifetime';

export interface CeilingLimit {
  window: CeilingWindow;
  /** Limit in the asset's smallest unit, as a string-encoded integer. */
  limit: string;
  /** Currency this limit applies to (must match the Money currency). */
  currency: string;
  decimals: number;
}

export interface CeilingProbe {
  /** Aggregation scope, e.g. agentId, appId, sessionKey. */
  scope: string;
  amount: Money;
  now?: number;
}

export interface CeilingVerdict {
  allowed: boolean;
  violatedWindow?: CeilingWindow;
  remaining?: string;
  reason?: string;
}

function windowStart(window: CeilingWindow, now: number): number {
  switch (window) {
    case 'hour':
      return now - 60 * 60 * 1000;
    case 'day':
      return now - 24 * 60 * 60 * 1000;
    case 'month':
      return now - 30 * 24 * 60 * 60 * 1000;
    case 'lifetime':
      return 0;
  }
}

interface SpendEntry {
  scope: string;
  amount: bigint;
  currency: string;
  decimals: number;
  ts: number;
}

export class SpendCeilings {
  private entries: SpendEntry[] = [];
  private limits: CeilingLimit[];

  constructor(limits: CeilingLimit[] = []) {
    this.limits = [...limits];
  }

  /** Add or replace a limit. */
  setLimit(limit: CeilingLimit): void {
    const idx = this.limits.findIndex(
      (l) => l.window === limit.window && l.currency === limit.currency,
    );
    if (idx >= 0) this.limits[idx] = limit;
    else this.limits.push(limit);
  }

  /** Inspect — would this proposal violate any window? */
  probe(probe: CeilingProbe): CeilingVerdict {
    const now = probe.now ?? Date.now();
    const amount = moneyToBigInt(probe.amount);
    const applicable = this.limits.filter((l) => l.currency === probe.amount.currency);
    for (const lim of applicable) {
      const since = windowStart(lim.window, now);
      const used = this.sumScopeSince(probe.scope, lim.currency, since);
      const limit = BigInt(lim.limit);
      if (used + amount > limit) {
        const remaining = limit > used ? (limit - used).toString() : '0';
        return {
          allowed: false,
          violatedWindow: lim.window,
          remaining,
          reason: `${lim.window} ceiling exceeded: used ${used} + proposed ${amount} > limit ${limit} ${lim.currency}`,
        };
      }
    }
    return { allowed: true };
  }

  /** Record a committed spend. Must be called only after successful execution. */
  record(probe: CeilingProbe): void {
    const now = probe.now ?? Date.now();
    this.entries.push({
      scope: probe.scope,
      amount: moneyToBigInt(probe.amount),
      currency: probe.amount.currency,
      decimals: probe.amount.decimals,
      ts: now,
    });
  }

  private sumScopeSince(scope: string, currency: string, since: number): bigint {
    let total = 0n;
    for (const e of this.entries) {
      if (e.scope === scope && e.currency === currency && e.ts >= since) {
        total += e.amount;
      }
    }
    return total;
  }

  reset(): void {
    this.entries = [];
  }
}
