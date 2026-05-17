import { describe, it, expect } from 'vitest';
import { SpendCeilings } from '../src/ceilings/SpendCeilings';
import type { Money } from '../src/types';

const usdc = (amt: string): Money => ({ amount: amt, currency: 'USDC', decimals: 6 });

describe('SpendCeilings', () => {
  it('allows below limit and blocks above', () => {
    const c = new SpendCeilings([
      { window: 'day', limit: '1000000000', currency: 'USDC', decimals: 6 },
    ]);
    expect(c.probe({ scope: 'a', amount: usdc('500000000') }).allowed).toBe(true);
    c.record({ scope: 'a', amount: usdc('500000000') });
    const v = c.probe({ scope: 'a', amount: usdc('600000000') });
    expect(v.allowed).toBe(false);
    expect(v.violatedWindow).toBe('day');
  });

  it('isolates scope', () => {
    const c = new SpendCeilings([
      { window: 'day', limit: '1000000000', currency: 'USDC', decimals: 6 },
    ]);
    c.record({ scope: 'a', amount: usdc('900000000') });
    expect(c.probe({ scope: 'b', amount: usdc('900000000') }).allowed).toBe(true);
  });

  it('hourly window expires', () => {
    const c = new SpendCeilings([
      { window: 'hour', limit: '100', currency: 'USDC', decimals: 6 },
    ]);
    const longAgo = Date.now() - 2 * 60 * 60 * 1000;
    c.record({ scope: 'a', amount: usdc('100'), now: longAgo });
    expect(c.probe({ scope: 'a', amount: usdc('100') }).allowed).toBe(true);
  });
});
