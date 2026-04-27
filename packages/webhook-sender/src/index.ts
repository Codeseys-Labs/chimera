/**
 * @chimera/webhook-sender
 *
 * Webhook delivery primitives for the chimera-59ee pipeline.
 *
 * Phase 1 surface:
 *   - HMAC-SHA256 signing & verification (Stripe-style)
 *   - SSRF guard for outbound URLs
 *   - Low-level `deliverWebhook` helper used by the Lambda handler
 *
 * Phase 2 adds the SQS Lambda entrypoint, secrets cache, and DDB
 * subscription query (see design §5).
 */

export * from './types';
export {
  signWebhookPayload,
  verifyWebhookSignature,
  type SignedHeaders,
} from './signing';
export { assertNotSsrf, SsrfBlockedError } from './ssrf-guard';
export { deliverWebhook, TransientDeliveryError, type DeliverWebhookDeps } from './sender';
