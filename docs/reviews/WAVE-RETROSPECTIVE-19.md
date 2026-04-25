---
title: "Wave 19 Retrospective — Wave-17 + Wave-18 burndown → v0.6.3 release"
status: retrospective
date: 2026-04-25
wave: 19
previous: WAVE-RETROSPECTIVE-18.md
---

# Wave 19 Retrospective

**Dates:** 2026-04-25
**Outcome:** 8 commits landed on `main`. Closed all 5 remaining Wave-17
security-ops findings (C-1, H-1, H-2, M-1, M-2) + both Wave-18 carryovers
(I1, I4). No new CRITICAL or HIGH findings surfaced during the wave.
v0.6.3 release tagged. Backlog reached zero for both Wave-17 security-ops
and Wave-18.

## Commits this wave (8)

1. `3765d6b` docs(runbooks): add 3 alarm runbook entries (Wave-18 I4)
2. `e7bba77` fix(chat-gateway): re-enable CI tests by fixing Bun mock pollution (Wave-18 I1)
3. `df5aa16` docs(architecture): accept DAX AWS-managed key limitation + CMK coverage matrix (Wave-17 C-1)
4. `26af584` fix(infra): named aliases + RETAIN for all DDB table CMKs (Wave-17 H-1)
5. `37b20d4` fix(api): encrypt API Gateway access log groups with platform CMK (Wave-17 M-1)
6. `f98b786` fix(pipeline): IMMUTABLE ECR image tags + drop :latest from buildspec (Wave-17 M-2)
7. `b710063` fix(infra): wrap ALB access log bucket in ChimeraBucket (Wave-17 H-2)
8. `d086284` release: v0.6.3

## Backlog delta

| Category | Wave 18 end | Wave 19 end | Δ |
|----------|-------------|-------------|-----|
| Wave-17 security-ops CRITICAL | 1 (C-1) | 0 | -1 ✅ |
| Wave-17 security-ops HIGH | 2 (H-1, H-2) | 0 | -2 ✅ |
| Wave-17 security-ops MEDIUM | 2 (M-1, M-2) | 0 | -2 ✅ |
| Wave-18 HIGH carryovers | 2 (I1, I4) | 0 | -2 ✅ |
| **Total Wave-17+18 open** | **7** | **0** | **-7 ✅** |
| Wave-19 new findings (HIGH+) | — | 0 | 0 |

## Key decisions

### C-1 DAX CMK reclassified from CRITICAL to ACCEPTED

Research via AWS docs (`docs/amazondynamodb/.../EncryptionAtRest.html`)
and the `AWS::DAX::Cluster` CloudFormation schema confirmed: **DAX does
not support customer-managed KMS keys**. The resource's `SSESpecification`
only exposes `SSEEnabled: boolean` — no `KmsKeyId` field. Per AWS: "When
creating a new DAX cluster with encryption at rest enabled, an AWS
managed key is used."

This reclassifies the finding from "CRITICAL — fix with CMK" to "ACCEPTED
— documented limitation." Mitigations documented in the new
`docs/architecture/cmk-coverage.md`:

- DAX is in isolated VPC subnets (no public route).
- Security-group ingress scoped to chat-gateway task SG only.
- The 6 underlying DynamoDB tables still use per-table CMKs; a data
  exfiltration attack would target DDB, not DAX.
- Main SOC-2 CC6.1 gap: no CloudTrail `kms:Decrypt` audit trail for
  cached data. Partially compensated by DDB CMK CloudTrail events for
  writes.

### M-2 ECR IMMUTABLE required dropping `:latest` from buildspec

IMMUTABLE and `docker push $REPO:latest` are incompatible — the second
push would fail. Buildspec now pushes only the git-SHA tag; pipeline
consumers already use `$CHAT_GATEWAY_IMAGE_URI` / `$AGENT_IMAGE_URI`
(SHA-tagged) for downstream ECS references. Rollback targets the prior
SHA. No functional regression.

### H-2 ALB logs: extended ChimeraBucket rather than duplicating

