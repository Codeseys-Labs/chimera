/**
 * Hono server for AWS Chimera chat gateway
 *
 * HTTP gateway that accepts Vercel AI SDK chat requests and routes them
 * to multi-tenant agents via @chimera/core, streaming responses via SSE.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authenticateJWT, optionalAuth } from './middleware/auth';
import { extractTenantContext } from './middleware/tenant';
import { rateLimitMiddleware, recordMetricsMiddleware } from './middleware/rate-limit';
import authRouter from './routes/auth';
import chatRouter from './routes/chat';
import discordRouter from './routes/discord';
import healthRouter from './routes/health';
import integrationsRouter from './routes/integrations';
import slackRouter from './routes/slack';
import teamsRouter from './routes/teams';
import telegramRouter from './routes/telegram';
import tenantRouter from './routes/tenant';
import { ErrorResponse } from './types';

// Create Hono app
const app = new Hono();

// Middleware
app.use('*', cors());

// Health check route (no auth required)
app.route('/', healthRouter);

// Auth routes (OAuth callback, token exchange, user info)
app.route('/auth', authRouter);

// Tenant provisioning API (administrative, requires authentication)
app.use('/tenants/*', authenticateJWT);
app.use('/tenants/*', extractTenantContext);
app.route('/tenants', tenantRouter);

// Handle Slack URL verification before tenant middleware.
// Slack sends challenges without tenant context during initial setup.
// Non-verification events fall through to slackRouter via next().
app.use('/slack/events', async (c, next) => {
  if (c.req.method === 'POST') {
    try {
      const body = await c.req.json();
      if (body?.type === 'url_verification') {
        return c.json({ challenge: body.challenge }, 200);
      }
    } catch {
      // Unparseable body — fall through to slackRouter for proper error handling
    }
  }
  return next();
});

// Apply auth + tenant middleware and rate limiting to all /chat/* and /slack/* routes.
// authenticateJWT: validates Cognito JWT — rejects unauthenticated requests (fail-closed).
// extractTenantContext: reads tenantId from verified JWT claims (NOT from X-Tenant-Id header
// in production) — prevents tenant impersonation via header spoofing.
app.use('/chat/*', authenticateJWT);
app.use('/chat/*', extractTenantContext);
app.use('/chat/*', rateLimitMiddleware('api-requests', 1));
app.use('/slack/*', extractTenantContext);
app.use('/slack/*', rateLimitMiddleware('slack-requests', 1));

// Chat routes
app.route('/chat', chatRouter);

// Slack routes
app.route('/slack', slackRouter);

// Discord routes (Ed25519 signature verification handled inside the router)
app.use('/discord/*', extractTenantContext);
app.use('/discord/*', rateLimitMiddleware('discord-requests', 1));
app.route('/discord', discordRouter);

// Teams routes (Bot Framework JWT verification handled inside the router)
app.use('/teams/*', extractTenantContext);
app.use('/teams/*', rateLimitMiddleware('teams-requests', 1));
app.route('/teams', teamsRouter);

// Telegram routes (secret token verification handled inside the router)
app.use('/telegram/*', extractTenantContext);
app.use('/telegram/*', rateLimitMiddleware('telegram-requests', 1));
app.route('/telegram', telegramRouter);

// Integration management routes (OAuth, user pairing)
app.use('/integrations/*', extractTenantContext);
app.route('/integrations', integrationsRouter);

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

    serve(
      {
        fetch: app.fetch,
        port: Number(PORT),
      },
      (info) => {
        console.log(`Chimera chat gateway listening on port ${info.port}`);
        console.log(`   Health: http://localhost:${info.port}/health`);
        console.log(`   Chat (streaming): POST http://localhost:${info.port}/chat/stream`);
        console.log(`   Chat (sync): POST http://localhost:${info.port}/chat/message`);
      }
    );
  })();
}
