---
title: "Self-Evolution via CodeCommit-as-Source — Pattern + CLI Decoupling"
status: canonical
date: 2026-04-24
supersedes: []
cross_links:
  - docs/runbooks/first-deploy-baladita.md
  - packages/core/src/evolution/self-evolution-orchestrator.ts
  - packages/agents/tools/evolution_tools.py
  - packages/cli/src/utils/codecommit.ts
  - infra/lib/pipeline-stack.ts
---

# Self-Evolution via CodeCommit-as-Source

**Problem this pattern solves:** how can an agent deployed in AWS
modify its own infrastructure + application code WITHOUT any
client-side tooling (no `chimera deploy`, no developer laptop) and
WITHOUT a CI/CD round-trip through GitHub/GitLab?

**Answer:** make an AWS-native Git-compatible source repository the
**canonical source of truth**, wire CodePipeline to auto-trigger on
every commit to that repo, and give both (a) the human CLI and (b)
the in-AWS agent the **same write primitive** — the CodeCommit
`CreateCommit` API. The CLI never "catches up" to agent changes
because both paths converge on the same repo.

---

## 1 · The invariants

| # | Invariant | Why it matters |
|---|-----------|---------------|
| 1 | **CodeCommit is the source of truth**, not GitHub. | A laptop with git access cannot be the SPOF. The agent never has GitHub credentials. |
| 2 | **Both writers use the same API**: `codecommit.CreateCommit` (Python + TypeScript). No local `git push`, no credential helpers. | One permission model, one auth path, one audit trail. |
| 3 | **Pipeline triggers on EventBridge rule** watching CodeCommit `referenceUpdated` events — never on GitHub webhook. | Works even if the repo has zero GitHub remote configured. |
| 4 | **Every commit message carries authorship metadata**: `Chimera Self-Evolution Agent` vs `baladita@...`. | Audit trail for "who changed what" without needing a second tracking table. |
| 5 | **Safety rails are enforced before commit** (Cedar policy, rate limit, forbidden-pattern check), not after. | A committed-but-rejected change still leaves noise in pipeline history. Block upstream. |
| 6 | **The CLI has NO exclusive writes.** Anything the CLI can commit, the agent can also commit, and vice-versa. | Keeps the two paths symmetric — no "only the CLI can do X" divergence. |

---

## 2 · The three write paths

All three use `codecommit.CreateCommit` under the hood. Same auth, same audit trail, same behaviour.

### 2a · CLI — `chimera deploy` / `chimera sync` (human in the loop)

**Entrypoint:** `packages/cli/src/utils/codecommit.ts::pushToCodeCommit()`

Batches the operator's local working tree into ≤5MB commits (CodeCommit's per-commit cap is 6MB; we leave 1MB buffer) and replays them onto the CodeCommit `main` branch via `CreateCommit`.

Key properties:

- **No local `git push`.** Uses `@aws-sdk/client-codecommit` directly.
- **Works with any AWS credential type** (IAM user, assumed role, SSO, EC2 instance profile, ECS task role). No git credential helper, no SSH key.
- **Skips files > 5MB** with a typed `SkippedLargeFile[]` warning list (categorised `iac` vs `other` so a bug that accidentally emits a 5MB CDK file fails loudly, not silently).
- **Excludes mandatory dirs** (`node_modules`, `.git`, `.overstory`, `.seeds`, `.mulch`, `dist`, …) — each exclusion is a documented correctness or size trade-off.

```typescript
// packages/cli/src/utils/codecommit.ts
export const BATCH_MAX_BYTES = 5 * 1024 * 1024;
export const BATCH_MAX_FILES = 100;
// CreateCommitCommand is called per batch; parentCommitId is threaded
// from the previous response into the next request so the batches form
// a linear chain of commits (no branch divergence).
```

### 2b · Agent — Python `trigger_infra_evolution` tool (agent in the loop)

**Entrypoint:** `packages/agents/tools/evolution_tools.py::_commit_to_codecommit()`

