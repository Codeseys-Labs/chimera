# ClawCore Architecture Review: Developer Experience & Migration

> **Reviewer:** Developer Experience Advocate
> **Team:** clawcore-architecture
> **Date:** 2026-03-19
> **Review Type:** Task #7 - Developer Experience & Migration Review
> **Input Documents:** Synthesis doc, OpenClaw Core Architecture, Skill System, Memory/Persistence, Strands Agents Core

---

## Executive Assessment

ClawCore's architecture makes strong infrastructure choices (AgentCore MicroVMs, Strands model-driven loop, Cedar policies) but the developer experience layer is **largely undesigned**. The synthesis document describes *what* the platform does, not *how developers interact with it*. This review fills that gap with concrete CLI designs, SDK patterns, getting-started workflows, and migration tooling.

**Key finding:** The platform needs a dedicated `clawcore` CLI and SDK layer that abstracts the underlying AWS complexity. Without it, developers face a wall of CDK, DynamoDB, S3, Cognito, and EventBridge configuration before they can run their first agent. OpenClaw's viral growth came from `openclaw onboard` getting people to a working agent in under 5 minutes. ClawCore must match or beat that.

---

## 1. Getting Started Experience: Zero to First Agent

### Current State (from synthesis doc)

The synthesis document jumps straight to CDK deployment:

```bash
npx cdk deploy ClawCorePlatformStack --context environment=prod --context region=us-west-2
```

This is a **platform operator** getting-started experience, not a **developer** getting-started experience. A skill author or tenant developer should never need to touch CDK.

### Recommended: 5-Minute Quick Start

```bash
# Step 1: Install CLI (30 seconds)
pip install clawcore-cli
# or: brew install clawcore

# Step 2: Authenticate (60 seconds)
clawcore auth login
# Opens browser for Cognito auth, stores JWT locally
# For AWS-native: clawcore auth login --aws-profile my-profile

# Step 3: Create your first agent (30 seconds)
clawcore agent init my-assistant
# Creates:
#   my-assistant/
#     agent.yaml          <- agent definition
#     system-prompt.md    <- system prompt in markdown
#     skills/             <- local skills directory
#     tests/              <- test fixtures

# Step 4: Run locally (60 seconds)
cd my-assistant
clawcore agent run
# > Agent "my-assistant" running locally on http://localhost:8080
# > Model: us.anthropic.claude-sonnet-4-6-v1:0 (Bedrock)
# > Tools: read_file, write_file, edit_file, shell
# > Type a message or press Ctrl+C to stop

# Step 5: Deploy (120 seconds)
clawcore agent deploy --tenant my-org
# > Deploying to AgentCore Runtime...
# > Agent endpoint: https://my-org.clawcore.example.com/agents/my-assistant
# > Slack webhook: /agents/my-assistant/slack
# > Done.
```

### Getting-Started Tutorial Outline

1. **Prerequisites** (1 page)
   - AWS account with Bedrock access
   - Python 3.11+ or Node.js 20+
   - `clawcore-cli` installed

2. **Your First Agent** (2 pages)
   - `clawcore agent init` walkthrough
   - Edit `system-prompt.md` to define personality
   - `clawcore agent run` for local testing
   - Chat with your agent in the terminal

3. **Adding a Skill** (2 pages)
   - Create a `SKILL.md` in `skills/`
   - Test with `clawcore skill test my-skill`
   - See the agent use the skill in conversation

4. **Adding an MCP Tool** (1 page)
   - Add MCP server to `agent.yaml`
   - `clawcore agent run` picks it up automatically

5. **Deploying to the Cloud** (2 pages)
   - `clawcore agent deploy` walkthrough
   - Connect to Slack with `clawcore channel connect slack`
   - Set up a cron job with `clawcore cron create`

6. **Next Steps** (1 page)
   - Multi-agent orchestration
   - Custom tools with the SDK
   - Skill marketplace publishing

---

## 2. Skill Authoring Workflow

### SKILL.md Format: Preserved and Enhanced

The synthesis correctly preserves OpenClaw's `SKILL.md` format. This is the right call -- the format is elegant and accessible. The enhancement should be adding **testability** and **type safety** without breaking the markdown-first philosophy.

### Recommended Workflow: Author -> Test -> Publish -> Share

