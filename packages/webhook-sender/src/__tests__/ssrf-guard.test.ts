/**
 * SSRF guard tests (chimera-59ee section 7.3).
 */

import { describe, it, expect } from 'bun:test';
import { assertNotSsrf, SsrfBlockedError } from '../ssrf-guard';

describe('ssrf-guard', () => {
  it('blocks non-HTTPS schemes', () => {
    expect(() => assertNotSsrf('http://example.com/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('ftp://example.com/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('file:///etc/passwd')).toThrow(SsrfBlockedError);
  });

  it('blocks RFC-1918 private ranges (10/8, 172.16/12, 192.168/16)', () => {
    expect(() => assertNotSsrf('https://10.0.0.1/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://10.255.255.255/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://172.16.0.1/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://172.31.255.255/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://192.168.1.1/hook')).toThrow(SsrfBlockedError);
    // 172.15 and 172.32 are OUTSIDE the private range and should pass.
    expect(() => assertNotSsrf('https://172.15.0.1/hook')).not.toThrow();
    expect(() => assertNotSsrf('https://172.32.0.1/hook')).not.toThrow();
  });

  it('blocks loopback 127/8 and IPv6 ::1', () => {
    expect(() => assertNotSsrf('https://127.0.0.1/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://127.250.1.1/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://[::1]/hook')).toThrow(SsrfBlockedError);
  });

  it('blocks 169.254.169.254 EC2 metadata and link-local', () => {
    expect(() => assertNotSsrf('https://169.254.169.254/latest/meta-data/')).toThrow(
      SsrfBlockedError,
    );
    expect(() => assertNotSsrf('https://169.254.1.1/hook')).toThrow(SsrfBlockedError);
  });

  it('blocks hostname "localhost" and .localhost subdomains', () => {
    expect(() => assertNotSsrf('https://localhost/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://LOCALHOST/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://api.localhost/hook')).toThrow(SsrfBlockedError);
  });

  it('allows ordinary public HTTPS URLs', () => {
    expect(() => assertNotSsrf('https://example.com/hook')).not.toThrow();
    expect(() => assertNotSsrf('https://api.stripe.com/v1/webhooks')).not.toThrow();
    expect(() => assertNotSsrf('https://8.8.8.8/hook')).not.toThrow();
  });

  it('blocks IPv6 link-local (fe80::/10), ULA (fc00::/7), and AWS IPv6 metadata', () => {
    expect(() => assertNotSsrf('https://[fe80::1]/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://[fc00::1]/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://[fd00::1]/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://[fd00:ec2::254]/hook')).toThrow(SsrfBlockedError);
  });

  it('blocks IPv4-mapped IPv6 pointing at private ranges', () => {
    expect(() => assertNotSsrf('https://[::ffff:10.0.0.1]/hook')).toThrow(SsrfBlockedError);
    expect(() => assertNotSsrf('https://[::ffff:169.254.169.254]/hook')).toThrow(
      SsrfBlockedError,
    );
  });
});
