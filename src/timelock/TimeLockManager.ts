/**
 * @module @veridex/agents-treasury/timelock
 *
 * Time-lock manager — delays high-value or anomalous transfers by a
 * configured cooling-off period. A scheduled action can be committed
 * after `executeAfter` or cancelled before.
 *
 * The manager is intentionally storage-pluggable; the default impl is
 * in-process and exists so that tests and single-process deployments
 * have a working primitive.
 */

export interface TimeLockedAction<T = unknown> {
  id: string;
  payload: T;
  /** Unix-ms at which this action becomes eligible. */
  executeAfter: number;
  /** Unix-ms when scheduled. */
  scheduledAt: number;
  status: 'pending' | 'ready' | 'cancelled' | 'executed';
}

export interface TimeLockManagerOptions {
  defaultDelayMs?: number;
  /** Floor on the delay even if caller requests less. */
  minDelayMs?: number;
}

export class TimeLockManager<T = unknown> {
  private actions = new Map<string, TimeLockedAction<T>>();
  private defaultDelayMs: number;
  private minDelayMs: number;

  constructor(opts: TimeLockManagerOptions = {}) {
    this.defaultDelayMs = opts.defaultDelayMs ?? 0;
    this.minDelayMs = opts.minDelayMs ?? 0;
  }

  /** Schedule an action; returns the locked action with computed executeAfter. */
  schedule(id: string, payload: T, delayMs?: number, now = Date.now()): TimeLockedAction<T> {
    if (this.actions.has(id)) {
      throw new Error(`time-lock id already exists: ${id}`);
    }
    const requested = delayMs ?? this.defaultDelayMs;
    const effective = Math.max(requested, this.minDelayMs);
    const action: TimeLockedAction<T> = {
      id,
      payload,
      executeAfter: now + effective,
      scheduledAt: now,
      status: effective === 0 ? 'ready' : 'pending',
    };
    this.actions.set(id, action);
    return { ...action };
  }

  /** Returns the action if it is now ready, else undefined. */
  poll(id: string, now = Date.now()): TimeLockedAction<T> | undefined {
    const a = this.actions.get(id);
    if (!a) return undefined;
    if (a.status === 'pending' && now >= a.executeAfter) {
      a.status = 'ready';
    }
    return a.status === 'ready' ? { ...a } : undefined;
  }

  /** Mark an action executed. Throws if not yet ready. */
  markExecuted(id: string, now = Date.now()): void {
    const a = this.actions.get(id);
    if (!a) throw new Error(`unknown time-lock id: ${id}`);
    if (a.status !== 'ready' && !(a.status === 'pending' && now >= a.executeAfter)) {
      throw new Error(`time-lock ${id} not ready: status=${a.status}`);
    }
    a.status = 'executed';
  }

  cancel(id: string): void {
    const a = this.actions.get(id);
    if (!a) return;
    if (a.status === 'executed') throw new Error(`cannot cancel executed action: ${id}`);
    a.status = 'cancelled';
  }

  get(id: string): TimeLockedAction<T> | undefined {
    const a = this.actions.get(id);
    return a ? { ...a } : undefined;
  }

  reset(): void {
    this.actions.clear();
  }
}
