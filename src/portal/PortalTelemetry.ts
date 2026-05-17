/**
 * @module @veridex/agents-treasury/portal
 *
 * Developer-portal telemetry client. Posts trace events, approval
 * requests, evidence bundles, and security-event ingest payloads to the
 * Veridex relayer's `/api/v1/apps/:appId/...` endpoints.
 *
 * The relayer is what the developer-portal reads from — it is the single
 * integration point that ties every package (agents, agents-security,
 * agentic-payments, agents-treasury) to the portal UI. Apps authenticate
 * with an API key via the `x-license-key` header. The portal proxies
 * /api/execution/apps/:appId/* to the relayer.
 */

import type { EvidenceBundle } from '../types';

export interface PortalTelemetryOptions {
  /** Relayer base URL, e.g. https://relayer.veridex.network. */
  baseUrl: string;
  /** App id (tenant). */
  appId: string;
  /** API key for x-license-key header. */
  apiKey: string;
  /** Optional override for the fetch implementation (testing). */
  fetch?: typeof globalThis.fetch;
  /** Default timeout in ms per request. */
  timeoutMs?: number;
}

/** Trace POST payload — mirrors the relayer's required trace contract. */
export interface PortalTracePayload {
  traceHash: string;
  reasoning: string;
  proposedAction: string;
  validationResult: string;
  status: 'executed' | 'blocked' | 'pending_approval';
  policyVerdicts?: Array<Record<string, unknown>>;
  signatures?: string[];
  txHash?: string;
  riskScore?: number;
  blockedBy?: string;
  durationMs?: number;
  agentId?: string;
  sessionKeyHash?: string;
  metadata?: Record<string, unknown>;
}

export interface PortalApprovalRequest {
  proposedAction: string;
  reason: string;
  riskScore: number;
  details?: Record<string, unknown>;
}

export interface PortalApprovalDecision {
  approvalId: string;
  decision: 'approve' | 'reject';
  decidedBy: string;
  reason?: string;
}

export interface PortalSecurityEvent {
  eventType: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  source: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface PortalIncidentInput {
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * Production-ready HTTP client for the developer-portal/relayer surface.
 *
 * All methods are best-effort and surface errors back to the caller so
 * upstream code can decide whether to retry; the {@link TreasuryPlugin}
 * wraps these calls and logs failures rather than aborting runs.
 */
export class PortalTelemetry {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: PortalTelemetryOptions) {
    if (!opts.baseUrl) throw new Error('PortalTelemetry: baseUrl is required');
    if (!opts.appId) throw new Error('PortalTelemetry: appId is required');
    if (!opts.apiKey) throw new Error('PortalTelemetry: apiKey is required');
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as typeof globalThis.fetch);
    if (!this.fetchImpl) {
      throw new Error('PortalTelemetry: no fetch implementation available');
    }
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  private url(path: string): string {
    return `${this.base}/api/v1/apps/${encodeURIComponent(this.opts.appId)}${path}`;
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: {
          'content-type': 'application/json',
          'x-license-key': this.opts.apiKey,
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await this.fetchImpl(this.url(path), init);
      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`portal ${method} ${path} failed: ${res.status} ${text}`);
      }
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        return (await res.json()) as T;
      }
      return undefined as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST a trace event (executed | blocked | pending_approval). */
  async submitTrace(payload: PortalTracePayload): Promise<{ id?: string }> {
    return this.request('POST', '/traces', payload);
  }

  /** POST a new approval request. */
  async requestApproval(payload: PortalApprovalRequest): Promise<{ id?: string }> {
    return this.request('POST', '/approvals', payload);
  }

  /** POST a decision on an existing approval. */
  async decideApproval(payload: PortalApprovalDecision): Promise<{ id?: string }> {
    const { approvalId, ...rest } = payload;
    return this.request('POST', `/approvals/${encodeURIComponent(approvalId)}/decide`, rest);
  }

  /** GET signed evidence bundle (JSON). */
  async getEvidence(): Promise<unknown> {
    return this.request('GET', '/evidence');
  }

  /** POST a security event (uses /security/events/ingest). */
  async ingestSecurityEvent(event: PortalSecurityEvent): Promise<void> {
    await this.request('POST', '/security/events/ingest', event);
  }

  /** POST an incident. */
  async createIncident(incident: PortalIncidentInput): Promise<{ id?: string }> {
    return this.request('POST', '/incidents', incident);
  }

  /**
   * POST a signed Evidence Bundle to the trace store. The bundle is
   * mapped to the relayer's `/evidence` POST contract; if the relayer
   * does not yet accept full bundles, callers can use {@link submitTrace}
   * to attach the bundle hash and signature as metadata.
   */
  async submitEvidence(bundle: EvidenceBundle): Promise<void> {
    // Attach as a trace with status 'executed' and metadata.evidence = bundle.
    await this.submitTrace({
      traceHash: bundle.contentHash,
      reasoning: `evidence bundle for run ${bundle.runId}`,
      proposedAction: 'evidence.bundle.submit',
      validationResult: 'signed',
      status: 'executed',
      ...(bundle.agentId ? { agentId: bundle.agentId } : {}),
      signatures: [bundle.signature],
      metadata: {
        evidence: bundle,
        sigAlg: bundle.sigAlg,
        keyId: bundle.keyId,
      },
    });
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
