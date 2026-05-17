/**
 * @module @veridex/agents-treasury/tools/escrow
 *
 * Escrow release tool. Wraps the same safety primitives as transfer
 * (idempotency, sanctions, ceilings) and additionally requires the
 * escrow id to be in `releasable` state per the injected provider.
 */

import { z } from 'zod';
import { tool } from '@veridex/agents/tools';
import type { ToolContract } from '@veridex/agents';
import { Counterparty, IdempotencyKey, Money } from '../types';
import type { IdempotencyStore } from '../idempotency/IdempotencyStore';
import type { SpendCeilings } from '../ceilings/SpendCeilings';
import type { SanctionScreener } from '../sanctions/SanctionScreener';

export interface EscrowReleaseReceipt {
  txHash: string;
  escrowId: string;
  amount: { amount: string; currency: string; decimals: number };
  beneficiary: string;
  releasedAt: number;
}

export interface EscrowProvider {
  /** Inspect — must return amount/beneficiary if escrow is releasable. */
  inspect(escrowId: string): Promise<
    | { releasable: true; amount: { amount: string; currency: string; decimals: number }; beneficiary: { id: string; chain: string; address: string } }
    | { releasable: false; reason: string }
  >;
  /** Execute the on-chain release. */
  release(escrowId: string, idempotencyKey: string): Promise<EscrowReleaseReceipt>;
}

export interface EscrowToolOptions {
  name?: string;
  idempotency: IdempotencyStore;
  idempotencyTtlMs?: number;
  sanctions: SanctionScreener;
  ceilings?: SpendCeilings;
  provider: EscrowProvider;
}

const InputSchema = z.object({
  escrowId: z.string().min(1),
  idempotencyKey: IdempotencyKey,
  /** Optional override — when caller wants to validate amount before release. */
  expectedAmount: Money.optional(),
  expectedBeneficiary: Counterparty.optional(),
});

export function escrowReleaseTool(opts: EscrowToolOptions): ToolContract<any, any> {
  return tool({
    name: opts.name ?? 'treasury.escrow_release',
    guidance: {
      summary: 'Release an on-chain escrow to its beneficiary.',
      whenToUse: ['When the underlying condition for the escrow has been satisfied and the beneficiary should now receive funds.'],
      whenNotToUse: [
        'For arbitrary transfers — use treasury.transfer.',
        'When the escrow id is unknown — request it first.',
      ],
      successExample:
        '{ "txHash": "0xabc…", "escrowId": "esc_…", "releasedAt": 1700000000000 }',
    },
    input: InputSchema,
    safetyClass: 'financial',
    idempotent: true,
    async execute({ input }) {
      const parsed = InputSchema.parse(input);
      const prior = await opts.idempotency.get<EscrowReleaseReceipt>(parsed.idempotencyKey);
      if (prior) {
        return {
          llmOutput: `Idempotent replay — escrow ${prior.result.escrowId} already released as ${prior.result.txHash}.`,
          success: true,
          metrics: { durationMs: 0, receipt: prior.result, replay: true },
        };
      }
      const probe = await opts.provider.inspect(parsed.escrowId);
      if (!probe.releasable) {
        return {
          llmOutput: `Escrow not releasable: ${probe.reason}`,
          success: false,
          error: `escrow_not_releasable:${probe.reason}`,
        };
      }
      if (parsed.expectedAmount) {
        const a = parsed.expectedAmount;
        if (
          a.currency !== probe.amount.currency ||
          a.decimals !== probe.amount.decimals ||
          a.amount !== probe.amount.amount
        ) {
          return {
            llmOutput: `Escrow amount mismatch: expected ${a.amount} ${a.currency}, got ${probe.amount.amount} ${probe.amount.currency}`,
            success: false,
            error: 'escrow_amount_mismatch',
          };
        }
      }
      const cp = {
        id: probe.beneficiary.id,
        chain: probe.beneficiary.chain,
        address: probe.beneficiary.address,
      };
      if (parsed.expectedBeneficiary && parsed.expectedBeneficiary.id !== cp.id) {
        return {
          llmOutput: `Escrow beneficiary mismatch: expected ${parsed.expectedBeneficiary.id}, got ${cp.id}`,
          success: false,
          error: 'escrow_beneficiary_mismatch',
        };
      }
      const sanction = await opts.sanctions.screen(cp);
      if (sanction.verdict === 'blocked') {
        return {
          llmOutput: `Escrow release blocked: ${sanction.reasons.join('; ')}`,
          success: false,
          error: `sanctions_blocked:${sanction.provider}`,
        };
      }
      try {
        await opts.idempotency.reserve(parsed.idempotencyKey, opts.idempotencyTtlMs ?? 24 * 60 * 60 * 1000);
      } catch (err) {
        return {
          llmOutput: 'idempotency key already in flight — refusing duplicate submission.',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      try {
        const receipt = await opts.provider.release(parsed.escrowId, parsed.idempotencyKey);
        if (opts.ceilings) {
          opts.ceilings.record({
            scope: cp.id,
            amount: {
              amount: receipt.amount.amount,
              currency: receipt.amount.currency,
              decimals: receipt.amount.decimals,
            },
          });
        }
        await opts.idempotency.commit(parsed.idempotencyKey, receipt);
        return {
          llmOutput: `Escrow ${receipt.escrowId} released: tx=${receipt.txHash}`,
          success: true,
          metrics: { durationMs: 0, receipt, sanction },
        };
      } catch (err) {
        await opts.idempotency.release(parsed.idempotencyKey);
        const msg = err instanceof Error ? err.message : String(err);
        return {
          llmOutput: `Escrow release failed: ${msg}`,
          success: false,
          error: `executor_error:${msg}`,
        };
      }
    },
  });
}
