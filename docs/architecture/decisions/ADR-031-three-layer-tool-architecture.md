---
title: 'ADR-031: Three-Layer Tool Architecture (AgentCore Built-ins, Custom Gateway, MCP Servers)'
status: accepted
date: 2026-04-02
decision_makers: [chimera-architecture-team]
---

# ADR-031: Three-Layer Tool Architecture (AgentCore Built-ins, Custom Gateway, MCP Servers)

## Status

**Accepted** (2026-04-02)

## Context

Chimera's agent runtime currently exposes tools through a single mechanism: Python tool functions registered in `gateway_config.py` and dispatched via Gateway Lambda targets. This approach served us well for the initial 25 AWS service tools, but it has three limitations:

1. **No sandbox execution**: The self-evolution flow in `evolution_tools.py` validates agent-generated CDK code using substring pattern matching (`_FORBIDDEN_CDK_PATTERNS` at line 42). This catches known-bad patterns but cannot verify that generated CDK code actually compiles. A `cdk synth` failure is only discovered after the code is committed to CodeCommit and the pipeline runs — a slow, wasteful feedback loop.

2. **No browser/web capability**: The VISION.md media ingestion use case requires fetching content from URLs and web pages. Today there is no tool that enables this. Building a custom browser tool would require managing headless Chrome infrastructure.

3. **No structured documentation access**: Agents generating CDK code must rely on their training data for API knowledge. There is no way to look up current CDK construct APIs or AWS service documentation at inference time.

AgentCore now provides two built-in tools (Code Interpreter, Browser) and a Gateway service that can front MCP servers. This ADR establishes a three-layer architecture that uses each mechanism where it is strongest.

## Decision

Adopt a **three-layer tool architecture** that classifies every tool by its delivery mechanism:

### Layer 1: AgentCore Built-in Tools (direct SDK, zero custom code)

These are consumed directly by the agent Python runtime via the `bedrock_agentcore` SDK. They do **not** flow through the Gateway Lambda targets.

| Tool                 | What It Replaces/Enables                                                                                                                | How Agents Access                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Code Interpreter** | CDK validation sandbox (`cdk synth` before committing), data analysis, ad-hoc Python/JS execution, boto3 operations for any AWS service | `bedrock_agentcore` SDK — `CodeInterpreter.create_session()`     |
| **Browser**          | Web UI verification after deployments, URL/media content ingestion, web scraping for capability building                                | `bedrock_agentcore` SDK — `BrowserClient` / Strands browser tool |

**Critical for self-evolution**: Code Interpreter enables the agent to run `npm install && npx cdk synth` on generated CDK code in a sandboxed MicroVM **before** committing to CodeCommit. This replaces the current substring-based validation in `evolution_tools.py:42-65` (`_FORBIDDEN_CDK_PATTERNS`) with actual TypeScript compilation verification. The forbidden-pattern check remains as a fast pre-filter; Code Interpreter adds a compilation gate.

**Critical for media ingestion**: Browser enables the agent to fetch and extract content from URLs/links the user sends, which is the "media ingestion pipeline" use case described in VISION.md. No custom headless Chrome infrastructure required.

### Layer 2: Custom Gateway Lambda Targets (Chimera-specific logic)

These remain as Gateway Lambda targets because they implement Chimera-specific protocols (tenant isolation, Cedar policy enforcement, evolution state machines, audit logging):

| Tool Category              | Lambda                    | Lines | Status    | Why Custom                                                                                                                           |
| -------------------------- | ------------------------- | ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `evolution.*` (5 tools)    | evolution-tools           | 735   | **Built** | Self-evolution CDK commit, Cedar policy checks, rate limiting, status tracking, capability registration — core to Chimera's identity |
| `codecommit.*` (5 tools)   | codecommit-tools          | —     | **Built** | CodeCommit SDK operations for self-modifying infrastructure; coupled to evolution flow                                               |
| `codepipeline.*` (7 tools) | codepipeline-tools        | —     | **Built** | Pipeline monitoring, triggering, status checks; coupled to evolution flow                                                            |
| `background.*` (2 tools)   | background-task-tools     | —     | **Built** | SQS-backed async task queue with tenant isolation via EventBridge                                                                    |
| `cloudmap.*` (3 tools)     | cloudmap-tools            | —     | **Built** | Service discovery for Chimera's own infrastructure (Cloud Map)                                                                       |
| All 23 AWS service tools   | tier1/tier2/tier3 Lambdas | —     | **Built** | Tier-gated access control via `_TOOL_TIER_REGISTRY` in `gateway_config.py`                                                           |

