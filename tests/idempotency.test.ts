import { describe, it, expect } from 'vitest';
import { InMemoryIdempotencyStore } from '../src/idempotency/IdempotencyStore';

describe('InMemoryIdempotencyStore', () => {
  it('reserves and commits a result', async () => {
    const s = new InMemoryIdempotencyStore();
    await s.reserve('k1', 60_000);
    expect(await s.get('k1')).toBeUndefined();
    await s.commit('k1', { txHash: '0xabc' });
    const got = await s.get<{ txHash: string }>('k1');
    expect(got?.result.txHash).toBe('0xabc');
  });

  it('refuses double reservation', async () => {
    const s = new InMemoryIdempotencyStore();
    await s.reserve('k1', 60_000);
    await expect(s.reserve('k1', 60_000)).rejects.toThrow(/already reserved/);
  });

  it('release allows re-reservation', async () => {
    const s = new InMemoryIdempotencyStore();
    await s.reserve('k1', 60_000);
    await s.release('k1');
    await expect(s.reserve('k1', 60_000)).resolves.toBeUndefined();
  });

  it('commit on unreserved key throws', async () => {
    const s = new InMemoryIdempotencyStore();
    await expect(s.commit('missing', {})).rejects.toThrow(/non-reserved/);
  });
});
