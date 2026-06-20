/**
 * @module @veridex/agents-treasury/evidence/FilecoinEvidenceStore
 *
 * Persists signed {@link EvidenceBundle}s to Filecoin as the system of
 * record for agent audit trails ("Thought Traces" / the "Agent Black Box").
 *
 * Design goals
 * ------------
 * - **No SDK pinned.** Following the {@link Ed25519Primitives} pattern, the
 *   actual Filecoin upload/retrieval is injected via a {@link FilecoinStorageClient}
 *   so callers can wire Filecoin Onchain Cloud / FilecoinPay / Synapse / a
 *   warm-storage provider of their choice without this package taking a hard
 *   dependency on any of them.
 * - **Deterministic, independently verifiable content addressing.** Each bundle
 *   is canonicalised, hashed, and addressed by a CIDv1 (raw codec, sha2-256)
 *   computed locally with no external dependency. Any IPFS/Filecoin tool can
 *   re-derive the same CID from the stored bytes.
 * - **Tamper-evident retrieval.** {@link FilecoinEvidenceStore.retrieveAndVerify}
 *   re-hashes the retrieved bytes, checks them against the bundle's own
 *   `contentHash`, and verifies the signature — so a retrieval is only trusted
 *   if the bytes are byte-for-byte the signed original.
 *
 * It implements {@link BundleSubmitter}, so it can be passed directly as the
 * `submitter` on an {@link EvidenceBundler} to write every finalized bundle to
 * Filecoin as a side effect of `finalize()`.
 */

import { createHash } from 'node:crypto';
import type { EvidenceBundle } from '../types';
import type { BundleSubmitter } from './EvidenceBundler';
import { canonicalJson, type EvidenceSigner } from './EvidenceSigner';

/**
 * The result of placing a piece of content on Filecoin. `cid` is required;
 * everything else is provider-specific and recorded for audit/billing.
 */
export interface FilecoinPutResult {
  /** Authoritative CID returned by the storage provider, if any. */
  cid?: string;
  /** Filecoin piece CID (the commP), when the provider exposes it. */
  pieceCid?: string;
  /** On-chain deal id / deal-making tx, when the provider exposes it. */
  dealId?: string;
  /** Provider name for evidence (e.g. "onchain-cloud", "synapse", "memory"). */
  provider?: string;
  /** Provider-reported size in bytes. */
  size?: number;
}

/**
 * Minimal Filecoin storage surface. Implementations wrap a concrete SDK
 * (Filecoin Onchain Cloud, Synapse, lighthouse, web3.storage, ...).
 */
export interface FilecoinStorageClient {
  /** Upload bytes and make (or queue) a storage deal. */
  put(bytes: Uint8Array, opts?: FilecoinPutOptions): Promise<FilecoinPutResult>;
  /** Retrieve bytes previously stored under `cid`. */
  get(cid: string): Promise<Uint8Array>;
}

export interface FilecoinPutOptions {
  /** Retention period in seconds the deal should guarantee (WORM/compliance). */
  retentionSeconds?: number;
  /** Opaque metadata to attach to the deal (appId, runId, ...) for indexing. */
  metadata?: Record<string, string>;
}

/**
 * Receipt returned after a bundle is persisted. This is the object a caller
 * commits on-chain (link `cid` to the originating payment tx) and shows in the
 * dispute-resolution dashboard.
 */
export interface EvidenceStorageReceipt {
  /** Locally-derived CIDv1 (raw, sha2-256) of the canonical bundle bytes. */
  cid: string;
  /** Provider-reported CID, if it differs from {@link cid}. */
  providerCid?: string;
  pieceCid?: string;
  dealId?: string;
  provider?: string;
  /** sha-256 hex of the canonical bytes — equals `bundle.contentHash`. */
  contentHash: string;
  /** Size of the stored canonical bytes. */
  size: number;
  /** Unix-ms when the bundle was stored. */
  storedAt: number;
  /** appId/runId/agentId copied from the bundle for indexing. */
  appId: string;
  runId: string;
  agentId: string;
}

export interface FilecoinEvidenceStoreOptions {
  client: FilecoinStorageClient;
  /**
   * Signer used to verify retrieved bundles. Must correspond to the key that
   * signed them. Optional at construction; required for {@link retrieveAndVerify}.
   */
  signer?: EvidenceSigner;
  /** Default retention applied to every deal (e.g. 7y for compliance). */
  defaultRetentionSeconds?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/** Canonical serialization used for both hashing and storage. Stable bytes. */
export function serializeBundle(bundle: EvidenceBundle): Uint8Array {
  return new TextEncoder().encode(canonicalJson(bundle));
}

/**
 * Compute a CIDv1 (multibase base32, raw codec 0x55, multihash sha2-256) for
 * arbitrary bytes — deterministic and re-derivable by any IPFS tooling for a
 * single raw block. No external dependency.
 */
export function computeCidV1Raw(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest();
  // multihash = <sha2-256 code 0x12><len 0x20><32-byte digest>
  const multihash = new Uint8Array(2 + digest.length);
  multihash[0] = 0x12;
  multihash[1] = digest.length; // 0x20
  multihash.set(digest, 2);
  // cid = <version 0x01><raw codec 0x55><multihash>
  const cidBytes = new Uint8Array(2 + multihash.length);
  cidBytes[0] = 0x01;
  cidBytes[1] = 0x55;
  cidBytes.set(multihash, 2);
  return `b${base32LowerNoPad(cidBytes)}`;
}

/** RFC 4648 base32 (lowercase, no padding) — the IPFS CIDv1 default. */
function base32LowerNoPad(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}

export class FilecoinEvidenceStore implements BundleSubmitter {
  private readonly client: FilecoinStorageClient;
  private readonly signer: EvidenceSigner | undefined;
  private readonly defaultRetentionSeconds: number | undefined;
  private readonly now: () => number;

