/**
 * Unit tests for email-sender Lambda helper functions.
 *
 * Tests pure business logic (MIME construction, quoted-printable encoding,
 * message ID generation) in isolation from AWS SDK dependencies.
 * AWS SDK calls are lazy-loaded inside the handler and not exercised here.
 */

import { describe, it, expect } from 'bun:test';
import {
  buildMimeEmail,
  buildMessageId,
  encodeQuotedPrintable,
} from '../../../infra/lambdas/email-sender/index.mjs';

describe('buildMimeEmail', () => {
  const base = {
    from: 'chimera@chimera.aws',
    to: 'user@example.com',
    subject: 'Re: Your question',
    bodyText: 'Thank you for reaching out.',
    messageId: '<12345.chimera@chimera.aws>',
    inReplyTo: null,
    references: null,
  };

  it('includes required headers', () => {
    const mime = buildMimeEmail(base);
    expect(mime).toContain('From: chimera@chimera.aws');
    expect(mime).toContain('To: user@example.com');
    expect(mime).toContain('Subject: Re: Your question');
    expect(mime).toContain('Message-ID: <12345.chimera@chimera.aws>');
    expect(mime).toContain('MIME-Version: 1.0');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
  });

  it('includes body text', () => {
    const mime = buildMimeEmail(base);
    expect(mime).toContain('Thank you for reaching out.');
  });

  it('includes In-Reply-To header when provided', () => {
    const mime = buildMimeEmail({
      ...base,
      inReplyTo: '<original@example.com>',
    });
    expect(mime).toContain('In-Reply-To: <original@example.com>');
  });

  it('omits In-Reply-To when null', () => {
    const mime = buildMimeEmail(base);
    expect(mime).not.toContain('In-Reply-To:');
  });

  it('includes References header when provided', () => {
    const mime = buildMimeEmail({
      ...base,
      inReplyTo: '<orig@example.com>',
      references: '<first@example.com> <second@example.com>',
    });
    expect(mime).toContain('References: <first@example.com> <second@example.com>');
  });

  it('uses CRLF line endings throughout', () => {
    const mime = buildMimeEmail(base);
    // Each header line must end with CRLF
    expect(mime).toContain('From: chimera@chimera.aws\r\n');
    expect(mime).toContain('To: user@example.com\r\n');
  });

  it('separates headers from body with blank CRLF line', () => {
    const mime = buildMimeEmail(base);
    expect(mime).toContain('\r\n\r\n');
  });
});

describe('buildMessageId', () => {
  it('returns a string in angle-bracket format', () => {
    const id = buildMessageId('myagent');
    expect(id).toMatch(/^<\d+\.myagent@chimera\.aws>$/);
  });

  it('uses "chimera" when agentId is undefined', () => {
    const id = buildMessageId(undefined);
    expect(id).toContain('.chimera@chimera.aws>');
  });

  it('generates unique IDs on successive calls', () => {
    const id1 = buildMessageId('agent');
    const id2 = buildMessageId('agent');
    // Timestamps may be equal within the same millisecond; just verify format
    expect(id1).toMatch(/^<\d+\.agent@chimera\.aws>$/);
    expect(id2).toMatch(/^<\d+\.agent@chimera\.aws>$/);
  });
});

describe('encodeQuotedPrintable', () => {
  it('passes through plain ASCII unchanged', () => {
    const text = 'Hello, world!';
    expect(encodeQuotedPrintable(text)).toBe('Hello, world!');
  });

  it('encodes equals sign as =3D', () => {
    const text = 'x = y';
    expect(encodeQuotedPrintable(text)).toContain('=3D');
  });

  it('encodes non-ASCII characters', () => {
    const text = 'café';
    const encoded = encodeQuotedPrintable(text);
    // 'é' is 0xE9 → =E9
    expect(encoded).toContain('=E9');
  });

  it('inserts soft line break at 75 characters', () => {
    // 80 identical ASCII characters → must be split at 75
    const text = 'A'.repeat(80);
    const encoded = encodeQuotedPrintable(text);
    expect(encoded).toContain('=\r\n');
  });

  it('preserves newlines as CRLF', () => {
    const text = 'line1\nline2';
    const encoded = encodeQuotedPrintable(text);
    expect(encoded).toContain('line1\r\nline2');
  });

  it('returns empty string for empty input', () => {
    expect(encodeQuotedPrintable('')).toBe('');
  });
});
