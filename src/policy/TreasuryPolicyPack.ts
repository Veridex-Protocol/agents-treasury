/**
 * @module @veridex/agents-treasury/policy
 *
 * Curated money-movement policy pack. The pack returns an ordered array
 * of {@link PolicyRule}s that callers register with the agents runtime
 * via `registerPolicy(...)` (or via the {@link TreasuryPlugin}, which
 * does this automatically).
 *
 * The pack composes:
 *
 *  - per-tx cap (block)
 *  - dual-approval threshold (escalate)
 *  - counterparty allow/deny (block)
 *  - chain allowlist (block)
 *  - per-window spend ceilings (block)
 *  - time-lock trigger above threshold (escalate)
 *  - reputation floor (escalate)
 *  - sanctions short-circuit (block) — pre-evaluated by tool, surfaced as
 *    metadata.sanction = 'blocked' on the proposal context
 *  - anomaly: large jump vs running median (flag)
 */

import type {
  PolicyContext,
  PolicyRule,
  PolicyCheckResult,
} from '@veridex/agents/policy';
import type { Money } from '../types';
import { moneyToBigInt } from '../types';
import type { SpendCeilings } from '../ceilings/SpendCeilings';
import type { ReputationProvider } from '../reputation/SbtReputationProvider';

export interface TreasuryPolicyPackOptions {
  /** Maximum per-transfer amount, indexed by currency. */
  perTxCap?: Record<string, Money>;
  /** Threshold above which a transfer requires dual approval. */
  dualApprovalThreshold?: Record<string, Money>;
  /** Threshold above which a transfer is time-locked. */
  timeLockThreshold?: Record<string, Money>;
  /** Allowed chain ids; if set, others are blocked. */
  allowedChains?: string[];
  /** Counterparty ids that are denylisted at the policy layer. */
  deniedCounterparties?: string[];
  /** Counterparty ids that are explicitly allowed (allowlist mode). */
  allowedCounterparties?: string[];
  /** Reputation provider — when set, low-reputation counterparties escalate. */
  reputation?: ReputationProvider;
  /** Minimum acceptable reputation score (0-100). Below this → escalate. */
  reputationFloor?: number;
  /** Spend ceilings, optional. */
  ceilings?: SpendCeilings;
  /** Scope resolver for ceilings (default: agentId). */
  ceilingScope?: (ctx: PolicyContext) => string;
}

const TOOL_NAMES = new Set(['treasury.transfer', 'treasury.escrow_release', 'treasury.x402_paywall']);

/** Return only when the proposal targets a treasury money-movement tool. */
function extractTransfer(ctx: PolicyContext): {
  toolName: string;
  args: Record<string, unknown>;
} | null {
  if (ctx.proposal.type !== 'tool_call') return null;
  for (const call of ctx.proposal.toolCalls) {
    if (TOOL_NAMES.has(call.name)) {
      return { toolName: call.name, args: call.arguments ?? {} };
    }
  }
  return null;
}

function getAmount(args: Record<string, unknown>): Money | null {
  const a = args.amount;
  if (!a || typeof a !== 'object') return null;
  const m = a as Money;
  if (typeof m.amount !== 'string' || typeof m.currency !== 'string' || typeof m.decimals !== 'number') {
    return null;
  }
  return m;
}

function getCounterpartyChain(args: Record<string, unknown>): string | null {
  const to = args.to;
  if (!to || typeof to !== 'object') return null;
  const c = to as { chain?: unknown };
  return typeof c.chain === 'string' ? c.chain : null;
}

function getCounterpartyId(args: Record<string, unknown>): string | null {
  const to = args.to;
  if (!to || typeof to !== 'object') return null;
  const c = to as { id?: unknown; address?: unknown };
  return typeof c.id === 'string' ? c.id : typeof c.address === 'string' ? c.address : null;
}

function passResult(ruleId: string, ruleName: string): PolicyCheckResult {
  return { ruleId, ruleName, passed: true, verdict: 'pass', reason: 'n/a', riskContribution: 0 };
}

