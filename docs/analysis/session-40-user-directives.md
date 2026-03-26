# Session #40 — User Directives & Decisions Log

> **Session**: `e856e983-f216-45a0-8029-744abdba1130`
> **Duration**: 97h 53m (2026-03-20 23:42 → 2026-03-25 01:40)
> **Messages**: 3,037 total (146 user, 607 assistant text turns)
> **Human directives**: 89 (56 were automated pipeline checks, 1 system init)
> **Est. cost**: $3,252.18

---

## Table of Contents

1. [Project Vision & Identity](#1-project-vision--identity)
2. [Architecture Decisions](#2-architecture-decisions)
3. [Toolchain Mandates](#3-toolchain-mandates)
4. [Agent Orchestration Directives](#4-agent-orchestration-directives)
5. [Deployment & CI/CD](#5-deployment--cicd)
6. [User Experience & Multi-Tenancy](#6-user-experience--multi-tenancy)
7. [Self-Evolution & Autonomy](#7-self-evolution--autonomy)
8. [Documentation & Quality](#8-documentation--quality)
9. [Infrastructure Fixes & Debugging](#9-infrastructure-fixes--debugging)
10. [Chronological Directive Summary](#10-chronological-directive-summary)

---

## 1. Project Vision & Identity

### Core Vision (Directive #4, the founding statement)

Chimera is an **AWS-native rebuild of OpenClaw/NemoClaw** with major improvements:

- Instead of having access to the computer it's on, Chimera has access to the **AWS account and all its resources**
- Can develop its own **skills, tools, capabilities, subagents** to complete any task or overcome any roadblock
- Can use: code interpreter, AWS services, OSS projects (OpenSandbox), browser tool, or anything available in the AWS account (or allotted to the agent's IAM role)
- User/Team/Org (UTO) can restrict or open the agent's access to the account
- Single installation per account that can **service multiple people** — needs user-recognition
- Should leverage **AgentCore** for runtime, memory, identity, and related capabilities
- Skills system should be **compatible with Claude Code, OpenClaw, and all other skill formats**
- Must support **self-evolution and self-expansion** (creation of subagents)
- Must have access to **CodeCommit** so it can **edit itself** with proper CI/CD
- Can set up other IaC for itself or for whatever the UTO asks

### Example Use Cases (from the vision)

- UTO instructs agent to build a document ingestion pipeline into a knowledge base with a Bedrock chatbot → agent delegates or completes it while UTO continues interacting
- UTO provides video/audio without instruction → system figures out how to ingest and analyze it
- Agent performs self-reflections and post-mortems to stay operational and improve

---

## 2. Architecture Decisions

### 11-Stack CDK Architecture
- Separation-of-concerns stacks: Network, Data, Security, Observability, API, Skill Pipeline, Chat, Orchestration, Evolution, Tenant Onboarding, Pipeline
- Each stack in its own file, using **nested stack system** for manageability (#81)

### Agent Gateway Architecture
- Vercel Chat SDK + AgentCore runtime for the chat interface (#17, #56)
- Hono instead of Node.js Express for the SSE bridge server (#69)
- 2-container Docker pattern: build container + runtime container (#69)

### Model Router
- Auto-router that routes requests to the right model (#55, #56)
- Should be **toggleable** — users can select static model or auto-routing (#56)
- Model pool should be expandable/shrinkable, not hardcoded to 4 models (#56)

### Skill Pipeline
- 7-stage security scanning pipeline — only 3 stages were complete (#56)
- Remaining 4 stages need to be finished

### Memory Architecture
- AgentCore memory with **tiered levels**: session, swarm, agent-level (#22)
- AGENTS.md and SOUL.md files to prime the agent with self-awareness (#22)

### Deployment Source
- Remote GitHub repo as source, **tagged releases as default** (#81)
- Optional flag for git repo with branch specification
- Not local repo as source

### Split Build Pipeline
- Image building and CDK deployment should be **separate CodePipeline/CodeBuild steps** (#89)

---

## 3. Toolchain Mandates

### Bun Over Everything (#40, #69, #75)
- Use `bun` and `bunx` for all JavaScript/TypeScript operations
- Use `uv` for Python (not pip, not requirements.txt)
- **Exception**: CDK commands must use `npx cdk` (Bun breaks CDK `instanceof` checks) (#75, #77)
- Remove all mention of nodejs and npm (#69)
- Lambdas might differ from the bun mandate (#69)

### Bun Binary Compilation (#17)
- Migrate to bun so Chimera CLI can be compiled into a **single binary**
- GitHub Actions to compile on tagged releases
- Bun script to auto-create release notes, tag, and push

### Document in CLAUDE.md and AGENTS.md (#40)
- Toolchain preferences must be codified in project configuration files

---

## 4. Agent Orchestration Directives

### Workflow Pattern (consistent throughout)
- **Leads → Scouts → Builders** hierarchy
- Scouts investigate and deep-dive first
- Leads architect and plan
- Builders implement, fix, and document
- "Use as many leads as you need" (#5)

### Specific Dispatch Orders
- "spin up multiple leads to all parallelly review the codebase" (#3)
- "plan out what can be parallelized and what is blocking what" (#7)
- "monitor every 5 mins using sleep command" (#7)
- "dispatch leads for everything" (#11, #46, #64, #65)
- "have them keep the vision in mind and all the research we've done" (#10)
- "every lead should read `docs/analysis/2026-03-23-well-architected-deep-dive.md`" (#49)
- "ask them to read files in multiple collaborative scout agents before dispatching builders" (#82)

### Agent Capabilities Required (#10)
- Self-healing: pushed to CodeCommit/CodePipeline, can edit itself
- Self-evolving: skills, programs, scripts, IaC projects/infra
- Self-optimizing: continuous improvement
- Self-expanding: creation of subagents
- Self-triggering: cron jobs and/or events (EventBridge)

---

## 5. Deployment & CI/CD

### Deployment Flow (#21, #45, #65, #72)
- CLI seeds the account with IaC for the agent system
- Deployment happens **asynchronously via CodePipeline** — CLI doesn't deploy directly
- CLI seeds CodeCommit and CodePipeline, then configures connection to the account/deployment
- "The CLI shouldn't be deploying unless it's deploying the CodeCommit and CodePipeline stuff" (#45)

### Repo Structure (#45)
- May need to separate CLI from agent code
- CLI is standalone question: can it package the agent into the binary or does it need the repo? (#65)

### Upstream Sync (#65)
- If there are upstream/base Chimera agent changes, how does sync/deploy apply them?
- Should the agent handle it automatically or let the user handle with a CLI command?
- Rebase pattern considered

### Destroy/Deploy Verification (#56)
- Full cleanup+deploy verification cycle
- Destroy should properly destroy everything with **optional data retention and export/archive**
- Deploy should have **optional reseeding of archived/exported data**

### Pipeline Monitoring (#73, #74)
- Set up cron to check pipeline status every 5 minutes
- Use CronJob tool for automated monitoring

---

## 6. User Experience & Multi-Tenancy

### User/Team/Org (UTO) Model
- Single installation per account services multiple people
- Per-user access with deployed agent and Vercel Chat SDK (#17)

### Authentication (#20, #25)
- Cognito login flow for user tracking
- Set up during CodePipeline deployment, not manually (#25)
- UI for chat application integration with Vercel Chat SDK
- User pairing between chat application user-id and Cognito user entry (#20)

### Chat Interface Preferences (#27)
- Web UI preferred over Slack
- Optional web portal
- Vercel Chat SDK supports multiple chat application integrations
- Group chat should be implemented or at least guidance documented (#65)

### Background Tasks (#27)
- Should be set up with EventBridge or similar service

---

## 7. Self-Evolution & Autonomy

### Self-Modification
- Agent can edit itself within the account via CodeCommit (#4, #10)
- Proper CI/CD guards the self-modification

### Self-Reflection (#4)
- Post-mortems and self-reflections to maintain operational status
- Continuous improvement on current and past work

### Session Retrospectives (#86, #87, #88)
- "Make sure every thought and idea has been documented"
- "Give every bit of what we've talked about to the session retrospective lead"
- "Get the lead to access this session's records on our local filesystem" to parse through all information (#88)

---

## 8. Documentation & Quality

### Documentation Mandates
- "Document everything" — repeated directive (#31, #79, #84, #86)
- Architecture decisions must be documented in ADR files (#84)
- Architecture MD file in docs folder that references decision files (#84)
- Update README and roadmap to reflect everything done (#17)
- "Spin up multiple collaborative leads to read, reason on, validate, and update architecture decision documentation" (#84)

### Best Practices
- Add to CLAUDE.md and AGENTS.md (#79)
- Comprehensive documentation for model router and all built features (#56)

### Session Knowledge Preservation (#86, #87)
- Track every thought and idea
- Document whether integration was planned, and if not, why not
- Research docs, future plans, and ADRs for unimplemented ideas

---

## 9. Infrastructure Fixes & Debugging

### Key Issues Encountered
- Code Defender git hooks breaking worktree creation (#2)
- Multiple merge conflict resolutions (sessions 3-67)
- CDK deploy failures needing investigation (#47)
- Chat Stack failures and investigation (#68)
- Test stage failures (#63)
- Bun vs npx CDK incompatibility (#75, #77)
- `chimera.ts` had Node shebang line that wasn't needed with npx cdk (#81)
- Agent worktrees dying unexpectedly (#81)

### Resolution Patterns
- "Fix first, then cleanup attempts, then continue" (#45)
- "Investigate the issue and fix it" (#47, #69)
- Use scout-first leads for fixes (#83)

---

## 10. Chronological Directive Summary

| # | Time | Directive |
|---|------|-----------|
| 1 | Mar 20 23:47 | Merge pending branches with merge lead |
| 2 | Mar 20 23:57 | Clean stale merge queue, delete builder-core-memtools branch |
| 3 | Mar 21 00:00 | Parallel leads to review codebase — what is built, what needs building |
| 4 | Mar 21 00:32 | **The founding vision statement** — AWS-native OpenClaw/NemoClaw rebuild |
| 5 | Mar 21 00:38 | Leads to research, fix foundation, greenfield the agent; update vision + roadmap |
| 7 | Mar 21 05:35 | Plan parallelization, set up seeds, dispatch leads, monitor every 5 min |
| 10 | Mar 21 17:59 | Full code + architecture review; self-healing/evolving/optimizing/expanding/triggering |
| 11 | Mar 21 18:24 | "Fix all the gaps. Dispatch leads for everything." |
| 16 | Mar 21 20:15 | CLI primes CodeCommit/CodePipeline, then configures connection |
| 17 | Mar 21 20:43 | Update README/roadmap, migrate to bun, compile to binary, GH Actions CI/CD, UX review |
| 20 | Mar 21 21:31 | Cognito login flow, chat app integration, user-id pairing |
| 21 | Mar 21 22:01 | Deployment is from CodeCommit via CodePipeline; CLI seeds the account |
| 22 | Mar 21 22:05 | Document everything, prime agent with AWS tooling, AGENTS.md + SOUL.md, tiered memory |
| 25 | Mar 22 01:11 | Cognito set up during CodePipeline deploy |
| 27 | Mar 22 03:18 | P1 issues first, research P2 before dispatch; web UI over Slack; EventBridge for background tasks |
| 31 | Mar 22 19:29 | Build CLI and deploy to baladita+Bedrock-Admin in us-west-2 (multi-region access) |
| 35 | Mar 22 19:32 | "All packages installed, what else do I need to do?" |
| 40 | Mar 22 20:21 | Use bun/bunx exclusively; document in CLAUDE.md and AGENTS.md |
| 41 | Mar 23 07:31 | Is there an npm variant to avoid pip installing codecommit? |
| 45 | Mar 23 08:44 | Fix → cleanup → continue; CLI shouldn't deploy directly; consider repo restructure |
| 47 | Mar 23 17:26 | Investigate CDK deploy failure and fix; find other issues |
| 49 | Mar 23 19:12 | All leads must read well-architected deep dive document |
| 55 | Mar 23 22:12 | "What model router was used?" |
| 56 | Mar 23 22:18 | Finish 4/7 skill pipeline stages; expandable model router; toggleable routing; full documentation; deploy verification with data retention |
| 61 | Mar 23 23:09 | Check pipeline status, verify all 11 stacks deployed |
| 63 | Mar 23 23:11 | Fix test stage and Chat Stack |
| 65 | Mar 24 00:49 | Group chat implementation; CLI standalone question; upstream sync; deploy source question |
| 68 | Mar 24 17:26 | Check Chat Stack; why did it take so long? |
| 69 | Mar 24 17:33 | Remove Node/npm mentions; use Hono not Express; 2-container Docker pattern; architecture of Vercel Chat SDK + AgentCore |
| 72 | Mar 24 19:23 | Use Chimera CLI to deploy without manual CodeCommit push |
| 75 | Mar 24 19:43 | Use npx cdk; get bun working if possible |
| 79 | Mar 24 20:33 | Leads for documentation/architecture/codebase mapping; best practices in CLAUDE.md |
| 81 | Mar 24 20:45 | Dead agents investigation; no TS compilation needed with npx cdk; tagged releases as source; remove shebang; nested stacks |
| 82 | Mar 24 21:03 | Collaborative scout agents to read files before dispatching builders |
| 83 | Mar 24 23:22 | Scout-first lead for fixes; what about everything else discussed? |
| 84 | Mar 24 23:37 | Multiple collaborative leads for architecture decision documentation |
| 85 | Mar 25 00:09 | Check lead worktrees for unmerged changes |
| 86 | Mar 25 00:14 | Document all thoughts, ideas, plans — track integration status for each |
| 87 | Mar 25 00:17 | Session retrospective lead must get all context |
| 88 | Mar 25 00:18 | Lead should access session records from local filesystem |
| 89 | Mar 25 00:39 | Split image building and CDK deployment into separate pipeline steps |

---

## Unresolved Questions (from user directives)

1. **CLI standalone binary**: Can it package everything or does it need the repo as source? (#65)
2. **Upstream sync**: Should the agent handle repo sync automatically or provide CLI commands? (#65)
3. **Model router pool**: What models should be in the default pool? How to configure? (#56)
4. **Skill pipeline stages 4-7**: What are the remaining stages? (#56)
5. **Data retention on destroy**: What format for archive/export? What's the reseeding flow? (#56)
6. **CodeCommit without pip**: Is there an npm/bun alternative to the Python codecommit helper? (#41)
7. **Group chat**: Implementation or just guidance doc? (#65)
