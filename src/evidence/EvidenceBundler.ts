/**
 * @module @veridex/agents-treasury/evidence/EvidenceBundler
 *
 * Captures runtime trace events, policy verdicts, approvals, proposals,
 * and chain tx refs for the lifetime of a run, then assembles a signed
 * {@link EvidenceBundle} on close. Submission to the relayer is delegated
 * to a {@link PortalTelemetry}-shaped client (see ../portal/PortalTelemetry).
 */

import type { EvidenceBundle } from '../types';
import {
  canonicalJson,
  contentHash as sha256Hex,
  type EvidenceSigner,
} from './EvidenceSigner';

export interface BundleSubmitter {
  submitEvidence(bundle: EvidenceBundle): Promise<void>;
}

export interface EvidenceBundlerOptions {
  appId: string;
  runId: string;
  agentId: string;
  signer: EvidenceSigner;
  submitter?: BundleSubmitter;
  teeAttestation?: string;
}

export class EvidenceBundler {
  private traces: Array<Record<string, unknown>> = [];
  private policyVerdicts: Array<Record<string, unknown>> = [];
  private approvals: Array<Record<string, unknown>> = [];
  private proposals: Array<Record<string, unknown>> = [];
  private chainTxRefs: string[] = [];

  constructor(private readonly opts: EvidenceBundlerOptions) {}

  recordTrace(event: Record<string, unknown>): void {
    this.traces.push(event);
  }
  recordPolicyVerdict(verdict: Record<string, unknown>): void {
    this.policyVerdicts.push(verdict);
  }
  recordApproval(approval: Record<string, unknown>): void {
    this.approvals.push(approval);
  }
  recordProposal(proposal: Record<string, unknown>): void {
    this.proposals.push(proposal);
  }
  recordChainTx(ref: string): void {
    this.chainTxRefs.push(ref);
  }

  /** Assemble + sign + (optionally) submit. */
  async finalize(now = Date.now()): Promise<EvidenceBundle> {
    const skeleton: Omit<EvidenceBundle, 'contentHash' | 'signature' | 'sigAlg' | 'keyId'> = {
      version: '1',
      appId: this.opts.appId,
      runId: this.opts.runId,
      agentId: this.opts.agentId,
      bundledAt: now,
      traces: this.traces,
      policyVerdicts: this.policyVerdicts,
      approvals: this.approvals,
      proposals: this.proposals,
      chainTxRefs: this.chainTxRefs,
      ...(this.opts.teeAttestation ? { teeAttestation: this.opts.teeAttestation } : {}),
    };
    const canonical = canonicalJson(skeleton);
    const bytes = new TextEncoder().encode(canonical);
    const hash = sha256Hex(bytes);
    const sigPayload = new TextEncoder().encode(hash);
    const { signature, sigAlg, keyId } = await this.opts.signer.sign(sigPayload);
    const bundle: EvidenceBundle = {
      ...skeleton,
      contentHash: hash,
      signature,
      sigAlg,
      keyId,
    };
    if (this.opts.submitter) {
      try {
        await this.opts.submitter.submitEvidence(bundle);
      } catch (err) {
        // Submission failure does not invalidate the bundle; surface for caller.
        (bundle as unknown as { submissionError?: string }).submissionError =
          err instanceof Error ? err.message : String(err);
      }
    }
    return bundle;
  }
}

/**
 * Verify a bundle: recompute canonical hash and verify signature.
 * Throws on tamper; returns true on success.
 */
export async function verifyEvidenceBundle(
  bundle: EvidenceBundle,
  signer: EvidenceSigner,
): Promise<boolean> {
  const { contentHash: storedHash, signature, sigAlg, keyId, ...rest } = bundle;
  void sigAlg;
  void keyId;
  const canonical = canonicalJson(rest);
  const bytes = new TextEncoder().encode(canonical);
  const recomputed = sha256Hex(bytes);
  if (recomputed !== storedHash) {
    throw new Error('evidence bundle contentHash mismatch — tampered');
  }
  const sigPayload = new TextEncoder().encode(storedHash);
  return signer.verify(sigPayload, signature);
}
