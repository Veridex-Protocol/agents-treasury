/**
 * @module @veridex/agents-treasury/evidence
 *
 * Evidence signer interface and two default implementations. Real
 * deployments use {@link Ed25519EvidenceSigner} backed by a KMS-held
 * key; {@link HmacEvidenceSigner} is suitable for shared-secret setups
 * where the verifier is an internal control-plane service.
 *
 * NoopEvidenceSigner exists exclusively for tests and demos and must
 * not be used in production — bundles signed by it are auditably
 * marked with sigAlg "none".
 */

import { createHash, createHmac } from 'node:crypto';
import type { EvidenceSigAlg } from '../types';

export interface SignatureResult {
  signature: string;
  sigAlg: EvidenceSigAlg;
  keyId: string;
}

export interface EvidenceSigner {
  readonly keyId: string;
  readonly sigAlg: EvidenceSigAlg;
  sign(canonicalBytes: Uint8Array): Promise<SignatureResult>;
  verify(canonicalBytes: Uint8Array, signature: string): Promise<boolean>;
}

/** Canonicalize an object: sorted keys, no extra whitespace. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const stringify = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'bigint') return JSON.stringify(v.toString());
    if (Array.isArray(v)) return `[${v.map(stringify).join(',')}]`;
    if (typeof v === 'object') {
      if (seen.has(v as object)) throw new Error('cycle in canonicalJson');
      seen.add(v as object);
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k])}`).join(',')}}`;
    }
    return 'null';
  };
  return stringify(value);
}

/** Hash canonical bytes (sha-256 hex). */
export function contentHash(canonicalBytes: Uint8Array): string {
  return createHash('sha256').update(canonicalBytes).digest('hex');
}

/** Test-only signer — does not actually sign. */
export class NoopEvidenceSigner implements EvidenceSigner {
  readonly keyId = 'noop';
  readonly sigAlg: EvidenceSigAlg = 'none';
  async sign(canonicalBytes: Uint8Array): Promise<SignatureResult> {
    return { signature: contentHash(canonicalBytes), sigAlg: 'none', keyId: this.keyId };
  }
  async verify(canonicalBytes: Uint8Array, signature: string): Promise<boolean> {
    return contentHash(canonicalBytes) === signature;
  }
}

/** HMAC-SHA256 signer — shared secret. Use only when verifier shares the key. */
export class HmacEvidenceSigner implements EvidenceSigner {
  readonly sigAlg: EvidenceSigAlg = 'hmac-sha256';
  constructor(readonly keyId: string, private readonly secret: Uint8Array) {
    if (secret.length < 16) throw new Error('HmacEvidenceSigner: secret must be >= 16 bytes');
  }
  async sign(canonicalBytes: Uint8Array): Promise<SignatureResult> {
    const sig = createHmac('sha256', this.secret).update(canonicalBytes).digest('hex');
    return { signature: sig, sigAlg: this.sigAlg, keyId: this.keyId };
  }
  async verify(canonicalBytes: Uint8Array, signature: string): Promise<boolean> {
    const expected = createHmac('sha256', this.secret).update(canonicalBytes).digest('hex');
    // constant-time compare
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return diff === 0;
  }
}

/**
 * Ed25519 signer — caller injects the signing primitives (so we don't pin
 * a particular curve library). Verifiers receive a hex-encoded signature.
 */
export interface Ed25519Primitives {
  sign(message: Uint8Array): Promise<Uint8Array>;
  verify(message: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

export class Ed25519EvidenceSigner implements EvidenceSigner {
  readonly sigAlg: EvidenceSigAlg = 'ed25519';
  constructor(readonly keyId: string, private readonly primitives: Ed25519Primitives) {}
  async sign(canonicalBytes: Uint8Array): Promise<SignatureResult> {
    const sig = await this.primitives.sign(canonicalBytes);
    return { signature: bufToHex(sig), sigAlg: this.sigAlg, keyId: this.keyId };
  }
  async verify(canonicalBytes: Uint8Array, signature: string): Promise<boolean> {
    return this.primitives.verify(canonicalBytes, hexToBuf(signature));
  }
}

function bufToHex(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += buf[i]!.toString(16).padStart(2, '0');
  return s;
}

function hexToBuf(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
