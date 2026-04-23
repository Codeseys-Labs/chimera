# Canary Deployment Rollback

> Abort + rollback playbook for a failing canary deployment in the `chimera-deploy-${env}` CodePipeline

**Last Updated:** 2026-04-22
**Audience:** Release managers, on-call engineers, platform team
**Severity class:** SEV1 (rollout already past 50%, production impact) / SEV2 (canary bake failure, pre-rollout)
**SLA:** Decision to halt within **5 minutes** of first bad signal; rollback complete within **15 minutes**
**Related:** [Deployment Runbook](./deployment.md), [CDK Deploy Failure Recovery](./cdk-deploy-failure-recovery.md), [Alarm Runbooks](./alarm-runbooks.md), [Incident Response](./incident-response.md)

---

## When to Use This Runbook

- `CanaryBakeValidation` Lambda reports `status: FAIL` during the bake window (the `Rollout` pipeline stage's Step Functions state machine emits this on a `FAIL` choice-path)
- A CloudWatch alarm fires during the bake window: `Chimera-Pipeline-ErrorRate-${env}` or `Chimera-Pipeline-Latency-${env}` (see `infra/lib/pipeline-stack.ts` lines 1350–1383)
- Progressive rollout (`Rollout25Percent` → `Rollout50Percent` → `Rollout100Percent`) detects a regression in the 15-minute inter-step wait windows
- A customer-facing SLI (chat-gateway 5xx, agent runtime error budget) drifts after the 100% rollout completes
- A compliance / security issue is discovered in the shipped image post-deploy (CVE, leaked secret, etc.)

**Do NOT use for:**
- CDK synth or CFN stack failures before the Rollout stage — see [cdk-deploy-failure-recovery.md](./cdk-deploy-failure-recovery.md)
- Runtime incidents unrelated to a deploy — see [incident-response.md](./incident-response.md)
- Data-plane corruption — see [ddb-pitr-restore.md](./ddb-pitr-restore.md)

---

## Pipeline Topology Quick Reference

The CI/CD pipeline `chimera-deploy-${env}` (defined `infra/lib/pipeline-stack.ts` lines 1256–1343) has 5 stages:

| # | Stage | Action | What canary runs here |
|---|-------|--------|-----------------------|
| 1 | `Source` | CodeCommit | — |
| 2 | `Build` | CDK synth + Docker build (parallel) | — |
| 3 | `Deploy` | `Cdk_Deploy` + `Frontend_Deploy` | — |
| 4 | `Test` | Integration + E2E | — |
| 5 | `Rollout` | `Canary_Orchestration` Step Functions | **Canary bake + progressive rollout runs here** |

The Rollout stage invokes the state machine `chimera-canary-orchestration-${env}` (pipeline-stack.ts line 1229). State machine flow:

```
DeployCanary → WaitCanaryBake → ValidateCanary → Choice(PASS/FAIL)
                                                   ├── PASS: Rollout25 → Wait15m → Rollout50 → Wait15m → Rollout100 → Success
                                                   └── FAIL: Rollback → Fail
```

- **Prod bake duration:** 30 min (`pipeline-stack.ts` line 1065)
- **Staging bake duration:** 10 min
- **Dev bake duration:** 2 min
- **Prod progressive waits:** 15 min between 25% / 50% / 100%
- **Staging progressive wait:** 5 min between 25% / 100%

## Canary Validation Thresholds

From `CanaryBakeValidationFunction` (pipeline-stack.ts lines 807–812):

| Metric | CloudWatch metric | Threshold |
|--------|------------------|-----------|
| Error rate | `AgentPlatform/Errors / Invocations` | `< 5.0%` |
| P99 latency | `AgentPlatform/InvocationDuration` (p99) | `< 30000 ms` |
| Guardrail trigger rate | `AgentPlatform/GuardrailTriggers / Invocations` | `< 10.0%` |
| Eval composite score | `AgentPlatform/EvaluationCompositeScore` | `>= 80` |

Breach **any one** → Lambda returns `{status: FAIL, recommendation: ROLLBACK}` and the Choice state routes to `RollbackDeployment`.

---

## Step 1 — Confirm the failure signal (within 5 min)

### 1a. Find the pipeline execution in distress

```bash
export ENV=prod
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# Most recent executions
aws codepipeline list-pipeline-executions \
  --pipeline-name chimera-deploy-${ENV} \
  --max-items 5 \
  --query 'pipelineExecutionSummaries[].{Id:pipelineExecutionId,Status:status,Start:startTime,Stage:stopTrigger.triggeredBy}' \
  --output table
```

### 1b. Inspect the Rollout stage's Step Functions execution

```bash
# Get the active state machine execution
export SM_ARN=arn:aws:states:us-west-2:${ACCOUNT}:stateMachine:chimera-canary-orchestration-${ENV}

aws stepfunctions list-executions \
  --state-machine-arn ${SM_ARN} \
  --max-results 5 \
  --query 'executions[].{Name:name,Status:status,Start:startDate,Arn:executionArn}' \
  --output table

export EXEC_ARN=<execution-arn>

# Full history — find the first failed state
aws stepfunctions get-execution-history \
  --execution-arn ${EXEC_ARN} \
  --reverse-order \
  --max-results 50 \
  --query 'events[?type==`TaskFailed` || type==`ExecutionFailed` || type==`TaskStateExited`].{Id:id,Type:type,Time:timestamp}' \
  --output table
```

### 1c. Pull the CanaryBakeValidation output

The validation result is at `$.validation.Payload` in state-machine state (pipeline-stack.ts line 1086 sets `resultPath: '$.validation'`). The Choice state checks `$.validation.Payload.status == 'FAIL'` (line 1206).

```bash
# Extract the validation Lambda output
aws stepfunctions get-execution-history \
  --execution-arn ${EXEC_ARN} \
  --query 'events[?stateEnteredEventDetails.name==`CheckCanaryHealth`] | [0].stateEnteredEventDetails.input' \
  --output text | jq '.validation.Payload'
```

Expected output on failure:

```json
{
  "status": "FAIL",
  "metrics": {
    "errorRate": 8.3,
    "p99Latency": 45000,
    "guardrailRate": 2.1,
    "evalScore": 72.5,
    "totalInvocations": 1240
  },
  "recommendation": "ROLLBACK"
}
```

### 1d. Cross-check with CloudWatch alarms

```bash
aws cloudwatch describe-alarms \
  --alarm-names "Chimera-Pipeline-ErrorRate-${ENV}" "Chimera-Pipeline-Latency-${ENV}" \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue,Reason:StateReason,Updated:StateUpdatedTimestamp}' \
  --output table
```

### 1e. Determine which rollout stage was active

```bash
# Check current ALB listener weights to infer rollout phase
export ALB_LISTENER_ARN=$(aws cloudformation describe-stacks \
  --stack-name Chimera-${ENV}-Chat \
  --query "Stacks[0].Outputs[?OutputKey=='AlbListenerArn'].OutputValue" \
  --output text)

aws elbv2 describe-listeners --listener-arns ${ALB_LISTENER_ARN} \
  --query 'Listeners[0].DefaultActions[0].ForwardConfig.TargetGroups[].{Arn:TargetGroupArn,Weight:Weight}' \
  --output table
```

Interpretation:
- `canary:0, stable:100` → pre-rollout (bake failed; in-orchestration rollback may have already fired)
- `canary:25, stable:75` → 25% rollout active
- `canary:50, stable:50` → 50% rollout active
- `canary:100, stable:0` → Fully rolled out; regression detected post-bake

---

## Step 2 — Halt the pipeline (within 5 min of Step 1)

### 2a. Stop the Step Functions execution if still running

If the state machine is still executing (e.g., mid-rollout wait), abort it:

```bash
aws stepfunctions stop-execution \
  --execution-arn ${EXEC_ARN} \
  --error "ManualAbort" \
  --cause "Operator aborted canary at $(date -u +%Y-%m-%dT%H:%M:%SZ) — see incident ${INCIDENT_ID}"
```

The abort triggers the `rollbackTask.addCatch(deploymentFailed)` handler (pipeline-stack.ts line 1214). BUT — if the execution is in a `Wait` state, the rollback handler is not invoked automatically. Proceed to Step 3 manually.

### 2b. Disable pipeline transitions to prevent retry

```bash
aws codepipeline disable-stage-transition \
  --pipeline-name chimera-deploy-${ENV} \
  --stage-name Rollout \
  --transition-type Inbound \
  --reason "Incident ${INCIDENT_ID} — canary rollback in progress"
```

### 2c. Post in `#chimera-incidents`

```
SEV[1|2] CANARY-ROLLBACK
IC: @<handle>
Pipeline execution: <exec-id>
Failure phase: [bake | 25% | 50% | 100% | post-rollout]
Image URI: <ecr-uri>
Current ALB state: canary=<X>% stable=<Y>%
Rollback starting: <UTC>
```

---

## Step 3 — Invoke the RollbackFunction Lambda

The Rollback Lambda is pre-provisioned in `pipeline-stack.ts` lines 918–1051. It:

1. Reads stable image URI from S3 (`deployments/latest-stable-metadata.json` written by `Rollout100Percent` at line 876–889)
2. Reverts ALB listener weights to `stable=100, canary=0` (lines 957–965)
3. Re-registers the canary ECS task definition with the stable image (lines 967–994)
4. Writes a rollback log to S3 `rollback-logs/<request-id>.json` (lines 997–1011)

### 3a. Invoke directly

```bash
export ROLLBACK_FN=chimera-rollback-${ENV}

aws lambda invoke \
  --function-name ${ROLLBACK_FN} \
  --cli-binary-format raw-in-base64-out \
  --payload "{
    \"reason\": \"Canary validation FAIL — errorRate 8.3%, p99 45s\",
    \"failedImageUri\": \"<canary-ecr-uri>\",
    \"fallbackImageUri\": \"<if-s3-metadata-missing>\"
  }" \
  /tmp/rollback-output.json

cat /tmp/rollback-output.json | jq .
```

Expected response:

```json
{
  "status": "ROLLBACK_COMPLETE",
  "rolledBackAt": "2026-04-22T15:30:00.000000",
  "stableImageUri": "<ecr-uri>:v1.2.3",
  "previousDeploymentId": "<uuid>",
  "trafficAllocation": {"canary": 0, "production": 100},
  "rollbackLogKey": "rollback-logs/<uuid>.json"
}
```

### 3b. If the RollbackFunction fails (S3 metadata missing, ECS update errors)

The Lambda logs useful context on failure:

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/${ROLLBACK_FN} \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern '"ERROR" OR "Warning:"'
```

Common failure modes:
- **"Warning: ECS service rollback failed"** — ECS task update hit a 409. Run Step 4 manually.
- **Exception reading `latest-stable-metadata.json`** — No previous successful deploy in S3. Use Step 4a with a pinned fallback image URI.

---

## Step 4 — Manual rollback (when Lambda fails or for post-100% regression)

Use this path if:
- The RollbackFunction returned an error
- The regression was detected AFTER `Rollout100Percent` completed (so S3 has the bad image as "latest-stable")
- You need to pin to a specific prior version

### 4a. Identify the last-known-good image URI

```bash
export ARTIFACT_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name Chimera-${ENV}-Pipeline \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue" \
  --output text)

# Current "stable" as promoted by the most recent successful rollout
aws s3 cp s3://${ARTIFACT_BUCKET}/deployments/latest-stable-metadata.json - | jq .
```

If `latest-stable-metadata.json` now points at the bad image (post-100% regression case), look at the previous rollback logs or query ECR:

```bash
export ECR_REPO=$(aws cloudformation describe-stacks \
  --stack-name Chimera-${ENV}-Pipeline \
  --query "Stacks[0].Outputs[?OutputKey=='ChatGatewayEcrRepositoryUri'].OutputValue" \
  --output text)

# Recent images, newest first
aws ecr describe-images \
  --repository-name $(basename ${ECR_REPO}) \
  --query 'sort_by(imageDetails,& imagePushedAt)[-10:].[imageTags,imagePushedAt,imageDigest]' \
  --output table
```

Pick the image **before** the one that started the incident.

### 4b. Revert the ALB listener

```bash
export STABLE_TG=$(aws elbv2 describe-listeners --listener-arns ${ALB_LISTENER_ARN} \
  --query 'Listeners[0].DefaultActions[0].ForwardConfig.TargetGroups[?Weight>`0`] | [0].TargetGroupArn' \
  --output text)
export CANARY_TG=$(aws elbv2 describe-listeners --listener-arns ${ALB_LISTENER_ARN} \
  --query 'Listeners[0].DefaultActions[0].ForwardConfig.TargetGroups[?TargetGroupArn!=`'${STABLE_TG}'`] | [0].TargetGroupArn' \
  --output text)

aws elbv2 modify-listener \
  --listener-arn ${ALB_LISTENER_ARN} \
  --default-actions "Type=forward,ForwardConfig={TargetGroups=[
    {TargetGroupArn=${STABLE_TG},Weight=100},
    {TargetGroupArn=${CANARY_TG},Weight=0}
  ]}"
