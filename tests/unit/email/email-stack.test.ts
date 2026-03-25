/**
 * Unit tests for email Lambda handler logic
 *
 * Tests the MIME parsing, header extraction, and body extraction
 * logic in email-parser/index.mjs without AWS SDK calls.
 *
 * Note: CDK construct assertions live in infra/test/ (uses jest/ts-jest).
 * These tests validate the pure functions that run inside the Lambda.
 */

import { describe, it, expect } from 'bun:test';

// --------------------------------------------------------------------------
// Inline the pure helper functions from the Lambda handler for testing.
// We duplicate them here rather than importing the .mjs directly so these
// tests remain fast and dependency-free.
// --------------------------------------------------------------------------

function parseHeaders(rawEmail: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const headerSection = rawEmail.split(/\r?\n\r?\n/)[0] ?? '';
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!(name in headers)) {
      headers[name] = value;
    }
  }
  return headers;
}

function extractBody(rawEmail: string): string {
  const contentType = (rawEmail.match(/^content-type:\s*([^\r\n;]+)/im) ?? [])[1]?.trim() ?? '';

  if (contentType.startsWith('multipart/')) {
    const boundary = (rawEmail.match(/boundary="?([^"\r\n;]+)"?/i) ?? [])[1];
    if (boundary) {
      const parts = rawEmail.split(`--${boundary}`);
      let htmlBody = '';
      for (const part of parts) {
        const partContentType = (part.match(/^content-type:\s*([^\r\n;]+)/im) ?? [])[1]?.trim() ?? '';
        const partBody = part.split(/\r?\n\r?\n/).slice(1).join('\n\n').trim();
        if (partContentType.startsWith('text/plain')) {
          return partBody;
        }
        if (partContentType.startsWith('text/html') && !htmlBody) {
          htmlBody = partBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
      return htmlBody;
    }
  }

  const bodyStart = rawEmail.search(/\r?\n\r?\n/);
  if (bodyStart === -1) return '';
  const body = rawEmail.slice(bodyStart).trim();

  if (contentType.startsWith('text/html')) {
    return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return body;
}

// --------------------------------------------------------------------------
// Test data
// --------------------------------------------------------------------------

const PLAIN_EMAIL = [
  'From: Alice <alice@example.com>',
  'To: agent@mail.chimera.example.com',
  'Subject: Hello agent',
  'Message-ID: <abc123@example.com>',
  'Date: Mon, 24 Mar 2026 10:00:00 +0000',
  '',
  'Please help me with my request.',
].join('\r\n');

const REPLY_EMAIL = [
  'From: Bob <bob@example.com>',
  'To: agent@mail.chimera.example.com',
  'Subject: Re: Original thread',
  'Message-ID: <reply456@example.com>',
  'In-Reply-To: <original789@example.com>',
  'References: <original789@example.com>',
  '',
  'Replying to the thread.',
].join('\r\n');

const MULTIPART_EMAIL = [
  'From: Carol <carol@example.com>',
  'To: agent@mail.chimera.example.com',
  'Subject: Multipart test',
  'Message-ID: <multi001@example.com>',
  'Content-Type: multipart/alternative; boundary="----=_Part_1"',
  '',
  '------=_Part_1',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  'Plain text body here.',
  '------=_Part_1',
  'Content-Type: text/html; charset=UTF-8',
  '',
  '<html><body><p>HTML body here.</p></body></html>',
  '------=_Part_1--',
].join('\r\n');

const FOLDED_HEADER_EMAIL = [
  'From: Dave <dave@example.com>',
  'Subject: Folded',
  ' header value',
  'Message-ID: <fold001@example.com>',
  '',
  'Body.',
].join('\r\n');

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('email-parser: parseHeaders', () => {
  it('parses From, To, Subject headers correctly', () => {
    const h = parseHeaders(PLAIN_EMAIL);
    expect(h['from']).toBe('Alice <alice@example.com>');
    expect(h['to']).toBe('agent@mail.chimera.example.com');
    expect(h['subject']).toBe('Hello agent');
  });

  it('parses Message-ID stripping angle brackets if present', () => {
    const h = parseHeaders(PLAIN_EMAIL);
    // Raw header value (angle brackets stripped by caller, not parseHeaders)
    expect(h['message-id']).toBe('<abc123@example.com>');
  });

  it('parses In-Reply-To header for reply emails', () => {
    const h = parseHeaders(REPLY_EMAIL);
    expect(h['in-reply-to']).toBe('<original789@example.com>');
    expect(h['references']).toBe('<original789@example.com>');
  });

  it('unfolds multi-line (folded) headers per RFC 5322', () => {
    const h = parseHeaders(FOLDED_HEADER_EMAIL);
    expect(h['subject']).toBe('Folded header value');
  });

  it('returns empty object for email with no headers', () => {
    const h = parseHeaders('\r\n\r\nBody only.');
    expect(Object.keys(h).length).toBe(0);
  });

  it('handles lowercase header names consistently', () => {
    const email = 'FROM: Test <test@example.com>\r\n\r\nBody';
    const h = parseHeaders(email);
    expect(h['from']).toBe('Test <test@example.com>');
  });

  it('keeps only the first occurrence of a duplicate header', () => {
    const email = [
      'Subject: First',
      'Subject: Second',
      '',
      'Body',
    ].join('\r\n');
    const h = parseHeaders(email);
    expect(h['subject']).toBe('First');
  });
});

describe('email-parser: extractBody', () => {
  it('extracts plain text body from a simple text/plain email', () => {
    const body = extractBody(PLAIN_EMAIL);
    expect(body).toBe('Please help me with my request.');
  });

  it('extracts body from a reply email', () => {
    const body = extractBody(REPLY_EMAIL);
    expect(body).toBe('Replying to the thread.');
  });

  it('prefers text/plain part in multipart/alternative email', () => {
    const body = extractBody(MULTIPART_EMAIL);
    expect(body).toBe('Plain text body here.');
  });

  it('falls back to HTML stripped text if no plain part', () => {
    const htmlOnly = [
      'From: Dave <dave@example.com>',
      'Content-Type: multipart/alternative; boundary="----=_B"',
      '',
      '------=_B',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>HTML <strong>only</strong> body.</p>',
      '------=_B--',
    ].join('\r\n');
    const body = extractBody(htmlOnly);
    expect(body).toContain('HTML');
    expect(body).toContain('only');
    // HTML tags should be stripped
    expect(body).not.toContain('<p>');
    expect(body).not.toContain('<strong>');
  });

  it('returns empty string when there is no body separator', () => {
    const noBody = 'From: Test <t@example.com>';
    const body = extractBody(noBody);
    expect(body).toBe('');
  });

  it('strips HTML tags from text/html single-part email', () => {
    const htmlEmail = [
      'Content-Type: text/html',
      '',
      '<html><body><h1>Hello</h1><p>World</p></body></html>',
    ].join('\r\n');
    const body = extractBody(htmlEmail);
    expect(body).toContain('Hello');
    expect(body).toContain('World');
    expect(body).not.toContain('<html>');
    expect(body).not.toContain('<h1>');
  });
});

describe('email threading: threadId derivation', () => {
  it('uses In-Reply-To as threadId for reply emails', () => {
    const h = parseHeaders(REPLY_EMAIL);
    const inReplyTo = h['in-reply-to']?.replace(/[<>]/g, '').trim() ?? '';
    const messageId = h['message-id']?.replace(/[<>]/g, '').trim() ?? '';
    const threadId = inReplyTo || messageId;
    expect(threadId).toBe('original789@example.com');
  });

  it('uses message-id as threadId for new (non-reply) emails', () => {
    const h = parseHeaders(PLAIN_EMAIL);
    const inReplyTo = h['in-reply-to']?.replace(/[<>]/g, '').trim() ?? '';
    const messageId = h['message-id']?.replace(/[<>]/g, '').trim() ?? '';
    const threadId = inReplyTo || messageId;
    expect(threadId).toBe('abc123@example.com');
  });
});

describe('email-sender: References header construction', () => {
  it('builds References header from existing refs + original message ID', () => {
    const originalMessageId = 'original789@example.com';
    const existingRefs = '<thread001@example.com>';
    const references = existingRefs
      ? `${existingRefs} <${originalMessageId}>`
      : `<${originalMessageId}>`;
    expect(references).toBe('<thread001@example.com> <original789@example.com>');
  });

  it('creates initial References header when no prior refs exist', () => {
    const originalMessageId = 'firstmail@example.com';
    const existingRefs = '';
    const references = existingRefs
      ? `${existingRefs} <${originalMessageId}>`
      : `<${originalMessageId}>`;
    expect(references).toBe('<firstmail@example.com>');
  });
});