```bash
# Create a new skill from template
clawcore skill init code-review --template tool-skill
# Creates:
#   skills/code-review/
#     SKILL.md             <- skill definition (YAML frontmatter + instructions)
#     tools/               <- Python/TS tool implementations (if skill provides tools)
#     tests/
#       test_skill.yaml    <- declarative test cases
#       fixtures/          <- test input files

# Edit the SKILL.md (same format as OpenClaw)
$EDITOR skills/code-review/SKILL.md

# Test the skill locally (runs against test fixtures)
clawcore skill test code-review
# > Running 3 test cases...
# > [PASS] basic_review: Agent correctly identified null pointer risk
# > [PASS] security_scan: Agent flagged SQL injection
# > [FAIL] style_check: Expected 3 suggestions, got 2
# > 2/3 passed

# Test interactively (spin up agent with only this skill)
clawcore skill test code-review --interactive
# > Agent running with skill "code-review" only
# > Type a message to test...

# Publish to tenant skill registry
clawcore skill publish code-review --version 1.0.0
# > Published code-review@1.0.0 to tenant registry

# Share to marketplace (requires review)
clawcore skill publish code-review --marketplace
# > Submitted code-review@1.0.0 for marketplace review
# > Security scan: PASSED
# > Estimated review time: 24-48 hours
```

### Skill Test Format (Declarative YAML)

```yaml
# tests/test_skill.yaml
name: code-review tests
skill: code-review
model: us.anthropic.claude-sonnet-4-6-v1:0

cases:
  - name: basic_review
    input: "Review the file at fixtures/example.py"
    expect:
      tool_calls:
        - review_file
      output_contains:
        - "null"
        - "risk"
      output_not_contains:
        - "no issues found"

  - name: security_scan
    input: "Check fixtures/vulnerable.py for security issues"
    expect:
      output_contains:
        - "SQL injection"
        - "OWASP"
```

### Skill SDK (Python)

For skills that provide tools (MCP server skills), the SDK should make tool creation trivial:

```python
# skills/code-review/tools/review.py
from clawcore.skill import skill_tool

@skill_tool
def review_file(file_path: str, focus: str = "all") -> str:
    """Review a file for code quality issues.

    Args:
        file_path: Path to the file to review
        focus: Focus area - "security", "style", "logic", or "all"
    """
    content = open(file_path).read()
    # ... analysis logic ...
    return analysis_result
```

### Skill SDK (TypeScript)

```typescript
// skills/code-review/tools/review.ts
import { skillTool } from '@clawcore/skill-sdk'
import { z } from 'zod'

export const reviewFile = skillTool({
  name: 'review_file',
  description: 'Review a file for code quality issues',
  input: z.object({
    filePath: z.string().describe('Path to the file to review'),
    focus: z.enum(['security', 'style', 'logic', 'all']).default('all'),
  }),
  handler: async (input) => {
    // ... analysis logic ...
    return analysisResult
  },
})
```

---

## 3. Cron Job Configuration UX

### Current State

The synthesis shows cron jobs as raw DynamoDB JSON documents. This is an implementation detail, not a developer interface.

### Recommended: Three Configuration Methods

#### Method A: YAML in Agent Definition (Primary)

```yaml
# agent.yaml
name: daily-digest
model: us.anthropic.claude-sonnet-4-6-v1:0
system_prompt: system-prompt.md

skills:
  - email-reader
  - summarizer

mcp_tools:
  - outlook
  - slack

cron:
  schedule: "weekdays 8:00 AM ET"  # Human-readable, parsed to cron expression
  # or: "0 8 ? * MON-FRI *"       # Standard cron expression also supported
  max_budget_usd: 2.00
  timeout_minutes: 10
  output:
    path: "outputs/digests/{date}.md"  # Relative to tenant S3 prefix
  notifications:
    on_success:
      - slack: "#daily-digest"
    on_failure:
      - slack_dm: "admin"
      - email: "admin@company.com"
  retry:
    max_attempts: 2
    backoff: exponential
```

#### Method B: CLI Commands (Quick Setup)

```bash
# Create a cron job from an existing agent
clawcore cron create daily-digest \
  --agent my-assistant \
  --schedule "weekdays 8:00 AM ET" \
  --budget 2.00 \
  --notify-slack "#daily-digest"

# List all cron jobs
clawcore cron list
# NAME            SCHEDULE              LAST RUN      STATUS   COST
# daily-digest    Weekdays 08:00 ET     2h ago        OK       $0.47
# extract-tasks   Weekdays 08:45 ET     1h ago        OK       $0.31
# weekly-report   Mondays 09:00 ET      5d ago        FAILED   $1.82

# View cron job details and recent runs
clawcore cron status daily-digest
# Schedule:    Weekdays 08:00 ET (next: tomorrow 08:00)
# Last 5 runs:
#   2026-03-19 08:00  OK     $0.47  42s   outputs/digests/2026-03-19.md
#   2026-03-18 08:00  OK     $0.52  38s   outputs/digests/2026-03-18.md
#   2026-03-17 08:00  FAIL   $0.12  5s    MCP auth error: outlook token expired
#   ...

# Trigger a manual run
clawcore cron run daily-digest --now

# Pause/resume
clawcore cron pause daily-digest
clawcore cron resume daily-digest

# Delete
clawcore cron delete daily-digest
```