  constructor(opts: FilecoinEvidenceStoreOptions) {
    this.client = opts.client;
    this.signer = opts.signer;
    this.defaultRetentionSeconds = opts.defaultRetentionSeconds;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Persist a bundle to Filecoin and return its receipt. The locally computed
   * CID is derived from the exact bytes uploaded, so it is independently
   * verifiable. We also assert the bundle's own `contentHash` matches the
   * recomputed canonical hash before storing, so we never persist a bundle
   * whose hash field has drifted from its contents.
   */
  async store(bundle: EvidenceBundle): Promise<EvidenceStorageReceipt> {
    const bytes = serializeBundle(bundle);
    // The signed inner hash (over the bundle minus signature fields). This is
    // what a verifier re-derives and what the signature covers — distinct from
    // the CID, which addresses the *full* stored bytes (signature included).
    const contentHash = this.recomputeBundleHash(bundle);
    if (bundle.contentHash && bundle.contentHash !== contentHash) {
      throw new Error(
        'FilecoinEvidenceStore: bundle.contentHash does not match its contents — refusing to store',
      );
    }
    const cid = computeCidV1Raw(bytes);
    const putOpts: FilecoinPutOptions = {
      metadata: {
        appId: bundle.appId,
        runId: bundle.runId,
        agentId: bundle.agentId,
        contentHash,
        cid,
      },
    };
    if (this.defaultRetentionSeconds !== undefined) {
      putOpts.retentionSeconds = this.defaultRetentionSeconds;
    }
    const put = await this.client.put(bytes, putOpts);
    return {
      cid,
      ...(put.cid && put.cid !== cid ? { providerCid: put.cid } : {}),
      ...(put.pieceCid ? { pieceCid: put.pieceCid } : {}),
      ...(put.dealId ? { dealId: put.dealId } : {}),
      ...(put.provider ? { provider: put.provider } : {}),
      contentHash,
      size: bytes.length,
      storedAt: this.now(),
      appId: bundle.appId,
      runId: bundle.runId,
      agentId: bundle.agentId,
    };
  }

  /** {@link BundleSubmitter} adapter so this can be an EvidenceBundler submitter. */
  async submitEvidence(bundle: EvidenceBundle): Promise<void> {
    await this.store(bundle);
  }

  /** Retrieve the raw bundle bytes for a CID, without verifying. */
  async retrieve(cid: string): Promise<EvidenceBundle> {
    const bytes = await this.client.get(cid);
    return JSON.parse(new TextDecoder().decode(bytes)) as EvidenceBundle;
  }

  /**
   * Retrieve a bundle and prove integrity: the retrieved bytes must
   * content-address to `cid`, their hash must equal the bundle's `contentHash`,
   * and the signature must verify. Throws on any mismatch.
   */
  async retrieveAndVerify(cid: string): Promise<EvidenceBundle> {
    if (!this.signer) {
      throw new Error('FilecoinEvidenceStore: a signer is required for retrieveAndVerify');
    }
    const bytes = await this.client.get(cid);
    const derivedCid = computeCidV1Raw(bytes);
    if (derivedCid !== cid) {
      throw new Error(
        `FilecoinEvidenceStore: retrieved bytes content-address to ${derivedCid}, not requested ${cid}`,
      );
    }
    const bundle = JSON.parse(new TextDecoder().decode(bytes)) as EvidenceBundle;
    const recomputed = this.recomputeBundleHash(bundle);
    if (recomputed !== bundle.contentHash) {
      throw new Error('FilecoinEvidenceStore: contentHash mismatch on retrieved bundle — tampered');
    }
    const sigPayload = new TextEncoder().encode(bundle.contentHash);
    const ok = await this.signer.verify(sigPayload, bundle.signature);
    if (!ok) {
      throw new Error('FilecoinEvidenceStore: signature verification failed on retrieved bundle');
    }
    return bundle;
  }

  /**
   * Recompute the canonical content hash exactly the way EvidenceBundler does:
   * over the bundle minus the signature-related fields.
   */
  private recomputeBundleHash(bundle: EvidenceBundle): string {
    const { contentHash: _c, signature: _s, sigAlg: _a, keyId: _k, ...rest } = bundle;
    void _c;
    void _s;
    void _a;
    void _k;
    const canonical = canonicalJson(rest);
    return createHash('sha256').update(new TextEncoder().encode(canonical)).digest('hex');
  }
}

/**
 * In-memory {@link FilecoinStorageClient} for tests, local dev, and CI. Stores
 * bytes keyed by their content-derived CID; `get` is exact-bytes faithful.
 * NOT for production — it does not make real Filecoin deals.
 */
export class InMemoryFilecoinClient implements FilecoinStorageClient {
  readonly provider = 'memory';
  private readonly blocks = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<FilecoinPutResult> {
    const cid = computeCidV1Raw(bytes);
    this.blocks.set(cid, bytes.slice());
    return { cid, provider: this.provider, size: bytes.length };
  }

  async get(cid: string): Promise<Uint8Array> {
    const bytes = this.blocks.get(cid);
    if (!bytes) throw new Error(`InMemoryFilecoinClient: no block for ${cid}`);
    return bytes.slice();
  }
}
