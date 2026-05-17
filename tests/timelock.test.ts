import { describe, it, expect } from 'vitest';
import { TimeLockManager } from '../src/timelock/TimeLockManager';

describe('TimeLockManager', () => {
  it('schedules pending action and becomes ready after delay', () => {
    const tlm = new TimeLockManager<{ id: string }>();
    const now = 1_000_000;
    const a = tlm.schedule('t1', { id: 'p' }, 10_000, now);
    expect(a.status).toBe('pending');
    expect(tlm.poll('t1', now + 5_000)).toBeUndefined();
    expect(tlm.poll('t1', now + 10_000)?.status).toBe('ready');
  });

  it('refuses duplicate id', () => {
    const tlm = new TimeLockManager();
    tlm.schedule('t1', {}, 0);
    expect(() => tlm.schedule('t1', {}, 0)).toThrow(/already exists/);
  });

  it('cancel prevents execution', () => {
    const tlm = new TimeLockManager();
    tlm.schedule('t1', {}, 1000);
    tlm.cancel('t1');
    expect(tlm.get('t1')?.status).toBe('cancelled');
  });

  it('markExecuted rejects not-ready', () => {
    const tlm = new TimeLockManager();
    tlm.schedule('t1', {}, 100_000);
    expect(() => tlm.markExecuted('t1')).toThrow(/not ready/);
  });

  it('zero-delay schedule is immediately ready', () => {
    const tlm = new TimeLockManager();
    const a = tlm.schedule('t1', {}, 0);
    expect(a.status).toBe('ready');
  });
});