#### Method C: Chat Command (Self-Scheduling Agent)

The synthesis mentions agents creating their own cron jobs. This should work via natural language:

```
User: Schedule yourself to summarize my email every weekday at 8am and post to #daily-digest
Agent: I'll create a cron job for that. Here's what I'll set up:
  - Schedule: Weekdays at 8:00 AM ET
  - Action: Read emails from the last 24 hours, summarize key items
  - Output: Post summary to #daily-digest
  - Budget: $2.00 per run
  Shall I proceed?
User: Yes
Agent: Done. Created cron job "email-summary" (ID: cron-a1b2c3).
  You can manage it with: clawcore cron status email-summary
```

---

## 4. Agent Definition Ergonomics

### Strands Python vs TypeScript

The synthesis exclusively uses Python (Strands). This is appropriate for the backend, but skill authors and tenant developers need both languages. The research shows TypeScript is "experimental preview" in Strands -- this is a risk.

### Recommended: Config-Driven with Code Escape Hatches

#### Primary: Declarative YAML (No Code Required)

```yaml
# agent.yaml -- the 80% case needs zero code
name: support-bot
description: Customer support agent for ACME Corp
model: us.anthropic.claude-sonnet-4-6-v1:0

system_prompt: system-prompt.md  # Markdown file, not inline

skills:
  - ticket-manager           # From marketplace
  - knowledge-base-search    # From marketplace
  - ./skills/acme-policies   # Local custom skill

mcp_tools:
  outlook:
    command: aws-outlook-mcp
  slack:
    command: workplace-chat-mcp

memory:
  strategies:
    - SUMMARY
    - SEMANTIC_MEMORY
    - USER_PREFERENCE

channels:
  slack:
    enabled: true
    channel: "#support"
  web:
    enabled: true
    path: /chat

conversation:
  manager: sliding_window
  window_size: 100000
```

#### Advanced: Code-Driven (Python, for complex orchestration)

```python
# agent.py -- escape hatch for the 20% case
from clawcore import ClawCoreAgent, CronJob
from clawcore.skills import load_skill
from strands import Agent, tool
from strands.multiagent import AgentsAsTool

@tool
def custom_analysis(data: str) -> str:
    """Run custom analysis pipeline.

    Args:
        data: Raw data to analyze
    """
    # Complex logic that doesn't fit in a SKILL.md
    return result

# Specialist subagents
reviewer = Agent(
    system_prompt="You review code for security issues...",
    tools=[read_file, check_vulnerabilities],
)

# Main agent with subagent
agent = ClawCoreAgent(
    config="agent.yaml",  # Load base config from YAML
    extra_tools=[
        custom_analysis,
        AgentsAsTool("security_review", reviewer, "Review code security"),
    ],
)

# Programmatic cron
agent.add_cron(CronJob(
    name="nightly-scan",
    schedule="0 2 * * *",
    prompt="Scan all repos for new security vulnerabilities",
))
```

#### Advanced: Code-Driven (TypeScript)

```typescript
// agent.ts
import { ClawCoreAgent, CronJob } from '@clawcore/sdk'
import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

const customAnalysis = tool({
  name: 'custom_analysis',
  description: 'Run custom analysis pipeline',
  inputSchema: z.object({
    data: z.string().describe('Raw data to analyze'),
  }),
  callback: async (input) => {
    // Complex logic
    return result
  },
})

const agent = new ClawCoreAgent({
  configPath: 'agent.yaml',
  extraTools: [customAnalysis],
})

agent.addCron(new CronJob({
  name: 'nightly-scan',
  schedule: '0 2 * * *',
  prompt: 'Scan all repos for new security vulnerabilities',
}))
```

---

## 5. CLI Tool Design

### `clawcore` CLI Command Tree

