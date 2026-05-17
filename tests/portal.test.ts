import { describe, it, expect } from 'vitest';
import { PortalTelemetry } from '../src/portal/PortalTelemetry';
import type { EvidenceBundle } from '../src/types';

function makeFetch(handler: (url: string, init: RequestInit) => Response): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(typeof input === 'string' ? input : input.toString(), init ?? {});
  }) as typeof globalThis.fetch;
}

describe('PortalTelemetry', () => {
  it('throws if required opts missing', () => {
    expect(() => new PortalTelemetry({ baseUrl: '', appId: 'a', apiKey: 'k' })).toThrow();
    expect(() => new PortalTelemetry({ baseUrl: 'u', appId: '', apiKey: 'k' })).toThrow();
    expect(() => new PortalTelemetry({ baseUrl: 'u', appId: 'a', apiKey: '' })).toThrow();
  });

  it('submitTrace POSTs to /api/v1/apps/:appId/traces with license header', async () => {
    let seenUrl = '';
    let seenHeader: string | null = null;
    let seenBody = '';
    const t = new PortalTelemetry({
      baseUrl: 'https://r.example',
      appId: 'app-1',
      apiKey: 'lic',
      fetch: makeFetch((url, init) => {
        seenUrl = url;
        seenHeader = (init.headers as Record<string, string>)['x-license-key'] ?? null;
        seenBody = String(init.body ?? '');
        return new Response(JSON.stringify({ id: 'trace-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });
    const out = await t.submitTrace({
      traceHash: 'h',
      reasoning: 'r',
      proposedAction: 'a',
      validationResult: 'v',
      status: 'executed',
    });
    expect(seenUrl).toBe('https://r.example/api/v1/apps/app-1/traces');
    expect(seenHeader).toBe('lic');
    expect(seenBody).toContain('"traceHash":"h"');
    expect(out).toEqual({ id: 'trace-1' });
  });

  it('submitEvidence wraps bundle into trace POST', async () => {
    let captured: Record<string, unknown> | null = null;
    const t = new PortalTelemetry({
      baseUrl: 'https://r.example',
      appId: 'app-1',
      apiKey: 'lic',
      fetch: makeFetch((_url, init) => {
        captured = JSON.parse(String(init.body));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    });
    const bundle: EvidenceBundle = {
      version: '1',
      appId: 'app-1',
      runId: 'r1',
      agentId: 'g1',
      bundledAt: 0,
      traces: [],
      policyVerdicts: [],
      approvals: [],
      proposals: [],
      chainTxRefs: [],
      contentHash: 'abc',
      signature: 'sig',
      sigAlg: 'hmac-sha256',
      keyId: 'k1',
    };
    await t.submitEvidence(bundle);
    expect(captured).not.toBeNull();
    expect(captured!['traceHash']).toBe('abc');
    expect(captured!['status']).toBe('executed');
    expect((captured!['metadata'] as Record<string, unknown>)['sigAlg']).toBe('hmac-sha256');
  });

  it('throws on non-2xx response', async () => {
    const t = new PortalTelemetry({
      baseUrl: 'https://r.example',
      appId: 'app',
      apiKey: 'k',
      fetch: makeFetch(() => new Response('boom', { status: 500 })),
    });
    await expect(
      t.submitTrace({
        traceHash: 'h',
        reasoning: '',
        proposedAction: '',
        validationResult: '',
        status: 'executed',
      }),
    ).rejects.toThrow(/500/);
  });
});
