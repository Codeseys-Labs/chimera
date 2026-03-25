# Chimera Chat Gateway Dockerfile
#
# Single-stage build: Bun runs TypeScript directly, no compilation needed.
# Generates a minimal root package.json to avoid resolving unused workspaces.

FROM oven/bun:1.3-alpine

WORKDIR /app

# Generate minimal root package.json (excludes infra, tests to avoid resolution failures)
RUN echo '{"name":"chimera","version":"1.0.0","workspaces":["packages/*"],"private":true}' > package.json

# Copy workspace packages (only the ones needed for chat-gateway)
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/sse-bridge ./packages/sse-bridge
COPY packages/chat-gateway ./packages/chat-gateway

# Copy lockfile
COPY bun.lock ./

# Install dependencies (no --frozen-lockfile for partial workspace resolution per mx-35e196)
RUN bun install

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

# Start server (Bun runs TypeScript directly, no build needed)
WORKDIR /app/packages/chat-gateway
CMD ["bun", "src/server.ts"]
