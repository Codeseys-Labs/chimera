/**
 * Browser-based login callback server for `chimera login --browser`
 *
 * Starts a local HTTP server on localhost:9999 that receives POST /auth/callback
 * from the deployed frontend login page. The CLI opens the deployed frontend URL
 * with a ?callback= query param; the frontend POSTs tokens back here after auth.
 */

import { loadCredentials, saveCredentials } from '../utils/workspace.js';
import { color } from '../lib/color.js';

/**
 * Start a local callback server on localhost:9999, open the deployed login page,
 * and wait for the frontend to POST tokens back via POST /auth/callback.
 * Resolves when credentials are saved; rejects on server error.
 */
export async function startBrowserLogin(frontendUrl: string): Promise<void> {
  const CALLBACK_PORT = 9999;
  const callbackUrl = encodeURIComponent('http://localhost:' + CALLBACK_PORT + '/auth/callback');
  const loginUrl = frontendUrl + '/login?callback=' + decodeURIComponent(callbackUrl);
  const allowedOrigin = new URL(frontendUrl).origin;

  return new Promise<void>((resolve, reject) => {
    // const is safe: fetch() closes over the binding but is never called during
    // Bun.serve() initialization — by the time a request arrives, server is assigned.
    const server = Bun.serve({
      port: CALLBACK_PORT,

      async fetch(req: Request) {
        const url = new URL(req.url);

        // CORS preflight for deployed frontend origin
        if (req.method === 'OPTIONS') {
          return new Response(null, {
            headers: {
              'Access-Control-Allow-Origin': allowedOrigin,
              'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
            },
          });
        }

        if (req.method === 'POST' && url.pathname === '/auth/callback') {
          try {
            const body = await req.json() as {
              access_token: string;
              id_token: string;
              refresh_token: string;
              expires_in?: number;
            };

            const expiresAt = new Date(
              Date.now() + (body.expires_in ?? 3600) * 1000,
            ).toISOString();

            const existing = loadCredentials();
            saveCredentials({
              ...existing,
              auth: {
                access_token: body.access_token,
                id_token: body.id_token ?? '',
                refresh_token: body.refresh_token ?? '',
                expires_at: expiresAt,
              },
            });

            server.stop(true);
            resolve();
            return new Response(JSON.stringify({ ok: true }), {
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': allowedOrigin,
              },
            });
          } catch (err) {
            server.stop(true);
            reject(err instanceof Error ? err : new Error(String(err)));
            return new Response(JSON.stringify({ error: 'Failed to process tokens' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        return new Response('Not Found', { status: 404 });
      },

      error(err: Error) {
        reject(err);
        return new Response('Internal Server Error', { status: 500 });
      },
    });

    console.log(color.gray(`\nOpening browser at ${loginUrl}`));
    console.log(color.gray('Complete login in your browser. Waiting for authentication...\n'));

    // Open browser — macOS, Linux, Windows
    const platform = process.platform;
    const openCmd =
      platform === 'darwin' ? ['open', loginUrl]
      : platform === 'win32' ? ['cmd', '/c', 'start', loginUrl]
      : ['xdg-open', loginUrl];
    Bun.spawn(openCmd, { stdio: ['ignore', 'ignore', 'ignore'] });
  });
}
