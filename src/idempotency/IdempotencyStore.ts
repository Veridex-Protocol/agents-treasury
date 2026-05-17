/**
 * @module @veridex/agents-treasury/idempotency
 *
 * Idempotency store interface and in-memory implementation. The transfer
 * tool consults this before executing — if the key has been seen, the
 * stored prior result is returned and no side-effect is performed.
 *
 * Production deployments swap the in-memory impl for a durable store
 * (postgres/redis). The interface is intentionally minimal.
 */

import type { IdempotencyKey } from '../types';

/** Result captured for a successful operation. */
export interface IdempotencyRecord<T = unknown> {
  key: IdempotencyKey;
  result: T;
  /** Unix-ms when this record was created. */
  createdAt: number;
  /** Unix-ms when this record expires and may be evicted. */
  expiresAt: number;
}

export interface IdempotencyStore {
  /** Get an existing record, or undefined if absent/expired. */
  get<T = unknown>(key: IdempotencyKey): Promise<IdempotencyRecord<T> | undefined>;
  /** Atomically reserve the key; throws if already reserved (race-safe). */
  reserve(key: IdempotencyKey, ttlMs: number): Promise<void>;
  /** Commit a result for a previously reserved key. */
  commit<T>(key: IdempotencyKey, result: T): Promise<void>;
  /** Release a reservation (e.g. on failure that should be retryable). */
  release(key: IdempotencyKey): Promise<void>;
}

interface InternalRecord {
  key: IdempotencyKey;
  state: 'reserved' | 'committed';
  result?: unknown;
  createdAt: number;
  expiresAt: number;
}

/** In-memory idempotency store. Safe for single-process / test use. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, InternalRecord>();
  private defaultTtlMs: number;

  constructor(opts: { defaultTtlMs?: number } = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 24 * 60 * 60 * 1000;
  }

  private prune(now = Date.now()): void {
    for (const [k, r] of this.records.entries()) {
      if (r.expiresAt <= now) this.records.delete(k);
    }
  }

  async get<T = unknown>(key: IdempotencyKey): Promise<IdempotencyRecord<T> | undefined> {
    this.prune();
    const rec = this.records.get(key);
    if (!rec || rec.state !== 'committed') return undefined;
    return {
      key: rec.key,
      result: rec.result as T,
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
    };
  }

  async reserve(key: IdempotencyKey, ttlMs: number = this.defaultTtlMs): Promise<void> {
    this.prune();
    if (this.records.has(key)) {
      throw new Error(`idempotency key already reserved: ${key}`);
    }
    const now = Date.now();
    this.records.set(key, {
      key,
      state: 'reserved',
      createdAt: now,
      expiresAt: now + ttlMs,
    });
  }

  async commit<T>(key: IdempotencyKey, result: T): Promise<void> {
    const rec = this.records.get(key);
    if (!rec) throw new Error(`cannot commit non-reserved key: ${key}`);
    rec.state = 'committed';
    rec.result = result;
  }

  async release(key: IdempotencyKey): Promise<void> {
    const rec = this.records.get(key);
    if (rec && rec.state === 'reserved') this.records.delete(key);
  }

  /** Test-only: clear all records. */
  reset(): void {
    this.records.clear();
  }
}
