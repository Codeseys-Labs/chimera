/**
 * @chimera/chat-gateway
 *
 * Express HTTP gateway for AWS Chimera multi-tenant agent platform.
 * Routes Vercel AI SDK chat requests to tenant agents with SSE streaming.
 *
 * @packageDocumentation
 */

// Express app (for embedding in other servers)
export { default as app } from './server';

// Types
export * from './types';

// Middleware
export { extractTenantContext } from './middleware/tenant';

// Routes
export { default as chatRouter } from './routes/chat';
export { default as healthRouter } from './routes/health';

// Adapters
export * from './adapters/types';
export { WebPlatformAdapter } from './adapters/web';
export { TelegramPlatformAdapter } from './adapters/telegram';
export { TeamsPlatformAdapter } from './adapters/teams';
