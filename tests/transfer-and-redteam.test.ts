import { describe, it, expect } from 'vitest';
import { transferTool } from '../src/tools/transfer';
import { InMemoryIdempotencyStore } from '../src/idempotency/IdempotencyStore';
import {
  NoopSanctionScreener,
  DenylistSanctionScreener,
} from '../src/sanctions/SanctionScreener';
import { SpendCeilings } from '../src/ceilings/SpendCeilings';
import type { TransferProposal } from '../src/types';
import { redTeamCases, runReplayScenario } from '../src/evals/redteam';

function proposal(over: Partial<TransferProposal> = {}): TransferProposal {
  return {
    idempotencyKey: over.idempotencyKey ?? 'idem-key-aaaaaaaaaa',
    from: { id: 'self', chain: 'eth', address: '0xself' },
    to: { id: 'vendor:1', chain: 'eth', address: '0xvendor' },
    amount: { amount: '1000', currency: 'USDC', decimals: 6 },
    ...over,
  } as TransferProposal;
}

describe('transferTool', () => {
  it('executes happy path and commits idempotency + ceiling', async () => {
    const idem = new InMemoryIdempotencyStore();
    const ceilings = new SpendCeilings();
    let executed = 0;
    const t = transferTool({
      idempotency: idem,
      sanctions: new NoopSanctionScreener(),
      ceilings,
      executor: {
        async execute(p) {
          executed += 1;
          return { txHash: '0xtx', chain: p.to.chain, confirmedAt: 1, idempotencyKey: p.idempotencyKey };
        },
      },
    });
    const res = await t.execute({ input: proposal() } as never);
    expect(res.success).toBe(true);
    expect(executed).toBe(1);
    const rec = await idem.get('idem-key-aaaaaaaaaa');
    expect(rec).toBeDefined();
  });

  it('returns replay on duplicate idempotency key (red-team replay)', async () => {
    const idem = new InMemoryIdempotencyStore();
    let executed = 0;
    const t = transferTool({
      idempotency: idem,
      sanctions: new NoopSanctionScreener(),
      executor: {
        async execute(p) {
          executed += 1;
          return { txHash: '0xtx-' + executed, chain: 'eth', confirmedAt: 1, idempotencyKey: p.idempotencyKey };
        },
      },
    });
    const p = proposal({ idempotencyKey: 'replay-key-zzzzzzzzz' });
    const a = await t.execute({ input: p } as never);
    const b = await t.execute({ input: p } as never);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(executed).toBe(1);
    expect((b.metrics as { replay?: boolean })?.replay).toBe(true);
  });

  it('blocks sanctioned counterparty', async () => {
    const idem = new InMemoryIdempotencyStore();
    const t = transferTool({
      idempotency: idem,
      sanctions: new DenylistSanctionScreener(new Set(['vendor:1'])),
      executor: { async execute() { throw new Error('should not run'); } },
    });
    const res = await t.execute({ input: proposal() } as never);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/sanctions_blocked/);
    // idempotency released on block
    expect(await idem.get('idem-key-aaaaaaaaaa')).toBeUndefined();
  });
});

describe('redTeamCases', () => {
  it('exports all four scenarios', () => {
    const ids = redTeamCases.map((c) => c.id).sort();
    expect(ids).toEqual([
      'confused-deputy-handoff',
      'prompt-injection-memo',
      'replay-attack',
      'tpa-transfer-redirect',
    ]);
  });

  it('replay scenario short-circuits via runReplayScenario', async () => {
    const idem = new InMemoryIdempotencyStore();
    let count = 0;
    const t = transferTool({
      idempotency: idem,
      sanctions: new NoopSanctionScreener(),
      executor: { async execute(p) { count++; return { txHash: 'x', chain: 'eth', confirmedAt: 0, idempotencyKey: p.idempotencyKey }; } },
    });
    const submit = async (p: TransferProposal) => {
      const r = await t.execute({ input: p } as never);
      const metrics = r.metrics as { replay?: boolean; receipt?: { txHash: string } };
      return {
        success: r.success,
        replay: metrics?.replay === true,
        txHash: metrics?.receipt?.txHash,
      };
    };
    const out = await runReplayScenario({
      proposal: proposal({ idempotencyKey: 'redteam-replay-test-key-0000000000' }),
      idempotency: idem,
      executor: { async execute() { throw new Error('unused'); } },
      submit,
    });
    expect(out.passed).toBe(true);
    expect(count).toBe(1);
  });
});
