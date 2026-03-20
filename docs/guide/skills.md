# Skill Authoring Guide

> **Learn how to create, test, and publish custom skills for Chimera agents.**

Skills extend agent capabilities by providing tools, functions, and integrations. Chimera supports three skill formats:

1. **SKILL.md v2** — Markdown-based format (OpenClaw-compatible)
2. **Python SDK** — `@tool` decorator (Strands-native)
3. **TypeScript SDK** — Function-based tools
4. **MCP Tools** — Model Context Protocol integration (10,000+ community tools)

This guide covers all four approaches.

---

## Table of Contents

- [Understanding Skills](#understanding-skills)
- [SKILL.md v2 Format](#skillmd-v2-format)
- [Python SDK](#python-sdk)
- [TypeScript SDK](#typescript-sdk)
- [MCP Integration](#mcp-integration)
- [Testing Skills](#testing-skills)
- [Publishing Skills](#publishing-skills)
- [Security Best Practices](#security-best-practices)

---

## Understanding Skills

### What is a Skill?

A **skill** is a reusable capability that agents can invoke to accomplish tasks:

```
Skill = Metadata + Instructions + Tools + Permissions
```

| Component | Purpose | Example |
|-----------|---------|---------|
| **Metadata** | Name, version, description, author | `aws-cost-analyzer@1.2.0` |
| **Instructions** | When and how to use the skill | "Analyze AWS costs when user asks about spending" |
| **Tools** | Functions the skill can call | `get_cost_data()`, `generate_recommendations()` |
| **Permissions** | What the skill can access | `filesystem: read`, `network: outbound` |

### Skill Lifecycle

```
1. Author       → Write skill definition (SKILL.md or @tool)
2. Test         → Local testing with mock data
3. Package      → Bundle as .skill.tar.gz
4. Publish      → Upload to skill registry (DynamoDB + S3)
5. Install      → Tenant installs skill (version pinning)
6. Execute      → Agent invokes skill tools at runtime
7. Update       → Publish new version with semver
```

### Skill Categories

Chimera organizes skills into fixed categories (follows SKILL.md v2 spec):

```
core/              # Built-in platform skills (auth, memory, search)
productivity/      # Task management, calendars, email, notes
development/       # Code analysis, CI/CD, version control
data/              # Databases, APIs, ETL, analytics
security/          # Secrets management, auditing, compliance
cloud/             # AWS, GCP, Azure integrations
communication/     # Slack, Teams, Discord, email
media/             # Image/video processing, transcription
finance/           # Billing, cost analysis, payments
custom/            # Tenant-specific skills
```

---

## SKILL.md v2 Format

### Overview

SKILL.md v2 is a **markdown file** with YAML frontmatter. It's human-readable, LLM-optimized, and compatible with OpenClaw's 13,700+ skill ecosystem.

### Basic Structure

```markdown
---
name: skill-name
version: 1.0.0
description: "Brief description"
category: productivity
author: your-org
license: MIT
tags: [tag1, tag2, tag3]

# Tools this skill needs (maps to Chimera tool names)
tools:
  - Bash
  - Read
  - Write
  - WebFetch

# Permissions required
permissions:
  filesystem: read-write
  network: outbound
  secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]

# External dependencies
dependencies:
  cli: [aws, jq]
  npm: [typescript]
  python: [boto3, pandas]

# MCP servers to connect (optional)
mcp_servers:
  - name: aws-mcp
    registry: "@mcp/aws"

# Skill triggers (LLM selection hints)
triggers:
  patterns:
    - "analyze aws costs"
    - "cost optimization"
    - "aws spending"
  entities: [aws, cost, billing, optimization]
  intents: [analyze, optimize, reduce_costs]
---

# Skill Title

## Purpose

[1-2 sentences explaining what this skill does]

## When to Use

Activate this skill when the user:

- [Condition 1]
- [Condition 2]
- [Condition 3]

## Instructions

### Step 1: [Action]

[Detailed instructions for the agent]

### Step 2: [Action]

[More instructions]

## Constraints

- [Important limitation or safety rule]
- [Another constraint]

## Examples

**Example 1: [Scenario]**

```
User: [Input]
Agent: [Expected behavior]
```

**Example 2: [Scenario]**

```
User: [Input]
Agent: [Expected behavior]
```

## Troubleshooting

**Problem:** [Common issue]
**Solution:** [How to fix]
```

### Complete Example: AWS Cost Analyzer

Create `aws-cost-analyzer/SKILL.md`:

```markdown
---
name: aws-cost-analyzer
version: 1.2.0
description: "Analyze AWS costs and provide optimization recommendations"
category: cloud
author: chimera-platform
license: MIT
tags: [aws, cost, optimization, cloud, billing]

tools:
  - Bash
  - Read
  - Write

permissions:
  filesystem: read-write
  network: outbound
  secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]

dependencies:
  cli: [aws, jq]
  python: [boto3, pandas]

triggers:
  patterns:
    - "analyze aws costs"
    - "cost optimization"
    - "aws spending"
    - "reduce aws bill"
  entities: [aws, cost, billing, budget, savings]
  intents: [analyze, optimize, reduce]
---

# AWS Cost Analyzer

## Purpose

Analyze AWS Cost Explorer data and provide actionable optimization recommendations.

## When to Use

Activate when the user asks about:

- AWS spending or costs
- Cost optimization opportunities
- Resource right-sizing
- Reserved instance recommendations
- Identifying unused resources

## Instructions

### Step 1: Gather Cost Data

Run AWS Cost Explorer query:

```bash
aws ce get-cost-and-usage \
  --time-period Start=2026-02-01,End=2026-03-01 \
  --granularity MONTHLY \
  --metrics BlendedCost \
  --group-by Type=SERVICE
```

Parse the JSON output to extract per-service costs.

### Step 2: Identify Top Spenders

1. Sort services by cost descending
2. Focus on top 10 services (typically 80% of spend)
3. For each service, query detailed usage:

```bash
aws ce get-cost-and-usage \
  --time-period Start=2026-02-01,End=2026-03-01 \
  --granularity DAILY \
  --metrics BlendedCost UsageQuantity \
  --filter file://filter.json \
  --group-by Type=USAGE_TYPE
```

### Step 3: Generate Recommendations

For each top-spending service, check:

1. **Unused resources**: 0 CPU/network for 7+ days
   ```bash
   aws cloudwatch get-metric-statistics \
     --namespace AWS/EC2 \
     --metric-name CPUUtilization \
     --dimensions Name=InstanceId,Value=i-xxx \
     --start-time 2026-02-15T00:00:00Z \
     --end-time 2026-02-22T00:00:00Z \
     --period 86400 \
     --statistics Average
   ```

2. **Oversized instances**: < 20% average utilization
   - Recommend downsize (e.g., t3.large → t3.medium)

3. **Missing reservations**: On-demand for steady-state workloads
   - Calculate savings with 1-year Reserved Instance

4. **Storage optimization**: Old snapshots, unattached EBS volumes
   ```bash
   aws ec2 describe-snapshots --owner-ids self \
     --query 'Snapshots[?StartTime<=`2025-01-01`]'
   ```

### Step 4: Output Report

Format as markdown table:

```markdown
## AWS Cost Optimization Report

**Analysis Period:** Feb 1 - Mar 1, 2026
**Total Spend:** $12,450

### Top 3 Opportunities

| Service | Issue | Recommendation | Est. Monthly Savings |
|---------|-------|----------------|----------------------|
| EC2 | 5 stopped instances (m5.2xlarge) | Terminate | $600 |
| RDS | db.r5.xlarge at 15% CPU | Downsize to db.r5.large | $350 |
| S3 | 2TB Glacier data not accessed in 90d | Delete or archive | $40 |

**Total Potential Savings:** $990/month ($11,880/year)
```

## Constraints

- **Never modify AWS resources** without explicit user confirmation
- Always show cost data before recommending changes
- Use `--dry-run` flags when available
- Respect resource tags (e.g., `DoNotTerminate=true`)
- Check for recent activity before recommending termination

## Examples

**Example 1: Basic Cost Analysis**

```
User: How much did we spend on AWS last month?
Agent: Let me check your AWS costs...
[runs aws ce get-cost-and-usage]
You spent $12,450 in February 2026. The top 3 services were:
1. EC2: $5,200
2. RDS: $3,100
3. S3: $1,800
Would you like me to analyze optimization opportunities?
```

**Example 2: Unused Resource Detection**

```
User: Find resources we're not using
Agent: Scanning for unused resources...
[checks CloudWatch metrics for low utilization]
Found 5 potential issues:
- 3 stopped EC2 instances (not started in 30+ days)
- 2 unattached EBS volumes (80 GB total)
- 1 RDS instance at 5% CPU average
Estimated monthly waste: $420
Shall I provide detailed recommendations?
```

## Troubleshooting

**Problem:** "An error occurred (AccessDeniedException)"
**Solution:** Ensure AWS credentials have Cost Explorer read permissions:
```json
{
  "Effect": "Allow",
  "Action": ["ce:GetCostAndUsage", "ce:GetCostForecast"],
  "Resource": "*"
}
```

**Problem:** "No data returned for time period"
**Solution:** Cost Explorer data has 24-hour delay. Use date ranges ending yesterday or earlier.
```

---

## Python SDK

### Overview

The Python SDK uses the **`@tool` decorator** from Strands Agents. Tools are defined as Python functions with type hints and docstrings.

### Basic Tool Definition

```python
from strands import tool
from typing import Optional

@tool
def search_documentation(
    query: str,
    source: str = "all",
    max_results: int = 5
) -> list[dict]:
    """Search technical documentation across multiple sources.

    Args:
        query: Search query (natural language or keywords)
        source: Documentation source ('aws', 'python', 'typescript', or 'all')
        max_results: Maximum number of results to return (default: 5, max: 20)

    Returns:
        List of documents with title, url, snippet, and relevance score

    Raises:
        ValueError: If source is not recognized
    """
    # Implementation
    if source not in ["aws", "python", "typescript", "all"]:
        raise ValueError(f"Unknown source: {source}")

    # Call search API
    results = call_search_api(query, source, max_results)

    return [
        {
            "title": doc["title"],
            "url": doc["url"],
            "snippet": doc["snippet"][:200],
            "score": doc["relevance"]
        }
        for doc in results
    ]
```

### Tool Schema Generation

Strands automatically generates JSON Schema from:

- **Type hints**: `str`, `int`, `bool`, `list[dict]`, `Optional[str]`
- **Docstring**: Description, parameter docs, return value
- **Default values**: Optional parameters

Generated schema:

```json
{
  "name": "search_documentation",
  "description": "Search technical documentation across multiple sources.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query (natural language or keywords)"
      },
      "source": {
        "type": "string",
        "description": "Documentation source ('aws', 'python', 'typescript', or 'all')",
        "default": "all",
        "enum": ["aws", "python", "typescript", "all"]
      },
      "max_results": {
        "type": "integer",
        "description": "Maximum number of results to return (default: 5, max: 20)",
        "default": 5
      }
    },
    "required": ["query"]
  }
}
```

### Multi-Tool Skills

Group related tools in a skill module:

```python
# skills/github_integration.py
from strands import tool
import requests
import os

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")

@tool
def create_github_issue(
    repo: str,
    title: str,
    body: str,
    labels: list[str] = []
) -> dict:
    """Create a new GitHub issue.

    Args:
        repo: Repository in format 'owner/repo'
        title: Issue title
        body: Issue body (markdown supported)
        labels: Optional list of labels to apply

    Returns:
        Created issue details (number, url, state)
    """
    url = f"https://api.github.com/repos/{repo}/issues"
    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }
    data = {"title": title, "body": body, "labels": labels}

    response = requests.post(url, json=data, headers=headers)
    response.raise_for_status()

    issue = response.json()
    return {
        "number": issue["number"],
        "url": issue["html_url"],
        "state": issue["state"]
    }


@tool
def list_github_issues(
    repo: str,
    state: str = "open",
    labels: list[str] = []
) -> list[dict]:
    """List GitHub issues for a repository.

    Args:
        repo: Repository in format 'owner/repo'
        state: Issue state ('open', 'closed', or 'all')
        labels: Filter by labels (comma-separated)

    Returns:
        List of issues with number, title, state, and url
    """
    url = f"https://api.github.com/repos/{repo}/issues"
    params = {"state": state}
    if labels:
        params["labels"] = ",".join(labels)

    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }

    response = requests.get(url, params=params, headers=headers)
    response.raise_for_status()

    return [
        {
            "number": issue["number"],
            "title": issue["title"],
            "state": issue["state"],
            "url": issue["html_url"]
        }
        for issue in response.json()
    ]


@tool
def close_github_issue(repo: str, issue_number: int) -> dict:
    """Close a GitHub issue.

    Args:
        repo: Repository in format 'owner/repo'
        issue_number: Issue number to close

    Returns:
        Updated issue details (number, state, url)
    """
    url = f"https://api.github.com/repos/{repo}/issues/{issue_number}"
    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    }
    data = {"state": "closed"}

    response = requests.patch(url, json=data, headers=headers)
    response.raise_for_status()

    issue = response.json()
    return {
        "number": issue["number"],
        "state": issue["state"],
        "url": issue["html_url"]
    }
```

### Register Python Skill

Add to agent definition:

```python
from strands import Agent
from strands.models import BedrockModel
from skills.github_integration import (
    create_github_issue,
    list_github_issues,
    close_github_issue
)

agent = Agent(
    model=BedrockModel(model_id="us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
    tools=[
        create_github_issue,
        list_github_issues,
        close_github_issue
    ],
    system_prompt="""You are a GitHub assistant.

    You can create, list, and close issues in GitHub repositories.
    Always confirm before closing issues or creating new ones.
    """
)
```

---

## TypeScript SDK

### Overview

TypeScript skills use the `ToolDefinition` interface from `@chimera/shared`. Tools are defined as objects with `inputSchema` (JSON Schema) and `executor` (async function).

### Basic Tool Definition

```typescript
import { ToolDefinition } from '@chimera/shared';

export const searchDocsTool: ToolDefinition = {
  name: 'search_documentation',
  description: 'Search technical documentation across multiple sources',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (natural language or keywords)'
      },
      source: {
        type: 'string',
        description: 'Documentation source',
        enum: ['aws', 'python', 'typescript', 'all'],
        default: 'all'
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results',
        default: 5,
        minimum: 1,
        maximum: 20
      }
    },
    required: ['query']
  },
  executor: async (input: {
    query: string;
    source?: string;
    maxResults?: number;
  }) => {
    const source = input.source || 'all';
    const maxResults = input.maxResults || 5;

    // Validate source
    if (!['aws', 'python', 'typescript', 'all'].includes(source)) {
      throw new Error(`Unknown source: ${source}`);
    }

    // Call search API
    const results = await callSearchAPI(query, source, maxResults);

    return results.map(doc => ({
      title: doc.title,
      url: doc.url,
      snippet: doc.snippet.slice(0, 200),
      score: doc.relevance
    }));
  }
};
```

### Multi-Tool Skills

Group tools in a TypeScript module:

```typescript
// packages/core/src/skills/github.ts
import { ToolDefinition } from '@chimera/shared';
import { Octokit } from '@octokit/rest';

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

export const createGitHubIssueTool: ToolDefinition = {
  name: 'create_github_issue',
  description: 'Create a new GitHub issue',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in format owner/repo',
        pattern: '^[^/]+/[^/]+$'
      },
      title: {
        type: 'string',
        description: 'Issue title'
      },
      body: {
        type: 'string',
        description: 'Issue body (markdown supported)'
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of labels',
        default: []
      }
    },
    required: ['repo', 'title', 'body']
  },
  executor: async (input) => {
    const [owner, repo] = input.repo.split('/');

    const { data: issue } = await octokit.issues.create({
      owner,
      repo,
      title: input.title,
      body: input.body,
      labels: input.labels || []
    });

    return {
      number: issue.number,
      url: issue.html_url,
      state: issue.state
    };
  }
};

export const listGitHubIssuesTool: ToolDefinition = {
  name: 'list_github_issues',
  description: 'List GitHub issues for a repository',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in format owner/repo'
      },
      state: {
        type: 'string',
        description: 'Issue state',
        enum: ['open', 'closed', 'all'],
        default: 'open'
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by labels',
        default: []
      }
    },
    required: ['repo']
  },
  executor: async (input) => {
    const [owner, repo] = input.repo.split('/');

    const { data: issues } = await octokit.issues.listForRepo({
      owner,
      repo,
      state: input.state as 'open' | 'closed' | 'all',
      labels: input.labels?.join(',')
    });

    return issues.map(issue => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.html_url
    }));
  }
};

export const closeGitHubIssueTool: ToolDefinition = {
  name: 'close_github_issue',
  description: 'Close a GitHub issue',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in format owner/repo'
      },
      issueNumber: {
        type: 'number',
        description: 'Issue number to close'
      }
    },
    required: ['repo', 'issueNumber']
  },
  executor: async (input) => {
    const [owner, repo] = input.repo.split('/');

    const { data: issue } = await octokit.issues.update({
      owner,
      repo,
      issue_number: input.issueNumber,
      state: 'closed'
    });

    return {
      number: issue.number,
      state: issue.state,
      url: issue.html_url
    };
  }
};

// Export all tools as array
export const githubTools: ToolDefinition[] = [
  createGitHubIssueTool,
  listGitHubIssuesTool,
  closeGitHubIssueTool
];
```

### Register TypeScript Skill

Add to agent config:

```typescript
import { ChimeraAgent, AgentConfig } from '@chimera/core';
import { githubTools } from './skills/github';

export const githubAgentConfig: AgentConfig = {
  name: 'github-assistant',
  description: 'GitHub repository management assistant',
  tools: githubTools,
  systemPrompt: `You are a GitHub assistant.

  You can create, list, and close issues in GitHub repositories.
  Always confirm before closing issues or creating new ones.`,
  isolation: {
    memoryNamespace: 'tenant-{tenant_id}-user-{user_id}',
    microVmEnabled: true
  }
};
```

---

## MCP Integration

### Overview

The **Model Context Protocol (MCP)** provides access to 10,000+ community tools. Chimera integrates MCP via **AgentCore Gateway**.

### Connecting MCP Servers

Add MCP servers to skill metadata:

```yaml
# In SKILL.md frontmatter
mcp_servers:
  - name: aws-mcp
    registry: "@mcp/aws"
    version: "^1.0.0"

  - name: github-mcp
    registry: "@modelcontextprotocol/server-github"
    version: "^0.5.0"
```

### Using MCP Tools in Python

```python
from strands.tools.mcp import MCPClient

# Connect to MCP server
mcp_client = MCPClient(
    server_name="aws-mcp",
    transport="stdio"  # or "http" for remote servers
)

# List available tools
tools = mcp_client.list_tools()
print(f"Available tools: {[t['name'] for t in tools]}")

# Add MCP tools to agent
agent = Agent(
    model=BedrockModel(model_id="us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
    tools=mcp_client.tools,  # All MCP tools
    system_prompt="You are an AWS assistant with MCP tool access."
)
```

### Using MCP Tools via AgentCore Gateway

For multi-tenant deployments, use **AgentCore Gateway** (managed MCP infrastructure):

```python
from chimera.core import ChimeraAgent
from chimera.core.gateway import GatewayClient

# Connect to AgentCore Gateway
gateway = GatewayClient(
    endpoint="https://gateway.chimera.example.com",
    tenant_id="tenant-abc123"
)

# Install MCP server for tenant
gateway.install_mcp_server(
    name="aws-mcp",
    registry="@mcp/aws",
    version="1.0.0"
)

# Gateway automatically provides tools to agents
agent = ChimeraAgent(
    tenant_id="tenant-abc123",
    agent_name="aws-assistant",
    gateway=gateway  # Automatically loads installed MCP tools
)
```

**Benefits of Gateway:**

- **Multi-tenant isolation**: Each tenant gets isolated MCP namespaces
- **Semantic discovery**: Search 10,000+ tools by natural language
- **Auto-scaling**: Gateway manages MCP server lifecycle
- **Cost tracking**: Per-tenant MCP usage attribution

---

## Testing Skills

### Local Testing (Python)

```python
# test_github_skill.py
import pytest
from skills.github_integration import create_github_issue, list_github_issues

def test_create_issue():
    """Test issue creation"""
    result = create_github_issue(
        repo="test-org/test-repo",
        title="Test issue",
        body="This is a test",
        labels=["bug"]
    )

    assert result["number"] > 0
    assert "url" in result
    assert result["state"] == "open"


def test_list_issues():
    """Test issue listing"""
    issues = list_github_issues(
        repo="test-org/test-repo",
        state="open"
    )

    assert isinstance(issues, list)
    for issue in issues:
        assert "number" in issue
        assert "title" in issue
        assert "url" in issue


@pytest.mark.integration
def test_full_workflow():
    """Test create → list → close workflow"""
    # Create issue
    issue = create_github_issue(
        repo="test-org/test-repo",
        title="Integration test",
        body="Testing full workflow"
    )

    # Verify it appears in list
    issues = list_github_issues(repo="test-org/test-repo", state="open")
    assert any(i["number"] == issue["number"] for i in issues)

    # Close issue
    closed = close_github_issue(
        repo="test-org/test-repo",
        issue_number=issue["number"]
    )
    assert closed["state"] == "closed"
```

Run tests:

```bash
# Unit tests only
pytest test_github_skill.py -m "not integration"

# Integration tests (requires GitHub token)
export GITHUB_TOKEN=ghp_xxx
pytest test_github_skill.py
```

### Local Testing (TypeScript)

```typescript
// __tests__/github-skill.test.ts
import { describe, it, expect, beforeAll } from 'bun:test';
import {
  createGitHubIssueTool,
  listGitHubIssuesTool,
  closeGitHubIssueTool
} from '../src/skills/github';

describe('GitHub Skill', () => {
  beforeAll(() => {
    process.env.GITHUB_TOKEN = 'ghp_test_token';
  });

  it('should create an issue', async () => {
    const result = await createGitHubIssueTool.executor({
      repo: 'test-org/test-repo',
      title: 'Test issue',
      body: 'This is a test',
      labels: ['bug']
    });

    expect(result.number).toBeGreaterThan(0);
    expect(result.url).toBeDefined();
    expect(result.state).toBe('open');
  });

  it('should list issues', async () => {
    const issues = await listGitHubIssuesTool.executor({
      repo: 'test-org/test-repo',
      state: 'open'
    });

    expect(Array.isArray(issues)).toBe(true);
    issues.forEach(issue => {
      expect(issue.number).toBeDefined();
      expect(issue.title).toBeDefined();
      expect(issue.url).toBeDefined();
    });
  });

  it('should close an issue', async () => {
    // First create an issue
    const created = await createGitHubIssueTool.executor({
      repo: 'test-org/test-repo',
      title: 'Test close',
      body: 'Will be closed'
    });

    // Then close it
    const closed = await closeGitHubIssueTool.executor({
      repo: 'test-org/test-repo',
      issueNumber: created.number
    });

    expect(closed.state).toBe('closed');
  });
});
```

Run tests:

```bash
bun test
```

### Testing with Chimera CLI

```bash
# Install skill locally
chimera skill install ./aws-cost-analyzer

# Test skill in interactive mode
chimera skill test aws-cost-analyzer

# Example interaction:
> analyze my aws costs
[Agent invokes aws-cost-analyzer skill tools]
```

---

## Publishing Skills

### 1. Package Skill

```bash
cd aws-cost-analyzer/

# Create package manifest
cat > skill.json <<EOF
{
  "name": "aws-cost-analyzer",
  "version": "1.2.0",
  "category": "cloud",
  "author": "your-org",
  "license": "MIT"
}
EOF

# Package as tarball
tar -czf aws-cost-analyzer-1.2.0.skill.tar.gz \
  SKILL.md \
  skill.json \
  README.md \
  LICENSE
```

### 2. Test Package

```bash
# Install from local tarball
chimera skill install ./aws-cost-analyzer-1.2.0.skill.tar.gz

# Run integration tests
chimera skill test aws-cost-analyzer --integration
```

### 3. Publish to Registry

```bash
# Authenticate
chimera auth login

# Publish skill
chimera skill publish aws-cost-analyzer-1.2.0.skill.tar.gz

# Output:
# ✓ Skill published: aws-cost-analyzer@1.2.0
# Registry URL: https://skills.chimera.aws/aws-cost-analyzer
# Install command: chimera skill install aws-cost-analyzer
```

### 4. Semantic Versioning

Follow semver for skill versions:

- **Patch** (1.2.0 → 1.2.1): Bug fixes, no breaking changes
- **Minor** (1.2.1 → 1.3.0): New features, backward compatible
- **Major** (1.3.0 → 2.0.0): Breaking changes (tool signature changes, removed tools)

### 5. Version Pinning

Tenants can pin skill versions:

```bash
# Install specific version
chimera skill install aws-cost-analyzer@1.2.0

# Update to latest compatible version (respects major version)
chimera skill update aws-cost-analyzer

# Force upgrade to breaking version
chimera skill install aws-cost-analyzer@2.0.0
```

---

## Security Best Practices

### 1. Permissions Model

**Principle:** Skills should request **minimum necessary permissions**.

```yaml
# Good: Specific permissions
permissions:
  filesystem: read
  network: outbound
  secrets: [GITHUB_TOKEN]

# Bad: Overly broad permissions
permissions:
  filesystem: read-write  # Only if truly needed
  network: bidirectional  # Rarely needed
  secrets: ["*"]  # Never use wildcard
```

### 2. Input Validation

Always validate tool inputs:

```python
@tool
def delete_resource(resource_id: str) -> dict:
    """Delete a resource by ID."""

    # Validate ID format
    if not re.match(r'^[a-z0-9-]{8,64}$', resource_id):
        raise ValueError(f"Invalid resource_id format: {resource_id}")

    # Check if resource exists
    if not resource_exists(resource_id):
        raise ValueError(f"Resource not found: {resource_id}")

    # Perform deletion
    return delete_resource_impl(resource_id)
```

### 3. Secrets Management

Never hardcode secrets:

```python
# Bad
GITHUB_TOKEN = "ghp_xxxxxxxxxxxxx"

# Good
import os
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
if not GITHUB_TOKEN:
    raise ValueError("GITHUB_TOKEN environment variable not set")
```

Use AWS Secrets Manager for production:

```python
import boto3

def get_secret(secret_name: str) -> str:
    """Retrieve secret from AWS Secrets Manager"""
    client = boto3.client('secretsmanager')
    response = client.get_secret_value(SecretId=secret_name)
    return response['SecretString']

GITHUB_TOKEN = get_secret("chimera/github-token")
```

### 4. Avoid Command Injection

Use parameterized subprocess calls:

```python
# SECURITY: Always use subprocess with list arguments, never shell=True
# Never construct shell commands with user input

def run_aws_command(s3_path: str):
    """Safe AWS CLI execution"""
    # Validate S3 path format first
    if not s3_path.startswith("s3://"):
        raise ValueError("Invalid S3 path")

    # Use subprocess.run with list arguments (not shell)
    subprocess.run(
        ["aws", "s3", "cp", s3_path, "/tmp/"],
        check=True,
        capture_output=True
    )
```

### 5. Rate Limiting

Implement rate limits for external APIs:

```python
import time
from collections import defaultdict

# Simple rate limiter (100 requests per minute)
request_times = defaultdict(list)

def rate_limit(api_name: str, max_requests: int = 100, window: int = 60):
    """Rate limit decorator"""
    def decorator(func):
        def wrapper(*args, **kwargs):
            now = time.time()
            # Remove old requests outside window
            request_times[api_name] = [
                t for t in request_times[api_name]
                if now - t < window
            ]

            # Check if limit exceeded
            if len(request_times[api_name]) >= max_requests:
                raise Exception(f"Rate limit exceeded for {api_name}")

            # Record this request
            request_times[api_name].append(now)

            return func(*args, **kwargs)
        return wrapper
    return decorator


@tool
@rate_limit("github_api", max_requests=100, window=60)
def create_github_issue(repo: str, title: str, body: str) -> dict:
    """Create GitHub issue (rate limited)"""
    # Implementation
    pass
```

### 6. Audit Logging

Log all skill executions:

```python
import logging
from datetime import datetime

logger = logging.getLogger("chimera.skills")

@tool
def delete_resource(resource_id: str) -> dict:
    """Delete a resource"""

    # Log execution
    logger.info(
        "Skill execution",
        extra={
            "skill": "aws-cost-analyzer",
            "tool": "delete_resource",
            "resource_id": resource_id,
            "timestamp": datetime.utcnow().isoformat(),
            "tenant_id": get_current_tenant_id()
        }
    )

    # Perform deletion
    result = delete_resource_impl(resource_id)

    # Log result
    logger.info(
        "Skill execution completed",
        extra={
            "skill": "aws-cost-analyzer",
            "tool": "delete_resource",
            "success": True,
            "resource_id": resource_id
        }
    )

    return result
```

Chimera automatically writes skill audit logs to DynamoDB `chimera-audit` table with 90-day retention.

---

## Next Steps

You now know how to create, test, and publish Chimera skills! Here's what to explore next:

1. **Browse Skill Registry**: `chimera skill search <query>`
2. **Study Examples**: Check `skills/` directory for built-in skills
3. **MCP Integration**: Connect to 10,000+ community MCP tools
4. **Advanced Patterns**: Multi-agent collaboration, skill chaining, conditional logic

### Learn More

- [Architecture Overview](./architecture.md) — Skill loading and execution pipeline
- [Deployment Guide](./deployment.md) — Deploy custom skills to production
- [API Reference](../api/skills.md) — Full API documentation

---

**AWS Chimera** — where agents are forged.