The existing tier-gated discovery mechanism (`GatewayToolDiscovery` class, `_TOOL_TIER_REGISTRY`, SSM-backed Lambda ARN resolution) is unchanged. Layer 2 tools continue to be loaded via the same `discover_tools(tenant_id, tier)` path.

### Layer 3: Pre-built MCP Server Gateway Targets (configuration-only)

Deploy community/AWS MCP servers as Gateway targets for structured tool discovery. These require no custom code — only Gateway target configuration pointing to the MCP server container/Lambda:

| MCP Server                                        | Source    | Tools Exposed                             | Use Case                                                              |
| ------------------------------------------------- | --------- | ----------------------------------------- | --------------------------------------------------------------------- |
| **AWS Documentation** (`@anthropic/aws-docs-mcp`) | Anthropic | `search_docs`, `fetch_doc`                | Agent references AWS docs when generating CDK code or troubleshooting |
| **Context7**                                      | Community | `resolve`, `get-library-docs`             | Agent looks up CDK construct APIs, SDK method signatures              |
| **Filesystem** (scoped to `/workspace`)           | Anthropic | `read_file`, `write_file`, `search_files` | Agent manages generated code artifacts in MicroVM workspace           |

MCP servers are registered as Gateway targets using L1 constructs (`CfnGatewayTarget`) and automatically appear in the agent's tool list through the existing discovery mechanism.

### CDK Implementation Approach

The infrastructure changes mix L1 and L2 constructs in the same stack:

- **L1 constructs** (`CfnRuntime`, `CfnGateway`, `CfnGatewayTarget`): Used for Gateway targets (Layer 2 and Layer 3). These are stable and GA.
- **L2 alpha** (`@aws-cdk/aws-bedrock-agentcore-alpha`): Used selectively for Code Interpreter and Browser (Layer 1). These are L2-only constructs with no L1 equivalent.

Mixing L1 + L2 in the same stack is supported per CDK documentation. The alpha dependency is acceptable because:

1. Code Interpreter and Browser are GA services; only the CDK constructs are alpha
2. We pin the alpha version in `package.json` to avoid surprise breaks
3. Fallback: if L2 breaks, we can use raw `CfnResource` with the CloudFormation resource type

### Impact on Self-Evolution Flow

**Current flow** (substring validation only):

```
Agent generates CDK → _FORBIDDEN_CDK_PATTERNS substring check →
  commit to CodeCommit → pipeline runs cdk synth →
  if synth fails: pipeline fails, agent must check status and regenerate
  if synth passes: deploy to staging → deploy to prod
```

**New flow** (substring check + Code Interpreter sandbox):

```
Agent generates CDK → _FORBIDDEN_CDK_PATTERNS substring check →
  Code Interpreter sandbox: npm install && npx cdk synth →
    if synth fails: agent reads error, fixes code, retries in sandbox (no commit needed)
    if synth passes: commit to CodeCommit → pipeline validates + deploys →
      Browser verifies deployment health (optional)
```

Key improvement: the agent gets **immediate compilation feedback** in the sandbox before committing. This eliminates the commit-wait-fail-recommit cycle that currently wastes pipeline capacity and pollutes CodeCommit history.

### Impact on Cedar Policies

