/**
 * OracleSanctionScreener tests — real-time sanctions gating with TTL cache
 * and fail-closed error handling (Gap 3: sanctions-list drift).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  OracleSanctionScreener,
  type SanctionOracle,
  type SanctionOracleResult,
} from '../src/sanctions/OracleSanctionScreener';
import type { Counterparty } from '../src/types';

function cp(overrides: Partial<Counterparty> = {}): Counterparty {
  return {
    id: 'eip155:1:0xabc',
    chain: 'ethereum',
    address: '0xABC',
    ...overrides,
  };
}

function oracleReturning(
  result: SanctionOracleResult | (() => Promise<SanctionOracleResult>),
): { oracle: SanctionOracle; check: ReturnType<typeof vi.fn> } {
  const check = vi.fn(async () => (typeof result === 'function' ? result() : result));
  return { oracle: { id: 'test-oracle', check }, check };
}

describe('OracleSanctionScreener', () => {
  it('returns clear for an unlisted counterparty', async () => {
    const { oracle } = oracleReturning({ listed: false });
    const screener = new OracleSanctionScreener(oracle);
    const result = await screener.screen(cp());
    expect(result.verdict).toBe('clear');
  });

  it('blocks a listed counterparty', async () => {
    const { oracle } = oracleReturning({ listed: true, severity: 'blocked', source: 'ofac-sdn' });
    const screener = new OracleSanctionScreener(oracle);
    const result = await screener.screen(cp());
    expect(result.verdict).toBe('blocked');
    expect(result.provider).toContain('ofac-sdn');
  });

  it('flags (not blocks) a counterparty when severity is flagged', async () => {
    const { oracle } = oracleReturning({ listed: true, severity: 'flagged' });
    const screener = new OracleSanctionScreener(oracle);
    expect((await screener.screen(cp())).verdict).toBe('flagged');
  });

  it('caches within the TTL and re-queries after it expires', async () => {
    let t = 1_000;
    const { oracle, check } = oracleReturning({ listed: false });
    const screener = new OracleSanctionScreener(oracle, { cacheTtlMs: 500, now: () => t });

    await screener.screen(cp());
    await screener.screen(cp());
    expect(check).toHaveBeenCalledTimes(1); // second hit served from cache

    t += 600; // advance past TTL
    await screener.screen(cp());
    expect(check).toHaveBeenCalledTimes(2); // re-queried — bounds list drift
  });

  it('catches an address sanctioned mid-run once the cache expires', async () => {
    let t = 0;
    let listed = false;
    const oracle: SanctionOracle = { id: 'drift', check: vi.fn(async () => ({ listed })) };
    const screener = new OracleSanctionScreener(oracle, { cacheTtlMs: 100, now: () => t });

    expect((await screener.screen(cp())).verdict).toBe('clear');
    // Address gets added to the list after the agent started.
    listed = true;
    t += 150;
    expect((await screener.screen(cp())).verdict).toBe('blocked');
  });

  it('fail-closed: blocks when the oracle throws (default)', async () => {
    const oracle: SanctionOracle = {
      id: 'down',
      check: vi.fn(async () => {
        throw new Error('oracle timeout');
      }),
    };
    const screener = new OracleSanctionScreener(oracle);
    const result = await screener.screen(cp());
    expect(result.verdict).toBe('blocked');
    expect(result.reasons.join(' ')).toMatch(/unavailable/i);
  });

  it('does not cache an error verdict (re-queries next call)', async () => {
    let fail = true;
    const check = vi.fn(async () => {
      if (fail) throw new Error('down');
      return { listed: false } as SanctionOracleResult;
    });
    const screener = new OracleSanctionScreener({ id: 'flaky', check });

    expect((await screener.screen(cp())).verdict).toBe('blocked'); // errored, fail-closed
    fail = false;
    expect((await screener.screen(cp())).verdict).toBe('clear'); // recovered, not stuck on cached error
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('honors onError=allow (fail-open) when explicitly configured', async () => {
    const oracle: SanctionOracle = {
      id: 'down',
      check: vi.fn(async () => {
        throw new Error('down');
      }),
    };
    const screener = new OracleSanctionScreener(oracle, { onError: 'allow' });
    expect((await screener.screen(cp())).verdict).toBe('clear');
  });

  it('invalidate() forces a fresh query for a counterparty', async () => {
    const { oracle, check } = oracleReturning({ listed: false });
    const screener = new OracleSanctionScreener(oracle, { cacheTtlMs: 10_000 });
    await screener.screen(cp());
    screener.invalidate(cp());
    await screener.screen(cp());
    expect(check).toHaveBeenCalledTimes(2);
  });
});