```
clawcore
  auth
    login [--aws-profile <profile>]     # Authenticate (Cognito or IAM)
    logout                               # Clear credentials
    whoami                               # Show current identity + tenant
    switch-tenant <tenant-id>            # Switch active tenant

  agent
    init <name> [--template <t>]         # Scaffold a new agent
    run [--port <port>]                  # Run agent locally
    deploy [--tenant <t>]               # Deploy to AgentCore
    list                                 # List deployed agents
    status <name>                        # Agent health + metrics
    logs <name> [--follow]              # Stream agent logs
    delete <name>                        # Remove deployed agent
    test <name> [--file <test.yaml>]    # Run test suite

  skill
    init <name> [--template <t>]         # Scaffold a new skill
    test <name> [--interactive]          # Test skill locally
    list [--marketplace]                 # List installed / available skills
    install <name> [--version <v>]       # Install from marketplace
    publish <name> [--marketplace]       # Publish to registry
    update [--all]                       # Update installed skills
    verify <name>                        # Security scan a skill

  cron
    create <name> --agent <a> --schedule <s>   # Create cron job
    list                                        # List all cron jobs
    status <name>                               # Job details + run history
    run <name> --now                            # Trigger manual run
    pause <name>                                # Pause schedule
    resume <name>                               # Resume schedule
    delete <name>                               # Delete cron job
    logs <name> [--run-id <id>]                # View run logs

  channel
    connect <platform> [--config <file>]   # Connect chat platform
    disconnect <platform>                   # Disconnect platform
    list                                    # List connected channels
    test <platform>                         # Send test message

  memory
    status                                 # Memory usage + health
    search <query>                         # Search tenant memory
    export [--format json|md]              # Export memory contents
    import <file>                          # Import memory from file
    clear [--confirm]                      # Clear all memory

  tenant
    info                                   # Current tenant details
    usage                                  # Cost + usage metrics
    config get <key>                       # Read tenant config
    config set <key> <value>              # Update tenant config
    users list                             # List tenant users
    users invite <email>                   # Invite user to tenant

  doctor                                   # Diagnose configuration issues
  version                                  # Show CLI version
  upgrade                                  # Self-update CLI
```

### CLI Design Principles

1. **Progressive disclosure:** Simple commands first, flags for advanced options
2. **Human-readable output by default**, `--json` flag for scripting
3. **Confirmation prompts** for destructive operations (`--yes` to skip)
4. **Colored output** with status indicators (green check, red X, yellow warning)
5. **Help text** includes examples, not just flag descriptions
6. **Tab completion** for bash/zsh/fish

### Error Messages

```bash
$ clawcore agent deploy my-assistant
ERROR: Bedrock model access not configured

  The model "us.anthropic.claude-sonnet-4-6-v1:0" is not enabled in your
  AWS account for region us-west-2.

  To fix this:
  1. Go to the Bedrock console: https://console.aws.amazon.com/bedrock
  2. Navigate to Model access > Manage model access
  3. Enable "Claude Sonnet 4.6" from Anthropic
  4. Wait 1-2 minutes for access to propagate

  Then retry: clawcore agent deploy my-assistant

  Alternatively, use a different model:
    clawcore agent deploy my-assistant --model us.amazon.nova-pro-v1:0
```

```bash
$ clawcore cron run daily-digest --now
ERROR: MCP authentication failed for "outlook"

  The Outlook MCP server returned 401 Unauthorized.
  This usually means your Midway credentials have expired.

  To fix this:
  1. Run: mwinit -o
  2. Retry: clawcore cron run daily-digest --now

  If the problem persists, check:
    clawcore doctor --check mcp-auth
```

---

## 6. SDK Design for Skill Authors

### Python SDK (`clawcore-sdk`)

```python
# Installation
# pip install clawcore-sdk

from clawcore.skill import skill_tool, SkillContext
from clawcore.memory import TenantMemory
from clawcore.types import SkillResult

# Simple tool (decorator-based, mirrors Strands @tool)
@skill_tool
def search_tickets(query: str, status: str = "open") -> str:
    """Search support tickets by query.

    Args:
        query: Search query text
        status: Filter by ticket status (open, closed, all)
    """
    results = ticket_api.search(query=query, status=status)
    return format_results(results)

# Tool with tenant context
@skill_tool(context=True)
def get_tenant_config(key: str, ctx: SkillContext) -> str:
    """Read a tenant configuration value.

    Args:
        key: Configuration key to read
    """
    return ctx.tenant.config.get(key)

# Tool with memory access
@skill_tool(context=True)
def recall_preference(topic: str, ctx: SkillContext) -> str:
    """Recall a previously stored preference.

    Args:
        topic: Topic to search preferences for
    """
    memory = TenantMemory(ctx.tenant_id)
    results = memory.search(topic, category="preferences")
    return results[0].content if results else "No preference found"

# Tool with streaming progress
@skill_tool
async def process_batch(items: list[str]) -> str:
    """Process a batch of items with progress updates.

    Args:
        items: List of items to process
    """
    for i, item in enumerate(items):
        yield f"Processing {i+1}/{len(items)}: {item}"
        await process_one(item)
    yield f"Completed {len(items)} items"
```

