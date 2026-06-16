import { describe, it, expect } from 'vitest';
import { HmacEvidenceSigner } from '../src/evidence/EvidenceSigner';
import { EvidenceBundler } from '../src/evidence/EvidenceBundler';
import {
  FilecoinEvidenceStore,
  InMemoryFilecoinClient,
  computeCidV1Raw,
  serializeBundle,
} from '../src/evidence/FilecoinEvidenceStore';

function signer() {
  return new HmacEvidenceSigner('test-key', new Uint8Array(32).fill(7));
}

async function makeBundle() {
  const bundler = new EvidenceBundler({
    appId: 'app-1',
    runId: 'run-1',
    agentId: 'agent-1',
    signer: signer(),
  });
  bundler.recordTrace({ type: 'tool_call', name: 'transfer' });
  bundler.recordPolicyVerdict({ decision: 'allow' });
  bundler.recordChainTx('0xdeadbeef');
  return bundler.finalize(1700000000000);
}

describe('computeCidV1Raw', () => {
  it('is deterministic and uses the CIDv1 base32 prefix', () => {
    const bytes = new TextEncoder().encode('hello filecoin');
    const cid = computeCidV1Raw(bytes);
    expect(cid).toBe(computeCidV1Raw(bytes));
    expect(cid.startsWith('b')).toBe(true);
  });

  it('changes when bytes change', () => {
    const a = computeCidV1Raw(new TextEncoder().encode('a'));
    const b = computeCidV1Raw(new TextEncoder().encode('b'));
    expect(a).not.toBe(b);
  });
});

describe('FilecoinEvidenceStore', () => {
  it('stores a bundle and returns a receipt with a content-derived CID', async () => {
    const bundle = await makeBundle();
    const client = new InMemoryFilecoinClient();
    const store = new FilecoinEvidenceStore({ client, signer: signer() });

    const receipt = await store.store(bundle);

    expect(receipt.cid).toBe(computeCidV1Raw(serializeBundle(bundle)));
    expect(receipt.contentHash).toBe(bundle.contentHash);
    expect(receipt.appId).toBe('app-1');
    expect(receipt.runId).toBe('run-1');
    expect(receipt.size).toBeGreaterThan(0);
    expect(receipt.provider).toBe('memory');
  });

  it('round-trips: retrieveAndVerify returns the original bundle', async () => {
    const bundle = await makeBundle();
    const client = new InMemoryFilecoinClient();
    const store = new FilecoinEvidenceStore({ client, signer: signer() });

    const receipt = await store.store(bundle);
    const got = await store.retrieveAndVerify(receipt.cid);

    expect(got.contentHash).toBe(bundle.contentHash);
    expect(got.runId).toBe(bundle.runId);
    expect(got.chainTxRefs).toEqual(['0xdeadbeef']);
  });

  it('works as an EvidenceBundler submitter', async () => {
    const client = new InMemoryFilecoinClient();
    const store = new FilecoinEvidenceStore({ client, signer: signer() });
    const bundler = new EvidenceBundler({
      appId: 'app-2',
      runId: 'run-2',
      agentId: 'agent-2',
      signer: signer(),
      submitter: store,
    });
    bundler.recordTrace({ type: 'reasoning', text: 'I will transfer funds' });
    const bundle = await bundler.finalize(1700000000001);

    const cid = computeCidV1Raw(serializeBundle(bundle));
    const got = await store.retrieveAndVerify(cid);
    expect(got.runId).toBe('run-2');
  });

  it('detects tampering on retrieval', async () => {
    const bundle = await makeBundle();
    const client = new InMemoryFilecoinClient();
    const store = new FilecoinEvidenceStore({ client, signer: signer() });
    const receipt = await store.store(bundle);

    // Corrupt the stored block under the same CID key.
    const tampered = { ...bundle, traces: [{ type: 'evil' }] };
    // @ts-expect-error reach into the private map for the test only
    client.blocks.set(receipt.cid, serializeBundle(tampered as never));

    await expect(store.retrieveAndVerify(receipt.cid)).rejects.toThrow(/content-address/);
  });

  it('refuses to store a bundle whose contentHash drifted from its contents', async () => {
    const bundle = await makeBundle();
    const client = new InMemoryFilecoinClient();
    const store = new FilecoinEvidenceStore({ client, signer: signer() });

    const drifted = { ...bundle, contentHash: 'deadbeef'.repeat(8) };
    await expect(store.store(drifted)).rejects.toThrow(/does not match/);
  });

  it('requires a signer for retrieveAndVerify', async () => {
    const bundle = await makeBundle();
    const client = new InMemoryFilecoinClient();
    const store = new FilecoinEvidenceStore({ client });
    const receipt = await store.store(bundle);

    await expect(store.retrieveAndVerify(receipt.cid)).rejects.toThrow(/signer is required/);
  });
});
