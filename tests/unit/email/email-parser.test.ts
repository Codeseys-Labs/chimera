/**
 * Unit tests for email-parser Lambda helper functions.
 *
 * Tests pure business logic (MIME body extraction, address parsing) in isolation
 * from AWS SDK dependencies. AWS SDK calls are lazy-loaded inside the handler
 * and not exercised here.
 */

import { describe, it, expect } from 'bun:test';
import {
  extractTextBody,
  parseAgentId,
  parseTenantId,
} from '../../../infra/lambdas/email-parser/index.mjs';

describe('extractTextBody', () => {
  it('extracts body from a simple non-multipart message', () => {
    const raw = [
      'From: sender@example.com',
      'To: agent@chimera.aws',
      'Subject: Hello',
      'Content-Type: text/plain',
      '',
      'Hello, agent!',
      'How are you?',
    ].join('\r\n');

    const body = extractTextBody(raw);
    expect(body).toContain('Hello, agent!');
    expect(body).toContain('How are you?');
  });

  it('extracts text/plain part from a multipart message', () => {
    const raw = [
      'From: sender@example.com',
      'Content-Type: multipart/alternative; boundary="abc123"',
      '',
      '--abc123',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Plain text body here.',
      '--abc123',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<html><body>HTML body here.</body></html>',
      '--abc123--',
    ].join('\r\n');

    const body = extractTextBody(raw);
    expect(body).toContain('Plain text body here.');
    expect(body).not.toContain('HTML body here.');
  });

  it('returns empty string when no body is present', () => {
    const raw = 'From: sender@example.com\r\nSubject: Test\r\n';
    const body = extractTextBody(raw);
    expect(body).toBe('');
  });

  it('handles LF-only line endings', () => {
    const raw = 'From: a@b.com\nSubject: Hi\n\nBody text';
    const body = extractTextBody(raw);
    expect(body).toBe('Body text');
  });

  it('handles multipart boundary with spaces in content-type', () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary = "boundary42"',
      '',
      '--boundary42',
      'Content-Type: text/plain',
      '',
      'Extracted content.',
      '--boundary42--',
    ].join('\n');

    const body = extractTextBody(raw);
    expect(body).toContain('Extracted content.');
  });
});

describe('parseAgentId', () => {
  it('parses agent ID from bare address', () => {
    expect(parseAgentId('myagent@chimera.aws')).toBe('myagent');
  });

  it('parses agent ID from subaddress (agent+tenant)', () => {
    expect(parseAgentId('myagent+tenant123@chimera.aws')).toBe('myagent');
  });

  it('parses agent ID from display-name format', () => {
    expect(parseAgentId('My Agent <myagent+tenant456@chimera.aws>')).toBe('myagent');
  });

  it('returns "default" for empty address', () => {
    expect(parseAgentId('')).toBe('default');
  });

  it('handles address with multiple + signs (uses first segment)', () => {
    expect(parseAgentId('agent+tenant+extra@domain.com')).toBe('agent');
  });
});

describe('parseTenantId', () => {
  it('returns "default" for bare address without subaddress', () => {
    expect(parseTenantId('myagent@chimera.aws')).toBe('default');
  });

  it('parses tenant ID from subaddress', () => {
    expect(parseTenantId('myagent+tenant123@chimera.aws')).toBe('tenant123');
  });

  it('parses tenant ID from display-name format', () => {
    expect(parseTenantId('My Agent <myagent+tenant456@chimera.aws>')).toBe('tenant456');
  });

  it('returns "default" for empty address', () => {
    expect(parseTenantId('')).toBe('default');
  });

  it('returns second segment only when multiple + signs present', () => {
    expect(parseTenantId('agent+tenantX+extra@domain.com')).toBe('tenantX');
  });
});
