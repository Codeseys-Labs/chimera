# Multi-Agent Orchestration & Subagents

> Part of the [[01-OpenClaw-Core-Architecture]] research series. See also [[04-Skill-System-Tool-Creation]] for tool surfaces and [[07-Chat-Interface-Multi-Platform]] for channel integration.

## Overview

OpenClaw's multi-agent story has three layers: (1) in-process subagent spawning via the Lane Queue concurrency model, (2) inter-agent communication via `sessions_send` and the Gateway, and (3) higher-level orchestration patterns built on top. NemoClaw adds privacy-aware routing across agent boundaries, and OpenFang takes a fundamentally different approach with autonomous "Hands" modeled as OS processes.

---

## 1. Lane Queue Concurrency Model

OpenClaw does **not** use threads or background worker processes. The entire Gateway is a single Node.js process running on async promises. Concurrency is managed by a **lane-aware FIFO queue** implemented in `src/process/command-queue.ts`.

### How It Works

1. Every incoming task gets enqueued by **session key** (lane `session:<key>`) to guarantee only one active run per session
2. Each session run is then queued into a **global lane** (`main` by default) so overall parallelism is capped
3. Different lanes run **in parallel** with each other but serialize within their own concurrency cap
4. Typing indicators fire immediately on enqueue (before execution starts) for UX continuity

### The Four Named Lanes

| Lane | Default Concurrency | Purpose |
|------|-------------------|---------|
| `main` | 4 | Inbound messages + main heartbeats |
| `subagent` | 8 | Background subagent runs |
| `cron` | 1 | Scheduled cron jobs |
| `nested` | 1 (!) | Agent-to-agent `sessions_send` calls |

**Key guarantee:** Lanes don't compete. A cron job in the `cron` lane cannot starve an inbound message in `main`, and a fleet of subagents has its own concurrency budget separate from the main chat flow.

### Configuration

```jsonc
{
  agents: {
    defaults: {
      maxConcurrent: 4,       // main lane (inbound messages)
      subagents: {
        maxConcurrent: 8,     // subagent lane
      },
      cron: {
        maxConcurrentRuns: 2, // cron lane
      }
    }
  }
}
```

### Queue Modes (Per Channel)

Queue modes control how inbound messages interact with active runs:

| Mode | Behavior |
|------|----------|
| `collect` (default) | Coalesce queued messages into a single followup turn |
| `steer` | Inject into the current run, cancelling pending tool calls at next boundary |
| `followup` | Wait for current run to end, then start a new turn |
| `steer-backlog` | Steer now AND preserve for a followup |

### Known Issue: Nested Lane Bottleneck

The `nested` lane (used by `sessions_send` for agent-to-agent communication) defaults to concurrency **1**. In multi-agent setups (e.g., 9 agents), this creates a severe bottleneck:

```
20:09:51 lane enqueue: lane=nested queueSize=1 (dequeued immediately)
20:10:31 lane enqueue: lane=nested queueSize=2 (blocked)
20:13:04 lane enqueue: lane=nested queueSize=3 (blocked)
20:16:11 lane task done: lane=nested durationMs=379024 active=0 queued=3
20:16:11 lane wait exceeded: lane=nested waitedMs=339753 queueAhead=2
```

