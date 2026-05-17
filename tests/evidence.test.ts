import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  contentHash,
  HmacEvidenceSigner,
  NoopEvidenceSigner,
} from '../src/evidence/EvidenceSigner';
import { EvidenceBundler, verifyEvidenceBundle } from '../src/evidence/EvidenceBundler';

describe('canonicalJson', () => {
  it('sorts keys deterministically', () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it('handles nested objects and arrays', () => {
    const s = canonicalJson({ z: [3, 2, 1], a: { y: 1, x: 2 } });
    expect(s).toBe('{"a":{"x":2,"y":1},"z":[3,2,1]}');
  });

  it('rejects cycles', () => {
    const o: Record<string, unknown> = {};
    o['self'] = o;
    expect(() => canonicalJson(o)).toThrow(/cycle/);
  });
});

describe('HmacEvidenceSigner', () => {
  it('signs and verifies', async () => {
    const secret = new Uint8Array(32).fill(7);
    const signer = new HmacEvidenceSigner('test-key', secret);
    const bytes = new TextEncoder().encode('hello');
    const sig = await signer.sign(bytes);
    expect(sig.sigAlg).toBe('hmac-sha256');
    expect(await signer.verify(bytes, sig.signature)).toBe(true);
  });

  it('rejects tampered message', async () => {
    const signer = new HmacEvidenceSigner('k', new Uint8Array(32).fill(1));
    const sig = await signer.sign(new TextEncoder().encode('a'));
    expect(await signer.verify(new TextEncoder().encode('b'), sig.signature)).toBe(false);
  });

  it('rejects short secret', () => {
    expect(() => new HmacEvidenceSigner('k', new Uint8Array(8))).toThrow();
  });
});

describe('EvidenceBundler', () => {
  it('produces verifiable signed bundle', async () => {
    const signer = new HmacEvidenceSigner('k1', new Uint8Array(32).fill(9));
    const b = new EvidenceBundler({
      appId: 'app1',
      runId: 'run1',
      agentId: 'agent1',
      signer,
    });
    b.recordTrace({ kind: 'tool', name: 'treasury.balance' });
    b.recordPolicyVerdict({ ruleId: 'r', verdict: 'pass' });
    b.recordApproval({ kind: 'request' });
    b.recordChainTx('0xabc');
    const bundle = await b.finalize();
    expect(bundle.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.sigAlg).toBe('hmac-sha256');
    expect(await verifyEvidenceBundle(bundle, signer)).toBe(true);
  });

  it('detects tamper', async () => {
    const signer = new HmacEvidenceSigner('k1', new Uint8Array(32).fill(2));
    const b = new EvidenceBundler({ appId: 'a', runId: 'r', agentId: 'g', signer });
    b.recordTrace({ x: 1 });
    const bundle = await b.finalize();
    (bundle.traces[0] as Record<string, unknown>)['x'] = 999;
    await expect(verifyEvidenceBundle(bundle, signer)).rejects.toThrow(/tampered/);
  });

  it('noop signer round-trips', async () => {
    const signer = new NoopEvidenceSigner();
    const b = new EvidenceBundler({ appId: 'a', runId: 'r', agentId: 'g', signer });
    const bundle = await b.finalize();
    expect(bundle.sigAlg).toBe('none');
    expect(await verifyEvidenceBundle(bundle, signer)).toBe(true);
  });

  it('submitter is invoked on finalize', async () => {
    const signer = new NoopEvidenceSigner();
    const submitted: unknown[] = [];
    const b = new EvidenceBundler({
      appId: 'a',
      runId: 'r',
      agentId: 'g',
      signer,
      submitter: { submitEvidence: async (x) => void submitted.push(x) },
    });
    await b.finalize();
    expect(submitted).toHaveLength(1);
  });
});

describe('contentHash', () => {
  it('is sha256 hex', () => {
    const h = contentHash(new TextEncoder().encode('abc'));
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