The ALB log bucket was already hardened (block-public-access, SSL,
30-day lifecycle, KMS_MANAGED) but bypassed ChimeraBucket because the
construct hardcoded CMK encryption, which AWS ELB does not support.
Extended ChimeraBucket with an `encryptionMode: 'cmk' | 'aws-managed'`
prop (defaults to 'cmk'). This preserves the strict CMK-required
default for tenant / platform data while providing a single audited
escape hatch for AWS-service-limited cases (today: ALB logs; future:
NLB logs, CloudFront real-time logs).

### I1 CI: "CJS/ESM" diagnosis was wrong

Subagent investigation root-caused the chat-gateway CI exclusion to a
Bun `mock.module` pollution bug — not an `@aws-sdk/lib-dynamodb`
compatibility issue. The mock in `persistence-session.test.ts` only
exposed 4 command classes; Bun's mock.module is process-global and
persists across test files in the same run; later route tests imported
`@chimera/core` which transitively imports `QueryCommand` and hit the
cached incomplete mock. Fix: expose every command class the codebase
uses. 178 previously-excluded tests now run on every PR (224 pass
total after the fix).

**Lesson captured:** Bun mock.module is process-wide. Always enumerate
ALL exports a module surfaces, not just the ones the current test needs.

## Cross-cutting observations

### Concurrent-review pattern worked well

Dispatched a read-only code-reviewer agent at the start of the wave to
audit the pre-wave baseline. Agent produced a 7-finding checklist that
exactly matched what main-thread implementation closed. Using a baseline
audit as an acceptance checklist is cleaner than mid-wave reviewer
notifications — less context-switching.

Limitation: the code-reviewer subagent type has only Read/WebFetch/TaskStop
— no Write. Main thread had to transcribe the findings to disk.
Worth noting for future wave design: if you want the reviewer to write
its own file, use `general-purpose` instead.

### Test-assertion updates required for every CDK invariant change

Every CDK change with a test assertion required a paired test update:

- H-1 (aliases): data-stack test `KMS::Alias count 1 → 6`, added per-alias
  name assertions
- M-2 (IMMUTABLE): pipeline-stack test `ImageTagMutability MUTABLE →
  IMMUTABLE`, added both-repos assertion

This is healthy — the tests caught the intent mismatch immediately — but
worth noting that CDK-test maintenance is ~30% of the work on
invariant-level security changes.

### AWS docs MCP was load-bearing for C-1 decision

Without `mcp__aws-knowledge-mcp-server`, the DAX-doesn't-support-CMK
constraint would have required either a broken deploy (discovering at
`cdk deploy` time that the synth fails), or manual doc spelunking. The
MCP search returned the definitive answer in one query. Pattern worth
repeating: ALWAYS verify AWS service support before writing the fix.

## Deploy state

- 14/14 stacks still live in `baladita+Bedrock-Admin`
- 623 infra tests pass; typecheck clean
- CHANGELOG updated; README install-line + status bumped to v0.6.3
- No production regression in this wave
- v0.6.3 tag ready

## Wave 20 candidates

The Wave-17 security-ops backlog is empty. Wave-18 carryovers are empty.
Wave-19 introduced zero new HIGH findings. Remaining work items are
strategic, not tactical:

1. **"Close the GTM loop"** (Wave-17 strategic): signup flow, Stripe
   integration, admin UI CRUD (tenant/user/key/skill management).
   Multi-week initiative.
2. **chimera-0092 + chimera-2087**: end-to-end chat validation + CLI
   integration test scripts, both blocked on first real tenant deploy.
3. **chimera-b7af**: remove `strands-agents.ts` shim once the package
   publishes to npm.
4. **chimera-76b9**: LLM-based task decomposer (current is heuristic).
5. **Wave-17 L-1**: ALB→ECS plaintext leg. VPC-internal, PCI-DSS/HIPAA
   would flag. Deferrable; requires ACM Private CA.

Suggest Wave 20 picks #1 (GTM loop) as the primary track — all tactical
hardening is done, so the product can now move on customer-facing
surface area.

## References

- `docs/reviews/wave19-concurrent-review.md` — acceptance checklist
- `docs/reviews/wave19-chat-gateway-ci-investigation.md` — I1 root cause
- `docs/architecture/cmk-coverage.md` — canonical CMK matrix + C-1 mitigations
- `CHANGELOG.md` §v0.6.3