First task held the lane for 6.3 minutes; next task waited 5.7 minutes. This is tracked in [issue #22167](https://github.com/openclaw/openclaw/issues/22167). The workaround is manual lane configuration; the proposed fix is a config knob for nested lane concurrency.

---

## 2. Subagent Spawning & Lifecycle

Subagents are **background agent runs** spawned from an existing agent run. They run in their own isolated session and announce results back to the requester chat.

### Session Isolation

Each subagent gets a unique session key: `agent:<agentId>:subagent:<uuid>`. This provides:
- Full session separation from the parent
- Independent context window and memory
- Optional sandboxing via tool restrictions

### Slash Commands

```
/subagents spawn [--model <model>] [--thinking <on|off>] <prompt>
/subagents steer <id> <message>
/subagents send <id> <message>
/subagents info <id>
/subagents log <id> [limit] [tools]
/subagents kill <id>
/subagents list
```

### Spawn Modes

| Mode | Command | Behavior |
|------|---------|----------|
| One-shot | `/subagents spawn` | `mode: "run"` -- runs prompt, announces result, archives |
| Persistent session | `sessions_spawn` with `thread: true` | `mode: "session"` -- stays alive for ongoing interaction |
| ACP harness | `sessions_spawn` with `runtime: "acp"` | Runs inside Codex, Claude Code, or Gemini CLI |

### Announce Pattern

When a subagent completes, it posts back to the requester chat with:
- Task status (success/failure)
- Runtime duration
- Token usage and cost
- Result summary

Sessions are auto-archived after a configurable timeout (default 60 minutes).

### Cost Control

Subagents can use cheaper models to reduce cost:

```jsonc
{
  agents: {
    defaults: {
      subagents: {
        model: "gpt-4o-mini",  // cheaper model for background work
      }
    }
  }
}
```

### Tool Restrictions

By default, subagents receive a **restricted tool surface** -- they do NOT get:
- `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`
- `gateway`, `cron`

This prevents uncontrolled fan-out. Override via config:

```jsonc
{
  tools: {
    subagents: {
      tools: {
        deny: ["gateway", "cron"],           // deny always wins
        // allow: ["read", "exec", "process"] // if set, becomes allow-only
      }
    }
  }
}
```

---

## 3. Nested Subagents & Orchestrator Pattern

By default, subagents **cannot** spawn their own subagents (`maxSpawnDepth: 1`). This prevents uncontrolled fan-out and keeps cost predictable.

### Enabling Nesting

Set `maxSpawnDepth: 2` to allow one level of nesting, enabling the **orchestrator pattern**:

```
main agent --> orchestrator subagent --> worker sub-sub-agents
```

```jsonc
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2,          // allow sub-agents to spawn children
        maxChildrenPerAgent: 5,    // max active children per agent session
        maxConcurrent: 8,          // global concurrency lane cap
        runTimeoutSeconds: 900,    // timeout for sessions_spawn (0 = no timeout)
      }
    }
  }
}
```

### Depth-Level Tool Access

| Depth | Tools Available |
|-------|----------------|
| 0 (main) | Full tool surface |
| 1 (subagent) | Restricted -- no session tools by default |
| 2 (orchestrator subagent) | Gets `sessions_spawn`, `subagents`, `sessions_list`, `sessions_history` to manage children |

When `maxSpawnDepth >= 2`, depth-1 orchestrator subagents receive the session management tools so they can coordinate their workers.

### Barrier Primitive (Proposed)

There is an open feature request ([issue #38522](https://github.com/openclaw/openclaw/issues/38522)) for a first-class **barrier primitive**:

1. Spawn multiple subagents as a cohort
2. Await completion of all/any/minimum N
3. Return combined results in a single structured response

Currently, orchestrators must manually poll and stitch results, which is brittle and token-inefficient.

---

## 4. Inter-Agent Communication via Gateway

Beyond parent-child subagent relationships, OpenClaw supports **peer-to-peer agent communication** through the Gateway.

### `sessions_send` / `agent_send`

Agents can send messages to other named agents using `sessions_send` or the `agent_send` tool. Messages are routed through the Gateway and enqueued in the recipient's `nested` lane.

### Communication Topologies

| Topology | Description | Use Case |
|----------|-------------|----------|
| **Star** | Coordinator sends to/receives from all workers | Task delegation, result aggregation |
| **Mesh** | Any agent can message any other agent | Collaborative problem-solving |
| **Pipeline** | Agent A -> Agent B -> Agent C | Sequential processing workflows |
| **Event bus** | Pub/sub via hooks and event queue | Decoupled async collaboration |

### Event Queue Configuration

OpenClaw supports an event bus deeply integrated with the Hooks system:

```yaml
team:
  event_bus:
    enabled: true
    events:
      - name: "scraping_completed"
        publisher: "web-scraper"
        subscribers: ["data-analyst"]
        trigger: "on_task_success"
      - name: "analysis_completed"
        publisher: "data-analyst"
        subscribers: ["report-writer", "coordinator"]
        trigger: "on_task_success"
      - name: "task_failed"
        publisher: ""  # Any agent can publish
        subscribers: ["coordinator"]
        trigger: "on_error"
```

Hooks triggered on agent task completion can automatically publish events to the queue, launching downstream agents. Each agent only needs to care about "when I finish" -- not "who is waiting for my results."

---

## 5. Task Delegation Patterns

### Pattern 1: Simple Fan-Out

The main agent spawns N subagents in parallel, each handling an independent subtask:

```
Main Agent
  |-- spawn subagent: "Research topic A"
  |-- spawn subagent: "Research topic B"
  |-- spawn subagent: "Research topic C"
  |-- await all results
  |-- synthesize final answer
```

### Pattern 2: Coordinator-Worker (Orchestrator)

Requires `maxSpawnDepth: 2`. The main agent spawns a coordinator that manages workers:

```
Main Agent
  |-- spawn Coordinator (depth 1, gets session tools)
       |-- spawn Worker 1 (depth 2)
       |-- spawn Worker 2 (depth 2)
       |-- spawn Worker 3 (depth 2)
       |-- collect results
       |-- synthesize and announce back to Main
```

### Pattern 3: Shared Blackboard

Multiple agents write to and read from a shared file or memory store:

```yaml
agents:
  researcher:
    tools: ["web", "read", "write"]
    instructions: "Research and write findings to /shared/blackboard.md"
  analyst:
    tools: ["read", "write", "exec"]
    instructions: "Read /shared/blackboard.md and produce analysis"
  coordinator:
    tools: ["read", "sessions_send"]
    instructions: "Monitor blackboard, coordinate agents"
```

### Pattern 4: Event-Driven Pipeline

Using the event bus for fully decoupled collaboration:

```
web-scraper (completes) --> event: scraping_completed
  --> data-analyst (triggered) --> event: analysis_completed
    --> report-writer (triggered) --> final output
    --> coordinator (also triggered) --> monitoring
```

### Pattern 5: Load-Balanced Agent Pool

For high-throughput scenarios:

```yaml
team:
  load_balancing:
    strategy: shortest-queue
    agent_pool:
      - web-scraper-1
      - web-scraper-2
      - web-scraper-3
    health_check:
      enabled: true
      interval: 30s
      failure_threshold: 3  # Removed from pool after 3 consecutive failures
```

---

## 6. Fallback & Resilience

Production multi-agent systems need robust error handling:

```yaml
agents:
  primary-analyst:
    model: claude-3-5-sonnet
    fallback:
      on_timeout:
        action: retry
        max_retries: 2
        backoff: exponential
      on_api_error:
        action: delegate
        fallback_agent: backup-analyst
      on_capability_mismatch:
        action: escalate
        escalate_to: coordinator
```

### Distributed Memory

Each subagent maintains only the context within its area of responsibility. The orchestrator handles cross-agent knowledge integration. This means even if the total context required far exceeds any single model's limit, the system can still function effectively.

---

## 7. Multi-Agent Streaming

Subagent results stream back to the parent through the **announce pattern**:

1. Subagent runs in its isolated session on the `subagent` lane
2. As it generates output, intermediate results can be observed via `/subagents log <id>`
3. On completion, the full result is announced to the requester channel
4. The parent agent can then process the result in its own context

For real-time monitoring of parallel subagents:

```
/subagents list              # See all active subagents
/subagents info <id>         # Check status of specific subagent
/subagents log <id> 20       # Tail last 20 log entries
/subagents steer <id> <msg>  # Redirect a running subagent
/subagents kill <id>         # Terminate a subagent
```

### QoS / Priority Control (Proposed)

There is an open feature request ([issue #33094](https://github.com/openclaw/openclaw/issues/33094)) for subagent priority control. Currently all subagents are treated equally regardless of task criticality. The proposal would allow P0 (blocking, time-sensitive) vs P3 (background, best-effort) distinction.

### Per-Agent Lane Isolation (Proposed)

When running 20+ agents on a single Gateway, all agents share the `main` lane with a global `maxConcurrent` cap. [Issue #42686](https://github.com/openclaw/openclaw/issues/42686) proposes per-agent lane isolation so long-running agents (e.g., ACP coding sessions) don't degrade response times for all other agents.

---

## 8. OpenFang Comparison: Agents as OS Processes

OpenFang takes a fundamentally different approach to multi-agent orchestration. Where OpenClaw treats agents as **in-process async tasks** managed by a lane queue, OpenFang models agents as **OS-level processes** within an Agent Operating System.

### The 7 Autonomous Hands

"Hands" are OpenFang's core innovation -- pre-built autonomous capability packages that run independently on schedules, without prompting:

| Hand | Purpose |
|------|---------|
| **Clip** | Turns video into shorts |
| **Lead** | Generates qualified leads |
| **Collector** | Monitors targets with change detection, sentiment tracking, knowledge graphs |
| **Predictor** | Forecasts with Brier scores |
| **Researcher** | Fact-checks with CRAAP methodology, generates reports |
| **Twitter/X** | Manages X account with approval queue |
| **Browser** | Automates web workflows with mandatory purchase gate |

Each Hand bundles its own agent loop, tools, and scheduling -- all compiled into a single ~32MB binary. No downloading, no pip install, no Docker pull.

### Architecture Differences

| Aspect | OpenClaw | OpenFang |
|--------|----------|---------|
| **Runtime** | Single Node.js process, async promises | Rust binary, WASM sandboxed processes |
| **Concurrency** | Lane-based FIFO queue | OS-level process isolation |
| **Agent model** | In-process subagents with session isolation | Autonomous Hands with lifecycle management |
| **Scheduling** | Cron lane + heartbeat | Native scheduler in kernel |
| **Security** | 7-layer model (auth to sandbox) | 16 security systems (WASM sandbox, Ed25519 signing, Merkle audit, taint tracking) |
| **Memory** | 200MB+ per agent | 40MB idle memory |
| **Cold start** | Seconds | <200ms |
| **Language** | TypeScript | Rust (137K lines, zero clippy warnings) |

### OpenFang Workflow Engine

OpenFang has a built-in workflow engine for multi-agent pipelines with:
- **Fan-out** step mode (parallel execution)
- **Conditional** step mode (branching logic)
- **Loop** step mode (iterative processing)

Hands are defined via `HAND.toml` files, similar to OpenClaw's `SKILL.md` but with richer lifecycle management.

### OpenFang Communication

OpenFang supports both MCP (Model Context Protocol) and A2A (Agent-to-Agent) protocol for inter-agent communication. With 140+ REST/WS/SSE endpoints, it exposes a comprehensive API for agent management, memory, workflows, and channels.

---

## 9. NemoClaw Orchestration: Privacy-Aware Routing

NemoClaw is **not** a separate multi-agent framework -- it's an enterprise wrapper around OpenClaw that adds critical infrastructure for production agent deployments.

### Privacy Router

The core NemoClaw innovation for multi-agent scenarios is the **privacy router**:

1. Agents can use **local Nemotron models** for sensitive workloads (running on-device)
2. When higher capability is needed, queries are routed to **frontier cloud models**
3. The privacy router ensures **sensitive data never reaches external endpoints**
4. Policy-based controls determine which data can flow where

```
Agent Request
  |
  v
[Privacy Router]
  |-- Sensitive query? --> Local Nemotron model (on-device)
  |-- Needs capability? --> Cloud model (data scrubbed)
  |-- Policy violation?  --> Blocked
```

### OpenShell Runtime

NemoClaw installs the **OpenShell runtime**, which provides:

- **Kernel-level sandboxing**: Linux namespaces, seccomp filters, Landlock
- **Policy engine**: Out-of-process policy constraints for filesystem, network, and process access
- **Privacy monitoring**: Watches agent communication and blocks unauthorized data transmission
- **Session isolation**: Each agent session runs in its own isolated sandbox

### Multi-Agent Security Implications

For multi-agent orchestration, NemoClaw adds:

| Concern | NemoClaw Solution |
|---------|------------------|
| Data leakage between agents | OpenShell session isolation + privacy router |
| Sensitive data to cloud | Local model routing for private queries |
| Uncontrolled agent behavior | Policy-based security guardrails |
| Agent-to-agent trust | Sandbox isolation with defined communication policies |
| Audit trail | Full logging of agent interactions and data flows |

### Deployment Targets

NemoClaw is optimized for:
- NVIDIA GeForce RTX PCs and laptops
- RTX PRO workstations
- DGX Spark and DGX Station
- Cloud deployments (with hybrid local/cloud model routing)

---

## 10. Deterministic Multi-Agent Pipelines (Lobster)

OpenClaw's workflow engine, **Lobster**, enables fully deterministic multi-agent pipelines where LLMs handle creative work and YAML workflows handle orchestration.

### Key Insight

The distinction between **deterministic orchestration** (YAML-defined flow) and **non-deterministic execution** (LLM doing the work) is critical:

- **Flow control** (which agent runs when, what data flows where) should be deterministic
- **Task execution** (research, analysis, code generation) benefits from LLM creativity

### Sub-Workflow Steps

Lobster supports sub-workflow steps with loop support, enabling patterns like:

```yaml
workflow:
  steps:
    - name: research
      agent: researcher
      input: "Research ${topic}"
    - name: review-loop
      type: sub-workflow
      loop:
        items: ${research.findings}
      steps:
        - name: review
          agent: reviewer
          input: "Review finding: ${item}"
    - name: synthesize
      agent: writer
      input: "Synthesize reviewed findings: ${review-loop.results}"
```

This enables code -> review -> test pipelines with autonomous AI agents, where the orchestration is deterministic but the execution is creative.

---

## 11. Production Scaling Lessons

### What Breaks at Scale

Real-world production deployments reveal scaling challenges:

- **GPU contention**: 12 concurrent agents on 2x A10 GPUs caused unsustainable KV-cache pressure
- **Cascading timeouts**: When inference queues internally, timeouts cascade and state stores fill with incomplete records
- **Solution**: Redis Streams as task queue with priority levels, retry logic, and dead-letter handling. Agents become pooled workers (5 warm + burst scaling on queue depth)

### Monitoring

Key metrics to watch:
- `openclaw_session_context_tokens` -- context window utilization
- p95 latency per lane
- Queue depth and saturation per lane
- Subagent spawn rate and completion rate

---

## Key Takeaways

| Dimension | OpenClaw | OpenFang | NemoClaw |
|-----------|----------|----------|----------|
| **Concurrency model** | Lane-based async FIFO | OS process isolation | OpenClaw lanes + OpenShell sandbox |
| **Agent hierarchy** | main -> subagent -> sub-subagent (depth 2 max) | Hands with lifecycle management | Same as OpenClaw with policy enforcement |
| **Communication** | sessions_send, event bus, hooks | MCP + A2A protocol, REST API | Privacy-routed agent communication |
| **Scheduling** | Cron lane + heartbeat | Native kernel scheduler | OpenClaw cron + policy controls |
| **Security** | Tool restrictions, session isolation | WASM sandbox, 16 security systems | OpenShell + privacy router + policy engine |
| **Best for** | Flexible multi-agent chat workflows | Autonomous always-on agents | Enterprise deployments with privacy requirements |

---

## References

- [OpenClaw Sub-Agents Documentation](https://docs.openclaw.ai/tools/subagents)
- [OpenClaw Command Queue Documentation](https://docs.openclaw.ai/concepts/queue)
- [OpenClaw Concurrency & Retry Control Guide](https://lumadock.com/tutorials/openclaw-concurrency-retry-control)
- [OpenClaw Reference Architecture (Feb 2026)](https://robotpaper.ai/reference-architecture-openclaw-early-feb-2026-edition-opus-4-6/)
- [OpenClaw Design Patterns Part 3: Orchestration](https://kenhuangus.substack.com/p/openclaw-design-patterns-part-3-of)
- [OpenClaw Multi-Agent: Subagents, Agent Teams & Orchestration](https://www.meta-intelligence.tech/en/insight-openclaw-multi-agent)
- [NVIDIA NemoClaw Announcement](https://nvidianews.nvidia.com/news/nvidia-announces-nemoclaw)
- [OpenShell Developer Blog](https://developer.nvidia.com/blog/run-autonomous-self-evolving-agents-more-safely-with-nvidia-openshell/)
- [OpenFang Documentation](https://openfang.sh/)
- [OpenFang GitHub](https://github.com/RightNow-AI/openfang)
- [Subagent Barrier Primitive Request (Issue #38522)](https://github.com/openclaw/openclaw/issues/38522)
- [Sub-agent QoS/Priority Control (Issue #33094)](https://github.com/openclaw/openclaw/issues/33094)
- [Per-Agent Lane Isolation (Issue #42686)](https://github.com/openclaw/openclaw/issues/42686)
- [Nested Lane Concurrency (Issue #22167)](https://github.com/openclaw/openclaw/issues/22167)
