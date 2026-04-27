/**
 * HMAC-SHA256 signing / verification tests (chimera-59ee §4).
 *
 * Covers:
 *   1. Happy path — signed header verifies within tolerance.
 *   2. Tampered body rejected.
 *   3. Out-of-tolerance timestamp rejected.
 *   4. `timingSafeEqual` is actually used (equal-length buffers survive
 *      the comparison; unequal-length inputs short-circuit to false).
 */

import { describe, it, expect } from 'bun:test';
import { signWebhookPayload, verifyWebhookSignature } from '../signing';

const SECRET = 'whsec_test_0123456789abcdef';
const BODY = JSON.stringify({ eventType: 'agent.task.completed', tenantId: 't42' });

describe('signing', () => {
  it('round-trips: signed headers verify with the same secret + body', () => {
    const now = new Date('2026-04-26T14:00:00.000Z');
    const headers = signWebhookPayload('wh_01J9X', BODY, SECRET, now);

    expect(headers['Chimera-Webhook-Id']).toBe('wh_01J9X');
    expect(headers['Chimera-Timestamp']).toBe(String(Math.floor(now.getTime() / 1000)));
    expect(headers['Chimera-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const ok = verifyWebhookSignature(BODY, headers['Chimera-Signature'], SECRET, 300, now);
    expect(ok).toBe(true);
  });

  it('rejects a tampered body (MAC mismatch)', () => {
    const now = new Date('2026-04-26T14:00:00.000Z');
    const headers = signWebhookPayload('wh_01J9X', BODY, SECRET, now);

    const tampered = BODY.replace('t42', 't99');
    const ok = verifyWebhookSignature(tampered, headers['Chimera-Signature'], SECRET, 300, now);
    expect(ok).toBe(false);
  });

  it('rejects a timestamp outside the tolerance window', () => {
    const signedAt = new Date('2026-04-26T14:00:00.000Z');
    const headers = signWebhookPayload('wh_01J9X', BODY, SECRET, signedAt);

    // 10 minutes later with a 5-minute tolerance -> reject.
    const verifyAt = new Date(signedAt.getTime() + 10 * 60 * 1000);
    const ok = verifyWebhookSignature(BODY, headers['Chimera-Signature'], SECRET, 300, verifyAt);
    expect(ok).toBe(false);
  });

  it('uses timingSafeEqual semantics: unequal-length v1 short-circuits to false', () => {
    const now = new Date('2026-04-26T14:00:00.000Z');
    const headers = signWebhookPayload('wh_01J9X', BODY, SECRET, now);

    // Truncate v1 so buffer lengths differ — timingSafeEqual throws on length
    // mismatch, so our wrapper must short-circuit to `false` first.
    const truncated = headers['Chimera-Signature'].replace(/v1=.*/, 'v1=deadbeef');
    const ok = verifyWebhookSignature(BODY, truncated, SECRET, 300, now);
    expect(ok).toBe(false);

    // And a bogus (non-hex) v1 of the right string length also returns false
    // without throwing.
    const bogus = headers['Chimera-Signature'].replace(/v1=.*/, `v1=${'z'.repeat(64)}`);
    expect(verifyWebhookSignature(BODY, bogus, SECRET, 300, now)).toBe(false);
  });
});
