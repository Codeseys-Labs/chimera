# Chimera Chat Gateway Dockerfile
#
# Multi-stage build for production deployment.
# Uses Bun as the runtime for optimal performance.

# Stage 1: Build
FROM oven/bun:1.1.40-alpine AS builder

WORKDIR /app

# Copy monorepo root dependencies
COPY package.json bun.lockb tsconfig.json ./

# Copy workspace packages
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/sse-bridge ./packages/sse-bridge
COPY packages/chat-gateway ./packages/chat-gateway

# Install dependencies
RUN bun install --frozen-lockfile

# Build packages in dependency order
RUN cd packages/shared && bun run build
RUN cd packages/core && bun run build
RUN cd packages/sse-bridge && bun run build
RUN cd packages/chat-gateway && bun run build

# Stage 2: Production runtime
FROM oven/bun:1.1.40-alpine AS runtime

WORKDIR /app

# Copy only production dependencies and built artifacts
COPY --from=builder /app/package.json /app/bun.lockb ./
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/sse-bridge/package.json ./packages/sse-bridge/
COPY --from=builder /app/packages/sse-bridge/dist ./packages/sse-bridge/dist
COPY --from=builder /app/packages/chat-gateway/package.json ./packages/chat-gateway/
COPY --from=builder /app/packages/chat-gateway/dist ./packages/chat-gateway/dist
COPY --from=builder /app/packages/chat-gateway/public ./packages/chat-gateway/public

# Install production dependencies only
RUN bun install --production --frozen-lockfile

# Create non-root user
RUN addgroup -g 1001 -S chimera && \
    adduser -S chimera -u 1001

# Set ownership
RUN chown -R chimera:chimera /app

# Switch to non-root user
USER chimera

# Expose port
EXPOSE 8080

# Set environment
ENV NODE_ENV=production
ENV PORT=8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start server
WORKDIR /app/packages/chat-gateway
CMD ["bun", "run", "start"]
