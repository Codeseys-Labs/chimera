/**
 * Webhook Delivery Types (chimera-59ee)
 *
 * Shared types for the webhook delivery pipeline:
 *   EventBridge -> SQS -> Lambda -> HTTPS POST with Stripe-style HMAC signing.
 *
 * See docs/designs/chimera-59ee-webhook-delivery.md for full architecture.
 */

/**
 * A tenant's webhook subscription row (stored in
 * chimera-webhook-subscriptions-{env} DynamoDB table).
 *
 * The plaintext signing secret is NEVER stored on this row — only the
 * Secrets Manager ARN. The sender resolves the plaintext at delivery time.
 */
export interface WebhookSubscription {
  /** Denormalized tenant id for GSI FilterExpression enforcement. */
  tenantId: string;
  /** ULID subscription identifier (SK = SUB#{subscriptionId}). */
  subscriptionId: string;
  /** Destination URL. Must be HTTPS and pass the SSRF guard. */
  url: string;
  /** Event-type glob list. "*" matches every event. */
  events: string[];
  /** Secrets Manager ARN holding the signing secret. */
  secretArn: string;
  /** Whether the subscription is active. Disabled subs are skipped at fan-out. */
  enabled: boolean;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Per-delivery timeouts / retry overrides. */
  deliveryConfig?: DeliveryConfig;
  /** Tenant-supplied free-form metadata. Not used by the sender. */
  metadata?: Record<string, unknown>;
}

/**
 * Per-subscription delivery configuration. All fields optional — the sender
 * applies defaults if unset.
 */
export interface DeliveryConfig {
  /** Per-request HTTP timeout, ms. Defaults to 10_000. */
  timeoutMs?: number;
  /** Max retry attempts before DLQ. Defaults to 5 (aligned with SQS redrive). */
  maxRetries?: number;
}

/**
 * The payload Chimera posts to the subscriber's URL. The outer envelope is
 * signed (HMAC); only the inner `payload` varies by `eventType`.
 */
export interface WebhookEnvelope {
  /** ULID delivery id. Unique per POST attempt. Echoed as Chimera-Webhook-Id. */
  webhookId: string;
  /** Subscription that caused this delivery. */
  subscriptionId: string;
  /** Tenant that owns this event. */
  tenantId: string;
  /** Wire event name, e.g. `agent.task.completed`. */
  eventType: string;
  /** ISO-8601 event time. */
  timestamp: string;
  /** Monotonic sequence number scoped to subscription (best-effort). */
  sequenceNumber?: number;
  /** Event-type-specific payload. Chimera does not schema-validate this. */
  payload: Record<string, unknown>;
}

/**
 * Outcome of a single delivery attempt. Transient failures (5xx, 429, network)
 * are surfaced as thrown errors so SQS can retry; permanent failures (4xx
 * non-429) are returned as `permanent-failure` with `drop: true`.
 */
export interface DeliveryResult {
  status: 'success' | 'permanent-failure';
  httpStatus?: number;
  /** True when the SQS message should be deleted without retry. */
  drop: boolean;
  /** Elapsed wall-clock time for the HTTP attempt. */
  durationMs: number;
  /** Short human-readable reason, suitable for structured logs. */
  reason?: string;
}