The agent generates CDK TypeScript code, validates it against the safety harness (Cedar policy + forbidden-pattern regex + size cap), and commits it to `infra/lib/agent-evolved/<capability>-stack.ts`. The pipeline's EventBridge rule picks up the commit and runs the full deploy.

```python
# packages/agents/tools/evolution_tools.py
def _commit_to_codecommit(repo_name, file_path, content, commit_message, region):
    codecommit = boto3.client("codecommit", region_name=region, config=_BOTO_CONFIG)
    branch_resp = codecommit.get_branch(repositoryName=repo_name, branchName="main")
    parent_commit_id = branch_resp["branch"]["commitId"]

    commit_resp = codecommit.create_commit(
        repositoryName=repo_name,
        branchName="main",
        parentCommitId=parent_commit_id,
        authorName="Chimera Self-Evolution Agent",    # <-- provenance
        email="agent@chimera.internal",
        commitMessage=commit_message,
        putFiles=[{
            "filePath": file_path,
            "fileMode": "NORMAL",
            "fileContent": content.encode("utf-8"),
        }],
    )
    return {"commit_id": commit_resp["commitId"]}
```

### 2c · Orchestrator — TypeScript `CodeCommitWorkspaceManager` (programmatic control plane)

**Entrypoint:** `packages/core/src/infra-builder/codecommit-workspace.ts::commitFiles()`

Used by `SelfEvolutionOrchestrator` to commit multi-file changes (CDK + Cedar policy + IAM wrapper). Same `CreateCommitCommand` as the CLI; the difference is it's callable from any Lambda / ECS task in the AgentCore plane without needing AWS CLI binaries.

---

## 3 · The trigger

```typescript
// infra/lib/pipeline-stack.ts (paraphrased)
new codepipeline_actions.CodeCommitSourceAction({
  actionName: 'Source',
  repository: sourceRepository,
  branch: 'main',
  output: sourceArtifact,
  // EventBridge-based trigger: auto-run pipeline on every commit
  // to main. Does NOT require GitHub webhook, Git LFS, or SSH.
  trigger: codepipeline_actions.CodeCommitTrigger.EVENTS,
});
```

When either writer (CLI or agent) lands a commit on `main`, CodeCommit emits a `referenceUpdated` event. The EventBridge rule in the Pipeline stack fires CodePipeline, which then:

1. **Source stage** — pulls the tree from CodeCommit.
2. **Build stage** — runs `bun install && bun test && bunx cdk synth`.
3. **Test stage** — integration + E2E.
4. **Deploy stage** — `npx cdk deploy --all` (see `cdk.json::app`).
5. **Rollout stage** — canary, 10% → 50% → 100% via the Canary Orchestration state machine.

Crucially, the CLI never invokes the pipeline. It doesn't know about the pipeline. It just writes to `CodeCommit`. The pipeline is what the stack deployed, and it runs itself.

---

## 4 · Why this decouples the CLI from the agent

```
┌──────────────────┐                                 ┌──────────────────┐
│  Human (CLI)     │                                 │  Agent (Python)  │
│  chimera deploy  │ ─┐                           ┌─ │  evolution_tools │
└──────────────────┘  │                           │  └──────────────────┘
                      │                           │
                      ▼                           ▼
                 ┌─────────────────────────────────────┐
                 │    codecommit.CreateCommit API      │  ← shared write primitive
                 │    (one IAM model, one audit trail) │
                 └─────────────────────────────────────┘
                                    │
                                    ▼
                 ┌─────────────────────────────────────┐
                 │  CodeCommit `main` branch           │  ← canonical source of truth
                 │  EventBridge `referenceUpdated`     │
                 └─────────────────────────────────────┘
                                    │
                                    ▼
                 ┌─────────────────────────────────────┐
                 │  CodePipeline (auto-triggered)      │  ← same pipeline for both
                 │  Source → Build → Test → Deploy →   │
                 │  Rollout (canary + progressive)     │
                 └─────────────────────────────────────┘
                                    │
                                    ▼
                 ┌─────────────────────────────────────┐
                 │  Updated infrastructure + code      │
                 └─────────────────────────────────────┘
```

