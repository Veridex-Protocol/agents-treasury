/**
 * Veridex evidence demo: an agent action becomes a signed, content-addressed
 * receipt, gets verified, and a tampered copy is rejected. Offline, ~1 second.
 *
 *   cd packages/agents-treasury && bun run demo/evidence-demo.ts
 */

import { HmacEvidenceSigner } from '../src/evidence/EvidenceSigner';
import { EvidenceBundler } from '../src/evidence/EvidenceBundler';
import {
  FilecoinEvidenceStore as EvidenceStore,
  InMemoryFilecoinClient as InMemoryStorage,
  serializeBundle,
} from '../src/evidence/FilecoinEvidenceStore';

const line = (s = '') => console.log(s);

async function main() {
  const signer = new HmacEvidenceSigner('veridex-demo-key', new Uint8Array(32).fill(7));
  const storage = new InMemoryStorage();
  const store = new EvidenceStore({ client: storage, signer });

  line('Veridex evidence demo');
  line('======================');
  line();

  // 1) An agent takes a money-moving action. Veridex records the whole decision.
  line('1) An AI agent pays $5 for compute. Veridex records the authorization.');
  const bundler = new EvidenceBundler({
    appId: 'demo-app',
    runId: 'run-001',
    agentId: 'agent-akash-buyer',
    signer,
  });
  bundler.recordTrace({ action: 'pay_for_compute', amountUSD: 5, recipient: 'akash-provider' });
  bundler.recordPolicyVerdict({ decision: 'allow', reasons: ['within budget', 'recipient allow-listed'] });
  bundler.recordChainTx('0xsettlement_5usd');
  const bundle = await bundler.finalize();

  const receipt = await store.store(bundle);
  line(`   signed, content-addressed receipt created`);
  line(`   CID:         ${receipt.cid}`);
  line(`   contentHash: ${receipt.contentHash.slice(0, 24)}...`);
  line();

  // 2) Anyone can retrieve and verify it (content-address + hash + signature).
  line('2) An auditor retrieves and verifies the receipt.');
  const verified = await store.retrieveAndVerify(receipt.cid);
  line(`   VERIFIED. amount=$${(verified.traces[0] as { amountUSD: number }).amountUSD}, policy=${(verified.policyVerdicts[0] as { decision: string }).decision}`);
  line();

  // 3) Now someone tampers the record: change the $5 to $5000.
  line('3) Someone tampers the stored record: changes $5 to $5000.');
  const tampered = { ...bundle, traces: [{ action: 'pay_for_compute', amountUSD: 5000, recipient: 'attacker' }] };
  // Overwrite the stored bytes under the same CID.
  (storage as unknown as { blocks: Map<string, Uint8Array> }).blocks.set(
    receipt.cid,
    serializeBundle(tampered as never),
  );

  try {
    await store.retrieveAndVerify(receipt.cid);
    line('   (unexpected) verification passed');
  } catch {
    line('   REJECTED. The altered bytes no longer match the receipt content address.');
    line('   Verification fails before any auditor would trust the record.');
  }
  line();
  line('The record cannot be quietly altered, even by the operator. That is the point.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
