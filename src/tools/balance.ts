/**
 * @module @veridex/agents-treasury/tools/balance
 *
 * Read-only treasury balance tool. Returns the agent's available balance
 * for a given asset. Safety class = "read"; never has side effects.
 */

import { z } from 'zod';
import { tool } from '@veridex/agents/tools';
import type { ToolContract } from '@veridex/agents';
import { CurrencyCode, type Money } from '../types';

export interface BalanceProvider {
  getBalance(asset: { currency: string }): Promise<Money>;
}

export interface BalanceToolOptions {
  provider: BalanceProvider;
  name?: string;
}

const InputSchema = z.object({ currency: CurrencyCode });

export function balanceTool(opts: BalanceToolOptions): ToolContract<any, any> {
  return tool({
    name: opts.name ?? 'treasury.balance',
    guidance: {
      summary: "Fetch the agent's available balance for a currency.",
      whenToUse: ['Before proposing a transfer to confirm funds.'],
      whenNotToUse: [
        'For historical statements — use a reporting tool instead.',
        'For other counterparties — this returns only the agent treasury balance.',
      ],
      successExample: '{ "amount": "1000000", "currency": "USDC", "decimals": 6 }',
    },
    input: InputSchema,
    safetyClass: 'read',
    idempotent: true,
    async execute({ input }) {
      const { currency } = input as z.infer<typeof InputSchema>;
      const balance = await opts.provider.getBalance({ currency });
      return {
        llmOutput: `Balance: ${balance.amount} (decimals=${balance.decimals}) ${balance.currency}`,
        success: true,
        metrics: { durationMs: 0, balance },
      };
    },
  });
}
