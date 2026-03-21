---
title: Architecture Alignment Review - Vision vs Implementation
version: 1.0.0
status: review
task: chimera-9995
last_updated: 2026-03-21
reviewer: lead-review-arch
---

# Architecture Alignment Review: Vision vs Implementation

Purpose: Verify every vision point from docs/VISION.md and docs/architecture/agent-architecture.md against actual implemented code.

Method: Direct source file analysis across all packages and infra stacks.

## Summary Scorecard

| # | Vision Point | Status | Coverage | Key Gap |
|---|-------------|--------|----------|---------|
| 1 | AWS Account Access (not computer) | Partial | 40% | 4/25 AWS service tools implemented |
| 2 | Self-Evolving | Substantial | 80% | Sandbox testing is simulated |
| 3 | Full Tool Access (25 services) | Partial | 16% | Only EC2, Lambda, S3, CloudWatch exist |
| 4 | UTO Model (User/Team/Org) | Substantial | 75% | Team abstraction missing |
| 5 | AgentCore-Based | Partial | 60% | No AgentCore CDK stack, TS agent uses custom ReAct |
| 6 | Skill Compatibility (3 formats) | Substantial | 85% | All 3 formats supported |
| 7 | Self-Expansion / Subagents | Partial | 45% | Infra exists, no agent-level spawning |
| 8 | CodeCommit Self-Editing + CI/CD | Substantial | 75% | LLM-assisted CDK gen is placeholder |
| 9 | Concurrent Operation | Partial | 40% | No background task dispatch from agent |
| 10 | Multi-Modal | Not Implemented | 0% | Zero Transcribe/Rekognition/Textract |
| 11 | Self-Reflection | Substantial | 80% | Strong analytics, no user-visible post-mortems |
| 12 | OpenClaw/NemoClaw Rebuild | Substantial | 75% | Context compaction missing |

Overall: ~55% implemented, ~25% partial, ~20% not started

## Point 1: AWS Account Access (not computer)

Vision: Agents operate on AWS accounts, not local computers. 25 core AWS services as tools.

What Exists:
- AWS Tools (packages/core/src/aws-tools/): ec2-tool.ts, lambda-tool.ts, s3-tool.ts, cloudwatch-tool.ts + client-factory.ts (STS AssumeRole) + tool-utils.ts (retry/backoff)
- Discovery Module (packages/core/src/discovery/): config-scanner.ts, resource-explorer.ts, cost-analyzer.ts, tag-organizer.ts, stack-inventory.ts, resource-index.ts
- Multi-Account (packages/core/src/multi-account/): organizations-client.ts, cross-account-discovery.ts, cross-account-role.ts, scp-manager.ts, billing-aggregator.ts

What's Missing: 21 of 25 promised service tools. No tier-gating logic in tool loading.
Verdict: PARTIAL (40%)

## Point 2: Self-Evolving

What Exists - Evolution Engine (packages/core/src/evolution/) 8 files:
- safety-harness.ts: Real AWS Verified Permissions Cedar eval + DynamoDB rate limits
- auto-skill-gen.ts: Real DynamoDB pattern detection, SKILL.md generation, S3 publishing
- model-router.ts: Real Thompson Sampling with DynamoDB state, 4 Bedrock models
- prompt-optimizer.ts, iac-modifier.ts, experiment-runner.ts: Real implementations
- self-reflection.ts: Health score (7 weighted metrics), trend analysis, circuit breaker

Missing: testSkillInSandbox uses Math.random() not real Code Interpreter. Pre-change S3 snapshot not in code.
Verdict: SUBSTANTIAL (80%)

## Point 3: Full Tool Access (25 services)

4 tool files: createEC2Tools, createLambdaTools, createS3Tools, createCloudWatchTools. Python has ec2_tools.py, s3_tools.py.
Missing: 21 services, no tier-gating, no Cedar filter in tool loading, no budget guard.
Verdict: PARTIAL (16%)

## Point 4: UTO Model

What Exists:
- tenant-onboarding-stack.ts: Full Step Functions workflow (7 steps: DDB records, Cognito group, IAM role with partition isolation, S3 prefix, Cedar policies, cost tracking)
- security-stack.ts: Cognito with custom:tenantId
- agent.ts: tenantId, tier (basic/advanced/premium), memory namespace tenant-{id}-user-{id}
Missing: Team abstraction (only User/Org), collaborative sessions, dedicated VPC for Premium.
Verdict: SUBSTANTIAL (75%)

## Point 5: AgentCore-Based

What Exists:
- Python Agent (packages/agents/chimera_agent.py): Uses strands.Agent + BedrockModel, bedrock_agentcore.runtime.BedrockAgentCoreApp + @entrypoint, AgentCoreMemorySessionManager. Extracts JWT claims from context.auth.claims.
- TypeScript Agent (packages/core/src/agent/agent.ts): Custom ChimeraAgent with hand-written ReAct loop (not Strands TS SDK). BedrockModel adapter wrapping @aws-sdk/client-bedrock-runtime Converse API.

Missing: No AgentCore CDK stack (no platform-runtime-stack.ts in 11 stacks). TS agent doesn't use Strands SDK. No AgentCore Gateway CDK. No AgentCore Evaluations.
Verdict: PARTIAL (60%)

## Point 6: Skill Compatibility (3 formats)

