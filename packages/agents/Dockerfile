# Chimera Agent Dockerfile
#
# Uses public.ecr.aws/docker/library/python:3.11-slim — ECR Public mirror of
# Docker Hub python:3.11-slim. No rate limits in AWS CodeBuild.
# uv installed via pip for Python environment management.

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
