/**
 * Express server for AWS Chimera chat gateway
 *
 * HTTP gateway that accepts Vercel AI SDK chat requests and routes them
 * to multi-tenant agents via @chimera/core, streaming responses via SSE.
 */

import express, { Request, Response, NextFunction } from 'express';
import type { Express } from 'express';
import cors from 'cors';
import path from 'path';
import { extractTenantContext } from './middleware/tenant';
import { rateLimitMiddleware, recordMetricsMiddleware } from './middleware/rate-limit';
import authRouter from './routes/auth';
import chatRouter from './routes/chat';
import healthRouter from './routes/health';
import slackRouter from './routes/slack';
import tenantRouter from './routes/tenant';
import { ErrorResponse } from './types';

// Create Express app
const app: Express = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Serve static files for web chat UI
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check route (no auth required)
app.use('/', healthRouter);

// Auth routes (OAuth callback, token exchange, user info)
app.use('/auth', authRouter);

// Tenant provisioning API (administrative, requires authentication)
app.use('/tenants', extractTenantContext);
app.use('/tenants', tenantRouter);

// Handle Slack URL verification before tenant middleware
// (Slack sends challenges without tenant context during initial setup)
app.post('/slack/events', (req: Request, res: Response, next: NextFunction) => {
  if (req.body?.type === 'url_verification') {
    res.status(200).json({ challenge: req.body.challenge });
    return;
  }
  next();
});

// Apply tenant middleware and rate limiting to all /chat/* and /slack/* routes
app.use('/chat', extractTenantContext);
app.use('/chat', rateLimitMiddleware('api-requests', 1));
app.use('/slack', extractTenantContext);
app.use('/slack', rateLimitMiddleware('slack-requests', 1));

// Chat routes
app.use('/chat', chatRouter);

// Slack routes
app.use('/slack', slackRouter);

// Record metrics after response (async, non-blocking)
app.use('/chat', recordMetricsMiddleware(1));
app.use('/slack', recordMetricsMiddleware(1));

// Global error handler
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);

  // Don't send error response if headers already sent (streaming)
  if (res.headersSent) {
    return;
  }

  const errorResponse: ErrorResponse = {
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred',
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    },
    timestamp: new Date().toISOString(),
  };

  res.status(500).json(errorResponse);
});

// Start server (only when run directly, not when imported for tests)
if (require.main === module) {
  const PORT = process.env.PORT || 8080;

  app.listen(PORT, () => {
    console.log(`🚀 Chimera chat gateway listening on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Chat (streaming): POST http://localhost:${PORT}/chat/stream`);
    console.log(`   Chat (sync): POST http://localhost:${PORT}/chat/message`);
  });
}

// Export for testing
export default app;
