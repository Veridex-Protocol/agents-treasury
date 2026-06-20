/**
 * @module @veridex/agents-treasury/tools/x402_paywall
 *
 * x402 paywall payment tool. Composes idempotency, sanctions, and
 * ceilings around a caller-supplied {@link X402PaywallClient} (e.g. the
 * `X402Client` from `@veridex/agentic-payments`).
 *
 * Why this lives here and not in agentic-payments: the treasury kit
 * wraps the raw payment primitive with the same money-movement controls
 * the rest of the kit uses — so policy verdicts, ceilings, and evidence
 * apply uniformly whether the agent is wiring USDC, releasing escrow,
 * or paying a paywall.
 */

import { z } from 'zod';
import { tool } from '@veridex/agents/tools';
import type { ToolContract } from '@veridex/agents';
import { IdempotencyKey, Money, type Counterparty } from '../types';
import type { IdempotencyStore } from '../idempotency/IdempotencyStore';
import type { SpendCeilings } from '../ceilings/SpendCeilings';
import type { SanctionScreener } from '../sanctions/SanctionScreener';

export interface X402PaywallReceipt {
  txHash: string;
  resourceUrl: string;
  amount: { amount: string; currency: string; decimals: number };
  paidAt: number;
}

export interface X402PaywallClient {
  pay(input: {
    resourceUrl: string;
    amount: { amount: string; currency: string; decimals: number };
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<X402PaywallReceipt>;
}

export interface X402PaywallToolOptions {
  name?: string;
  client: X402PaywallClient;
  idempotency: IdempotencyStore;
  idempotencyTtlMs?: number;
  sanctions: SanctionScreener;
  ceilings?: SpendCeilings;
  /**
   * Optional adapter to turn a resource URL into a Counterparty for
   * sanctions/ceilings — defaults to using the URL host.
   */
  toCounterparty?: (resourceUrl: string) => Counterparty;
}

const InputSchema = z.object({
  resourceUrl: z.string().url(),
  amount: Money,
  idempotencyKey: IdempotencyKey,
  metadata: z.record(z.unknown()).optional(),
});

const defaultCounterparty = (url: string): Counterparty => {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep original */
  }
  return {
    id: `https://${host}`,
    chain: 'off-chain',
    address: host,
  };
};

export function x402PaywallTool(opts: X402PaywallToolOptions): ToolContract<any, any> {
  const counterpartyOf = opts.toCounterparty ?? defaultCounterparty;
  return tool({
    name: opts.name ?? 'treasury.x402_paywall',
    guidance: {
      summary: 'Pay an x402 paywall and obtain the unlocked resource receipt.',
      whenToUse: ['When an upstream resource returned 402 Payment Required and the agent decides to pay.'],
      whenNotToUse: [
        'For arbitrary transfers — use treasury.transfer.',
        'For prepaid plans — use the standard API path with credentials.',
      ],
      successExample:
        '{ "txHash": "0xabc…", "resourceUrl": "https://…", "paidAt": 1700000000000 }',
    },
    input: InputSchema,
    safetyClass: 'financial',
    idempotent: true,
    async execute({ input }) {
      const parsed = InputSchema.parse(input);
      const prior = await opts.idempotency.get<X402PaywallReceipt>(parsed.idempotencyKey);
      if (prior) {
        return {
          llmOutput: `Idempotent replay — paywall ${prior.result.resourceUrl} already paid as ${prior.result.txHash}.`,
          success: true,
          metrics: { durationMs: 0, receipt: prior.result, replay: true },
        };
      }
      const counterparty = counterpartyOf(parsed.resourceUrl);
      const sanction = await opts.sanctions.screen(counterparty);
      if (sanction.verdict === 'blocked') {
        return {
          llmOutput: `Paywall payment blocked: ${sanction.reasons.join('; ')}`,
          success: false,
          error: `sanctions_blocked:${sanction.provider}`,
        };
      }
      if (opts.ceilings) {
        const probe = opts.ceilings.probe({ scope: counterparty.id, amount: parsed.amount });
        if (!probe.allowed) {
          return {
            llmOutput: `Paywall payment blocked: ${probe.reason}`,
            success: false,
            error: `ceiling_exceeded:${probe.violatedWindow}`,
          };
        }
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
        const receipt = await opts.client.pay({
          resourceUrl: parsed.resourceUrl,
          amount: parsed.amount,
          idempotencyKey: parsed.idempotencyKey,
          ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
        });
        if (opts.ceilings) {
          opts.ceilings.record({ scope: counterparty.id, amount: parsed.amount });
        }
        await opts.idempotency.commit(parsed.idempotencyKey, receipt);
        return {
          llmOutput: `Paywall paid: ${receipt.resourceUrl} tx=${receipt.txHash}`,
          success: true,
          metrics: { durationMs: 0, receipt, sanction },
        };
      } catch (err) {
        await opts.idempotency.release(parsed.idempotencyKey);
        const msg = err instanceof Error ? err.message : String(err);
        return {
          llmOutput: `Paywall payment failed: ${msg}`,
          success: false,
          error: `executor_error:${msg}`,
        };
      }
    },
  });
}