```

### 4c. Pin the canary ECS service to the stable image

```bash
export ECS_CLUSTER=$(aws cloudformation describe-stacks \
  --stack-name Chimera-${ENV}-Chat \
  --query "Stacks[0].Outputs[?OutputKey=='EcsClusterName'].OutputValue" \
  --output text)
export CANARY_SVC=$(aws cloudformation describe-stacks \
  --stack-name Chimera-${ENV}-Chat \
  --query "Stacks[0].Outputs[?OutputKey=='EcsCanaryServiceName'].OutputValue" \
  --output text)
export GOOD_IMAGE=<ecr-uri-from-4a>

# Describe current task definition
CURRENT_TD=$(aws ecs describe-services \
  --cluster ${ECS_CLUSTER} --services ${CANARY_SVC} \
  --query 'services[0].taskDefinition' --output text)

aws ecs describe-task-definition \
  --task-definition ${CURRENT_TD} \
  --query 'taskDefinition' > /tmp/td.json

# Patch the essential container's image
jq --arg img "${GOOD_IMAGE}" '
  .containerDefinitions |= map(if .essential then .image = $img else . end)
  | {family, containerDefinitions, networkMode, requiresCompatibilities, cpu, memory, executionRoleArn, taskRoleArn, volumes}
  | with_entries(select(.value != null))
