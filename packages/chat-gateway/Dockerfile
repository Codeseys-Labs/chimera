# Chimera Chat Gateway Dockerfile
#
# Prebuild strategy: workspace deps (@chimera/shared, @chimera/core, @chimera/sse-bridge)
# are bundled at CodeBuild time (where the full monorepo exists) via:
#   bun build packages/chat-gateway/src/server.ts --outdir packages/chat-gateway/dist --target bun
# The Docker image simply copies and runs the pre-built bundle — no workspace resolution needed.
#
# Base: public.ecr.aws/debian/debian:bookworm-slim — ECR Public mirror of Docker Hub
# debian:bookworm-slim. No rate limits in AWS CodeBuild.
# Bun runtime installed via curl https://bun.sh/install to bypass Docker Hub entirely.

FROM public.ecr.aws/debian/debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    unzip \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install bun via official install script (no Docker Hub dependency)
RUN curl -fsSL https://bun.sh/install | bash && \
    cp /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

WORKDIR /app

# Copy pre-built bundle (all workspace deps inlined by CodeBuild)
COPY packages/chat-gateway/dist/server.js ./

# Copy static files for web chat UI (served at /static/*)
COPY packages/chat-gateway/public ./public

# Create non-root user
RUN groupadd -g 1001 chimera && \
    useradd -u 1001 -g chimera -s /bin/sh -M chimera

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

# Start pre-built bundle (bun installed to /usr/local/bin/bun)
CMD ["bun", "server.js"]