What Exists (packages/core/src/skills/ - 8 modules):
- parser.ts: SKILL.md v2 parser with YAML frontmatter, permissions, dependencies, MCP config, tests
- registry.ts: DynamoDB-backed skill metadata
- installer.ts: Skill lifecycle management
- discovery.ts: Semantic + full-text search
- validator.ts: Permission validation, security checks
- mcp-gateway-client.ts: AgentCore Gateway integration for MCP
- trust-engine.ts: Cedar-based policy enforcement
- skill-bridge.ts: Bridge between skill defs and agent tools

3 Formats: SKILL.md v2 (full parser), MCP Servers (MCPGatewayClient), Strands @tool (native).
Missing: 7-stage security pipeline not fully implemented (described in types/arch).
Verdict: SUBSTANTIAL (85%)

## Point 7: Self-Expansion / Subagents

What Exists:
- orchestration-stack.ts: EventBridge custom bus, SQS FIFO + Standard queues, Step Functions (PipelineBuild, DataAnalysis), Archive
- events/event-bus.ts: EventBridge client with multi-tenant support
- events/event-types.ts: Agent lifecycle events (CREATED, STARTED, COMPLETED, FAILED)
- auto-skill-gen.ts: Creates new capabilities from patterns

Missing: No spawn_subagent() in ChimeraAgent. No supervisor/swarm pattern. No task decomposition. No start_background_task tool.
Verdict: PARTIAL (45%)

## Point 8: CodeCommit Self-Editing + CI/CD

What Exists:
- cdk-generator.ts: Template-based CDK gen (6 types: scale_horizontal/vertical, env_var, rotate_secret, add_tool, update_config), L3 constructs, LLM-assisted (placeholder), validation with forbidden patterns
- codecommit-workspace.ts: Real AWS SDK CodeCommit (create/get/delete repos, commit files, create branches, list workspaces)
- codepipeline-deployer.ts: Pipeline deployment integration
- drift-detector.ts: Infra drift detection
- pipeline-stack.ts: Source->Build->Canary(5%)->Bake(30min)->Progressive(25->50->100%). Rollback: error>5%, P99>2x, guardrail>10%

Missing: generateFromLLM() returns mock CDK code. Pipeline uses GitHub not CodeCommit.
Verdict: SUBSTANTIAL (75%)

## Point 9: Concurrent Operation

What Exists: EventBridge bus with task lifecycle events, SQS queues, Step Functions for background workflows.
Missing: No start_background_task tool. No DDB task state table (TENANT#acme/TASK#abc123). No notification mechanism. No check_background_task tool.
Verdict: PARTIAL (40%)

## Point 10: Multi-Modal Support

What Exists: Bedrock Converse API supports images natively (implicit via BedrockModel).
Missing: No Amazon Transcribe, Rekognition, or Textract integration. No automatic media processing. No upload detection or routing. Grep found 0 relevant matches.
Verdict: NOT IMPLEMENTED (0%) — Largest gap. Entire vision section with zero code.

## Point 11: Self-Reflection

What Exists:
- self-reflection.ts: calculateHealthScore (7 metrics: quality 25%, completion 20%, cost 15%, corrections 15%, skill reuse 10%, memory hit 10%, rollback 5%), analyzeEvolutionTrends, shouldThrottleEvolution (circuit breaker: health<40=72h, rollback>30%=48h), recommendEvolutionActions
- agent.ts:508-548: performSelfReflection runs after every ReAct loop, stores reflection metadata

Missing: No structured post-mortem docs. No monthly aggregates. No 13 AgentCore evaluators.
Verdict: SUBSTANTIAL (80%)

## Point 12: OpenClaw/NemoClaw Rebuild

Mapped: ReAct Loop (implemented), SKILL.md v2 (implemented+extended), Lane Queue->session serialization (Python), Memory->AgentCore Memory STM+LTM (implemented), ClawHub->chimera-skills+7-stage (implemented), exec-approvals->Cedar (implemented).
Missing: Context compaction (no auto-summarization). MicroVM deployment (no CDK stack).
Verdict: SUBSTANTIAL (75%)

## Critical Gaps Ranked by Impact

Priority 1 - Blocking:
1. AWS Service Tools (4/25) — Core value prop blocked. Need 11+ more minimum.
2. AgentCore CDK Deployment — No platform-runtime-stack.ts. Python agent ready but no deploy infra.
3. Multi-Modal (0%) — Entire vision section, zero implementation.

Priority 2 - Significant:
4. Background Task Dispatch — No agent API for concurrent ops.
5. Subagent Spawning — Infra exists, agents cant spawn subagents.
6. Tool Tier-Gating — Loading pipeline not implemented.

Priority 3 - Polish:
7. LLM-Assisted CDK Gen — Connect placeholder to Bedrock.
8. Team Abstraction — Add T to UTO.
9. Context Compaction — OpenClaw heritage feature.
10. Sandbox Testing — Replace Math.random() with Code Interpreter.

## Strengths Worth Preserving

1. Evolution Engine — Most mature. Safety Harness with Cedar + rate limits is production-quality.
2. Tenant Onboarding — Step Functions workflow, 7 steps, comprehensive.
3. SKILL.md v2 Parser — Full spec with permissions, deps, MCP config, tests.
4. CodeCommit Workspace — Real AWS SDK integration for agent-managed repos.
5. Self-Reflection Analytics — Health scores + trends + circuit breaker.
6. DynamoDB Schema — 6-table design with proper GSI and tenant isolation.