' /tmp/td.json > /tmp/td-rollback.json

# Register new revision
NEW_TD=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/td-rollback.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)

# Force new deployment
aws ecs update-service \
  --cluster ${ECS_CLUSTER} \
  --service ${CANARY_SVC} \
  --task-definition ${NEW_TD} \
  --force-new-deployment
```

### 4d. Wait for ECS service stable

```bash
aws ecs wait services-stable \
  --cluster ${ECS_CLUSTER} \
  --services ${CANARY_SVC}
```

---

## Step 5 — Verify ALB health + traffic

### 5a. Target group health + traffic split

```bash
# Stable MUST have healthy targets
aws elbv2 describe-target-health --target-group-arn ${STABLE_TG} \
  --query 'TargetHealthDescriptions[].{Id:Target.Id,State:TargetHealth.State,Reason:TargetHealth.Reason}' \
  --output table

# Confirm weights
aws elbv2 describe-listeners --listener-arns ${ALB_LISTENER_ARN} \
  --query 'Listeners[0].DefaultActions[0].ForwardConfig.TargetGroups' --output table
# Expected: stable=100, canary=0
```

If any stable target shows `unhealthy` (reason `Target.FailedHealthChecks`), the rollback image itself is broken — escalate to [incident-response.md](./incident-response.md) SEV1.

### 5b. Live error rate, latency, smoke test

```bash
# Error rate in last 5 min (should be < 1%)
aws cloudwatch get-metric-statistics \
  --namespace AgentPlatform --metric-name Errors \
  --start-time "$(date -u -v-5M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 60 --statistics Sum

