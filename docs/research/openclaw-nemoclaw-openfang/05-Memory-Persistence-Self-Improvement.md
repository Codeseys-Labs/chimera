# Memory, Persistence & Self-Improvement in OpenClaw

> Part of the [[01-OpenClaw-Core-Architecture]] research series. See also [[04-Skill-System-Tool-Creation]] for how memory interacts with skills, and [[08-Deployment-Infrastructure-Self-Editing]] for self-editing infrastructure patterns.

## Executive Summary

OpenClaw's memory system is an **engineering hack to simulate remembering on top of a model that forgets everything**. LLMs are stateless -- they don't learn over time. OpenClaw's approach is radical in its simplicity: **plain Markdown files on disk are the source of truth**, layered with hybrid semantic search (BM25 + vector embeddings) stored in per-agent SQLite databases. The agent "remembers" only what gets written to disk and retrieved into its context window.

This is fundamentally different from model-level memory (fine-tuning) or conversation history caching. It's a **system design**, not a model capability. Human memory is weights in a neural network; OpenClaw's memory is files on disk and tricks to get them into the model's view.

---

## Memory Architecture: Three Layers

OpenClaw's memory lives in `~/.openclaw/workspace/` (configurable via `agents.defaults.workspace`) and consists of three distinct layers:

### 1. Ephemeral Memory (Daily Logs)

```
memory/YYYY-MM-DD.md
```

- **Append-only** daily logs written by the agent during conversations
- Read today + yesterday at session start (recent context window)
- Contains decisions, bug fixes, preferences, todos discovered during the day
- Automatically rotated by date -- old logs drop out of the immediate context window
- Conversation history stored in JSONL format (timestamp, role, content fields)
- This is the **short-term working memory** -- high churn, high relevance

### 2. Durable Memory (Curated Knowledge)

```
MEMORY.md
```

- Optional curated long-term memory file
- Only loaded in the main private session (never in group contexts for privacy)
- Contains stable patterns, project decisions, user preferences, key facts
- Analogous to Claude Code's `CLAUDE.md` -- persistent instructions across sessions
- The agent can (and should) edit this file to capture important learnings
- **Manual curation by the agent** is the primary mechanism -- the agent decides what's worth persisting

### 3. Session Memory

- In-context conversation history within a single session
- Subject to **context window limits and compaction**
- When the context window fills, older messages are compressed/summarized
- Critical information must be written to disk (Layer 1 or 2) before compaction truncates it

### Memory Behavior Flow

```
Session Start
    |
    v
Load MEMORY.md (if exists, main session only)
    |
    v
Load memory/today.md + memory/yesterday.md
    |
    v
[Agent processes messages]
    |
    v
On compaction trigger --> Memory Flush
    |   (agent extracts insights before truncation)
    |
    v
Write important facts to MEMORY.md or memory/today.md
    |
    v
Session End / Daily Reset (4:00 AM local)
    |
    v
New session gets fresh ID, only bootstrap files + searchable memory carry over
```

**Key insight:** Daily resets at 4:00 AM are essentially guaranteed compaction events. This is why writing to memory files matters -- sessions don't survive the daily reset, but files do.

---

## Semantic Memory Search (memorySearch)

The built-in memory search system (`memory-core` plugin) creates a vector index over memory files for semantic retrieval. This is essentially **RAG for personal agent memory**.

### What Gets Indexed

- **File types:** Markdown only (`MEMORY.md`, `memory/**/*.md`)
- **Index storage:** Per-agent SQLite at `~/.openclaw/memory/<agentId>.sqlite` (configurable via `agents.defaults.memorySearch.store.path`, supports `{agentId}` token)
- **Freshness:** File watcher on memory directory with 1.5s debounce
- **Reindex triggers:** Changes to embedding provider/model, endpoint fingerprint, or chunking params trigger automatic full reindex
- **Extra paths:** Can index additional Markdown outside the workspace via `extraPaths` config

### Hybrid Search: BM25 + Vector

The search combines two strategies:

| Strategy | Weight | Purpose |
|----------|--------|---------|
| **Vector search** | 70% (default) | Semantic similarity -- "Redis cache config" finds "Redis L1 cache with 5min TTL" |
| **BM25 keyword** | 30% (default) | Exact matching -- "PostgreSQL 16" does NOT match "PostgreSQL 15" |

This hybrid approach is critical for coding contexts where exact names (function names, error codes, version numbers) matter as much as conceptual similarity.

