/**
 * Stage 6: Manual Review / Permission Validation Lambda
 *
 * Compares declared permissions in skill manifest vs detected required
 * permissions.  Auto-approves safe skills; queues critical-permission skills
 * for human review by writing PENDING_REVIEW status to DynamoDB.
 *
 * Input:  { skillManifest: { permissions, detectedPermissions? }, skillId }
 * Output: { review_result: 'PASS'|'FAIL', reviewStatus, criteria, decision, ...passthrough }
 */

import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});
const SKILLS_TABLE = process.env.SKILLS_TABLE;

const RISK_LEVEL = {
  'skills:read':       'LOW',
  'knowledge:read':    'LOW',
  'context:read':      'LOW',
  'skills:write':      'MEDIUM',
  'knowledge:write':   'MEDIUM',
  'tools:invoke':      'MEDIUM',
  'storage:read':      'MEDIUM',
  'storage:write':     'MEDIUM',
  'network:http':      'HIGH',
  'network:websocket': 'HIGH',
  'code:execute':      'HIGH',
  'agents:spawn':      'HIGH',
  'admin:*':           'CRITICAL',
  'tenants:*':         'CRITICAL',
  '*':                 'CRITICAL',
};
const RISK_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function maxRiskOf(perms) {
  let max = 'LOW';
  for (const p of perms) {
    const r = RISK_LEVEL[p] ?? 'MEDIUM';
    if (RISK_ORDER.indexOf(r) > RISK_ORDER.indexOf(max)) max = r;
  }
  return max;
}

async function markPendingReview(skillId, reason) {
  if (!SKILLS_TABLE || skillId === 'unknown') return;
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: SKILLS_TABLE,
      Key: { pk: { S: `SKILL#${skillId}` }, sk: { S: 'PROFILE' } },
      UpdateExpression: 'SET #s = :s, #r = :r, #u = :u',
      ExpressionAttributeNames: { '#s': 'status', '#r': 'reviewReason', '#u': 'updatedAt' },
      ExpressionAttributeValues: {
        ':s': { S: 'PENDING_REVIEW' },
        ':r': { S: reason },
        ':u': { S: new Date().toISOString() },
      },
    }));
  } catch (err) {
    console.error('manual-review: DDB update error:', err.message);
  }
}

export const handler = async (event) => {
  const skillId  = event.skillId ?? 'unknown';
  const manifest = event.skillManifest ?? {};
  console.log('manual-review: skillId=%s', skillId);

  const declared = manifest.permissions ?? [];
  const required = event.detectedPermissions ?? manifest.detectedPermissions ?? [];

  const maxRisk      = maxRiskOf(declared);
  const overGranted  = declared.filter(p => p !== '*' && !required.includes(p));
  const missing      = required.filter(p => !declared.includes(p) && !declared.includes('*'));

  const requiresManualReview = maxRisk === 'CRITICAL' || overGranted.length > 2 || missing.length > 0;
  const canAutoApprove = ['LOW', 'MEDIUM'].includes(maxRisk) && overGranted.length <= 2 && missing.length === 0;

  let reviewStatus, decision, review_result;

  if (canAutoApprove) {
    reviewStatus = 'auto_approved';
    decision     = { approved: true, reviewer: 'auto', reviewedAt: new Date().toISOString(),
                     reason: `Auto-approved: maxRisk=${maxRisk}, overGranted=${overGranted.length}, missing=0` };
    review_result = 'PASS';
  } else if (requiresManualReview) {
    const reason = maxRisk === 'CRITICAL'    ? 'Critical permissions require manual review'
                 : missing.length > 0        ? `Missing permissions: ${missing.join(', ')}`
                 : `Over-granted permissions: ${overGranted.join(', ')}`;
    reviewStatus = 'pending_review';
    decision     = { approved: false, reviewer: null, reviewedAt: null, reason };
    review_result = 'FAIL';
    await markPendingReview(skillId, reason);
  } else {
    reviewStatus = 'approved';
    decision     = { approved: true, reviewer: 'system', reviewedAt: new Date().toISOString(),
                     reason: 'Permissions within acceptable bounds' };
    review_result = 'PASS';
  }

  console.log('manual-review: result=%s status=%s', review_result, reviewStatus);

  return {
    ...event,
    review_result,
    reviewStatus,
    reviewPriority: maxRisk === 'CRITICAL' ? 'critical' : maxRisk === 'HIGH' ? 'high' : 'low',
    criteria: { maxRisk, hasWarnings: overGranted.length > 0, requiresManualReview, overGrantedPermissions: overGranted, missingPermissions: missing },
    decision,
  };
};
