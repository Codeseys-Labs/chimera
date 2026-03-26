/**
 * Hono server for AWS Chimera chat gateway
 *
 * HTTP gateway that accepts Vercel AI SDK chat requests and routes them
 * to multi-tenant agents via @chimera/core, streaming responses via SSE.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { extractTenantContext } from './middleware/tenant';
import { rateLimitMiddleware, recordMetricsMiddleware } from './middleware/rate-limit';
import authRouter from './routes/auth';
import chatRouter from './routes/chat';
import healthRouter from './routes/health';
import slackRouter from './routes/slack';
import tenantRouter from './routes/tenant';
import { ErrorResponse } from './types';

// Create Hono app
const app = new Hono();

// Middleware
app.use('*', cors());

// Serve static files for web chat UI (if public directory exists)
app.use('/static/*', serveStatic({ root: './public' }));

// Health check route (no auth required)
app.route('/', healthRouter);

// Auth routes (OAuth callback, token exchange, user info)
app.route('/auth', authRouter);

// Tenant provisioning API (administrative, requires authentication)
app.use('/tenants/*', extractTenantContext);
app.route('/tenants', tenantRouter);

// Handle Slack URL verification before tenant middleware
// (Slack sends challenges without tenant context during initial setup)
app.post('/slack/events', async (c) => {
  const body = await c.req.json();
  if (body?.type === 'url_verification') {
    return c.json({ challenge: body.challenge }, 200);
  }
  // For non-verification events, continue to slack router
  // This is a workaround - ideally slack router would handle this
  return c.json({ error: 'Invalid event type' }, 400);
});

// Apply tenant middleware and rate limiting to all /chat/* and /slack/* routes
app.use('/chat/*', extractTenantContext);
app.use('/chat/*', rateLimitMiddleware('api-requests', 1));
app.use('/slack/*', extractTenantContext);
app.use('/slack/*', rateLimitMiddleware('slack-requests', 1));

// Chat routes
app.route('/chat', chatRouter);

// Slack routes
app.route('/slack', slackRouter);

// Record metrics after response (async, non-blocking)
app.use('/chat/*', recordMetricsMiddleware(1));
app.use('/slack/*', recordMetricsMiddleware(1));

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);

  const errorResponse: ErrorResponse = {
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred',
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    },
    timestamp: new Date().toISOString(),
  };

  return c.json(errorResponse, 500);
});

// Named export for library/test use.
// NOTE: Do NOT add `export default app` here. Bun detects a default export
// with a .fetch method and auto-starts a built-in HTTP server ("Started
// development server"), which races with the explicit serve() below and causes
// "port already in use" crashes in the Docker container.
export { app };

// Start server only when this module is the entry point (not when imported by tests).
// In Node.js CJS (jest/ts-jest), require.main !== module when imported — correct.
// In the Bun bundle (bun server.js), Bun's CJS compat sets require.main === module
// for the entry file — correct, server starts exactly once.
if (require.main === module) {
  (async () => {
    const { serve } = await import('@hono/node-server');
    const PORT = process.env.PORT || 8080;

    serve({
      fetch: app.fetch,
      port: Number(PORT),
    }, (info) => {
      console.log(`Chimera chat gateway listening on port ${info.port}`);
      console.log(`   Health: http://localhost:${info.port}/health`);
      console.log(`   Chat (streaming): POST http://localhost:${info.port}/chat/stream`);
      console.log(`   Chat (sync): POST http://localhost:${info.port}/chat/message`);
    });
  })();
}
