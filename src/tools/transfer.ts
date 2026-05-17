/**
 * @module @veridex/agents-treasury/tools/transfer
 *
 * Production-ready transfer tool. Composes idempotency, ceilings,
 * time-locks, sanctions screening, and (optionally) reputation into a
 * single typed tool the agent can call. The policy engine, registered
 * with rules from {@link treasuryPolicyPack}, then evaluates the
 * proposal against per-tx caps, dual-approval thresholds, and chain
 * allowlists *before* this tool's `execute` runs.
 *
 * Execution order inside `execute` (post-policy-pass):
 *
 *   1. Idempotency reservation (replay protection)
 *   2. Sanctions screening (last-line block)
 *   3. Optional time-lock enforcement (must be ready)
 *   4. Submit on-chain via the injected {@link TransferExecutor}
 *   5. Record ceiling spend (idempotency commit)
 *   6. Return llm-actionable result
 */

import { z } from 'zod';
import { tool } from '@veridex/agents/tools';
import type { ToolContract } from '@veridex/agents';
import { Counterparty, IdempotencyKey, Money, TransferProposal } from '../types';
import type { TransferProposal as TransferProposalT } from '../types';
import type { IdempotencyStore } from '../idempotency/IdempotencyStore';
import type { SpendCeilings } from '../ceilings/SpendCeilings';
import type { TimeLockManager } from '../timelock/TimeLockManager';
import type { SanctionScreener } from '../sanctions/SanctionScreener';

export interface TransferReceipt {
  txHash: string;
  chain: string;
  confirmedAt: number;
  /** Echo of the idempotency key for caller correlation. */
  idempotencyKey: string;
}

export interface TransferExecutor {
  execute(proposal: TransferProposalT): Promise<TransferReceipt>;
}

export interface TransferToolOptions {
  name?: string;
  idempotency: IdempotencyStore;
  idempotencyTtlMs?: number;
  sanctions: SanctionScreener;
  ceilings?: SpendCeilings;
  ceilingScope?: (proposal: TransferProposalT) => string;
  timeLock?: TimeLockManager<TransferProposalT>;
  executor: TransferExecutor;
}

const InputSchema = z.object({
  idempotencyKey: IdempotencyKey,
  from: Counterparty,
  to: Counterparty,
  amount: Money,
  memo: z.string().max(512).optional(),
  riskScore: z.number().min(0).max(100).optional(),
  executeAfter: z.number().int().nonnegative().optional(),
});

export function transferTool(opts: TransferToolOptions): ToolContract<any, any> {
  const scopeOf = opts.ceilingScope ?? ((p: TransferProposalT) => p.from.id);
  return tool({
    name: opts.name ?? 'treasury.transfer',
    guidance: {
      summary: 'Move funds from the agent treasury to a counterparty.',
      whenToUse: [
        'When an approved instruction requires moving funds.',
        'After verifying the balance is sufficient and the counterparty is expected.',
      ],
      whenNotToUse: [
        'For balance queries — use treasury.balance.',
        'For partial test transactions — production uses the same path.',
      ],
      successExample:
        '{ "txHash": "0xabc…", "chain": "ethereum", "confirmedAt": 1700000000000 }',
    },
    input: InputSchema,
    safetyClass: 'financial',
    idempotent: true,
    errorTemplates: {
      default: 'transfer failed: {message}',
      byCode: {
        idempotency_replay: 'idempotency replay — previous result returned ({message}).',
        sanctions_blocked: 'transfer blocked by sanctions: {message}.',
        timelock_pending: 'transfer is time-locked and not yet eligible: {message}.',
        executor_error: 'on-chain executor returned an error: {message}.',
      },
    },
    async execute({ input }) {
      const proposal = TransferProposal.parse(input);
      // 1. Idempotency replay check
      const prior = await opts.idempotency.get<TransferReceipt>(proposal.idempotencyKey);
      if (prior) {
        return {
          llmOutput: `Idempotent replay — prior tx ${prior.result.txHash} returned.`,
          success: true,
          metrics: { durationMs: 0, receipt: prior.result, replay: true },
        };
      }
      try {
        await opts.idempotency.reserve(
          proposal.idempotencyKey,
          opts.idempotencyTtlMs ?? 24 * 60 * 60 * 1000,
        );
      } catch (err) {
        return {
          llmOutput: 'idempotency key already in flight — refusing duplicate submission.',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      try {
        // 2. Sanctions
        const sanction = await opts.sanctions.screen(proposal.to);
        if (sanction.verdict === 'blocked') {
          await opts.idempotency.release(proposal.idempotencyKey);
          return {
            llmOutput: `Transfer blocked: ${sanction.reasons.join('; ')}`,
            success: false,
            error: `sanctions_blocked:${sanction.provider}`,
          };
        }
        // 3. Time-lock
        if (opts.timeLock) {
          const id = proposal.idempotencyKey;
          const existing = opts.timeLock.get(id);
          if (!existing) {
            const delay = proposal.executeAfter
              ? Math.max(0, proposal.executeAfter * 1000 - Date.now())
              : 0;
            const locked = opts.timeLock.schedule(id, proposal, delay);
            if (locked.status === 'pending') {
              await opts.idempotency.release(proposal.idempotencyKey);
              return {
                llmOutput: `Transfer time-locked until ${new Date(locked.executeAfter).toISOString()}`,
                success: false,
                error: `timelock_pending:${locked.executeAfter}`,
              };
            }
          } else if (existing.status === 'cancelled' || existing.status === 'executed') {
            await opts.idempotency.release(proposal.idempotencyKey);
            return {
              llmOutput: `Transfer cannot proceed: time-lock status=${existing.status}`,
              success: false,
              error: `timelock_${existing.status}`,
            };
          } else if (existing.status === 'pending') {
            const ready = opts.timeLock.poll(id);
            if (!ready) {
              await opts.idempotency.release(proposal.idempotencyKey);
              return {
                llmOutput: `Transfer time-locked until ${new Date(existing.executeAfter).toISOString()}`,
                success: false,
                error: `timelock_pending:${existing.executeAfter}`,
              };
            }
          }
        }
        // 4. Execute
        const receipt = await opts.executor.execute(proposal);
        if (opts.timeLock) {
          try {
            opts.timeLock.markExecuted(proposal.idempotencyKey);
          } catch {
            /* time-lock missing is fine when none was used */
          }
        }
        // 5. Record ceiling spend
        if (opts.ceilings) {
          opts.ceilings.record({ scope: scopeOf(proposal), amount: proposal.amount });
        }
        await opts.idempotency.commit(proposal.idempotencyKey, receipt);
        return {
          llmOutput: `Transfer confirmed: tx=${receipt.txHash} chain=${receipt.chain}`,
          success: true,
          metrics: { durationMs: 0, receipt, sanction },
        };
      } catch (err) {
        await opts.idempotency.release(proposal.idempotencyKey);
        const msg = err instanceof Error ? err.message : String(err);
        return {
          llmOutput: `Transfer failed: ${msg}`,
          success: false,
          error: `executor_error:${msg}`,
        };
      }
    },
  });
}
