/**
 * Schedule-token authentication middleware (chimera-2b2a).
 *
 * The dispatcher Lambda cannot hold a Cognito JWT, so it signs requests to
 * `/chat/stream` with an HMAC-SHA256 keyed on SCHEDULE_SIGNING_KEY (a
 * Secrets Manager secret). This middleware verifies the token and populates
 * `auth` + `tenantContext` just like the JWT path would.
 *
 * Wire protocol:
 *   X-Schedule-Token:   <hex HMAC>
 *   X-Schedule-Tenant:  <tenantId>
 *   X-Schedule-Id:      <scheduleId>
 *   X-Schedule-Ts:      <unix seconds>
 *
 * Signing payload (design-review CRITICAL 5 — body binding):
 *   HMAC-SHA256(key, `${tenantId}:${scheduleId}:${ts}:${sha256hex(body)}`)
 *
 * Binding the body hash prevents a captured token from being replayed with
 * a different body. `body` is the exact bytes of the request body; an
 * empty body hashes to sha256("") (a fixed, well-known value). The Python
 * dispatcher on @infra-builder's side computes the identical tuple.
 *
 * Other guarantees:
 *   - 5-minute replay window (abs(now - ts) <= 300).
 *   - Constant-time comparison via crypto.timingSafeEqual.
 *   - Signing key cached in-memory for 15 minutes (avoids Secrets Manager
 *     rate-limit blowups under dispatcher burst load).
 *
 * After verification, the raw body is re-attached to the context under
 * `scheduleRawBody` so downstream handlers can read it without re-reading
 * the stream (which Hono/Node only lets you do once).
 */

import type { Context, Next } from 'hono';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

const SIGNING_KEY_TTL_MS = 15 * 60 * 1000;
const REPLAY_WINDOW_SECONDS = 300;

let cachedKey: { value: string; fetchedAt: number } | null = null;
const secretsClient = new SecretsManagerClient({});

async function getSigningKey(): Promise<string> {
  const now = Date.now();
  if (cachedKey && now - cachedKey.fetchedAt < SIGNING_KEY_TTL_MS) {
    return cachedKey.value;
  }
  const secretArn = process.env.SCHEDULE_SIGNING_KEY_ARN;
  if (!secretArn) {
    throw new Error('SCHEDULE_SIGNING_KEY_ARN not configured');
  }
  const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const value = resp.SecretString;
  if (!value) {
    throw new Error('SCHEDULE_SIGNING_KEY secret is empty');
  }
  cachedKey = { value, fetchedAt: now };
  return value;
}

/**
 * Test seam: forces the next getSigningKey() call to re-fetch. Not exported
 * as a general API — reset between unit tests, never called in prod.
 */
export function __resetScheduleTokenCacheForTests(): void {
  cachedKey = null;
}

/**
 * Test seam: inject a static signing key + skip Secrets Manager. Required
 * for the routes test harness where AWS SDKs are not mocked.
 */
export function __setSigningKeyForTests(key: string | null): void {
  if (key === null) {
    cachedKey = null;
  } else {
    cachedKey = { value: key, fetchedAt: Date.now() };
  }
}

export async function authenticateScheduleToken(
  c: Context,
  next: Next
): Promise<Response | void> {
  const token = c.req.header('x-schedule-token');
  const tenantId = c.req.header('x-schedule-tenant');
  const scheduleId = c.req.header('x-schedule-id');
  const tsHeader = c.req.header('x-schedule-ts');

  if (!token || !tenantId || !scheduleId || !tsHeader) {
    return c.json(
      {
        error: {
          code: 'MISSING_SCHEDULE_TOKEN',
          message:
            'X-Schedule-Token, X-Schedule-Tenant, X-Schedule-Id, X-Schedule-Ts headers are required',
        },
        timestamp: new Date().toISOString(),
      },
      401
    );
  }

  const ts = Number.parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) {
    return c.json(
      {
        error: { code: 'INVALID_SCHEDULE_TOKEN', message: 'X-Schedule-Ts must be a unix timestamp' },
        timestamp: new Date().toISOString(),
      },
      401
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > REPLAY_WINDOW_SECONDS) {
    return c.json(
      {
        error: {
          code: 'SCHEDULE_TOKEN_EXPIRED',
          message: 'Schedule token timestamp outside the 5-minute window',
        },
        timestamp: new Date().toISOString(),
      },
      401
    );
  }

  let key: string;
  try {
    key = await getSigningKey();
  } catch (err) {
    console.error('Failed to load SCHEDULE_SIGNING_KEY:', err);
    return c.json(
      {
        error: { code: 'AUTH_NOT_CONFIGURED', message: 'Schedule auth unavailable' },
        timestamp: new Date().toISOString(),
      },
      500
    );
  }

  // Design-review CRITICAL 5: buffer the full body and hash it before
  // verifying the HMAC. Node/Hono's request body stream is single-shot,
  // so we capture the raw bytes here and stash them on context for the
  // downstream handler to re-use without another `.json()` read.
  let rawBody: Uint8Array;
  try {
    rawBody = new Uint8Array(await c.req.arrayBuffer());
  } catch (err) {
    console.error('Failed to read schedule request body:', err);
    return c.json(
      {
        error: {
          code: 'INVALID_SCHEDULE_TOKEN',
          message: 'Could not read request body for signature verification',
        },
        timestamp: new Date().toISOString(),
      },
      400
    );
  }

  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const expected = createHmac('sha256', key)
    .update(`${tenantId}:${scheduleId}:${ts}:${bodyHash}`)
    .digest('hex');

  // Constant-time compare requires matching buffer lengths; reject early
  // on length mismatch so timingSafeEqual doesn't throw.
  const tokenBuf = Buffer.from(token, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
    return c.json(
      {
        error: { code: 'INVALID_SCHEDULE_TOKEN', message: 'Signature verification failed' },
        timestamp: new Date().toISOString(),
      },
      401
    );
  }

  // Populate auth + tenantContext so downstream handlers that read either
  // slot behave identically to the JWT path. Flag the source so logs can
  // attribute the request to a scheduled run.
  c.set('auth', {
    sub: `schedule:${scheduleId}`,
    tenantId,
    tenantTier: c.req.header('x-schedule-tenant-tier') || 'basic',
  });
  c.set('tenantContext', {
    tenantId,
    userId: `schedule:${scheduleId}`,
    tier: (c.req.header('x-schedule-tenant-tier') || 'basic') as
      | 'basic'
      | 'advanced'
      | 'enterprise'
      | 'dedicated'
      | 'premium',
  });
  c.set('scheduleContext', { tenantId, scheduleId });
  // Expose the already-consumed body so the downstream handler can parse
  // it (c.req.json() would fail — the stream is drained).
  c.set('scheduleRawBody', rawBody);

  await next();
}
