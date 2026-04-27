/**
 * Webhook delivery core.
 *
 * See docs/designs/chimera-59ee-webhook-delivery.md sections 1 and 7.
 *
 * Delivery rules:
 *   - SSRF guard runs first. Violations surface as a permanent failure (drop).
 *   - HTTPS POST with an AbortController-driven timeout (default 10s).
 *   - 2xx                 -> success; SQS message deleted.
 *   - 4xx, not 429        -> permanent failure; logged and dropped.
 *   - 5xx, 429, timeout,
 *     network failure     -> throw; SQS retries with visibility backoff.
 */

import { signWebhookPayload } from './signing';
import { SsrfBlockedError, assertNotSsrf } from './ssrf-guard';
import type { DeliveryResult, WebhookEnvelope, WebhookSubscription } from './types';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Thrown for any transient failure so SQS re-enqueues the message.
 * `httpStatus` is populated when the remote responded (5xx/429); it's
 * undefined for network errors and timeouts.
 */
export class TransientDeliveryError extends Error {
  readonly httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'TransientDeliveryError';
    this.httpStatus = httpStatus;
  }
}

export interface DeliverWebhookDeps {
  /** Injected for testability — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected clock for deterministic signatures in tests. */
  now?: () => Date;
}

/**
 * Deliver a single webhook envelope to the subscription URL.
 *
 * Throws `TransientDeliveryError` on 5xx/429/timeout/network — the caller
 * (SQS Lambda handler) lets the exception propagate so SQS retries. All
 * other outcomes (success, 4xx, SSRF block) return a DeliveryResult.
 */
export async function deliverWebhook(
  subscription: WebhookSubscription,
  envelope: WebhookEnvelope,
  secret: string,
  deps: DeliverWebhookDeps = {},
): Promise<DeliveryResult> {
  const start = Date.now();

  // Syntactic SSRF guard. A blocked URL is a tenant misconfiguration, not a
  // transient failure — drop rather than retry forever.
  try {
    assertNotSsrf(subscription.url);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return {
        status: 'permanent-failure',
        drop: true,
        durationMs: Date.now() - start,
        reason: `ssrf-blocked: ${err.message}`,
      };
    }
    throw err;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = subscription.deliveryConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body = JSON.stringify(envelope);
  const headers = signWebhookPayload(envelope.webhookId, body, secret, now());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(subscription.url, {
      method: 'POST',
      body,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Chimera-Webhook/1.0',
        'Chimera-Signature': headers['Chimera-Signature'],
        'Chimera-Webhook-Id': headers['Chimera-Webhook-Id'],
        'Chimera-Timestamp': headers['Chimera-Timestamp'],
      },
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    // Network errors, DNS failures, and aborts all retry. Throw so SQS
    // re-enqueues the message.
    throw new TransientDeliveryError(
      isAbort
        ? `webhook delivery timed out after ${timeoutMs}ms`
        : `webhook network failure: ${message} (after ${durationMs}ms)`,
    );
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - start;
  const httpStatus = response.status;

  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      status: 'success',
      httpStatus,
      drop: true,
      durationMs,
    };
  }

  if (httpStatus === 429 || httpStatus >= 500) {
    throw new TransientDeliveryError(
      `webhook transient failure: HTTP ${httpStatus} after ${durationMs}ms`,
      httpStatus,
    );
  }

  // 4xx (not 429): tenant endpoint is rejecting us. Drop the message.
  return {
    status: 'permanent-failure',
    httpStatus,
    drop: true,
    durationMs,
    reason: `permanent-4xx: HTTP ${httpStatus}`,
  };
}