### TypeScript SDK (`@clawcore/skill-sdk`)

```typescript
// Installation
// npm install @clawcore/skill-sdk

import { skillTool, type SkillContext } from '@clawcore/skill-sdk'
import { z } from 'zod'

// Simple tool
export const searchTickets = skillTool({
  name: 'search_tickets',
  description: 'Search support tickets by query',
  input: z.object({
    query: z.string().describe('Search query text'),
    status: z.enum(['open', 'closed', 'all']).default('open'),
  }),
  handler: async (input) => {
    const results = await ticketApi.search(input)
    return formatResults(results)
  },
})

// Tool with context
export const getTenantConfig = skillTool({
  name: 'get_tenant_config',
  description: 'Read a tenant configuration value',
  input: z.object({
    key: z.string().describe('Configuration key to read'),
  }),
  context: true,
  handler: async (input, ctx: SkillContext) => {
    return ctx.tenant.config.get(input.key)
  },
})
```

### SDK Design Principles

1. **Decorator/factory pattern** that mirrors Strands `@tool` -- no new paradigms to learn
2. **Type inference** from function signatures (Python) and Zod schemas (TypeScript)
3. **Context injection** opt-in via `context=True` flag
4. **Streaming** via async generators (Python `yield`) and async iterators (TypeScript)
5. **Zero boilerplate** for simple tools -- docstring becomes tool description
6. **Testing utilities** built into the SDK

---

## 7. Local Development Experience

### Run Agent Locally Before Deploying

```bash
# Start local agent (uses Bedrock for model, runs tools locally)
clawcore agent run
# > Agent "my-assistant" starting...
# > Loading system prompt from system-prompt.md
# > Loading 3 skills: code-review, ticket-manager, acme-policies
# > Connecting MCP servers: outlook (stdio), slack (stdio)
# > Model: us.anthropic.claude-sonnet-4-6-v1:0 (Bedrock)
# > Memory: local (SQLite + file-based)
# >
# > Agent running on http://localhost:8080
# > Chat: http://localhost:8080/chat (web UI)
# > API:  http://localhost:8080/api/v1/invoke
# >
# > Type a message below, or open the web UI.
# > -----------------------------------------------
# you> Review the file at ./src/main.py
# agent> I'll review that file for you...

# Run with specific model (e.g., local Ollama for offline dev)
clawcore agent run --model ollama:llama3.2

# Run with debug logging
clawcore agent run --verbose

# Run with hot-reload (watches for skill/prompt changes)
clawcore agent run --watch

# Run a specific test scenario
clawcore agent test --file tests/support-flow.yaml
```

### Local Dev Features

| Feature | Behavior |
|---------|----------|
| **Hot reload** | `--watch` flag restarts agent when `SKILL.md`, `system-prompt.md`, or tool files change |
| **Local memory** | SQLite-backed memory in `.clawcore/memory/` (same API as production AgentCore Memory) |
| **Local MCP** | MCP servers run as local processes (stdio transport) |
| **Model switching** | `--model` flag overrides `agent.yaml` for quick testing with cheaper/faster models |
| **Web UI** | Built-in chat interface at `localhost:8080/chat` for testing |
| **Request logging** | Every model call and tool execution logged to `.clawcore/logs/` |
| **Cost tracking** | Running token/cost estimate displayed in terminal |

### Docker-Based Local Dev (Full Isolation)

```bash
# Run in a container that mirrors AgentCore MicroVM
clawcore agent run --docker
# > Building container from agent.yaml...
# > Starting in isolated environment (mirrors AgentCore Runtime)
# > Same sandboxing as production deployment
```

---

## 8. Migration Path from OpenClaw

### What Works the Same

| Feature | OpenClaw | ClawCore | Migration Effort |
|---------|----------|----------|-----------------|
| **SKILL.md format** | YAML frontmatter + markdown | Same format | **Zero** -- copy files directly |
| **System prompt** | SOUL.md (markdown) | system-prompt.md (markdown) | **Rename only** |
| **Memory philosophy** | File-based, human-readable | File-based + AgentCore LTM | **Low** -- existing files import cleanly |
| **MCP servers** | mcporter bridge | Native Strands MCP support | **Low** -- config format differs slightly |
| **Skill hierarchy** | Bundled > Managed > Workspace | Global > Marketplace > Tenant | **Conceptually identical** |

### What's Different

