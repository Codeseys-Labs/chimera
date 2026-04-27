/**
 * SSRF guard for outbound webhook URLs.
 *
 * See docs/designs/chimera-59ee-webhook-delivery.md section 7.
 *
 * Blocks:
 *   - non-HTTPS schemes
 *   - RFC-1918 private IPv4 ranges (10/8, 172.16/12, 192.168/16)
 *   - loopback (127/8, ::1)
 *   - link-local / EC2 metadata (169.254/16)
 *   - hostname `localhost`
 *
 * NOTE: This is a syntactic (URL-literal) guard. Day-2 adds a DNS-resolution
 * re-check at delivery time to defeat rebinding attacks.
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Throws `SsrfBlockedError` (a subclass of Error) if `url` targets a
 * disallowed destination. Returns void on success.
 */
export function assertNotSsrf(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(
      `SSRF blocked: only https:// is permitted (got ${parsed.protocol})`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new SsrfBlockedError(`SSRF blocked: hostname "${hostname}" resolves to loopback`);
  }

  // IPv6 literal? URL.hostname strips the brackets from [...] but we also
  // accept bracketed forms for defense-in-depth.
  const v6 = hostname.replace(/^\[|\]$/g, '');
  if (looksLikeIPv6(v6)) {
    if (isBlockedIPv6(v6)) {
      throw new SsrfBlockedError(`SSRF blocked: IPv6 ${hostname} in reserved/private range`);
    }
    return;
  }

  // IPv4 literal?
  const v4 = parseIPv4(hostname);
  if (v4) {
    if (isBlockedIPv4(v4)) {
      throw new SsrfBlockedError(
        `SSRF blocked: IPv4 ${hostname} is in a reserved/private range`,
      );
    }
    return;
  }
  // For non-literal hostnames, we rely on Day-2 DNS re-resolution. Syntactic
  // guard completes here.
}

function looksLikeIPv6(host: string): boolean {
  return host.includes(':');
}

function isBlockedIPv6(v6: string): boolean {
  const h = v6.toLowerCase();

  if (h === '::' || h === '::1') return true; // unspecified / loopback
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 ULA (includes fd00::/8)
  if (h.startsWith('fd00:ec2:')) return true; // AWS IPv6 metadata service
  if (/^::ffff:/.test(h)) {
    // IPv4-mapped IPv6 — can arrive as dotted-quad (::ffff:10.0.0.1) OR as
    // WHATWG-normalized hex pair (::ffff:a00:1). Handle both.
    const tail = h.slice('::ffff:'.length);
    const v4FromDotted = parseIPv4(tail);
    if (v4FromDotted && isBlockedIPv4(v4FromDotted)) return true;
    const v4FromHex = parseMappedHex(tail);
    if (v4FromHex && isBlockedIPv4(v4FromHex)) return true;
  }
  return false;
}

/** Parse `HHHH:HHHH` (two 16-bit hex groups) into 4 octets. */
function parseMappedHex(tail: string): [number, number, number, number] | null {
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

/**
 * Parse a dotted-quad IPv4 literal. Returns null for anything else
 * (hostnames, IPv6, malformed strings).
 */
function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [
    number,
    number,
    number,
    number,
  ];
  for (const o of octets) {
    if (o < 0 || o > 255) return null;
  }
  return octets;
}

function isBlockedIPv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;

  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local (includes 169.254.169.254 EC2 metadata)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 "this host"
  if (a === 0) return true;
  // 100.64.0.0/10 carrier-grade NAT (defensive)
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}
