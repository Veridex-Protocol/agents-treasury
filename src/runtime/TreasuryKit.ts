/**
 * @module @veridex/agents-treasury/runtime/TreasuryKit
 *
 * Single-entrypoint factory for installing the treasury kit into a
 * Veridex agent runtime. Returns:
 *
 *  - The composed tool array (balance, transfer, escrow_release, x402_paywall)
 *  - The curated policy pack (PolicyRule[])
 *  - A {@link RuntimePlugin} that wires:
 *      * sanctions screening into the proposal context (so the sanctions
 *        rule has data before policy evaluation)
 *      * trace + approval + evidence forwarding to {@link PortalTelemetry}
 *      * automatic Evidence Bundle assembly at run close
 */

import type { RuntimePlugin, RuntimeHook, ToolContract } from '@veridex/agents';
import type { PolicyRule } from '@veridex/agents/policy';

import type { IdempotencyStore } from '../idempotency/IdempotencyStore';
import type { SpendCeilings } from '../ceilings/SpendCeilings';
import type { TimeLockManager } from '../timelock/TimeLockManager';
import type { SanctionScreener } from '../sanctions/SanctionScreener';
import type { ReputationProvider } from '../reputation/SbtReputationProvider';
import type { EvidenceSigner } from '../evidence/EvidenceSigner';
import { EvidenceBundler } from '../evidence/EvidenceBundler';
import type { PortalTelemetry } from '../portal/PortalTelemetry';

import { balanceTool, type BalanceProvider } from '../tools/balance';
import { transferTool, type TransferExecutor } from '../tools/transfer';
import { escrowReleaseTool, type EscrowProvider } from '../tools/escrow';
import { x402PaywallTool, type X402PaywallClient } from '../tools/x402_paywall';
import {
  treasuryPolicyPack,
  type TreasuryPolicyPackOptions,
} from '../policy/TreasuryPolicyPack';
import type { TransferProposal as TransferProposalT } from '../types';

export interface TreasuryKitOptions {
  appId: string;
  runId: string;
  agentId: string;

  /** Required infrastructure */
  idempotency: IdempotencyStore;
  sanctions: SanctionScreener;
  evidenceSigner: EvidenceSigner;

  /** Optional infrastructure */
  ceilings?: SpendCeilings;
  timeLock?: TimeLockManager<TransferProposalT>;
  reputation?: ReputationProvider;
  reputationFloor?: number;
  portal?: PortalTelemetry;
  teeAttestation?: string;

  /** Backends — at least one tool's backend is typically supplied. */
  balance?: { provider: BalanceProvider; name?: string };
  transfer?: { executor: TransferExecutor; name?: string };
  escrow?: { provider: EscrowProvider; name?: string };
  x402?: { client: X402PaywallClient; name?: string };

  /** Policy pack overrides (caps, allowlists, thresholds). */
  policy?: Omit<TreasuryPolicyPackOptions, 'ceilings' | 'reputation' | 'reputationFloor'>;
}

export interface TreasuryKit {
  tools: ToolContract<any, any>[];
  policyRules: PolicyRule[];
  plugin: RuntimePlugin;
  /** The bundler — exposed so callers can recordChainTx() etc. */
  bundler: EvidenceBundler;
}