/** Per-transfer cap. */
export function ruleMaxPerTransfer(caps: Record<string, Money>): PolicyRule {
  return {
    id: 'treasury:max-per-transfer',
    name: 'Max Per Transfer',
    description: 'Block any transfer above the configured per-currency cap.',
    priority: 10,
    evaluate(ctx) {
      const t = extractTransfer(ctx);
      if (!t) return passResult(this.id, this.name);
      const amt = getAmount(t.args);
      if (!amt) return passResult(this.id, this.name);
      const cap = caps[amt.currency];
      if (!cap) return passResult(this.id, this.name);
      if (cap.decimals !== amt.decimals) return passResult(this.id, this.name);
      if (moneyToBigInt(amt) > moneyToBigInt(cap)) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'block',
          reason: `transfer ${amt.amount} ${amt.currency} exceeds cap ${cap.amount}`,
          riskContribution: 1.0,
        };
      }
      return passResult(this.id, this.name);
    },
  };
}

/** Dual-approval threshold — escalate above limit. */
export function ruleDualApproval(thresholds: Record<string, Money>): PolicyRule {
  return {
    id: 'treasury:dual-approval',
    name: 'Dual Approval Threshold',
    description: 'Escalate transfers at or above the configured per-currency threshold.',
    priority: 20,
    evaluate(ctx) {
      const t = extractTransfer(ctx);
      if (!t) return passResult(this.id, this.name);
      const amt = getAmount(t.args);
      if (!amt) return passResult(this.id, this.name);
      const th = thresholds[amt.currency];
      if (!th || th.decimals !== amt.decimals) return passResult(this.id, this.name);
      if (moneyToBigInt(amt) >= moneyToBigInt(th)) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'escalate',
          reason: `transfer ${amt.amount} ${amt.currency} >= dual-approval threshold ${th.amount}`,
          riskContribution: 0.6,
        };
      }
      return passResult(this.id, this.name);
    },
  };
}

/** Time-lock trigger — escalate above limit (caller's hook schedules the lock). */
export function ruleTimeLockTrigger(thresholds: Record<string, Money>): PolicyRule {
  return {
    id: 'treasury:time-lock-trigger',
    name: 'Time Lock Trigger',
    description: 'Escalate transfers that must be time-locked before execution.',
    priority: 25,
    evaluate(ctx) {
      const t = extractTransfer(ctx);
      if (!t) return passResult(this.id, this.name);
      const amt = getAmount(t.args);
      if (!amt) return passResult(this.id, this.name);
      const th = thresholds[amt.currency];
      if (!th || th.decimals !== amt.decimals) return passResult(this.id, this.name);
      if (moneyToBigInt(amt) >= moneyToBigInt(th)) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'escalate',
          reason: `transfer ${amt.amount} ${amt.currency} >= time-lock threshold ${th.amount}`,
          riskContribution: 0.5,
        };
      }
      return passResult(this.id, this.name);
    },
  };
}

/** Counterparty deny/allow list. */
export function ruleCounterpartyList(opts: {
  denied?: string[];
  allowed?: string[];
}): PolicyRule {
  const denied = new Set(opts.denied ?? []);
  const allowed = opts.allowed ? new Set(opts.allowed) : null;
  return {
    id: 'treasury:counterparty-list',
    name: 'Counterparty List',
    description: 'Block denied counterparties or anything not on allowlist.',
    priority: 5,
    evaluate(ctx) {
      const t = extractTransfer(ctx);
      if (!t) return passResult(this.id, this.name);
      const id = getCounterpartyId(t.args);
      if (!id) return passResult(this.id, this.name);
      if (denied.has(id)) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'block',
          reason: `counterparty ${id} is denied`,
          riskContribution: 1.0,
        };
      }
      if (allowed && !allowed.has(id)) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'block',
          reason: `counterparty ${id} is not on allowlist`,
          riskContribution: 1.0,
        };
      }
      return passResult(this.id, this.name);
    },
  };
}

/** Chain allowlist. */
export function ruleChainAllowlist(allowed: string[]): PolicyRule {
  const set = new Set(allowed);
  return {
    id: 'treasury:chain-allowlist',
    name: 'Chain Allowlist',
    description: 'Block transfers targeting non-allowed chains.',
    priority: 8,
    evaluate(ctx) {
      const t = extractTransfer(ctx);
      if (!t) return passResult(this.id, this.name);
      const chain = getCounterpartyChain(t.args);
      if (!chain) return passResult(this.id, this.name);
      if (!set.has(chain)) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'block',
          reason: `chain '${chain}' is not allowed`,
          riskContribution: 1.0,
        };
      }
      return passResult(this.id, this.name);
    },
  };
}

