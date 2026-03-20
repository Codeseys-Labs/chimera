/**
 * Health check routes
 */

import { Router, Request, Response } from 'express';
import type { Router as ExpressRouter } from 'express';
import { HealthResponse } from '../types';

const router: ExpressRouter = Router();

/**
 * GET /health
 *
 * Health check endpoint for ALB target group health checks
 */
router.get('/health', (_req: Request, res: Response) => {
  const response: HealthResponse = {
    status: 'healthy',
    service: 'chimera-chat-gateway',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  };

  res.status(200).json(response);
});

export default router;