Key consequence: **the CLI's feature set is NOT a gating factor for what the agent can do**. If the agent wants to add a new DynamoDB table tomorrow, it generates the CDK, commits to CodeCommit, and the pipeline deploys it — the CLI can remain ignorant.

Conversely, if the CLI gains a new command (say `chimera undeploy`), the agent can invoke the same functionality by writing the same CDK delta to CodeCommit. The CLI is just a convenience wrapper; it's never the privileged path.

---

## 5 · Boundaries the CLI still owns

The CLI does retain a small set of **bootstrap** responsibilities — things that must happen BEFORE CodeCommit exists:

| CLI-only responsibility | Why |
|-------------------------|-----|
| `chimera deploy` — **first-ever bootstrap** of CDKToolkit + PipelineStack + CodeCommit repo | You need the repo to exist before anyone can commit. |
| `chimera destroy` — teardown | Destroying the pipeline that destroys itself is awkward; the CLI delegates to a CodeBuild project (`ChimeraDestroyProject`) that runs with admin credentials. |
| `chimera doctor` — pre-flight | AWS credentials + CDK bootstrap + Bedrock model access checks. |
| `chimera setup` — Cognito admin user provisioning | Runs **once** after Security stack exists. |

Everything else (deploy updates, rollback, skills management, tenant onboarding) can be driven by either CLI or agent via CodeCommit writes.

---

## 6 · Safety rails (before any commit)

Both the CLI and the agent run checks before calling `CreateCommit`:

### CLI pre-commit

- AWS credential valid (STS GetCallerIdentity)
- CDK bootstrap exists (CDKToolkit stack present)
- File count + size limits (batch planner rejects > 5 MB)
- `chimera.toml` schema validation

### Agent pre-commit (stricter, because agents can be adversarial)

- **Kill switch check** — SSM `/chimera/evolution/self-modify-enabled/{env}` must be `true`. Ops can veto all agent evolution instantly.
- **Cedar policy check** — AWS Verified Permissions evaluates the evolution request against tenant policy + global guardrails.
- **Per-tenant rate limit** — atomic DynamoDB `UpdateItem` with `ConditionExpression` (5 evolutions per tenant per day). Wave-15 hardened this to eliminate a TOCTOU race.
- **Forbidden CDK patterns** — regex blocklist for `AdministratorAccess`, `PowerUserAccess`, `addToPolicy`, `grantAdmin`, bare `"*"` resource strings, `RemovalPolicy.DESTROY`, `.deleteTable`, `.deleteBucket`, `ec2.Vpc`, `ec2.SecurityGroup`, `addIngressRule`, `fromLookup`, etc.
- **Size cap** — 64 KB per CDK stack file.