# P99 latency (should be < 30s)
aws cloudwatch get-metric-statistics \
  --namespace AgentPlatform --metric-name InvocationDuration \
  --start-time "$(date -u -v-5M +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 60 --extended-statistics p99

# Smoke test
export API_URL=$(aws cloudformation describe-stacks --stack-name Chimera-${ENV}-Api \
  --query "Stacks[0].Outputs[?OutputKey=='ApiGatewayUrl'].OutputValue" --output text)
curl -sS "${API_URL}/v1/health" | jq .
# Expected: {"status":"ok","version":"<stable-sha>"}
```

---

## Step 6 — Analyze the canary signal + root-cause

### 6a. Pull the bake-window metrics

```bash
DEPLOY_START=$(aws stepfunctions get-execution-history \
  --execution-arn ${EXEC_ARN} \
  --query 'events[?type==`TaskStateEntered` && stateEnteredEventDetails.name==`DeployCanary`] | [0].timestamp' \
  --output text)
BAKE_END=$(date -u -d "${DEPLOY_START} +30 minutes" +%Y-%m-%dT%H:%M:%S)

for metric in Errors Invocations InvocationDuration GuardrailTriggers EvaluationCompositeScore; do
  echo "=== ${metric} (canary) ==="
  aws cloudwatch get-metric-statistics \
    --namespace AgentPlatform --metric-name ${metric} \
    --dimensions Name=Endpoint,Value=canary \
    --start-time "${DEPLOY_START}" --end-time "${BAKE_END}" \
    --period 300 --statistics Sum Average --extended-statistics p99 \
    --output json | jq '.Datapoints | sort_by(.Timestamp)'
