FROM python:3.11-slim

WORKDIR /app

# Install system dependencies and uv
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | sh

# Add uv to PATH
ENV PATH="/root/.cargo/bin:${PATH}"

# Copy project files
COPY pyproject.toml .
COPY .python-version .
COPY uv.lock* ./

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
CMD ["python", "-m", "bedrock_agentcore.runtime"]
