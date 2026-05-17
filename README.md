# @veridex/agents-treasury

> Opinionated, safe money-movement primitives for AI agents — idempotency, ceilings, time-lock, sanctions, signed Evidence Bundles, SBT reputation, and a built-in red-team eval suite.

## Status

Beta. Public API stabilising for `1.0`. Tested against the runtime in [`@veridex/agents`](../agents).

## Why this package exists

Treasury workflows are the single highest-stakes use of agents in production. A retry that double-pays, an unsanctioned counterparty, a missing audit trail — any one is a board-level incident. This package consolidates the non-negotiable primitives so a treasury-capable agent inherits them by default.

| Concern | Primitive |
|---|---|
| Double-execution under retries / crashes | `IdempotencyStore` |
| Velocity & cumulative spend | `SpendCeilings` |
| Cooling-off for high-value transfers | `TimeLockManager` |
| Counterparty risk | `SanctionScreener` |
| Tamper-evident disclosure | `EvidenceBundler` + signers |
| Compositional rules | `TreasuryPolicyPack` |
| Continuous adversarial proof | `runRedTeamSuite` |

## Installation

```bash
npm install @veridex/agents-treasury @veridex/agents zod
# or
pnpm add @veridex/agents-treasury @veridex/agents zod
```

## Quick Start

```ts
import { createAgent, OpenAIProvider } from '@veridex/agents';
import {
  createTreasuryKit,
  InMemoryIdempotencyStore,
  SpendCeilings,
  TimeLockManager,
  NoopSanctionScreener,
  HmacEvidenceSigner,
  PortalTelemetry,
} from '@veridex/agents-treasury';

const kit = createTreasuryKit({
  appId:    'app_123',
  runId:    'run_xyz',
  agentId:  'finance-bot',
  idempotency:    new InMemoryIdempotencyStore(),
  ceilings:       new SpendCeilings({
    perTransferUsdMicro: 5_000_000_000n,           // $5,000
    dayUsdMicro:         50_000_000_000n,          // $50,000
  }),
  timeLock:       new TimeLockManager({ baseDelaySec: 60 }),
  sanctions:      new NoopSanctionScreener(),       // swap for OFAC etc. in production
  evidenceSigner: new HmacEvidenceSigner('kid-1', Buffer.from(process.env.HMAC!)),
  portal:         new PortalTelemetry({ baseUrl, appId: 'app_123', apiKey: process.env.PORTAL! }),
  transfer:       { executor: myChainAdapter },
  dualApprovalAbove: { amountUsdMicro: 10_000_000_000n },
});

const agent = createAgent(
  {
    name: 'treasury-bot',
    instructions: 'You execute approved finance operations safely.',
    tools:    kit.tools,
    policies: kit.policyRules,
  },
  {
    modelProviders: { default: new OpenAIProvider({ apiKey: process.env.OPENAI_KEY! }) },
    plugins: [kit.plugin],
  },
);

const run = await agent.run('Pay $50,000 to acme.com for invoice INV-1234');
// → status: 'suspended' (dual approval needed)
// → checkpoint persisted; evidence bundle accumulating
```

After two approvers, `agent.resume(run.runId, run.approvalId, decision)` runs idempotency reservation → sanctions screen → time-lock → executor → ceiling commit → signed Evidence Bundle → portal submission.

## Key Features

### Idempotency you can trust

```ts
import { IdempotencyStore, PostgresIdempotencyStore } from '@veridex/agents-treasury';
const store = new PostgresIdempotencyStore(pool);
// reserve → in_flight / completed / reserved; commit on success; bounded TTL.
```

The runtime threads the `idempotencyKey` into the executor so downstream APIs see end-to-end protection.

### Compositional, replayable policy

```ts
import { treasuryPolicyPack } from '@veridex/agents-treasury/policy';

const policies = treasuryPolicyPack({
  sanctions, ceilings, timeLock, reputation,
  dualApprovalAbove: { amountUsdMicro: 10_000_000_000n },
});
```

Sanctions → counterparty allowlist → route allowlist → per-transfer cap → velocity → dual-approval threshold → time-lock → reputation floor → idempotency guard. Every verdict emits an event.

### Signed Evidence Bundles

```ts
import {
  EvidenceBundler, Ed25519EvidenceSigner, verifyEvidenceBundle,
} from '@veridex/agents-treasury';

const bundler = new EvidenceBundler({
  signer: new Ed25519EvidenceSigner({ privateKey, publicKey, keyId: 'ops-2026' }),
  portal,
});
// bundler.recordTrace / recordPolicyVerdict / recordApproval / recordProposal / recordChainTx
const bundle = await bundler.finalize({ workflowId, submit: true });

// Anyone can verify offline:
const ok = await verifyEvidenceBundle(bundle, { publicKey });
```

Canonical JSON (RFC 8785) + content hashing → portable, third-party-verifiable receipts.

### Red-team suite in CI

```ts
import { runRedTeamSuite } from '@veridex/agents-treasury/evals';
const report = await runRedTeamSuite({ agent, provider });
expect(report.failures).toEqual([]);
```

Cases: TPA, prompt injection, confused deputy, replay, cap-bypass split, OOB exfil, homoglyph tool names, stale sanctions cache, time-lock cancel race, dual-approval self-approve. See [Red-Team Suite](../../documentation/pages/agent-fabric/treasury/red-team.mdx).

## Documentation

- [Treasury overview](../../documentation/pages/agent-fabric/treasury/overview.mdx)
- [Idempotency](../../documentation/pages/agent-fabric/treasury/idempotency.mdx)
- [Ceilings](../../documentation/pages/agent-fabric/treasury/ceilings.mdx)
- [Time-Lock](../../documentation/pages/agent-fabric/treasury/time-lock.mdx)
- [Sanctions](../../documentation/pages/agent-fabric/treasury/sanctions.mdx)
- [Evidence Bundles](../../documentation/pages/agent-fabric/treasury/evidence-bundles.mdx)
- [Policy Pack](../../documentation/pages/agent-fabric/treasury/policy.mdx)
- [Red-Team Suite](../../documentation/pages/agent-fabric/treasury/red-team.mdx)
- ADRs: [0049](../../docs/architecture/decisions/0049-event-sourced-policy-gated-runtime-loop.md), [0053](../../docs/architecture/decisions/0053-policy-engine-rule-composition.md), [0054](../../docs/architecture/decisions/0054-approvals-checkpoint-resume.md), [0056](../../docs/architecture/decisions/0056-immutable-event-log-signed-audit.md)

## Comparison

| Capability | Veridex Treasury | Generic agent framework |
|---|---|---|
| Idempotent execution under retries | ✅ enforced | typically DIY |
| Velocity ceilings with atomic commit | ✅ | DIY |
| Time-lock with resume-safe scheduler | ✅ | DIY |
| Sanctions screening (composite) | ✅ | DIY |
| Signed, portable Evidence Bundles | ✅ Ed25519 / HMAC | logs only |
| Red-team eval in CI | ✅ built-in | external |
| Policy pack composition | ✅ | none |

## Ecosystem

- Runtime: [`@veridex/agents`](../agents)
- Policy / control plane: [`@veridex/agents-control-plane`](../agents-control-plane)
- React inbox + dashboards: [`@veridex/agents-react`](../agents-react)
- Security policy packs: [`@veridex/agent-security`](../agents-security)

## License

MIT — see [LICENSE](./LICENSE).
