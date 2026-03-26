# Chimera Agent Dockerfile
#
# Uses ghcr.io/astral-sh/uv:python3.11 — official Astral image with Python 3.11
# and uv pre-installed. Purpose-built for uv-managed Python projects.

FROM ghcr.io/astral-sh/uv:python3.11

WORKDIR /app

# Install system dependencies (git required for some Python packages)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

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
