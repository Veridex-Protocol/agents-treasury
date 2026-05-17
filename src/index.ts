/**
 * @module @veridex/agents-treasury
 *
 * Public surface of the Veridex Treasury Kit.
 *
 * Quick start:
 *
 * ```ts
 * import {
 *   createTreasuryKit,
 *   InMemoryIdempotencyStore,
 *   SpendCeilings,
 *   HmacEvidenceSigner,
 *   PortalTelemetry,
 *   NoopSanctionScreener,
 * } from '@veridex/agents-treasury';
 *
 * const kit = createTreasuryKit({
 *   appId: 'app_123',
 *   runId: run.id,
 *   agentId: 'finance-bot',
 *   idempotency: new InMemoryIdempotencyStore(),
 *   sanctions: new NoopSanctionScreener(),
 *   evidenceSigner: new HmacEvidenceSigner('kid-1', Buffer.from('…')),
 *   portal: new PortalTelemetry({ baseUrl, appId: 'app_123', apiKey }),
 *   transfer: { executor: myChainAdapter },
 * });
 *
 * runtime.use(kit.plugin); // tools + policies + portal wiring all installed.
 * ```
 */

export * from './types';

// Infra
export * from './idempotency/IdempotencyStore';
export * from './ceilings/SpendCeilings';
export * from './timelock/TimeLockManager';
export * from './sanctions/SanctionScreener';

// Reputation
export * from './reputation/SbtReputationProvider';

// Evidence
export * from './evidence/EvidenceSigner';
export * from './evidence/EvidenceBundler';

// Policy
export * from './policy/TreasuryPolicyPack';

// Portal
export * from './portal/PortalTelemetry';

// Tools
export * from './tools/balance';
export * from './tools/transfer';
export * from './tools/escrow';
export * from './tools/x402_paywall';

// Kit
export * from './runtime/TreasuryKit';

// Evals
export * from './evals/redteam';