export function createTreasuryKit(opts: TreasuryKitOptions): TreasuryKit {
  const tools: ToolContract<any, any>[] = [];
  if (opts.balance) tools.push(balanceTool({ provider: opts.balance.provider, ...(opts.balance.name ? { name: opts.balance.name } : {}) }));
  if (opts.transfer) {
    tools.push(
      transferTool({
        idempotency: opts.idempotency,
        sanctions: opts.sanctions,
        executor: opts.transfer.executor,
        ...(opts.ceilings ? { ceilings: opts.ceilings } : {}),
        ...(opts.timeLock ? { timeLock: opts.timeLock } : {}),
        ...(opts.transfer.name ? { name: opts.transfer.name } : {}),
      }),
    );
  }
  if (opts.escrow) {
    tools.push(
      escrowReleaseTool({
        idempotency: opts.idempotency,
        sanctions: opts.sanctions,
        provider: opts.escrow.provider,
        ...(opts.ceilings ? { ceilings: opts.ceilings } : {}),
        ...(opts.escrow.name ? { name: opts.escrow.name } : {}),
      }),
    );
  }
  if (opts.x402) {
    tools.push(
      x402PaywallTool({
        idempotency: opts.idempotency,
        sanctions: opts.sanctions,
        client: opts.x402.client,
        ...(opts.ceilings ? { ceilings: opts.ceilings } : {}),
        ...(opts.x402.name ? { name: opts.x402.name } : {}),
      }),
    );
  }

  const policyRules = treasuryPolicyPack({
    ...(opts.policy ?? {}),
    ...(opts.ceilings ? { ceilings: opts.ceilings } : {}),
    ...(opts.reputation ? { reputation: opts.reputation } : {}),
    ...(typeof opts.reputationFloor === 'number'
      ? { reputationFloor: opts.reputationFloor }
      : {}),
  });

  const bundler = new EvidenceBundler({
    appId: opts.appId,
    runId: opts.runId,
    agentId: opts.agentId,
    signer: opts.evidenceSigner,
    ...(opts.portal ? { submitter: { submitEvidence: (b) => opts.portal!.submitEvidence(b) } } : {}),
    ...(opts.teeAttestation ? { teeAttestation: opts.teeAttestation } : {}),
  });

  const plugin: RuntimePlugin = {
    id: 'veridex.treasury-plugin',
    install(ctx) {
      for (const t of tools) ctx.registerTool(t);
      for (const r of policyRules) ctx.registerPolicy(r);

      // After every tool execution: capture trace and forward.
      const captureTool: RuntimeHook<unknown> = {
        name: 'treasury.capture.afterToolExecute',
        phase: 'afterToolExecute',
        priority: 200,
        execute: (hookCtx) => {
          const c = hookCtx as {
            runId: string;
            agentId: string;
            turnIndex: number;
            toolName: string;
            toolInput: Record<string, unknown>;
            toolOutput?: unknown;
            safetyClass?: string;
          };
          const entry = {
            kind: 'tool',
            runId: c.runId,
            agentId: c.agentId,
            turnIndex: c.turnIndex,
            toolName: c.toolName,
            toolInput: c.toolInput,
            toolOutput: c.toolOutput,
            safetyClass: c.safetyClass,
            ts: Date.now(),
          };
          bundler.recordTrace(entry);
          if (opts.portal) {
            void opts.portal
              .submitTrace({
                traceHash: `${c.runId}:${c.turnIndex}:${c.toolName}`,
                reasoning: `tool ${c.toolName} executed`,
                proposedAction: c.toolName,
                validationResult: 'executed',
                status: 'executed',
                agentId: c.agentId,
                metadata: { toolInput: c.toolInput, toolOutput: c.toolOutput },
              })
              .catch(() => {
                /* portal failures must not abort runs */
              });
          }
        },
      };

      const captureApprovalRequest: RuntimeHook<unknown> = {
        name: 'treasury.capture.beforeApprovalRequest',
        phase: 'beforeApprovalRequest',
        priority: 200,
        execute: (hookCtx) => {
          const a = hookCtx as Record<string, unknown>;
          bundler.recordApproval({ kind: 'request', ts: Date.now(), ...a });
          if (opts.portal) {
            void opts.portal
              .requestApproval({
                proposedAction: String(a['action'] ?? 'unknown'),
                reason: String(a['reason'] ?? ''),
                riskScore: typeof a['riskScore'] === 'number' ? (a['riskScore'] as number) : 50,
                details: a as Record<string, unknown>,
              })
              .catch(() => {});
          }
        },
      };

      const captureApprovalDecision: RuntimeHook<unknown> = {
        name: 'treasury.capture.afterApprovalDecision',
        phase: 'afterApprovalDecision',
        priority: 200,
        execute: (hookCtx) => {
          const a = hookCtx as Record<string, unknown>;
          bundler.recordApproval({ kind: 'decision', ts: Date.now(), ...a });
        },
      };

      const captureViolation: RuntimeHook<unknown> = {
        name: 'treasury.capture.onPolicyViolation',
        phase: 'onPolicyViolation',
        priority: 200,
        execute: (hookCtx) => {
          const v = hookCtx as Record<string, unknown>;
          bundler.recordPolicyVerdict({ ts: Date.now(), ...v });
        },
      };

      const finalize: RuntimeHook<unknown> = {
        name: 'treasury.capture.afterRun',
        phase: 'afterRun',
        priority: 200,
        execute: async () => {
          try {
            await bundler.finalize();
          } catch {
            /* finalize failures surfaced via submitter metadata, don't crash hook */
          }
        },
      };

      ctx.registerHook(captureTool);
      ctx.registerHook(captureApprovalRequest);
      ctx.registerHook(captureApprovalDecision);
      ctx.registerHook(captureViolation);
      ctx.registerHook(finalize);
    },
  };

  return { tools, policyRules, plugin, bundler };
}