| Feature | OpenClaw | ClawCore | Migration Impact |
|---------|----------|----------|-----------------|
| **Agent framework** | Pi (TypeScript, 4 tools) | Strands (Python/TS, model-driven) | **Medium** -- different tool registration |
| **Gateway** | Node.js daemon on port 18789 | API Gateway + AgentCore Runtime | **High** -- no local daemon concept |
| **Config format** | `openclaw.json` (JSON5) | `agent.yaml` (YAML) | **Low** -- automated conversion |
| **Skill registry** | ClawHub (clawhub.ai) | S3 + DynamoDB + marketplace | **Medium** -- different publishing flow |
| **Memory search** | SQLite + BM25/vector hybrid | AgentCore Memory STM/LTM | **Medium** -- different API, same concepts |
| **Channels** | 20+ built-in adapters | Chat SDK (Slack/Teams/Discord/Web) | **Low** -- fewer channels, cleaner integration |
| **Auth** | Config-based API keys | Cognito + IAM + Cedar | **High** -- enterprise auth model |
| **Cron** | Gateway cron scheduler | EventBridge + Step Functions | **Medium** -- more powerful, different config |

### Migration Tool

```bash
# Scan an OpenClaw workspace and generate migration report
clawcore migrate scan ~/openclaw-workspace/
# > Scanning OpenClaw workspace...
# > Found:
# >   SOUL.md             -> Will become system-prompt.md
# >   MEMORY.md           -> Will import to AgentCore Memory
# >   12 skills           -> 11 compatible, 1 needs manual review
# >   openclaw.json       -> Will convert to agent.yaml
# >   3 MCP servers       -> All compatible
# >   2 cron jobs         -> Will convert to EventBridge schedules
# >
# > Compatibility: 92%
# > Issues requiring manual review:
# >   - skills/custom-browser: Uses Pi-specific bash patterns
# >   - Memory: 847 daily log entries (recommend selective import)
# >
# > Run `clawcore migrate apply` to proceed

# Apply migration
clawcore migrate apply ~/openclaw-workspace/ --tenant my-org
# > Converting SOUL.md -> system-prompt.md ... done
# > Converting openclaw.json -> agent.yaml ... done
# > Importing 11 skills ... done
# > Importing MEMORY.md to AgentCore Memory ... done
# > Converting cron schedules to EventBridge ... done
# > Uploading to tenant "my-org" ... done
# >
# > Migration complete. Run `clawcore agent run` to test locally.
```

### Config Conversion Example

**Before (openclaw.json):**
```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
  gateway: {
    port: 18789,
  },
  tools: {
    profile: "coding",
  },
  memorySearch: {
    provider: "openai",
    query: {
      hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 }
    }
  },
  mcpServers: {
    "outlook": {
      command: "aws-outlook-mcp",
    }
  }
}
```

**After (agent.yaml):**
```yaml
name: migrated-agent
model: us.anthropic.claude-opus-4-6-v1:0
system_prompt: system-prompt.md  # Was SOUL.md

tools:
  profile: coding

memory:
  strategies:
    - SUMMARY
    - SEMANTIC_MEMORY

mcp_tools:
  outlook:
    command: aws-outlook-mcp

# Note: gateway config not needed -- AgentCore handles routing
# Note: memorySearch replaced by AgentCore Memory with similar semantics
```

---

## 9. Migration Path from OpenFang

OpenFang migration is more complex due to fundamental architectural differences (Rust vs Python/TS, WASM sandbox vs MicroVM, Merkle audit trail vs Cedar policies).

### Key Differences

| Feature | OpenFang | ClawCore |
|---------|----------|----------|
| **Language** | Rust | Python/TypeScript |
| **Tool sandbox** | WASM with capability grants | AgentCore MicroVM + Cedar policies |
| **Audit trail** | Merkle hash-chain (tamper-evident) | CloudTrail + CloudWatch (centralized) |
| **Binary size** | 32MB single binary | Containerized (varies) |
| **Startup time** | 30x faster than OpenClaw | MicroVM cold start ~2-5s |
| **Skills** | Compiled Rust crates | SKILL.md (markdown) + optional code |

### Migration Strategy

1. **Skills:** Rewrite Rust crate skills as SKILL.md + Python/TS tools. The markdown instruction layer translates directly; compiled tool logic needs rewriting.

2. **Security model:** OpenFang's WASM capability grants map conceptually to Cedar policies. The migration tool should generate Cedar policy skeletons from OpenFang capability manifests.

3. **Audit trail:** OpenFang's Merkle chain provides cryptographic tamper evidence. ClawCore's CloudTrail + Cedar audit is different (centralized, not cryptographic). Organizations requiring tamper-evident audit may need a custom plugin.

