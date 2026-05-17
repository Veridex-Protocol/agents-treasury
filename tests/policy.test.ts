import { describe, it, expect } from 'vitest';
import {
  treasuryPolicyPack,
  ruleMaxPerTransfer,
  ruleDualApproval,
  ruleChainAllowlist,
  ruleCounterpartyList,
  ruleSanctionsSurface,
  ruleSpendCeilings,
  ruleReputationFloor,
} from '../src/policy/TreasuryPolicyPack';
import { SpendCeilings } from '../src/ceilings/SpendCeilings';
import { StaticReputationProvider } from '../src/reputation/SbtReputationProvider';
import type { PolicyContext } from '@veridex/agents/policy';

function ctxWith(args: Record<string, unknown>, metadata?: Record<string, unknown>): PolicyContext {
  return {
    runId: 'r',
    agentId: 'a',
    turnIndex: 0,
    proposal: {
      type: 'tool_call',
      toolCalls: [{ id: 't1', name: 'treasury.transfer', arguments: args }],
    } as PolicyContext['proposal'],
    metadata,
  };
}

const amount6 = (n: string) => ({ amount: n, currency: 'USDC', decimals: 6 });
const to = (id: string, chain = 'eth', address = '0xabc') => ({ id, chain, address });

describe('policy rules', () => {
  it('max-per-transfer blocks above cap', async () => {
    const r = ruleMaxPerTransfer({ USDC: amount6('1000000000') });
    const res = await r.evaluate(ctxWith({ amount: amount6('2000000000'), to: to('v') }));
    expect(res.verdict).toBe('block');
  });

  it('max-per-transfer passes below cap', async () => {
    const r = ruleMaxPerTransfer({ USDC: amount6('1000000000') });
    const res = await r.evaluate(ctxWith({ amount: amount6('500000000'), to: to('v') }));
    expect(res.verdict).toBe('pass');
  });

  it('dual-approval escalates at threshold', async () => {
    const r = ruleDualApproval({ USDC: amount6('100000000') });
    const res = await r.evaluate(ctxWith({ amount: amount6('100000000'), to: to('v') }));
    expect(res.verdict).toBe('escalate');
  });

  it('chain allowlist blocks unknown chain', async () => {
    const r = ruleChainAllowlist(['eth']);
    const res = await r.evaluate(
      ctxWith({ amount: amount6('1'), to: to('v', 'solana') }),
    );
    expect(res.verdict).toBe('block');
  });

  it('counterparty deny blocks', async () => {
    const r = ruleCounterpartyList({ denied: ['evil'] });
    const res = await r.evaluate(ctxWith({ amount: amount6('1'), to: to('evil') }));
    expect(res.verdict).toBe('block');
  });

  it('sanctions metadata blocked surfaces as block', async () => {
    const r = ruleSanctionsSurface();
    const res = await r.evaluate(
      ctxWith(
        { amount: amount6('1'), to: to('v') },
        { sanction: { verdict: 'blocked', reasons: ['x'], provider: 'p' } },
      ),
    );
    expect(res.verdict).toBe('block');
  });

  it('spend ceilings rule blocks over-window', async () => {
    const c = new SpendCeilings([
      { window: 'day', limit: '1000', currency: 'USDC', decimals: 6 },
    ]);
    const r = ruleSpendCeilings(c, () => 'scope-a');
    const res = await r.evaluate(ctxWith({ amount: amount6('2000'), to: to('v') }));
    expect(res.verdict).toBe('block');
  });

  it('reputation rule escalates below floor', async () => {
    const prov = new StaticReputationProvider(
      new Map([['vendor', { subjectId: 'vendor', score: 30, issuer: 'i', issuedAt: 0 }]]),
    );
    const r = ruleReputationFloor(prov, 50);
    const res = await r.evaluate(ctxWith({ amount: amount6('1'), to: to('vendor') }));
    expect(res.verdict).toBe('escalate');
  });

  it('reputation rule passes above floor', async () => {
    const prov = new StaticReputationProvider(
      new Map([['vendor', { subjectId: 'vendor', score: 80, issuer: 'i', issuedAt: 0 }]]),
    );
    const r = ruleReputationFloor(prov, 50);
    const res = await r.evaluate(ctxWith({ amount: amount6('1'), to: to('vendor') }));
    expect(res.verdict).toBe('pass');
  });

  it('treasuryPolicyPack composes ordered rules', () => {
    const rules = treasuryPolicyPack({
      perTxCap: { USDC: amount6('100') },
      allowedChains: ['eth'],
    });
    expect(rules.length).toBeGreaterThanOrEqual(3);
    expect(rules[0]!.id).toBe('treasury:sanctions');
  });
});
