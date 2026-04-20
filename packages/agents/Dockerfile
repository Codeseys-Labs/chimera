# Chimera Agent Dockerfile
#
# Uses public.ecr.aws/docker/library/python:3.11-slim — ECR Public mirror of
# Docker Hub python:3.11-slim. No rate limits in AWS CodeBuild.
# uv installed via pip for Python environment management.
#
# ---- Supply-chain: base image pinning policy ----
# The `FROM` line below SHOULD be pinned to a specific SHA256 digest so an
# upstream retag cannot silently substitute a different image. Refresh the
# digest quarterly (and any time a security patch is needed) by running:
#
#   docker pull public.ecr.aws/docker/library/python:3.11-slim
#   docker inspect --format='{{index .RepoDigests 0}}' \
#     public.ecr.aws/docker/library/python:3.11-slim
#
# Then replace the tag-only FROM below with the pinned form:
#
#   FROM public.ecr.aws/docker/library/python:3.11-slim@sha256:<digest>
#
# A placeholder template is kept below as a comment. Do NOT uncomment it until
# the digest is filled in -- `sha256:REPLACE_WITH_CURRENT_DIGEST` is not a
# valid digest and `docker build` will fail. See packages/agents/CONTRIBUTING.md
# for the quarterly refresh policy and rationale.
#
# FIXME(supply-chain): replace the tag-only FROM with a digest-pinned form:
# FROM public.ecr.aws/docker/library/python:3.11-slim@sha256:REPLACE_WITH_CURRENT_DIGEST

FROM public.ecr.aws/docker/library/python:3.11-slim

# Install uv and system dependencies (git required for some Python packages)
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv

WORKDIR /app

# Copy Python project files
COPY pyproject.toml .python-version uv.lock ./

# Install dependencies with uv
RUN uv sync --frozen --no-dev

# Copy agent code
COPY chimera_agent.py .
COPY tools/ ./tools/

# Set environment variables
ENV PYTHONUNBUFFERED=1

# AgentCore Runtime expects port 8080
EXPOSE 8080

# Run agent via AgentCore runtime module
CMD ["uv", "run", "python", "-m", "bedrock_agentcore.runtime"]