```bash
# OpenFang migration (more manual than OpenClaw)
clawcore migrate scan-openfang ~/openfang-workspace/
# > Found:
# >   5 Rust crate skills -> Manual rewrite required (SKILL.md + tools)
# >   Agent config        -> Will convert to agent.yaml
# >   Capability grants   -> Will generate Cedar policy skeletons
# >   Memory (SQLite)     -> Will import to AgentCore Memory
# >
# > Compatibility: 45% (manual work required for compiled skills)
# > See migration guide: docs.clawcore.dev/migration/openfang
```

---

## 10. Documentation Architecture

### Recommended Structure

```
docs.clawcore.dev/
  getting-started/
    quickstart.md              # 5-minute zero to first agent
    installation.md            # CLI install + auth setup
    first-agent.md             # Create, run, deploy
    first-skill.md             # Author a skill
    first-cron-job.md          # Schedule an agent

  guides/
    agent-definition.md        # agent.yaml reference
    skill-authoring.md         # SKILL.md format + testing
    tool-development.md        # Python + TS SDK
    cron-configuration.md      # Scheduling patterns
    memory-management.md       # Memory strategies + search
    multi-agent.md             # Subagents, swarms, graphs
    channel-integration.md     # Slack, Teams, Discord, Web
    security.md                # Cedar policies, skill verification
    local-development.md       # Local run, debug, test
    deployment.md              # AgentCore deploy + CI/CD

  reference/
    cli.md                     # Full CLI reference
    agent-yaml.md              # agent.yaml schema reference
    skill-md.md                # SKILL.md schema reference
    sdk-python.md              # Python SDK API reference
    sdk-typescript.md          # TypeScript SDK API reference
    cedar-policies.md          # Cedar policy reference
    api.md                     # REST/WebSocket API reference

  migration/
    from-openclaw.md           # OpenClaw migration guide
    from-openfang.md           # OpenFang migration guide
    from-langchain.md          # LangChain/LangGraph migration

  tutorials/
    build-support-bot.md       # End-to-end: support bot with tickets + Slack
    build-email-digest.md      # End-to-end: scheduled email summarizer
    build-code-reviewer.md     # End-to-end: PR review agent
    build-research-agent.md    # End-to-end: multi-agent research pipeline

  concepts/
    architecture.md            # How ClawCore works (the synthesis doc, simplified)
    agent-loop.md              # Strands event loop explained
    multi-tenancy.md           # Isolation model
    skill-marketplace.md       # Publishing and governance
```

### Documentation Principles

1. **Code-first:** Every concept illustrated with runnable code
2. **Copy-paste friendly:** All examples work as-is (no pseudocode)
3. **Progressive complexity:** Start simple, link to advanced topics
4. **Platform-specific tabs:** Python and TypeScript side-by-side
5. **Search-optimized:** Every page answers a question ("How do I...?")

### Examples Repository

```
github.com/clawcore/examples/
  agents/
    hello-world/               # Minimal agent
    support-bot/               # Full support bot with skills + cron
    code-reviewer/             # Multi-agent code review
    email-digest/              # Scheduled email summarizer
    research-pipeline/         # Graph-based research orchestration
  skills/
    weather/                   # Simple API skill
    code-review/               # Tool-providing skill
    ticket-manager/            # MCP-wrapping skill
  templates/
    agent-basic/               # Template for `clawcore agent init`
    agent-multi-agent/         # Template with subagents
    skill-basic/               # Template for `clawcore skill init`
    skill-tool/                # Template with tool implementations
```

---

## 11. Community and Ecosystem Strategy

### Skill Marketplace Governance

ClawHub's ClawHavoc incident (1,184 malicious skills, 12% of registry) is the cautionary tale. ClawCore must build security in from day one.

#### Recommended Governance Model

| Tier | Requirements | Trust Level | Review Process |
|------|-------------|-------------|----------------|
| **Tenant-private** | None | Full (tenant owns it) | No review |
| **Organization-shared** | Org admin approval | High | Admin review |
| **Marketplace: Unverified** | Account + code scan | Low (sandboxed) | Automated scan |
| **Marketplace: Verified** | Automated + manual review | Medium | Security team review |
| **Marketplace: Official** | ClawCore team authored | High | Internal QA |

#### Automated Security Pipeline

```
Skill submitted
  |-> Static analysis (SAST) for SKILL.md prompt injection patterns
  |-> Dependency scan (if tools have code)
  |-> Sandbox execution test (run in isolated MicroVM)
  |-> Cedar policy validation (declared permissions match actual behavior)
  |-> If all pass: published as "Unverified"
  |-> Manual review request: queued for "Verified" promotion
```

