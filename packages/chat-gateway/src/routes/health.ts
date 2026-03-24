/**
 * Health check routes
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { HealthResponse } from '../types';

const router = new Hono();

/**
 * GET /health
 *
 * Health check endpoint for ALB target group health checks
 */
router.get('/health', (c: Context) => {
  const response: HealthResponse = {
    status: 'healthy',
    service: 'chimera-chat-gateway',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  };

  return c.json(response, 200);
});

export default router;