### Advanced Search Features

- **MMR (Maximal Marginal Relevance):** `lambda: 0.7` -- promotes diversity in results to avoid returning 8 near-identical snippets
- **Temporal decay:** `halfLifeDays: 30` -- recent notes rank higher than stale ones. A September note drops below a March note even if the September note has better raw semantic match
- **Candidate multiplier:** `4` -- expands the search pool before re-ranking for better quality

### Embedding Provider Auto-Selection

OpenClaw auto-selects the embedding provider in priority order:

1. `local` -- if `memorySearch.local.modelPath` is configured and file exists
2. `openai` -- if OpenAI key available (uses `text-embedding-3-small`)
3. `gemini` -- if Gemini key available (`gemini-embedding-001`)
4. `voyage` -- if Voyage key available
5. `mistral` -- if Mistral key available
6. Otherwise disabled until configured

**Local option:** `hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf` -- runs entirely on-device, no API calls.

### The memory_search Tool

```typescript
{
  label: "Memory Search",
  name: "memory_search",
  description:
    "Mandatory recall step: semantically search MEMORY.md + memory/*.md "
    + "(and optional session transcripts) before answering questions about "
    + "prior work, decisions, dates, people, preferences, or todos; "
    + "returns top snippets with path + lines.",
  parameters: MemorySearchSchema,
  execute: async (_toolCallId, params) => {
    const results = await manager.search(query, {
      maxResults,
      minScore,
      sessionKey: options.agentSessionKey,
    });
    return jsonResult({
      results, provider: status.provider,
      model: status.model, fallback: status.fallback,
    });
  },
}
```

Returns results with: file path, line range (start_line, end_line), relevance score, and snippet text.