### Contribution Guidelines

1. **Skill contribution:** Fork examples repo, add skill, submit PR. Automated CI runs tests + security scan.
2. **SDK contribution:** Standard open-source workflow (issues, PRs, CLA).
3. **Documentation:** Docs-as-code in the main repo. Anyone can submit corrections.
4. **Community tools:** Published to npm/PyPI with `clawcore-skill-` or `@clawcore/skill-` prefix for discoverability.

---

## 12. Error Messages and Debugging Experience

### Error Message Design Standards

Every error should follow this template:

```
ERROR: <What happened>

  <Why it happened -- 1-2 sentences>

  To fix this:
  1. <Concrete step>
  2. <Concrete step>

  <Alternative approach if applicable>

  More info: docs.clawcore.dev/errors/<error-code>
```

### Common Error Scenarios

```bash
# Model access error
$ clawcore agent run
ERROR: Model not available (CC-1001)

  The model "us.anthropic.claude-sonnet-4-6-v1:0" returned
  AccessDeniedException. This model is not enabled in your AWS account.

  To fix this:
  1. Open the Bedrock console and enable Claude Sonnet 4.6
  2. Wait 1-2 minutes, then retry

  For local development without Bedrock access:
    clawcore agent run --model ollama:llama3.2

  More info: docs.clawcore.dev/errors/CC-1001

# Skill test failure
$ clawcore skill test code-review
FAIL: test "security_scan" (CC-4012)

  Expected output to contain "SQL injection" but agent response was:
  "The code looks clean. No issues found."

  This usually means:
  - The skill instructions are ambiguous (check SKILL.md ## Instructions)
  - The test fixture doesn't contain the expected vulnerability
  - The model version may behave differently (try with --model flag)

  Debug with:
    clawcore skill test code-review --interactive --verbose

  More info: docs.clawcore.dev/errors/CC-4012

# Cron failure
$ clawcore cron status daily-digest
Last run: FAILED at 2026-03-19 08:00 ET (CC-5003)

  MCP server "outlook" failed to authenticate.
  Error: "Midway credentials expired"

  To fix this:
  1. Renew credentials: mwinit -o
  2. Test manually: clawcore cron run daily-digest --now

  To prevent this:
  - Set up credential auto-renewal (see docs)
  - Add failure notifications: clawcore cron update daily-digest --notify-on-failure

  Run logs: clawcore cron logs daily-digest --run-id run-2026-03-19-0800
  More info: docs.clawcore.dev/errors/CC-5003
```

### Debugging Tools

```bash
# Comprehensive health check
clawcore doctor
# [OK]  CLI version: 1.2.0 (latest)
# [OK]  AWS credentials: valid (expires in 11h)
# [OK]  Bedrock access: Claude Sonnet 4.6 enabled
# [WARN] Midway: expires in 2h (renew with: mwinit -o)
# [OK]  MCP servers: 3/3 healthy
# [OK]  Memory: 1,247 entries indexed
# [FAIL] Skill "custom-browser": missing dependency "chromium"
#        Fix: brew install chromium

# Debug a specific agent run
clawcore agent logs my-assistant --follow --verbose
# Shows: model calls, tool executions, memory reads/writes, token usage

# Trace a specific request
clawcore agent trace <request-id>
# Shows: full execution timeline with model reasoning, tool calls, latency
```

---

## Summary of Recommendations

| Priority | Recommendation | Effort |
|----------|---------------|--------|
| **P0** | Build `clawcore` CLI with `agent init/run/deploy` | Medium |
| **P0** | Create 5-minute getting-started tutorial | Low |
| **P0** | Define `agent.yaml` schema as the primary config format | Low |
| **P1** | Build skill testing framework (`clawcore skill test`) | Medium |
| **P1** | Design error messages with fix instructions for all common failures | Medium |
| **P1** | Build OpenClaw migration tool (`clawcore migrate`) | Medium |
| **P1** | Create `clawcore doctor` diagnostic command | Low |
| **P2** | Python + TypeScript skill SDKs | Medium |
| **P2** | Cron job CLI and YAML configuration | Medium |
| **P2** | Local web UI for agent testing | Medium |
| **P2** | Documentation site with tutorials and examples repo | High |
| **P3** | Skill marketplace governance pipeline | High |
| **P3** | OpenFang migration tool | Medium |
| **P3** | Community contribution guidelines and processes | Low |

The synthesis document provides an excellent infrastructure blueprint. This review provides the developer-facing layer that turns that infrastructure into a product developers actually want to use. The gap between "powerful platform" and "beloved developer tool" is entirely in the UX -- and that UX starts with the CLI.
