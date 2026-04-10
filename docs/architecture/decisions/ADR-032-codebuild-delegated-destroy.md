# ADR-032: Delegate Stack Destruction to CodeBuild

## Status

Accepted (2026-04-10)

## Context

The `chimera destroy` command was directly orchestrating CloudFormation stack deletion via the `DeleteStack` API. This approach had fundamental problems:

1. **Hardcoded stack ordering** — The CLI maintained a `STACK_DESTROY_ORDER` array of 15 stack names. If the agent self-evolved and added new stacks (via the Evolution module or IaC Modifier), the CLI's destroy order would be stale and miss them entirely.

2. **Duplicated dependency resolution** — CDK already knows the full stack dependency graph (via `addDependency()` edges in the CDK app). The CLI was reimplementing this in reverse, which was error-prone — we hit the Discovery→Frontend export ordering bug multiple times.

3. **Separation of concerns violation** — The CLI creates the bootstrap infrastructure (CodeCommit + Pipeline stack). The Pipeline's CodeBuild project deploys the application stacks. But the CLI was reaching past the bootstrap to directly manipulate application stacks it didn't create.

4. **Cleanup complexity** — DynamoDB deletion protection, S3 bucket emptying (including access log buckets), ECR image cleanup, and Cognito user pool deletion all needed explicit handling per-stack in the CLI. This cleanup logic grew with every new stack feature.

## Decision

Restructure `chimera destroy` into a 3-phase lifecycle that mirrors `chimera deploy`:

### Deploy lifecycle:

1. CLI creates CodeCommit repo + Pipeline stack (bootstrap)
2. CodePipeline/CodeBuild runs `cdk deploy --all` (application stacks)

### Destroy lifecycle:

1. CLI triggers a standalone CodeBuild build using `buildspec-destroy.yml` — this runs `cdk destroy --all --force --exclusively` on all application stacks except Pipeline
2. CLI deletes the Pipeline CFN stack (bootstrap infrastructure)
3. CLI deletes the CodeCommit repository

The key insight: **the CLI only manages what it creates**. CodeBuild handles destroying everything CodeBuild deployed.

### Implementation Details

- **buildspec-destroy.yml** — New buildspec that:
  1. Disables DynamoDB deletion protection on all `chimera-*` tables via `aws dynamodb update-table`
  2. Empties all `chimera-*` S3 buckets (including versioned objects and access log buckets) via `aws s3api`
  3. Runs `npx cdk destroy` on 14 explicit stack names with `--force --exclusively`

- **StartBuild with overrides** — The Deploy CodeBuild project is a `PipelineProject`. To trigger it standalone, the CLI uses `StartBuild` with:
  - `buildspecOverride: 'buildspec-destroy.yml'`
  - `sourceTypeOverride: 'CODECOMMIT'` (pulls from the Chimera repo)
  - `artifactsOverride: { type: 'NO_ARTIFACTS' }` (destroy produces no output)

- **IAM** — The Deploy project's role was granted `codecommit:GitPull` on the Chimera repo to enable standalone execution outside the pipeline.

- **Fallback** — If CodeBuild fails, the CLI falls back to direct `DeleteStack` API calls on remaining stacks (the old approach, but only as a safety net).

## Consequences

### Positive

- **Self-evolution safe** — If Chimera's agent adds stacks via the Evolution module, CDK destroy handles them automatically. No CLI update needed.
- **Single source of truth** — CDK resolves the dependency graph once, used for both deploy and destroy.
- **DDB/S3 cleanup in CodeBuild** — The cleanup runs in the same environment that created the resources, with the same IAM permissions.
- **CLI simplicity** — The CLI's destroy command dropped from 819 lines to 500 lines, with most of the reduction in the hardcoded stack ordering and per-stack cleanup logic.

### Negative

- **Longer destroy time** — CodeBuild startup adds ~2 minutes (install Bun, install deps). Total destroy time is ~30 minutes vs ~25 minutes with direct API calls.
- **CodeBuild must be functional** — If the Deploy CodeBuild project is broken (e.g., IAM misconfiguration), the destroy fails. The fallback mitigates this.
- **buildspec-destroy.yml must stay in sync** — The list of 14 stack names in the buildspec must match the CDK app. However, using `--all` with CDK destroy would also destroy the Pipeline stack (which owns the CodeBuild project running the destroy), creating a chicken-and-egg problem. The explicit list avoids this.

### Risks

- The `--exclusively` flag prevents CDK from pulling in dependency stacks. If a stack has a required dependency that's already been destroyed by a previous `cdk destroy` invocation, CDK may fail. This hasn't been observed in practice because CDK processes destroys in reverse dependency order.

## Alternatives Considered

1. **`cdk destroy --all` from CLI** — Would require the CLI to have CDK installed and the full source code available. Breaks the principle that the CLI only manages bootstrap resources.

2. **Add a "Destroy" stage to CodePipeline** — Rejected because CodePipeline stages are static. You can't dynamically inject a destroy stage, and the pipeline would need a way to receive "please destroy" signals. Also, the pipeline itself needs to be destroyed, creating a circular dependency.

3. **Lambda-based destroy orchestrator** — A Step Functions workflow or Lambda that runs `cdk destroy`. Adds complexity (another CDK construct, IAM role, etc.) for no benefit over reusing the existing Deploy CodeBuild project.

4. **Keep the direct API approach** — Continue using `DeleteStack` with hardcoded ordering. Rejected because it doesn't handle self-evolved stacks and requires constant maintenance of the ordering array.

## References

- `packages/cli/src/commands/destroy.ts` — Destroy command implementation
- `buildspec-destroy.yml` — CodeBuild destroy buildspec
- `infra/lib/pipeline-stack.ts:354` — Deploy project `codecommit:GitPull` grant
- ADR-013 — CodeCommit + CodePipeline as deployment mechanism
