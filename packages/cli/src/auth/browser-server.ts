/**
 * Browser-based login server for `chimera login --browser`
 *
 * Starts a local HTTP server on localhost:9999, serves a custom Chimera login
 * page, and awaits a POST /auth/callback from the browser with Cognito tokens.
 */

import browserLoginHtml from './browser-login.html' with { type: 'text' };
import { loadCredentials, saveCredentials } from '../utils/workspace.js';
import { color } from '../lib/color.js';

/**
 * Start a local HTTP server on localhost:9999, open the browser login page,
 * and wait for the browser to post tokens back via POST /auth/callback.
 * Resolves when credentials are saved; rejects on server error.
 */
export async function startBrowserLogin(clientId: string, region: string): Promise<void> {
  // Static import with { type: 'text' } tells Bun's bundler to embed the HTML
  // as a string constant at compile time — no filesystem access needed at runtime.
  // Cast to string: TypeScript infers HTMLBundle from the .html extension, but
  // the `with { type: 'text' }` attribute makes Bun emit it as a plain string.
  const htmlTemplate = browserLoginHtml as unknown as string;
  const loginHtml = htmlTemplate
    .replace('{{CLIENT_ID}}', clientId)
    .replace('{{REGION}}', region);

  return new Promise<void>((resolve, reject) => {
    // const is safe: fetch() closes over the binding but is never called during
    // Bun.serve() initialization — by the time a request arrives, server is assigned.
    const server = Bun.serve({
      port: 9999,

      async fetch(req: Request) {
        const url = new URL(req.url);

        if (req.method === 'GET' && url.pathname === '/') {
          return new Response(loginHtml, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
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
              headers: { 'Content-Type': 'application/json' },
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

    const loginUrl = 'http://localhost:9999';
    console.log(color.dim(`\nOpening browser at ${loginUrl}`));
    console.log(color.dim('Complete login in your browser. Waiting for authentication...\n'));

    // Open browser — macOS, Linux, Windows
    const platform = process.platform;
    const openCmd =
      platform === 'darwin' ? ['open', loginUrl]
      : platform === 'win32' ? ['cmd', '/c', 'start', loginUrl]
      : ['xdg-open', loginUrl];
    Bun.spawn(openCmd, { stdio: ['ignore', 'ignore', 'ignore'] });
  });
}
