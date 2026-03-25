/**
 * Scan Failure Notification Lambda
 *
 * Publishes a structured failure notification to SNS and updates the skill
 * status to FAILED in DynamoDB.
 *
 * Input:  Pipeline event with one or more *_result = 'FAIL' fields
 * Output: { notification_sent, author_notified, ddb_updated, failed_stage, skillId }
 */

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const sns = new SNSClient({});
const ddb = new DynamoDBClient({});

const NOTIFICATION_TOPIC_ARN = process.env.NOTIFICATION_TOPIC_ARN;
const SKILLS_TABLE            = process.env.SKILLS_TABLE;

function determineFailedStage(event) {
  if (event.static_result      === 'FAIL') return { stage: 'StaticAnalysis',       details: event.findings?.slice(0, 3) };
  if (event.dependency_result  === 'FAIL') return { stage: 'DependencyAudit',      details: event.vulnerabilities?.slice(0, 3) };
  if (event.sandbox_result     === 'FAIL') return { stage: 'SandboxRun',           details: event.violations?.slice(0, 3) };
  if (event.signature_result   === 'FAIL') return { stage: 'SignatureVerification', details: [event.failureReason] };
  if (event.performance_result === 'FAIL') return { stage: 'PerformanceTesting',   details: event.violations?.slice(0, 3) };
  if (event.review_result      === 'FAIL') return { stage: 'ManualReview',         details: [event.decision?.reason] };
  if (event.deployment_result  === 'FAIL') return { stage: 'SkillDeployment',      details: [event.failureReason] };
  if (event.error)                          return { stage: 'Unknown',              details: [JSON.stringify(event.error)] };
  return { stage: 'Unknown', details: ['No specific failure stage identified'] };
}

function buildMessage(skillId, { stage, details }) {
  const lines = [
    'Chimera Skill Security Pipeline FAILED',
    '',
    `Skill ID    : ${skillId}`,
    `Failed Stage: ${stage}`,
    `Timestamp   : ${new Date().toISOString()}`,
    '',
  ];
  if (details?.length) {
    lines.push('Details:');
    details.filter(Boolean).forEach(d => lines.push(`  - ${typeof d === 'object' ? JSON.stringify(d) : d}`));
    lines.push('');
  }
  lines.push('Review pipeline execution logs for full details.');
  return lines.join('\n');
}

export const handler = async (event) => {
  const skillId = event.skillId ?? 'unknown';
  const failure = determineFailedStage(event);
  console.log('scan-failure: skillId=%s stage=%s', skillId, failure.stage);

  let snsSent = false;
  let ddbUpdated = false;

  // --- SNS notification ---
  if (NOTIFICATION_TOPIC_ARN) {
    try {
      await sns.send(new PublishCommand({
        TopicArn: NOTIFICATION_TOPIC_ARN,
        Subject: `[Chimera] Skill Pipeline Failed: ${skillId} (Stage: ${failure.stage})`,
        Message: buildMessage(skillId, failure),
        MessageAttributes: {
          skillId:     { DataType: 'String', StringValue: skillId },
          failedStage: { DataType: 'String', StringValue: failure.stage },
          severity:    { DataType: 'String', StringValue: 'HIGH' },
        },
      }));
      snsSent = true;
      console.log('scan-failure: SNS notification sent');
    } catch (err) {
      console.error('scan-failure: SNS publish failed:', err.message);
    }
  } else {
    console.warn('scan-failure: NOTIFICATION_TOPIC_ARN not set — skipping SNS');
  }

  // --- DynamoDB status update ---
  if (SKILLS_TABLE && skillId !== 'unknown') {
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: SKILLS_TABLE,
        Key: { pk: { S: `SKILL#${skillId}` }, sk: { S: 'PROFILE' } },
        UpdateExpression: 'SET #s = :s, #fs = :fs, #fr = :fr, #u = :u',
        ExpressionAttributeNames: { '#s': 'status', '#fs': 'failedStage', '#fr': 'failureReason', '#u': 'updatedAt' },
        ExpressionAttributeValues: {
          ':s':  { S: 'FAILED' },
          ':fs': { S: failure.stage },
          ':fr': { S: (failure.details?.filter(Boolean)?.[0] ?? 'Pipeline security check failed').toString() },
          ':u':  { S: new Date().toISOString() },
        },
      }));
      ddbUpdated = true;
      console.log('scan-failure: DynamoDB status set to FAILED for skillId=%s', skillId);
    } catch (err) {
      console.error('scan-failure: DynamoDB update failed:', err.message);
    }
  }

  return { notification_sent: snsSent, author_notified: snsSent, ddb_updated: ddbUpdated, failed_stage: failure.stage, skillId };
};
