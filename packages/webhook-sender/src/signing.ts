/**
 * Stripe-style HMAC-SHA256 webhook signing.
 *
 * See docs/designs/chimera-59ee-webhook-delivery.md §4.
 *
 * Headers on every delivery POST:
 *   Chimera-Signature:    t=<unix-secs>,v1=<hex-hmac>
 *   Chimera-Webhook-Id:   <ULID>
 *   Chimera-Timestamp:    <unix-secs>
 *
 * Signed payload:
 *   signed_payload = `${timestamp}.${body}`
 *   hmac           = HMAC-SHA256(secret, signed_payload)
 *
 * Consumers MUST verify with `crypto.timingSafeEqual` and enforce a
 * tolerance window on `Chimera-Timestamp` to prevent replay attacks.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedHeaders {
  /** `t=<epoch-secs>,v1=<hex>` */
  'Chimera-Signature': string;
  /** Delivery id (ULID) — echoed in signature for idempotency on the consumer side. */
  'Chimera-Webhook-Id': string;
  /** Seconds since epoch, stringified. */
  'Chimera-Timestamp': string;
}

/**
 * Compute the signed headers for a single webhook delivery.
 *
 * `body` is the raw HTTP body that will be sent on the wire (usually the
 * JSON-stringified WebhookEnvelope). It MUST be byte-identical on the
 * sender and verifier sides — any re-serialisation will break the MAC.
 */
export function signWebhookPayload(
  webhookId: string,
  body: string,
  secret: string,
  now: Date = new Date(),
): SignedHeaders {
  if (!webhookId) {
    throw new Error('signWebhookPayload: webhookId is required');
  }
  if (!secret) {
    throw new Error('signWebhookPayload: secret is required');
  }

  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const signedPayload = `${timestamp}.${body}`;
  const hmac = createHmac('sha256', secret).update(signedPayload).digest('hex');

  return {
    'Chimera-Signature': `t=${timestamp},v1=${hmac}`,
    'Chimera-Webhook-Id': webhookId,
    'Chimera-Timestamp': timestamp,
  };
}

/**
 * Verify a Chimera-Signature header against the raw body.
 *
 * Returns `false` (never throws) for any verification failure: malformed
 * header, stale timestamp, or bad MAC. Uses `timingSafeEqual` to prevent
 * timing side-channels on the HMAC comparison.
 *
 * @param toleranceSecs how far the delivered timestamp may drift from
 *   local wall-clock time. Default 300 (5 minutes) matches Stripe.
 */
export function verifyWebhookSignature(
  body: string,
  signatureHeader: string | undefined | null,
  secret: string,
  toleranceSecs: number = 300,
  now: Date = new Date(),
): boolean {
  if (!signatureHeader || !secret) return false;

  // Parse `t=...,v1=...` — order-independent, ignore unknown schemes.
  const parts = signatureHeader.split(',').map((p) => p.trim());
  let tStr: string | undefined;
  let v1: string | undefined;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === 't') tStr = v;
    else if (k === 'v1') v1 = v;
  }
  if (!tStr || !v1) return false;

  const t = Number.parseInt(tStr, 10);
  if (!Number.isFinite(t)) return false;

  // Replay window.
  const nowSecs = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSecs - t) > toleranceSecs) return false;

  const signedPayload = `${tStr}.${body}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');

  // timingSafeEqual requires equal-length buffers. A hex-length mismatch is
  // an instant-fail and we never reach the constant-time compare.
  if (expected.length !== v1.length) return false;

  const expectedBuf = Buffer.from(expected, 'hex');
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(v1, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
