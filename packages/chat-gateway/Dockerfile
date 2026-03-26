# Chimera Chat Gateway Dockerfile
#
# Prebuild strategy: workspace deps (@chimera/shared, @chimera/core, @chimera/sse-bridge)
# are bundled at CodeBuild time (where the full monorepo exists) via:
#   bun build packages/chat-gateway/src/server.ts --outdir packages/chat-gateway/dist --target bun
# The Docker image simply copies and runs the pre-built bundle — no workspace resolution needed.

FROM oven/bun:1.3-alpine

WORKDIR /app

# Copy pre-built bundle (all workspace deps inlined by CodeBuild)
COPY packages/chat-gateway/dist/server.js ./

# Copy static files for web chat UI (served at /static/*)
COPY packages/chat-gateway/public ./public

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

# Start pre-built bundle (bun, not node — oven/bun images do not include node binary)
CMD ["bun", "server.js"]