| Concern                     | Current                    | After This ADR                             |
| --------------------------- | -------------------------- | ------------------------------------------ |
| Gateway tools (Layer 2 + 3) | `use_tool` action in Cedar | **No change** — same `use_tool` action     |
| Code Interpreter (Layer 1)  | N/A (doesn't exist)        | New `use_code_interpreter` action in Cedar |
| Browser (Layer 1)           | N/A (doesn't exist)        | New `use_browser` action in Cedar          |

**Tier gating for Layer 1 tools:**

| Tool                 | Basic (tier 1) | Advanced (tier 2) | Premium (tier 3) |
| -------------------- | -------------- | ----------------- | ---------------- |
| Code Interpreter     | ❌ Denied      | ✅ Available      | ✅ Available     |
| Browser (read-only)  | ✅ Available   | ✅ Available      | ✅ Available     |
| Browser (automation) | ❌ Denied      | ❌ Denied         | ✅ Available     |

These tier gates are enforced at the Python runtime level in `gateway_config.py` before the SDK call is made. Cedar policies provide a second enforcement layer.

## Alternatives Considered

### Alternative 1: Three-Layer Architecture (Selected)

Separate tools into AgentCore built-ins, custom Gateway Lambdas, and MCP servers based on delivery mechanism.

**Pros:**

- ✅ **CDK compilation verification**: Code Interpreter replaces regex with actual `cdk synth`
- ✅ **Media ingestion without custom infra**: Browser tool replaces need for headless Chrome
- ✅ **Documentation access at inference time**: MCP servers provide live API docs
- ✅ **Reduces future custom code**: Code Interpreter can run arbitrary boto3, reducing need for new tool Lambdas
- ✅ **Preserves existing tools**: All 23 built tools continue working unchanged

**Cons:**

- Alpha CDK dependency for L2 constructs
- Code Interpreter has broader IAM surface than individual Lambda tools
- Code Interpreter sessions cost per-use ($0.00001667/sec)

**Verdict:** Selected for the safety improvement to self-evolution and enablement of media ingestion.

### Alternative 2: Everything Through Gateway Lambdas (Status Quo)

Keep all tools as Gateway Lambda targets. Build custom Lambda for CDK validation, custom Lambda for browser, custom Lambda for docs.

**Pros:**

- No new dependencies
- Uniform tool delivery mechanism
- Full Cedar enforcement on every call

**Cons:**

- ❌ **Custom CDK sandbox Lambda**: Must manage CodeBuild project or custom Docker for `cdk synth` — significant operational overhead
- ❌ **Custom browser Lambda**: Must manage headless Chrome (Puppeteer/Playwright) — dependency hell, memory-intensive
- ❌ **Custom docs Lambda**: Must build and maintain documentation search index
- ❌ **No reuse of AgentCore investment**: AWS already built and operates these tools at scale

**Verdict:** Rejected — building custom equivalents of existing AWS services is wasteful.

### Alternative 3: All Tools as MCP Servers

Migrate all tools (including existing 23 AWS service tools) to MCP servers.

**Pros:**

- Standardized protocol for all tools
- Framework-agnostic

**Cons:**

- ❌ **Massive migration effort**: Rewrite 23 tool files (thousands of lines) as MCP servers
- ❌ **Lose tier gating infrastructure**: Existing `GatewayToolDiscovery` and Cedar integration would need rebuilding
- ❌ **No benefit for existing tools**: Current tools work; migration risk with no functional improvement

**Verdict:** Rejected — all pain, no gain for existing tools.

## Consequences

### Positive

- **CDK validation moves from regex to compilation**: Massive safety improvement for self-evolution. Agent gets immediate feedback on syntax errors, missing imports, type errors — before any commit to CodeCommit.
- **Media ingestion becomes possible**: Browser tool enables URL content extraction without custom infrastructure, unblocking the VISION.md media ingestion milestone.
- **Arbitrary Python execution without new tools**: Code Interpreter can run any boto3 operation, reducing the need to build new Lambda tools for every AWS service interaction.
- **Live documentation access**: MCP servers give the agent current API docs at inference time, improving CDK code generation accuracy.
- **Backward compatible**: All existing tools, tier gating, Cedar policies, and Gateway infrastructure remain unchanged.

### Negative

- **Code Interpreter has broader IAM surface**: A Code Interpreter session can execute arbitrary Python, so IAM permissions must be tightly scoped. The AgentCore session role should have only the permissions needed for `cdk synth` (read-only CDK context, no AWS resource creation).
- **Cedar policies don't enforce within Code Interpreter calls**: Once a Code Interpreter session starts, Cedar cannot inspect individual operations inside it. Enforcement relies on IAM role permissions + prompt-based instructions. This is a defense-in-depth trade-off.
- **Alpha CDK dependency**: `@aws-cdk/aws-bedrock-agentcore-alpha` may have breaking changes between minor versions. Mitigated by pinning the version and testing in CI.
- **Per-use cost**: Code Interpreter sessions are billed at $0.00001667/sec active. For a 30-second `cdk synth`, that is ~$0.0005/validation — negligible, but must be monitored to prevent runaway sessions.

### Risks

- **AgentCore alpha construct instability**: If the L2 alpha constructs break, we fall back to `CfnResource` with raw CloudFormation properties.
- **Code Interpreter sandbox escape**: If a sandboxed session could affect production resources, the blast radius is limited by the IAM session role (read-only for CDK context).

## Files Affected

| File                                              | Change Type | Description                                                                                              |
| ------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `packages/agents/gateway_config.py`               | **Modify**  | Add Layer 1 tool registration (Code Interpreter, Browser) with tier gating outside `_TOOL_TIER_REGISTRY` |
| `packages/agents/tools/evolution_tools.py`        | **Modify**  | Add Code Interpreter sandbox step between `_validate_cdk_code()` and CodeCommit commit                   |
| `infra/lib/evolution-stack.ts`                    | **Modify**  | Add IAM permissions for AgentCore Code Interpreter session role                                          |
| `infra/lib/chat-stack.ts`                         | **Modify**  | Add IAM permissions for Browser tool in ECS task role                                                    |
| `infra/lib/api-stack.ts`                          | **Modify**  | Register MCP server Gateway targets (Layer 3)                                                            |
| `infra/lib/security-stack.ts`                     | **Modify**  | Add `use_code_interpreter` and `use_browser` Cedar actions                                               |
| `packages/core/src/gateway/tier-config.ts`        | **Modify**  | Add Layer 1 tier mappings (mirrors `gateway_config.py` changes)                                          |
| `packages/agents/tools/code_interpreter_tools.py` | **New**     | Wrapper for `bedrock_agentcore` Code Interpreter SDK calls                                               |
| `packages/agents/tools/browser_tools.py`          | **New**     | Wrapper for `bedrock_agentcore` Browser SDK calls                                                        |
| `infra/package.json`                              | **Modify**  | Add `@aws-cdk/aws-bedrock-agentcore-alpha` dependency (pinned version)                                   |

## Evidence

- **Evolution tools source**: `packages/agents/tools/evolution_tools.py` — 735 lines, substring-based CDK validation at lines 42-65 (`_FORBIDDEN_CDK_PATTERNS`)
- **Gateway config source**: `packages/agents/gateway_config.py` — 569 lines, tier registry at lines 41-137
- **Evolution stack**: `infra/lib/evolution-stack.ts` — 1416 lines, Step Functions state machines for evolution workflows
- **Chat stack**: `infra/lib/chat-stack.ts` — 561 lines, ECS Fargate + ALB for chat gateway

## Related Decisions

- **ADR-007** (AgentCore MicroVM): Code Interpreter runs in the same MicroVM isolation model
- **ADR-009** (Universal Skill Adapter): MCP servers (Layer 3) integrate via the skill adapter pattern
- **ADR-011** (Self-Modifying IaC): Code Interpreter sandbox strengthens the validation step in the DynamoDB-driven CDK flow
- **ADR-013** (CodeCommit/CodePipeline): Layer 2 evolution tools continue to commit to CodeCommit; Code Interpreter adds a pre-commit validation gate
- **ADR-021** (npx for CDK): Code Interpreter sandbox uses `npx cdk synth` (Node runtime required for CDK, per this ADR)
- **ADR-024** (Standardize Tier Naming): Layer 1 tools follow the same basic/advanced/premium tier naming

## References

1. AgentCore Code Interpreter: https://docs.aws.amazon.com/agentcore/latest/userguide/code-interpreter.html
2. AgentCore Browser: https://docs.aws.amazon.com/agentcore/latest/userguide/browser.html
3. AgentCore Gateway: https://docs.aws.amazon.com/agentcore/latest/userguide/gateway.html
4. MCP specification: https://modelcontextprotocol.io/
5. `@aws-cdk/aws-bedrock-agentcore-alpha`: https://constructs.dev/packages/@aws-cdk/aws-bedrock-agentcore-alpha
