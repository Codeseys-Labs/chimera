/**
 * Delivery-core tests (chimera-59ee section 9 test scenarios 1-3).
 *
 * Uses a hand-mocked fetch so we can deterministically exercise:
 *   1. 200 -> success + SQS delete (drop=true, status=success)
 *   2. 400 -> permanent failure drop (drop=true, status=permanent-failure)
 *   3. 500 -> throws TransientDeliveryError so SQS retries
 */

import { describe, it, expect } from 'bun:test';
import { deliverWebhook, TransientDeliveryError } from '../sender';
import type { WebhookEnvelope, WebhookSubscription } from '../types';

function makeSubscription(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    tenantId: 'tenant42',
    subscriptionId: 'sub_01J9X',
    url: 'https://example.com/hook',
    events: ['agent.task.completed'],
    secretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:chimera/webhook/tenant42/x',
    enabled: true,
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
  };
}

function makeEnvelope(): WebhookEnvelope {
  return {
    webhookId: 'wh_01J9X',
    subscriptionId: 'sub_01J9X',
    tenantId: 'tenant42',
    eventType: 'agent.task.completed',
    timestamp: '2026-04-26T14:32:11.847Z',
    payload: { taskId: 'task_1' },
  };
}

function mockFetch(
  status: number,
  capture?: (url: string, init: RequestInit | undefined) => void,
): typeof fetch {
  return async (input, init) => {
    capture?.(String(input), init);
    return new Response('ok', { status });
  };
}

describe('deliverWebhook', () => {
  it('returns success for a 2xx response and includes signature headers', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = mockFetch(200, (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
    });

    const result = await deliverWebhook(makeSubscription(), makeEnvelope(), 'whsec_abc', {
      fetchImpl,
      now: () => new Date('2026-04-26T14:32:11.000Z'),
    });

    expect(result.status).toBe('success');
    expect(result.drop).toBe(true);
    expect(result.httpStatus).toBe(200);

    // Signature headers populated and formatted correctly.
    expect(capturedHeaders['Chimera-Webhook-Id']).toBe('wh_01J9X');
    expect(capturedHeaders['Chimera-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(capturedHeaders['Chimera-Timestamp']).toMatch(/^\d+$/);
  });

  it('returns permanent-failure (drop=true) for a 4xx (non-429) response', async () => {
    const fetchImpl = mockFetch(400);

    const result = await deliverWebhook(makeSubscription(), makeEnvelope(), 'whsec_abc', {
      fetchImpl,
    });

    expect(result.status).toBe('permanent-failure');
    expect(result.drop).toBe(true);
    expect(result.httpStatus).toBe(400);
    expect(result.reason).toContain('permanent-4xx');
  });

  it('throws TransientDeliveryError on a 5xx response so SQS retries', async () => {
    const fetchImpl = mockFetch(500);

    let thrown: unknown;
    try {
      await deliverWebhook(makeSubscription(), makeEnvelope(), 'whsec_abc', { fetchImpl });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TransientDeliveryError);
    expect((thrown as TransientDeliveryError).httpStatus).toBe(500);
  });
});