done

# Agent runtime errors during bake
aws logs filter-log-events \
  --log-group-name /chimera/${ENV}/agent-runtime \
  --start-time $(date -u -d "${DEPLOY_START}" +%s)000 \
  --end-time $(date -u -d "${BAKE_END}" +%s)000 \
  --filter-pattern '{ $.level = "ERROR" }' --max-items 100 \
  | jq -r '.events[].message | fromjson | .error_type' | sort | uniq -c | sort -rn
```

Optional: X-Ray high-latency traces:

```bash
aws xray get-trace-summaries \
  --start-time "${DEPLOY_START}" --end-time "${BAKE_END}" \
  --filter-expression 'responsetime > 10 AND annotation.deployment = "canary"' \
  --query 'TraceSummaries[:5].[Id,ResponseTime,HasError]' --output table
```

### 6b. Identify the commit + classify

```bash
aws codepipeline get-pipeline-execution \
  --pipeline-name chimera-deploy-${ENV} \
  --pipeline-execution-id <pipeline-exec-id> \
  --query 'pipelineExecution.artifactRevisions[0].{Commit:revisionId,Summary:revisionSummary}'

export BAD_SHA=<above>
export GOOD_SHA=$(aws s3 cp s3://${ARTIFACT_BUCKET}/deployments/latest-stable-metadata.json - | jq -r '.commitSha // "unknown"')

git log --oneline ${GOOD_SHA}..${BAD_SHA}
git diff --stat ${GOOD_SHA}..${BAD_SHA}
```

| Signal | Likely cause |
|--------|--------------|
| Error rate > 10% | Regression, unhandled exception |
| P99 latency > 3× baseline | Bedrock throttle, DDB hot partition, N+1 query |
| Guardrail trigger rate > 10% | Prompt-template change in `packages/core/src/agent/prompts/` |
| Eval score < 80 | Model routing / context-window regression |
| All metrics normal but rollback fired | False positive — tune thresholds in `pipeline-stack.ts` lines 807–812 |

### 6c. File the RCA task

```bash
sd create --type bug --priority 1 \
  --title "Canary rollback RCA: <commit-sha> — <failure-class>"
```

Link the pipeline execution ID, state-machine ARN, validation metrics, and rollback log S3 URI (from Step 3).

---

## Rollback the rollback (re-promote the canary)

Only if Step 6 analysis concludes the rollback was a false positive:

```bash
# 1. Restore ALB weights to 100% canary
aws elbv2 modify-listener \
  --listener-arn ${ALB_LISTENER_ARN} \
  --default-actions "Type=forward,ForwardConfig={TargetGroups=[
    {TargetGroupArn=${STABLE_TG},Weight=0},
    {TargetGroupArn=${CANARY_TG},Weight=100}
  ]}"

