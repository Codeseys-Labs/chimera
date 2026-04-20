# AWS Chimera - Development Workflow

> **Multi-agent orchestration system powered by Overstory**

This project uses the **Overstory swarm orchestration framework** with specialized lead and builder agents. This guide covers conventions, workflows, and quality gates for contributing to AWS Chimera.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Overstory Workflow](#overstory-workflow)
3. [Git Conventions](#git-conventions)
4. [Seeds Issue Tracking](#seeds-issue-tracking)
5. [Mulch Expertise Management](#mulch-expertise-management)
6. [CDK Infrastructure Conventions](#cdk-infrastructure-conventions)
7. [Testing Requirements](#testing-requirements)
8. [Documentation Standards](#documentation-standards)
9. [Quality Gates](#quality-gates)

---

## Quick Start

```bash
# 1. Clone and setup
git clone <repo-url>
cd chimera
bun install

# 2. Prime expertise and context
mulch prime              # Load project conventions
sd prime                 # Load issue tracking context
cn prime                 # Load prompt management

# 3. Find work
sd ready                 # List unblocked issues

# 4. Create worktree for your task
ov worktree create <task-id> --from main

# 5. Work in isolated worktree
cd .overstory/worktrees/<worktree-name>
# ... make changes ...

# 6. Run quality gates
bun test
bun run lint
bun run typecheck

# 7. Commit and signal completion
git add .
git commit -m "feat: description"
mulch record <domain> --type pattern --description "..."
sd close <task-id> --reason "completed"
```

---

## Development Conventions

### Bun Package Manager

**CRITICAL:** This project uses **Bun exclusively** for package management and script execution, **with one exception: AWS CDK**.

- ✅ **Always use `bun`** for package installation: `bun install`, `bun add <package>`, `bun remove <package>`
- ✅ **Always use `bun` or `bunx`** for script execution: `bun test`, `bun run lint`, `bunx tsc`
- ⚠️ **EXCEPTION: AWS CDK commands must use `npx`** — `npx cdk deploy`, `npx cdk synth`, `npx cdk bootstrap`
- ❌ **Never use npm** for package management — no `npm install`, `npm run`
- ❌ **Never use yarn** or `pnpm`

**Why the CDK exception?**

AWS CDK is fundamentally Node.js-based and relies on Node's module resolution algorithm. Bun's module resolution, while compatible with most packages, creates different class instances for aws-cdk-lib constructs, breaking `instanceof` checks and peer dependency patterns. This causes errors like `TypeError: peer.canInlineRule is not a function` in security group rules.

**Solution:** CDK commands use `npx cdk` (Node runtime) while everything else uses Bun. The `infra/cdk.json` app field uses `npx ts-node` to ensure CDK construct code runs under Node.

**Examples:**
```bash
# ✅ Correct
bun install                    # Package management
bun test                       # Tests
bun run lint                   # Linting
bunx tsc --noEmit             # TypeScript
npx cdk synth                  # CDK synthesis (Node required)
npx cdk deploy --all           # CDK deployment (Node required)

# ❌ Wrong
npm install                    # Use bun install
bunx cdk deploy                # Use npx cdk (Bun breaks CDK)
cdk deploy                     # Assumes global install
```

### Best Practices (Learned Conventions)

These conventions were discovered through production incidents and are documented in ADRs. See [SESSION-RETROSPECTIVE.md](docs/SESSION-RETROSPECTIVE.md) for detailed session learnings.

#### Toolchain (ADR-019, ADR-020)

| Technology | Tool | Why | Never Use |
|------------|------|-----|-----------|
| **JavaScript/TypeScript** | `bun` | 2-5x faster installs, native TypeScript | `npm`, `yarn`, `pnpm` |
| **Python** | `uv` + `pyproject.toml` | Deterministic resolution, fast | `pip`, `requirements.txt` |
| **AWS CDK** | `npx cdk` | Node runtime required (Bun breaks instanceof) | `bunx cdk`, global `cdk` |
| **CDK Synthesis** | `npx ts-node --transpile-only` | 3x faster than regular ts-node | `ts-node` without flag |
| **AWS SDK v3** | Module-level singletons | Reuse clients, connection pooling | Per-request client creation |

**Critical:** CDK **must** use `npx cdk` not `bunx cdk`. Bun's module resolution creates different class instances for aws-cdk-lib constructs, breaking instanceof checks causing `TypeError: peer.canInlineRule is not a function`.

#### Infrastructure (ADR-021, ADR-022, ADR-023)

**CodeBuild YAML:** Avoid decorative echo commands (breaks parser), use POSIX-compliant shell (no `${VAR:0:8}` substring syntax)

**Docker in Buildspec:** Add `|| true` for fault tolerance, BUT remove when downstream stack depends on image (must fail loudly if build breaks)

**KMS for CloudWatch Logs:** Must grant permissions via key policy (not just IAM) — CloudWatch Logs can ONLY access KMS keys via key policy

**Step Functions Lambda Tasks:** Always add retry with `errors: ['States.ALL']` to prevent transient cold start failures

**DLQ Circuit Breakers:** CloudWatch alarms on `ApproximateNumberOfMessagesVisible` > 5 messages

**Cross-Stack Dependencies:** When Stack B depends on Stack A resources (e.g., ChatStack using PipelineStack's ECR repo), Stack A failures must propagate

**ECS ALB Target Groups:** Must be referenced by at least one ApplicationListener or deployment fails

**Docker 2-Container Pattern:** Build container (install deps, build artifacts) + Runtime container (copy artifacts, run app) reduces image size 60-80%

#### Security

**Cedar Authorization Tests:** Assert on specific policy reasons, not just allow/deny (ensures correct policy applied)

**GSI Cross-Tenant Leakage:** ALWAYS add `FilterExpression='tenantId = :tid'` to all GSI queries on multi-tenant tables — GSI keys don't enforce partition isolation

**Tenant isolation is enforced at three layers** (as of ADR-033):
1. **CDK/DynamoDB** — partition keys `TENANT#{id}`, per-tenant KMS, IAM boundaries
2. **TypeScript Cedar** — policies validated in `packages/core/src/tenant/cedar-authorization.ts`
3. **Python agent tools** — every `@tool` calls `require_tenant_id()` from `tools/tenant_context.py`; DDB queries auto-inject `FilterExpression='tenantId = :__chimera_tid'` via `ensure_tenant_filter()`. An anti-pattern guard test (`test_no_tool_imports_boto3_without_tenant_context`) prevents regressions.

**Web UI XSS Prevention:** Use `createElement` + `textContent` for user content (never set innerHTML directly)

**Secrets Manager:** Never use `Secret.secretValue.unsafeUnwrap()` — embeds plaintext in CloudFormation template

#### Development

**Lead Agent Constraints:** Read-only file operations plus mail/mulch/seeds commands (cannot write files or run destructive git commands)

**Quality Gates:** `bun test && bun run lint && bun run typecheck` required before merge

**Mulch Expertise:** Record learnings before closing tasks with `--outcome-status success --outcome-agent <name>`, classify as `foundational` (confirmed) or `tactical` (session-specific)

**Python Agents:** Use `uv` with `pyproject.toml` + `uv.lock`, replace deprecated `[tool.uv] dev-dependencies` with `[dependency-groups] dev`

**CLI Deploy:** Uses `findProjectRoot()` to locate package.json, detects binary files, skips files > 5MB, batched CodeCommit CreateCommit API with 5MB batches

**Token Budget:** Pre-flight check uses `estimateMessageTokens()` with `Math.ceil(estimate * 1.1)` safety margin

**TSConfig for CDK:** `infra/tsconfig.json` needs `skipLibCheck: true` because `ts-node --transpile-only` skips type checking

---

## Overstory Workflow

### Worktree-Based Development

AWS Chimera uses **git worktrees** for isolated development branches. Each task gets its own worktree:

```bash
# Create worktree (done by orchestrator)
ov worktree create chimera-1234 --from main

# Work in isolation
cd .overstory/worktrees/<agent-name>
```

**Key principles:**
- ✅ All writes go to your worktree directory (never the canonical repo root)
- ✅ Each worktree has its own branch: `overstory/<agent-name>/<task-id>`
- ✅ Worktrees are ephemeral — merged and removed after task completion
- ✅ Never push to main directly — work flows through merge coordination

### Agent Roles

| Role | Responsibility | Examples |
|------|----------------|----------|
| **Lead agents** | Research, architecture, task decomposition, merge coordination | `lead-arch`, `lead-docs`, `lead-infra` |
| **Builder agents** | Implementation, testing, documentation-as-you-go | `builder-data`, `builder-api`, `builder-docs` |
| **Scout agents** | Quick exploration, recon, feasibility checks | `scout-01`, `scout-02` |
| **Reviewer agents** | Independent code review, quality validation, spec compliance verification | `review-<task>` |

> **Scout-first is mandatory:** For moderate and complex tasks, leads MUST spawn a scout before spawning builders. Scouts explore the codebase and report findings; leads use these findings to write accurate builder specs. Only simple tasks (1-3 files, well-understood changes) may skip the scout phase.

### Communication Protocol

Agents communicate via `ov mail`:

```bash
# Send status update
ov mail send --to lead-docs --subject "Progress" \
  --body "Completed schema design" --type status

# Ask question
ov mail send --to lead-arch --subject "Question: GSI design" \
  --body "Should we add GSI2?" --type question --priority high

# Report completion
ov mail send --to lead-docs --subject "Worker done: chimera-1234" \
  --body "All quality gates passed" --type worker_done

# Report error
ov mail send --to parent-agent --subject "Error: tests failing" \
  --body "TypeScript errors in data-stack.ts" --type error --priority urgent
```

---

## Git Conventions

### Branch Naming

```
overstory/<agent-name>/<task-id>
```

Examples:
- `overstory/lead-docs/chimera-a519`
- `overstory/builder-data/chimera-5a87`
- `overstory/scout-01/chimera-recon`

### Rebase Before Merge

**CRITICAL:** Lead agents must rebase on `main` before sending `merge_ready`:

```bash
# In lead worktree
git fetch origin main
git rebase origin/main

# Resolve conflicts if any
git add .
git rebase --continue

# Signal ready for merge
ov mail send --to merger --subject "merge_ready: lead-docs" \
  --body "Rebased on main, all tests pass" --type merge_ready
```

### Merge Order

The merger agent follows this sequence:

1. **Builder branches first** — merge all `builder-*` branches into lead branch
2. **Lead branch second** — merge consolidated lead branch into main

This prevents merge conflicts when multiple builders contribute to a single lead's work.

### Handling Rename Conflicts

When rebasing after a large rename (e.g., ClawCore → Chimera):

```bash
# If conflicts occur
git status  # Review conflicted files

# For rename+content conflicts:
git checkout --theirs <file>  # Accept incoming changes
# Then manually apply your edits on top

git add .
git rebase --continue
```

**Pattern learned:** Rename operations should be completed and merged to main before feature branches start work on renamed files.

---

## Seeds Issue Tracking

AWS Chimera uses **Seeds** for git-native issue tracking.

### Issue Lifecycle

```bash
# Create issue
sd create --title "Add DynamoDB GSI2 for tenant queries" \
  --type task --priority 2

# Claim work
sd update chimera-1234 --status in_progress

# Add dependency
sd dep add chimera-1235 chimera-1234  # 1235 depends on 1234

# Complete work
sd close chimera-1234 --reason "Added GSI2 with FilterExpression"

# Sync with git
sd sync
git push
```

### Issue Types

- `task` — Implementation work
- `bug` — Defects to fix
- `research` — Investigation, architecture decisions
- `epic` — Large multi-task initiatives

### Priority Levels

- `1` — Critical (blocking, urgent)
- `2` — High (important, next sprint)
- `3` — Medium (normal priority)
- `4` — Low (nice-to-have)
- `5` — Backlog (future consideration)

### Dependencies

Use `sd dep add <child> <parent>` to model task relationships:

```bash
# Phase 1 depends on Phase 0
sd dep add chimera-fb27 chimera-5a87

# Query ready issues (no unresolved dependencies)
sd ready
```

---

## Mulch Expertise Management

AWS Chimera uses **Mulch** for structured knowledge capture.

### Recording Patterns

After completing work, record learnings:

```bash
mulch record architecture --type convention \
  --description "All DDB GSI queries must include FilterExpression for tenantId" \
  --classification foundational \
  --outcome-status success --outcome-agent builder-data
```

### Record Types

| Type | When to Use | Example |
|------|-------------|---------|
| `convention` | Project-wide rules | "6-table DynamoDB design" |
| `pattern` | Reusable solutions | "GSI cross-tenant leakage prevention" |
| `failure` | Mistakes + fixes | "ClawHavoc supply chain attack → 7-stage pipeline" |
| `decision` | Architecture choices | "AWS CDK over Terraform" |
| `reference` | External resources | Link to AWS docs |
| `guide` | How-to instructions | "Self-evolution research workflow" |

### Classification Levels

- `foundational` — Core conventions confirmed across multiple sessions
- `tactical` — Session-specific patterns (default if omitted)
- `observational` — One-off findings, unverified hypotheses

### Loading Expertise

```bash
# Load all domain expertise
mulch prime

# Load only specific domains
mulch prime architecture security

# Load records for specific files
mulch prime --files infra/lib/data-stack.ts

# Search existing patterns
mulch search "dynamodb gsi"
```

### Syncing Records

```bash
# Show what files changed (decide what to record)
mulch learn

# Record insights
mulch record <domain> --type <type> --description "..."

# Validate, stage, and commit .mulch/ changes
mulch sync
```

---

## CDK Infrastructure Conventions

### 11-Stack Architecture

AWS Chimera uses separation-of-concerns CDK stacks:

```
infra/lib/
├── network-stack.ts            # VPC, subnets, NAT, security groups, VPC endpoints
├── data-stack.ts               # DynamoDB (6 tables), S3 buckets
├── security-stack.ts           # Cognito, IAM roles, Cedar policies, KMS, WAF
├── observability-stack.ts      # CloudWatch, X-Ray, alarms, SNS topics
├── api-stack.ts                # API Gateway REST + WebSocket, JWT auth, OpenAI-compatible endpoint
├── skill-pipeline-stack.ts     # 7-stage skill security scanning pipeline
├── chat-stack.ts               # ECS Fargate, ALB, SSE streaming bridge
├── orchestration-stack.ts      # EventBridge event bus, SQS queues, agent-to-agent messaging
├── evolution-stack.ts          # Self-evolution engine (A/B testing, auto-skills, model routing)
├── tenant-onboarding-stack.ts  # Tenant provisioning workflow with Cedar policies
└── pipeline-stack.ts           # CI/CD, CodePipeline, canary deployment
```

### L3 Construct Pattern

Reusable constructs encapsulate multi-resource patterns:

```typescript
// constructs/tenant-agent.ts
export class TenantAgent extends Construct {
  constructor(scope: Construct, id: string, props: TenantAgentProps) {
    super(scope, id);

    // 15+ resources: MicroVM, IAM role, S3 bucket, DDB partition, etc.
    // Enforces multi-tenant isolation by default
  }
}
```

### Naming Conventions

- **Stacks:** `ChimeraDataStack`, `ChimeraNetworkStack`
- **Resources:** `chimera-tenants`, `chimera-sessions`
- **Constructs:** `TenantAgent`, `SkillRegistry`

### 6-Table DynamoDB Schema

See [docs/architecture/canonical-data-model.md](docs/architecture/canonical-data-model.md) for authoritative schema.

**Tables:**
1. `chimera-tenants` — Tenant config (PROFILE, CONFIG, BILLING, QUOTA items)
2. `chimera-sessions` — Active agent sessions (24h TTL)
3. `chimera-skills` — Installed skills + MCP endpoints
4. `chimera-rate-limits` — Token bucket state (5min TTL)
5. `chimera-cost-tracking` — Monthly cost accumulation (2yr TTL)
6. `chimera-audit` — Security events (90d-7yr TTL, CMK encryption)

**GSI Query Pattern:**
```typescript
// ALWAYS filter by tenantId on GSI queries
const result = await ddb.query({
  IndexName: 'GSI2',
  KeyConditionExpression: 'status = :status',
  FilterExpression: 'tenantId = :tid',  // <-- CRITICAL
  ExpressionAttributeValues: {
    ':status': 'ACTIVE',
    ':tid': tenantId
  }
});
```

---

## Testing Requirements

### Quality Gates (Required)

All code must pass before merge:

```bash
bun test           # Jest unit + integration tests
bun run lint       # ESLint + Prettier
bun run typecheck  # TypeScript compiler
```

### Test Organization

```
tests/
├── unit/          # Fast, isolated tests
├── integration/   # Multi-component tests
└── e2e/           # Full system tests
```

### Test Naming

```typescript
describe('DataStack', () => {
  describe('TenantsTable', () => {
    it('should enforce tenantId partition key', () => {
      // Test GSI FilterExpression enforcement
    });
  });
});
```

### CDK Testing

```typescript
import { Template } from 'aws-cdk-lib/assertions';

test('DataStack creates 6 DynamoDB tables', () => {
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::DynamoDB::Table', 6);
});
```

---

## Documentation Standards

### Documentation-as-You-Go

Documentation is woven into implementation:

- **Non-obvious code** → Inline comments explaining WHY
- **New directories** → Brief README.md explaining purpose
- **Architecture decisions** → Commit messages or inline notes

### Document Types

| Type | Location | Purpose |
|------|----------|---------|
| Architecture | `docs/architecture/` | ADRs, canonical schemas |
| Research | `docs/research/` | Investigation, competitive analysis |
| Runbooks | `docs/runbooks/` | Operational procedures |
| README | Each package | Package purpose, API, usage |

### Frontmatter Convention

```markdown
---
title: "Canonical DynamoDB Data Model"
version: 1.0.0
status: canonical
last_updated: 2026-03-19
supersedes:
  - docs/research/file1.md
  - docs/research/file2.md
---
```

### Avoiding Documentation Bloat

❌ **Don't add:**
- Boilerplate comments repeating code
- Redundant README files
- Documentation for self-explanatory code

✅ **Do add:**
- Comments for non-obvious business logic
- README for new directories
- Architecture decision notes

---

## Quality Gates

### Before Signaling Completion

1. ✅ All tests pass: `bun test`
2. ✅ No lint errors: `bun run lint`
3. ✅ No type errors: `bun run typecheck`
4. ✅ Changes committed to worktree branch
5. ✅ Mulch learnings recorded: `mulch record ...`
6. ✅ Seeds issue closed: `sd close <task-id> --reason "..."`
7. ✅ Worker done mail sent: `ov mail send --to parent --type worker_done`

### Lead Agent Merge Checklist

Before sending `merge_ready`:

1. ✅ Rebase on main: `git rebase origin/main`
2. ✅ Resolve conflicts (if any)
3. ✅ All builder branches merged into lead branch
4. ✅ Quality gates pass in consolidated branch
5. ✅ Documentation updated
6. ✅ Mulch records synced: `mulch sync`
7. ✅ Seeds issues synced: `sd sync`
8. ✅ Builder `.mulch/` records consolidated into lead branch
9. ✅ Lead's own orchestration insights recorded via `mulch record`

### Worktree Merge Flow

Changes flow UP the agent hierarchy, never bypass levels:

```
Builder worktree → Lead branch (lead consolidates) → Main (coordinator merges)
Scout worktree  → Lead branch (lead records findings) → Main (coordinator merges)
```

**Rules:**
- Builders and scouts commit to their own worktree branches
- Leads merge builder/scout work + `.mulch/` records into their lead branch
- Leads send `merge_ready` to coordinator only after full consolidation
- Coordinator ONLY merges `overstory/lead-*` branches (never builder/scout branches)
- Coordinator verifies `.mulch/` changes are present before worktree cleanup
- Worktree cleanup NEVER uses `--force`

### Merge Coordinator Actions

The merger agent follows this sequence:

```bash
# 1. Merge builder branches → lead branch
ov merge builder-data → lead-arch
ov merge builder-api → lead-arch

# 2. Lead rebases on main
cd .overstory/worktrees/lead-arch
git rebase origin/main

# 3. Merge lead branch → main
ov merge lead-arch → main

# 4. Push to remote
git push origin main
```

---

## Common Workflows

### Starting a New Feature

```bash
# 1. Create issue
sd create --title "Add WebSocket support" --type task --priority 2

# 2. Lead creates worktree
ov worktree create chimera-6f0e --from main

# 3. Load expertise
mulch prime integration architecture

# 4. Decompose into builder tasks
sd create --title "Implement WebSocket handler" --type task --priority 2
sd dep add chimera-6f0f chimera-6f0e  # Child depends on parent

# 5. Dispatch builder agents
ov spawn builder-api --task chimera-6f0f
```

### Resolving Merge Conflicts

```bash
# In lead worktree
git fetch origin main
git rebase origin/main

# If conflicts
git status
# Edit conflicted files
git add .
git rebase --continue

# Rerun quality gates
bun test
bun run lint
```

### Recording a Pattern

```bash
# After discovering a useful pattern
mulch record architecture --type pattern \
  --description "self-modifying-iac-dynamodb-cdk: DynamoDB-driven CDK synthesis enables agent-autonomous infrastructure" \
  --classification foundational \
  --outcome-status success --outcome-agent lead-arch \
  --evidence-commit $(git rev-parse HEAD)
```

---

## Failure Modes (Avoid These)

These are named failures from the project's mulch expertise:

### PATH_BOUNDARY_VIOLATION
Writing to any file outside your worktree directory. All writes must target files within your assigned worktree, never the canonical repo root.

### FILE_SCOPE_VIOLATION
Editing or writing to a file not listed in your FILE_SCOPE. Read any file for context, but only modify scoped files.

### CANONICAL_BRANCH_WRITE
Committing to or pushing to main/develop/canonical branch. You commit to your worktree branch only.

### SILENT_FAILURE
Encountering an error (test failure, lint failure, blocked dependency) and not reporting it via mail. Every error must be communicated to your parent with `--type error`.

### INCOMPLETE_CLOSE
Running `sd close` without first passing quality gates and sending a result mail.

### MISSING_WORKER_DONE
Closing a seeds issue without first sending `worker_done` mail to parent. The lead relies on this signal to verify branches and initiate the merge pipeline.

### MISSING_MULCH_RECORD
Closing without recording mulch learnings. Every implementation session produces insights. Skipping `ml record` loses knowledge for future agents.

### GSI Cross-Tenant Data Leakage
Global secondary indexes on shared DynamoDB tables can leak data across tenants.
**Fix:** Add `FilterExpression='tenantId = :tid'` to all GSI queries.

---

## Resources

- [README.md](README.md) — Project overview
- [docs/ROADMAP.md](docs/ROADMAP.md) — Implementation roadmap
- [docs/architecture/canonical-data-model.md](docs/architecture/canonical-data-model.md) — DynamoDB schema
- [AGENTS.md](AGENTS.md) — Mulch, Seeds, Canopy quick reference
- [Overstory Documentation](https://github.com/jayminwest/overstory) — Agent orchestration framework
- [Mulch Documentation](https://github.com/jayminwest/mulch) — Expertise management
- [Seeds Documentation](https://github.com/jayminwest/seeds) — Issue tracking

---

**AWS Chimera** — where agents are forged.

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard-v:1 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->

<!-- canopy:start -->
## Prompt Management (Canopy)
<!-- canopy-onboard-v:1 -->

This project uses [Canopy](https://github.com/jayminwest/canopy) for git-native prompt management.

**At the start of every session**, run:
```
cn prime
```

This injects prompt workflow context: commands, conventions, and common workflows.

**Quick reference:**
- `cn list` — List all prompts
- `cn render <name>` — View rendered prompt (resolves inheritance)
- `cn emit --all` — Render prompts to files
- `cn update <name>` — Update a prompt (creates new version)
- `cn sync` — Stage and commit .canopy/ changes

**Do not manually edit emitted files.** Use `cn update` to modify prompts, then `cn emit` to regenerate.
<!-- canopy:end -->
