/**
 * CDK Nag Suppressions for Chimera Infrastructure
 *
 * All suppressions are documented with a reason explaining why the deviation
 * from the AwsSolutions rule pack is acceptable for this project.
 *
 * Applied per-stack in each stack's constructor, not globally.
 * Reference: ADR-025 CDK Nag Compliance Strategy.
 */
import { NagSuppressions } from 'cdk-nag';
import { Stack } from 'aws-cdk-lib';

/**
 * Suppressions common to all stacks (Lambda execution roles, access log buckets).
 */
export function applyCommonSuppressions(stack: Stack): void {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'Lambda execution roles use AWSLambdaBasicExecutionRole AWS managed policy. ' +
        'This is the minimal required policy for Lambda to write logs. ' +
        'Custom inline policy would duplicate this without adding security value.',
    },
    {
      id: 'AwsSolutions-L1',
      reason:
        'Lambda runtime versions are pinned for reproducibility and stability. ' +
        'Pinning to a specific runtime (e.g. python3.12, nodejs20.x) prevents ' +
        'unexpected behavior from automatic runtime upgrades in production.',
    },
    {
      id: 'AwsSolutions-SQS4',
      reason:
        'Dead-letter queues (DLQs) do not require their own DLQ. ' +
        'DLQs are terminal destinations for failed messages — adding a DLQ-of-DLQ ' +
        'provides no operational benefit and adds unnecessary complexity.',
    },
    {
      id: 'AwsSolutions-S1',
      reason:
        'Access logging bucket does not require its own access log bucket. ' +
        'S3 access logging buckets cannot recursively log to themselves. ' +
        'ChimeraBucket marks access-log buckets with isAccessLogBucket:true to skip self-logging.',
    },
  ]);
}

/**
 * Suppressions for DataStack.
 * Applied in DataStack constructor.
 */
export function applyDataStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'DAX role requires wildcard resource for DynamoDB table access patterns. ' +
        'The role is scoped to specific DynamoDB actions and all 6 Chimera tables.',
    },
  ]);
}

/**
 * Suppressions for EvolutionStack.
 * Applied in EvolutionStack constructor.
 */
export function applyEvolutionStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);
}

/**
 * Suppressions for SkillPipelineStack.
 * Applied in SkillPipelineStack constructor.
 */
export function applySkillPipelineStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'Performance testing Lambda requires cloudwatch:PutMetricData on wildcard resource. ' +
        'CloudWatch PutMetricData does not support resource-level permissions — ' +
        'wildcard is the only valid value for this action.',
    },
  ]);
}

/**
 * Suppressions for OrchestrationStack.
 * Applied in OrchestrationStack constructor.
 */
export function applyOrchestrationStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'Queue provisioner and groupchat provisioner roles use wildcard on tenant-prefixed resources. ' +
        'These are scoped to chimera-tenant-* and chimera-groupchat-* patterns respectively, ' +
        'which is the tightest possible scoping for dynamically-named resources.',
    },
    {
      id: 'AwsSolutions-SQS3',
      reason:
        'Workflow Lambda DLQs (ChimeraLambda internal) do not require additional DLQ. ' +
        'These DLQs receive Lambda async invocation failures. Adding another DLQ level ' +
        'provides no operational value — unprocessed DLQ messages trigger CloudWatch alarms.',
    },
  ]);
}

/**
 * Suppressions for stacks that use EventBridge event bus without resource policy.
 */
export function applyEventBridgeSuppressions(stack: Stack): void {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-EB3',
      reason:
        'EventBridge event bus does not require a resource policy for internal use. ' +
        'The bus is accessed only by IAM-authorized resources within the same account.',
    },
  ]);
}
