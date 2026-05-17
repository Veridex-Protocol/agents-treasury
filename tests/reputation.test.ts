import { describe, it, expect } from 'vitest';
import {
  StaticReputationProvider,
  SbtReputationProvider,
} from '../src/reputation/SbtReputationProvider';

describe('StaticReputationProvider', () => {
  it('returns null for unknown', async () => {
    const p = new StaticReputationProvider(new Map());
    expect(await p.lookup('x')).toBeNull();
  });

  it('returns stored attestation', async () => {
    const p = new StaticReputationProvider(
      new Map([['v', { subjectId: 'v', score: 75, issuer: 'i', issuedAt: 1 }]]),
    );
    const r = await p.lookup('v');
    expect(r?.score).toBe(75);
  });
});

describe('SbtReputationProvider', () => {
  it('clamps score and omits missing proof', async () => {
    const p = new SbtReputationProvider({
      async getReputation(_id) {
        return { score: 150, issuer: 'sbt', issuedAt: 1 };
      },
    });
    const r = await p.lookup('subj');
    expect(r?.score).toBe(100);
    expect(r?.proof).toBeUndefined();
  });

  it('preserves proof when present', async () => {
    const p = new SbtReputationProvider({
      async getReputation(_id) {
        return { score: 50, issuer: 'sbt', issuedAt: 1, proof: '0xdeadbeef' };
      },
    });
    const r = await p.lookup('subj');
    expect(r?.proof).toBe('0xdeadbeef');
  });

  it('returns null when client returns null', async () => {
    const p = new SbtReputationProvider({ async getReputation() { return null; } });
    expect(await p.lookup('x')).toBeNull();
  });
});