See `packages/agents/tools/evolution_tools.py::_FORBIDDEN_CDK_PATTERNS` for the canonical list (kept in sync with the TypeScript orchestrator's `BLOCKED_CDK_PATTERNS` in `self-evolution-orchestrator.ts`).

---

## 7 · Operator recovery paths

Because the pipeline deploys what CodeCommit says, **the fix for any bad deploy is a CodeCommit revert**:

```bash
# Pull the latest CodeCommit state via the CLI's SDK path (no git clone needed).
chimera sync

# Revert the bad commit locally, then push it back via CreateCommit.
git revert <bad-commit-sha>
chimera sync   # uploads the revert as a new commit, triggering the pipeline.
```

An agent can do the exact same thing with `evolution_tools.py` — commit a revert file, pipeline redeploys.

If the pipeline itself is broken, the CLI has `chimera cleanup` + `chimera redeploy` to delete rolled-back stacks and retry. These are CLI-privileged because they predate the Pipeline stack's existence.

---

## 8 · Applying this pattern to a new project

**Prerequisites (all AWS-native):**

- CodeCommit repo with `main` branch
- CodePipeline with CodeCommit source action + `CodeCommitTrigger.EVENTS`
- CDK bootstrap in the target account/region
- Both writer paths (CLI + agent) have IAM permission to call `codecommit:GetBranch`, `codecommit:CreateCommit`, `codecommit:PutFile` on the repo ARN.

**The code to reuse:**

```
packages/cli/src/utils/codecommit.ts         # batched CreateCommit for CLI
packages/agents/tools/evolution_tools.py     # _commit_to_codecommit for agents
packages/core/src/infra-builder/codecommit-workspace.ts  # orchestrator path
```

All three are thin wrappers over `CreateCommitCommand` / `create_commit` and portable to any CDK project.

**The CDK to reuse:**

```
infra/lib/pipeline-stack.ts                  # Source + Build + Deploy + Rollout
```

The critical line is the `trigger: codepipeline_actions.CodeCommitTrigger.EVENTS` option — this is what makes commits from any authorized principal (human or agent) kick off a deploy.

---

## 9 · What this pattern is NOT

- **Not a replacement for GitHub.** The CodeCommit repo is a pure deployment surface. Source-of-record for humans remains GitHub. The CLI's `chimera upgrade` pulls GitHub `main`, cherry-picks onto CodeCommit, and preserves agent edits via a 3-way merge.
- **Not unbounded agent power.** The safety harness is non-negotiable. An agent cannot escape the Cedar policy + pattern check + rate limit trifecta.
- **Not tied to Chimera specifically.** Any AWS-native project with Bedrock/AgentCore + CDK can adopt this pattern by copying the three files above and wiring the EventBridge trigger.

---

## 10 · When NOT to use this pattern

- **GitHub Actions is already the deploy path.** Introducing CodeCommit as a second source-of-truth doubles the audit surface. Stay on GitHub Actions unless you specifically need in-AWS agent-driven deploys.
- **Multi-region writes.** CodeCommit is regional; cross-region replication is your responsibility. If you need global writes, use a GitHub/GitLab-centric flow.
- **The repo has > 2,000 files changing per commit.** CodeCommit's `CreateCommit` API has a per-request file cap (≤ 100 files in our batch pattern). Very high-churn monorepos hit this limit quickly.

---

## 11 · Cross-references

- **CLI impl:** `packages/cli/src/utils/codecommit.ts`, `packages/cli/src/commands/deploy.ts`, `packages/cli/src/commands/sync.ts`, `packages/cli/src/commands/upgrade.ts`
- **Agent impl:** `packages/agents/tools/evolution_tools.py` (`trigger_infra_evolution`, `_commit_to_codecommit`, `_check_kill_switch`, `_check_evolution_rate_limit`, `_validate_cdk_code`)
- **Orchestrator impl:** `packages/core/src/evolution/self-evolution-orchestrator.ts`, `packages/core/src/infra-builder/codecommit-workspace.ts`
- **Pipeline wiring:** `infra/lib/pipeline-stack.ts::CodeCommitSourceAction` with `CodeCommitTrigger.EVENTS`
- **Safety harness:** `packages/core/src/evolution/safety-harness.ts`, `packages/agents/tools/evolution_tools.py::_FORBIDDEN_CDK_PATTERNS`
- **Rate-limit primitive:** `packages/agents/tools/evolution_tools.py::_check_evolution_rate_limit` (atomic `UpdateItem` with `ConditionExpression`; Wave-15 H2 hardened)
- **Audit trail:** `evolution_tools.py::_record_evolution_request` writes to `chimera-evolution-state` DDB for provenance
- **Kill switch:** SSM parameter `/chimera/evolution/self-modify-enabled/{env}` — ops can disable all agent evolution instantly
- **Operator runbook:** `docs/runbooks/cdk-deploy-failure-recovery.md`