### Complete Configuration Example

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "local",
        "local": {
          "modelPath": "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf"
        },
        "extraPaths": [
          "~/Documents/Obsidian/ProjectNotes/**/*.md"
        ],
        "sync": {
          "watch": true,
          "watchDebounceMs": 1500
        },
        "query": {
          "maxResults": 8,
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.7,
            "textWeight": 0.3,
            "candidateMultiplier": 4,
            "mmr": {
              "enabled": true,
              "lambda": 0.7
            },
            "temporalDecay": {
              "enabled": true,
              "halfLifeDays": 30
            }
          }
        },
        "cache": {
          "enabled": true,
          "maxEntries": 50000
        }
      }
    }
  }
}
```

### Performance Characteristics

| Metric | Value |
|--------|-------|
| OpenAI embedding throughput | ~1000 tokens/sec (batched) |
| Search latency | <100ms for 10K chunks |
| Index size | ~5KB per 1K tokens (1536-dim embeddings) |
| Token savings | 5-10x reduction vs. loading full memory files |

---

## Context Management & Auto-Compaction

### The Compaction Problem

Agent sessions run long -- context switches are constant, and information accumulates over days or weeks. When the context window fills up, older messages must be truncated. This is **compaction**.

### Memory Flush on Compaction

OpenClaw triggers a **memory flush** before compaction:

1. The agent gets a final chance to extract insights from the conversation
2. Important facts, decisions, and todos are written to `MEMORY.md` or daily log
3. Only then does the transcript get truncated
4. Skipped in read-only sandbox mode (no file write access)
5. One flush per compaction cycle to avoid spam

### Reserve Floor

The compaction system maintains a **reserve floor** (configurable, e.g., 40,000 tokens) -- a minimum amount of context that's always preserved for the current conversation, even after bootstrap files and memory injection.

### Session Transcripts

Session transcripts use **delta thresholds** to trigger background index sync -- as the conversation grows, the memory index is periodically updated with new content from the active session.

---

## Session Persistence Across Conversations

### What Survives a Session Boundary

| Persists | Does Not Persist |
|----------|-----------------|
| `MEMORY.md` content | In-context conversation history |
| `memory/*.md` daily logs | Session-specific variables |
| SQLite vector index | Ephemeral tool state |
| Agent configuration | Context window content |
| Skills and tools | Running processes |

### Daily Reset Behavior

Sessions get a **new session ID at the daily reset** (default 4:00 AM local time). This is essentially a fresh session. Only bootstrap files and searchable memory carry over. This is expected, not a bug.

**Recovery pattern for continuity:**
```
Search your memory files for yesterday's activity. What were we working on?
What decisions were made? What's still open? Summarize and let's continue.
```

### The QMD Alternative Backend

QMD (Query-Memory-Document) is an alternative memory backend that replaces the default search while keeping Markdown files as-is. It runs multiple search strategies in parallel and merges results for significantly better retrieval:

```yaml
memory:
  backend: qmd
  citations: auto
  qmd:
    includeDefaultMemory: true
    update:
      interval: 5m
      debounceMs: 15000
      onBoot: true
      waitForBootSync: false
    limits:
      maxResults: 6
      maxSnippetChars: 700
      timeoutMs: 4000
    scope:
      default: deny
      rules:
        - action: allow
          match:
            chatType: direct
```

---

## Self-Improvement: Agent Editing Its Own Config, Prompts & Skills

This is where OpenClaw gets genuinely novel. The agent can **modify its own operating parameters** -- a capability that distinguishes it from static tool-use agents.

### What the Agent Can Self-Edit

1. **MEMORY.md** -- The agent writes and curates its own long-term memory
2. **Daily logs** -- Automatic journaling of decisions and learnings
3. **Skills** -- Through the skill system ([[04-Skill-System-Tool-Creation]]), agents can write new SKILL.md files and tools
4. **Configuration** -- The agent can update its own gateway config (e.g., "enable memory search with embeddings" and the agent handles it)
5. **Prompts/Identity** -- The agent can modify its own system prompt and personality files

### The Self-Improvement Loop

```
Interaction --> Learn something new
    |
    v
Write to MEMORY.md or create new skill
    |
    v
Next session loads updated memory/skills
    |
    v
Agent behaves differently based on what it learned
    |
    v
Better interactions --> More learning
```

### Practical Self-Improvement Patterns

**Pattern 1: Bug Fix Memory**
Agent encounters and fixes a bug, writes the pattern to memory. Next time it sees a similar issue, it recalls the fix without re-discovering it.

**Pattern 2: Preference Learning**
User corrects the agent's behavior. Agent writes the correction to MEMORY.md. Future sessions respect the preference without being told again.

**Pattern 3: Skill Self-Creation**
Agent identifies a repetitive task, writes a new skill (SKILL.md + tool), and uses it in future sessions. See [[04-Skill-System-Tool-Creation]] for the full skill creation workflow.

**Pattern 4: Config Self-Tuning**
Agent can restart its own gateway, update plugin configurations, and modify search parameters based on observed performance.

### Security Implications of Self-Editing

This is also the **primary security concern** with OpenClaw (see Microsoft's security analysis):

> "A long-running agent with persistent shell access, live credentials, and the ability to rewrite its own tooling is a fundamentally different threat model than a stateless chatbot."

- Every prompt injection becomes a potential persistent state modification
- Malicious skills can be installed that survive across sessions
- Memory manipulation can alter agent behavior subtly over time
- Microsoft recommends: "Regularly review the agent's saved instructions and state for unexpected persistent rules, newly trusted sources, or changes in behavior across runs"

---

## Knowledge Base Building Over Time

### The Compounding Effect

Unlike session-based assistants, OpenClaw agents **accumulate knowledge**:

- Daily logs create a searchable history of all interactions
- MEMORY.md grows with curated insights
- The vector index expands, making retrieval more comprehensive
- Skills library grows as the agent creates new capabilities
- Configuration refines as the agent self-tunes

### Knowledge Graph Integration (Cognee Plugin)

For advanced use cases, the Cognee plugin builds a **knowledge graph** on top of memory files:

```yaml
plugins:
  entries:
    memory-cognee:
      enabled: true
      config:
        baseUrl: "http://localhost:8000"
        apiKey: "${COGNEE_API_KEY}"
        datasetName: "my-project"
        searchType: "GRAPH_COMPLETION"
        autoRecall: true
        autoIndex: true
```

After each agent run, the plugin scans memory files for changes and updates the graph. New knowledge and relationships are reflected in future queries.

### External Memory Plugins

The memory slot is **pluggable** -- several third-party systems can replace or augment `memory-core`:

| Plugin | Approach | Key Feature |
|--------|----------|-------------|
| **memory-core** (default) | SQLite + local embeddings | Zero-config, fully local |
| **QMD** | Multi-strategy hybrid search | Better retrieval quality |
| **Mem0** | Cloud/self-hosted memory service | Cross-platform memory sharing |
| **Hindsight** | Auto-inject before every response | No tool-call dependency |
| **Basic Memory** | Composited search (text + graph + tasks) | Knowledge graph + task tracking |
| **Cognee** | Knowledge graph overlay | Relationship-aware retrieval |
| **memsearch** (Milvus) | Extracted OpenClaw memory as standalone lib | Framework-agnostic, MIT licensed |

### Mem0 Integration (Auto-Recall + Auto-Capture)

Mem0 provides a fully managed memory layer:

- **Auto-Recall:** Searches Mem0 for relevant memories before every response. Even after compaction truncates the window, the next response still has access to everything learned
- **Auto-Capture:** Sends each exchange to Mem0 after the agent responds. Mem0's extraction layer determines what to persist -- new facts stored, outdated ones updated, duplicates merged
- **Scoping:** Per-agent memory boundaries with user-level and agent-level scopes
- **Self-hosted option:** Bring your own embedder (Ollama), vector store (Qdrant), and LLM (Anthropic)

```json
// openclaw.json - Mem0 cloud
{
  "memory": {
    "provider": "mem0",
    "apiKey": "your-mem0-api-key"
  }
}

// openclaw.json - Self-hosted
{
  "memory": {
    "mode": "open-source",
    "embedder": "ollama",
    "vectorStore": "qdrant",
    "llm": "anthropic"
  }
}
```

### Hindsight: Auto-Injection Without Tool Calls

Hindsight solves a practical problem: **models don't consistently use search tools**. Instead of exposing `memory_search` as a tool, Hindsight injects relevant memory into context before every agent response:

- Replaces the `memory-core` slot entirely
- Includes a **feedback loop prevention** mechanism -- strips its own `<hindsight_memories>` tags before retention to prevent exponential growth
- Uses a separate, cheaper model for memory extraction (doesn't need the primary model)

---

## RAG Integration Patterns

OpenClaw's memory system IS a RAG system -- it indexes documents, embeds them, and retrieves relevant chunks at query time. The patterns are:

### Pattern 1: Personal Knowledge RAG (Default)

```
Write to memory/*.md --> Auto-index --> Hybrid search --> Inject into context
```

This is the default behavior. Every memory file becomes part of the retrievable knowledge base.

### Pattern 2: Extended Document RAG (extraPaths)

```json
{
  "memorySearch": {
    "extraPaths": [
      "~/Documents/Obsidian/ProjectNotes/**/*.md",
      "~/Documents/specs/**/*.md"
    ]
  }
}
```

Point the memory index at external document directories. Same hybrid search, no extra install. Useful for connecting to existing Obsidian vaults or documentation.

### Pattern 3: Composited Search RAG (Basic Memory Plugin)

Three sources searched in parallel:
1. **MEMORY.md** -- text search of primary memory file
2. **Knowledge Graph** -- hybrid full-text + vector search across all notes
3. **Active Tasks** -- scans `memory/tasks/` for in-progress work

### Pattern 4: Cross-Platform RAG (Mem0)

Memory shared across OpenClaw, ChatGPT, Claude, Gemini, Perplexity -- a unified memory layer that works across all AI assistants.

---

## OpenFang Memory Comparison

OpenFang takes a fundamentally different approach to memory, reflecting its "Agent OS" philosophy vs. OpenClaw's "agent runtime" approach.

### OpenFang Memory Architecture

| Dimension | OpenClaw | OpenFang |
|-----------|----------|----------|
| **Storage** | File-based (Markdown) | SQLite + vector extensions |
| **Audit trail** | Logs | **Merkle hash-chain** (tamper-evident) |
| **Isolation** | None (agent has full filesystem) | **WASM dual-metered sandbox** |
| **State security** | Trust-based | **Taint tracking** + secret zeroization |
| **Memory footprint** | ~394MB | ~40MB |

### Merkle Audit Trail

OpenFang links all critical actions into a **verifiable audit path via a Merkle hash-chain**:

- Every agent action is cryptographically chained to previous actions
- Tamper-evident -- any modification to historical actions is detectable
- Ed25519 manifest signing for cryptographic verification
- This addresses the "memory manipulation" attack vector that OpenClaw is vulnerable to

### WASM-Isolated State

OpenFang's WASM sandbox provides **dual metering** (fuel + epoch interruption):

- Tool code runs in a secure WASM context, not directly on the host
- Memory substrate (SQLite) is verified at startup
- Workspace-confined file operations -- agents can't escape their sandbox
- Environment-cleared subprocess isolation
- 10-phase graceful shutdown ensures state consistency

### Why This Matters for Memory

OpenClaw's "files on disk" approach is elegant but **trusts the agent completely**. An OpenClaw agent with shell access can modify its own memory files arbitrarily, including:
- Injecting false memories
- Deleting inconvenient history
- Modifying its own personality/identity files

OpenFang's approach makes memory **auditable and tamper-evident** -- critical for enterprise and multi-tenant deployments.

---

## NemoClaw Memory Additions

NemoClaw (NVIDIA's security/privacy layer for OpenClaw) adds **privacy-aware memory** through the OpenShell runtime. Announced at GTC 2026 on March 16.

### Privacy Router

NemoClaw includes a **privacy router** that operates across models and data:

- Routes requests to appropriate models based on data sensitivity
- Enforces data handling policies before information reaches memory
- Prevents sensitive data (PII, credentials, proprietary information) from being persisted in plain-text memory files

### NeMo Guardrails Integration

NemoClaw wraps OpenClaw's memory system with NVIDIA NeMo Guardrails:

- **Input guardrails:** Scan incoming data before it's written to memory
- **Output guardrails:** Filter retrieved memories before injection into context
- **Topical guardrails:** Prevent the agent from storing or recalling off-limits topics
- Policy-based rules configurable per deployment

### Nemotron Models for On-Device Memory

NemoClaw bundles NVIDIA Nemotron models optimized for:
- Local embedding generation (no API calls for memory indexing)
- On-device inference for memory extraction and summarization
- Runs on RTX PCs, DGX Station, and DGX Spark

### Enterprise Memory Considerations

NemoClaw's approach addresses the enterprise gap:
- OpenClaw's memory is **local by design** -- your Mac Mini's agent doesn't know what your laptop learned
- NemoClaw adds **privacy controls** that allow memory to be shared across deployments without leaking sensitive data
- Memory audit trails for compliance
- Encrypted memory storage

---

## Storage Backends Comparison

| Backend | Storage | Embeddings | Search | Setup Complexity |
|---------|---------|------------|--------|-----------------|
| **memory-core** (default) | SQLite + Markdown | Local GGUF or API | BM25 + vector hybrid | Zero config |
| **QMD** | Markdown (unchanged) | Configurable | Multi-strategy parallel | Moderate |
| **Mem0 Cloud** | Managed cloud | Managed | Semantic + dedup | API key only |
| **Mem0 Self-Hosted** | Qdrant + Ollama | Local (Ollama) | Semantic + dedup | Docker setup |
| **Basic Memory** | SQLite + knowledge graph | Configurable | Text + graph + tasks | Plugin install |
| **Cognee** | Docker (knowledge graph) | API-based | Graph completion | Docker Compose |
| **Hindsight** | Embedded in plugin | Separate model | Auto-injection | Plugin install |
| **OpenFang** | SQLite + vec | Built-in | SQLite FTS5 | Single binary |

---

## Comparison with Claude Code Memory

Since this ADMINISTRIVIA project uses Claude Code's memory system, the comparison is directly relevant:

| Feature | Claude Code | OpenClaw |
|---------|-------------|----------|
| **Memory file** | `CLAUDE.md` (project) + auto-memory dir | `MEMORY.md` + `memory/*.md` |
| **Loaded when** | Every session start | Session start (MEMORY.md = main only) |
| **Search** | None (full file injection) | Hybrid BM25 + vector semantic search |
| **Auto-capture** | Manual (agent writes to memory dir) | Memory flush on compaction + daily logs |
| **Token cost** | Full file every message | ~1.5-2K tokens per search (targeted) |
| **Cross-session** | Yes (file-based) | Yes (file-based + indexed) |
| **Self-editing** | Agent can write to memory dir | Agent can edit all files + config + skills |
| **Truncation** | 200 lines in MEMORY.md | Compaction with reserve floor |
| **Plugins** | None | Pluggable memory slot (6+ options) |

The key difference: Claude Code loads the entire MEMORY.md into context every time, which scales poorly. OpenClaw's semantic search retrieves only relevant snippets, saving 5-10x on token usage as memory grows.

---

## Code Examples

### Checking Memory Status

```bash
# Check memory index health
openclaw memory status --deep

# Force reindex all memory files
openclaw memory index --force

# Search memory from CLI
openclaw memory search "deployment decisions"
openclaw memory search --query "authentication" --max-results 20

# Check specific agent's memory
openclaw memory status --agent main --json
```

### Enabling Memory Search in Config

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "openai",
        "query": {
          "hybrid": {
            "enabled": true,
            "vectorWeight": 0.7,
            "textWeight": 0.3
          }
        }
      }
    }
  }
}
```

### First-Class Persistence (Proposed in Issue #39885)

The community has proposed native session memory that eliminates the MEMORY.md workaround:

```json
{
  "agents": {
    "defaults": {
      "memory": {
        "enabled": true,
        "maxEntries": 1000,
        "consolidation": "nightly",
        "searchProvider": "ollama"
      }
    }
  }
}
```

Key proposed capabilities:
1. Automatic persistence -- agent remembers facts without manual MEMORY.md maintenance
2. Semantic search -- retrieve by meaning, not keyword
3. Consolidation -- automatic summarization as memory grows
4. Scoping -- per-agent memory boundaries
5. User control -- explicit save, delete, list commands

---

## Building Self-Improving Agents on OpenClaw

Scott Martinis' reverse-engineering of OpenClaw identified four unique capabilities:

1. **Generally capable** -- research, code, problem-solve
2. **Persistent memory and identity** -- feels like talking to the same person for weeks
3. **Autonomous** -- acts like an employee, wakes up, engages, doesn't just wait
4. **Coordination** -- multiple agents working together

The self-improvement architecture he built (MVP):
- **Slack integration** -- @ mention the agent, it responds via GitHub Actions
- **Expanded memory architecture** -- identity files + deep reference + daily logs
- **Channel awareness and daily heartbeat** -- cron jobs that wake the agent up
- **Agent identity that persists across sessions**

The key insight: **Everything goes into files** -- workspace files, chat logs in structured architecture. Semantic search with embeddings + keywords makes memory reliable. Memory workflows survive compaction because important information is written to disk before truncation.

---

## Key Takeaways for AWS-Native Architecture

When designing an AWS-native equivalent (see [[08-Deployment-Infrastructure-Self-Editing]]):

1. **Memory should be file-based with semantic search** -- OpenClaw proves that simple Markdown + SQLite + embeddings is sufficient for powerful memory
2. **Pluggable memory backends** are essential -- different use cases need different storage (S3 for durability, DynamoDB for low-latency, OpenSearch for semantic search)
3. **Compaction-aware memory flush** is critical -- agents must write important context to durable storage before context windows are truncated
4. **Self-editing is powerful but dangerous** -- NemoClaw's guardrails and OpenFang's Merkle audit trail are necessary for production deployments
5. **Hybrid search (BM25 + vector) outperforms pure semantic search** for coding and technical contexts
6. **Auto-recall beats tool-based recall** -- models don't consistently call memory_search tools; injecting memory before responses is more reliable (Hindsight pattern)
7. **Privacy-aware memory** (NemoClaw's approach) is required for enterprise -- plain-text memory files with sensitive data are a compliance risk

---

## References

- [OpenClaw Memory Docs](https://docs.openclaw.ai/concepts/memory)
- [OpenClaw Memory CLI](https://docs.openclaw.ai/cli/memory)
- [memsearch -- Extracted OpenClaw Memory (Milvus/Zilliz)](https://milvus.io/blog/we-extracted-openclaws-memory-system-and-opensourced-it-memsearch.md)
- [Mem0 Memory Plugin for OpenClaw](https://mem0.ai/blog/mem0-memory-for-openclaw)
- [NemoClaw Announcement (NVIDIA GTC 2026)](https://nvidianews.nvidia.com/news/nvidia-announces-nemoclaw)
- [OpenFang Agent OS](https://openfang.sh)
- [Microsoft Security Analysis of OpenClaw](https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk/)
- [OpenClaw Issue #39885: Native Session Memory](https://github.com/openclaw/openclaw/issues/39885)
- [OpenClaw memorySearch Complete Guide](https://dev.to/czmilo/2026-complete-guide-to-openclaw-memorysearch-supercharge-your-ai-assistant-49oc)
- [OpenClaw Memory Masterclass (VelvetShark)](https://velvetshark.com/openclaw-memory-masterclass)
- [OpenClaw Memory Deep Dive (Avasdream)](https://avasdream.com/blog/openclaw-memory-system-deep-dive)
- [NVIDIA OpenShell Developer Blog](https://developer.nvidia.com/blog/run-autonomous-self-evolving-agents-more-safely-with-nvidia-openshell/)