# 2. Pin canary ECS service back to the canary image
# (Reverse Step 4c with the canary image URI)

# 3. Update S3 metadata so future rollbacks know this IS the new stable
aws s3 cp - s3://${ARTIFACT_BUCKET}/deployments/latest-stable-metadata.json <<EOF
{
  "imageUri": "<canary-ecr-uri>",
  "deploymentId": "manual-repromote-${INCIDENT_ID}",
  "promotedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "commitSha": "${BAD_SHA}",
  "notes": "Rollback-of-rollback; original canary was OK, validation thresholds too tight"
}
EOF

# 4. Tune the validation thresholds in pipeline-stack.ts and redeploy
```

---

## Post-Rollback Checklist

- [ ] Step Functions execution is `ABORTED` or `FAILED`
- [ ] ALB weights confirmed `stable=100, canary=0`
- [ ] All stable target-group targets `healthy`
- [ ] API `/v1/health` returns stable version SHA
- [ ] Error rate dashboard within normal range for 15 min post-rollback
- [ ] P99 latency within baseline
- [ ] Rollback log S3 URI recorded in incident ticket
- [ ] Pipeline transition re-enabled: `aws codepipeline enable-stage-transition --stage-name Rollout --transition-type Inbound`
- [ ] RCA seeds issue filed with commit SHA + failure classification
- [ ] Post-mortem scheduled within 48h (SEV1) / 1 week (SEV2)
- [ ] If false positive: validation thresholds task filed to tighten/loosen

---

## Common Failure Modes During Rollback

| Symptom | Cause | Fix |
|---------|-------|-----|
| RollbackFunction returns `stableImageUri: unknown` | No `latest-stable-metadata.json` in S3 (first-ever deploy?) | Use Step 4 with explicit `fallbackImageUri` |
| ECS service stuck `deployment in progress` | Previous deploy circuit breaker not cleared | `aws ecs update-service --force-new-deployment`; escalate if > 10 min |
| ALB listener modify returns `TargetGroup not found` | Stack output stale | Re-derive from `aws elbv2 describe-target-groups` |
| `describe-target-health` shows `draining` | Grace period | Wait 30s; targets re-register |
| Rollback Lambda times out (> 5 min) | ECS task describe slow on large fleets | Split into ALB-only revert first, ECS revert second |
| Health check 5xx post-rollback | Stable image ALSO broken (regression pre-existed) | Full incident — escalate to [incident-response.md](./incident-response.md) SEV1 |
| `enable-stage-transition` after re-deploy still blocks | Pipeline execution still terminating | `stop-pipeline-execution` then re-enable |

---

## Cross-References

- [Deployment Runbook](./deployment.md) — Happy-path deploy
- [CDK Deploy Failure Recovery](./cdk-deploy-failure-recovery.md) — Pre-Rollout stage failures
- [Alarm Runbooks](./alarm-runbooks.md) — `Chimera-Pipeline-ErrorRate` + `Chimera-Pipeline-Latency` are defined in pipeline-stack.ts lines 1350–1383
- [Pipeline Stack CDK](../../infra/lib/pipeline-stack.ts) — `CanaryBakeValidationFunction` (l.708), `ProgressiveRolloutFunction` (l.840), `RollbackFunction` (l.918), `CanaryOrchestration` state machine (l.1228)
- [Incident Response](./incident-response.md) — Broader SEV1 structure if rollback itself fails
- [Observability Stack](../../infra/lib/observability-stack.ts) — Canary-namespace CloudWatch dashboards
- [DR Runbook Gaps](../reviews/dr-runbook-gaps.md) — Why this runbook exists

---

**Owner:** Release manager (primary), Platform on-call (secondary)
**Next review:** 2026-07-22 (quarterly) — or immediately after any canary-rollback event
