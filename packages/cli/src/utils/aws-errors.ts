/**
 * Network and AWS SDK error utilities
 *
 * Provides helpers to detect and format offline/connectivity errors for
 * consistent user-facing messages across CLI commands.
 */

const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * Returns true if the error looks like a network connectivity problem
 * (DNS failure, timeout, refused connection, etc.)
 */
export function isOfflineError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && OFFLINE_CODES.has(code)) return true;
  // AWS SDK wraps network errors in the message string
  const msg = err.message;
  return (
    msg.includes('ENOTFOUND') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('getaddrinfo') ||
    msg.includes('network socket disconnected')
  );
}

/**
 * Returns a user-friendly error message for a network/offline error.
 * Falls back to the original error message if not a network error.
 */
export function formatNetworkError(err: unknown, service = 'remote service'): string {
  if (isOfflineError(err)) {
    return `Cannot reach ${service}. Check your network connection or VPN and try again.`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