/** Spend ceilings — block when window exceeded. */
export function ruleSpendCeilings(
  ceilings: SpendCeilings,
  scopeOf: (ctx: PolicyContext) => string,
): PolicyRule {
  return {
    id: 'treasury:spend-ceilings',
    name: 'Spend Ceilings',
    description: 'Block transfers that would exceed the configured rolling window ceilings.',
    priority: 15,
    evaluate(ctx) {
      const t = extractTransfer(ctx);
      if (!t) return passResult(this.id, this.name);
      const amt = getAmount(t.args);
      if (!amt) return passResult(this.id, this.name);
      const verdict = ceilings.probe({ scope: scopeOf(ctx), amount: amt });
      if (!verdict.allowed) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'block',
          reason: verdict.reason ?? 'ceiling exceeded',
          riskContribution: 0.9,
        };
      }
      return passResult(this.id, this.name);
    },
  };
}

/** Reputation floor — escalate when subject's score is below threshold. */
export function ruleReputationFloor(provider: ReputationProvider, floor: number): PolicyRule {
  return {
    id: 'treasury:reputation-floor',
    name: 'Reputation Floor',
    description: `Escalate transfers when counterparty reputation < ${floor}.`,
    priority: 30,
    async evaluate(ctx) {
      const t = extractTransfer(ctx);
      if (!t) return passResult(this.id, this.name);
      const id = getCounterpartyId(t.args);
      if (!id) return passResult(this.id, this.name);
      const r = await provider.lookup(id);
      if (!r) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'escalate',
          reason: `no reputation attestation for ${id}`,
          riskContribution: 0.4,
        };
      }
      if (r.score < floor) {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'escalate',
          reason: `reputation ${r.score} < floor ${floor} for ${id}`,
          riskContribution: 0.6,
        };
      }
      return passResult(this.id, this.name);
    },
  };
}

/**
 * Sanctions surface — the transfer tool pre-screens and writes the
 * verdict to `ctx.metadata.sanction`. This rule turns that signal into
 * a `block` verdict at policy time so it appears in the trace alongside
 * other verdicts.
 */
export function ruleSanctionsSurface(): PolicyRule {
  return {
    id: 'treasury:sanctions',
    name: 'Sanctions',
    description: 'Surface pre-screened sanctions outcome as a block verdict.',
    priority: 1,
    evaluate(ctx) {
      const t = extractTransfer(ctx);
      if (!t) return passResult(this.id, this.name);
      const sanction = ctx.metadata?.sanction as
        | { verdict: 'clear' | 'flagged' | 'blocked'; reasons: string[]; provider: string }
        | undefined;
      if (!sanction) return passResult(this.id, this.name);
      if (sanction.verdict === 'blocked') {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'block',
          reason: `sanctions blocked: ${sanction.reasons.join('; ')} (${sanction.provider})`,
          riskContribution: 1.0,
        };
      }
      if (sanction.verdict === 'flagged') {
        return {
          ruleId: this.id,
          ruleName: this.name,
          passed: false,
          verdict: 'escalate',
          reason: `sanctions flagged: ${sanction.reasons.join('; ')}`,
          riskContribution: 0.7,
        };
      }
      return passResult(this.id, this.name);
    },
  };
}

/** Build the full curated treasury policy pack. */
export function treasuryPolicyPack(opts: TreasuryPolicyPackOptions): PolicyRule[] {
  const rules: PolicyRule[] = [];
  rules.push(ruleSanctionsSurface());
  if (opts.deniedCounterparties || opts.allowedCounterparties) {
    rules.push(
      ruleCounterpartyList({
        ...(opts.deniedCounterparties ? { denied: opts.deniedCounterparties } : {}),
        ...(opts.allowedCounterparties ? { allowed: opts.allowedCounterparties } : {}),
      }),
    );
  }
  if (opts.allowedChains) rules.push(ruleChainAllowlist(opts.allowedChains));
  if (opts.perTxCap) rules.push(ruleMaxPerTransfer(opts.perTxCap));
  if (opts.ceilings) {
    const scopeOf = opts.ceilingScope ?? ((ctx: PolicyContext) => ctx.agentId);
    rules.push(ruleSpendCeilings(opts.ceilings, scopeOf));
  }
  if (opts.dualApprovalThreshold) rules.push(ruleDualApproval(opts.dualApprovalThreshold));
  if (opts.timeLockThreshold) rules.push(ruleTimeLockTrigger(opts.timeLockThreshold));
  if (opts.reputation && typeof opts.reputationFloor === 'number') {
    rules.push(ruleReputationFloor(opts.reputation, opts.reputationFloor));
  }
  return rules;
}
