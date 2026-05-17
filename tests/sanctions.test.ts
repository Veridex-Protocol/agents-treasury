import { describe, it, expect } from 'vitest';
import {
  NoopSanctionScreener,
  DenylistSanctionScreener,
  AllowlistSanctionScreener,
  CompositeSanctionScreener,
} from '../src/sanctions/SanctionScreener';
import type { Counterparty } from '../src/types';

const cp: Counterparty = { id: 'vendor:1', chain: 'eth', address: '0xabc' };
const bad: Counterparty = { id: 'evil', chain: 'eth', address: '0xdead' };

describe('SanctionScreener', () => {
  it('noop is always clear', async () => {
    expect((await new NoopSanctionScreener().screen(cp)).verdict).toBe('clear');
  });

  it('denylist blocks matches by id', async () => {
    const s = new DenylistSanctionScreener(new Set(['evil']));
    expect((await s.screen(bad)).verdict).toBe('blocked');
    expect((await s.screen(cp)).verdict).toBe('clear');
  });

  it('denylist blocks matches by address', async () => {
    const s = new DenylistSanctionScreener(new Set(['0xdead']));
    expect((await s.screen(bad)).verdict).toBe('blocked');
  });

  it('allowlist only allows known', async () => {
    const s = new AllowlistSanctionScreener(new Set(['vendor:1']));
    expect((await s.screen(cp)).verdict).toBe('clear');
    expect((await s.screen(bad)).verdict).toBe('blocked');
  });

  it('composite shorts on first non-clear', async () => {
    const s = new CompositeSanctionScreener([
      new NoopSanctionScreener(),
      new DenylistSanctionScreener(new Set(['evil'])),
    ]);
    expect((await s.screen(bad)).verdict).toBe('blocked');
    expect((await s.screen(cp)).verdict).toBe('clear');
  });
});
