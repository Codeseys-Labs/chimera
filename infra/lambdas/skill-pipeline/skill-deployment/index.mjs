/**
 * Stage 7: Skill Deployment Lambda
 *
 * Publishes a validated skill artifact to S3 and registers it in DynamoDB.
 *
 * Input:  { skillBundle, skillManifest, skillId, bundleHash, platformSignature }
 * Output: { deployment_result: 'SUCCESS'|'FAIL', deploymentId, publishedAt, targets, ...passthrough }
 */

import { createHash, randomBytes } from 'crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { writeSkillToRegistryIfEnabled } from './registry-writer.mjs';

const ddb = new DynamoDBClient({});
const s3  = new S3Client({});

const SKILLS_TABLE  = process.env.SKILLS_TABLE;
const SKILLS_BUCKET = process.env.SKILLS_BUCKET;

function makeDeploymentId() {
  return 'deploy-' + randomBytes(6).toString('hex');
}

export const handler = async (event) => {
  const skillId   = event.skillId   ?? 'unknown';
  const manifest  = event.skillManifest ?? {};
  const version   = manifest.version ?? event.version ?? `1.0.0-${Date.now()}`;
  const bundleHash = event.bundleHash ?? '';
  const deploymentId = makeDeploymentId();

  console.log('skill-deployment: skillId=%s version=%s deploymentId=%s', skillId, version, deploymentId);

  const now = new Date().toISOString();
  let s3Uploaded = false;
  let s3Key = '';

  // --- Upload to S3 ---
  if (SKILLS_BUCKET) {
    s3Key = `skills/${skillId}/${version}/${deploymentId}/manifest.json`;
    const artifact = JSON.stringify({
      skillId, version, deploymentId, bundleHash,
      name: manifest.name ?? skillId,
      description: manifest.description ?? '',
      author: manifest.author ?? 'unknown',
      permissions: manifest.permissions ?? [],
      platformSignature: event.platformSignature?.signature ?? '',
      deployedAt: now,
      files: Object.keys(event.skillBundle ?? {}),
    }, null, 2);

    try {
      await s3.send(new PutObjectCommand({
        Bucket: SKILLS_BUCKET,
        Key: s3Key,
        Body: artifact,
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
        Metadata: { 'skill-id': skillId, 'version': version, 'deployment-id': deploymentId },
      }));
      s3Uploaded = true;
      console.log('skill-deployment: uploaded to s3://%s/%s', SKILLS_BUCKET, s3Key);
    } catch (err) {
      console.error('skill-deployment: S3 upload failed:', err.message);
      return { ...event, deployment_result: 'FAIL', failureReason: `S3 upload failed: ${err.message}`, deploymentId };
    }
  } else {
    console.warn('skill-deployment: SKILLS_BUCKET not set — skipping S3 upload');
  }

  // --- Register in DynamoDB ---
  let ddbRegistered = false;
  if (SKILLS_TABLE) {
    const baseItem = {
      pk: { S: `SKILL#${skillId}` },
      skillId:             { S: skillId },
      version:             { S: version },
      deploymentId:        { S: deploymentId },
      status:              { S: 'ACTIVE' },
      name:                { S: manifest.name ?? skillId },
      description:         { S: manifest.description ?? '' },
      author:              { S: manifest.author ?? 'unknown' },
      bundleHash:          { S: bundleHash },
      s3Key:               { S: s3Key },
      s3Bucket:            { S: SKILLS_BUCKET ?? '' },
      platformSignature:   { S: event.platformSignature?.signature ?? '' },
      pipelinePassedAt:    { S: now },
      deployedAt:          { S: now },
      updatedAt:           { S: now },
    };

    // Write PROFILE record
    try {
      await ddb.send(new PutItemCommand({
        TableName: SKILLS_TABLE,
        Item: { ...baseItem, sk: { S: 'PROFILE' } },
      }));
      // Write immutable VERSION record for rollback support
      await ddb.send(new PutItemCommand({
        TableName: SKILLS_TABLE,
        Item: { ...baseItem, sk: { S: `VERSION#${version}#${deploymentId}` } },
      }));
      ddbRegistered = true;
      console.log('skill-deployment: registered in DynamoDB skillId=%s', skillId);
    } catch (err) {
      console.error('skill-deployment: DynamoDB write failed:', err.message);
      return { ...event, deployment_result: 'FAIL', failureReason: `DynamoDB registration failed: ${err.message}`, deploymentId, s3Key };
    }
  } else {
    console.warn('skill-deployment: SKILLS_TABLE not set — skipping DynamoDB registration');
  }

  // --- ADR-034 Phase 1: flag-gated Registry dual-write ---
  // DDB is primary. Registry write is attempted only after DDB succeeds and
  // NEVER causes the Lambda to fail (see registry-writer.mjs invariant).
  let registryTarget = { attempted: false };
  if (ddbRegistered) {
    const skillDescriptor = {
      skillId,
      version,
      deploymentId,
      bundleHash,
      s3Key,
      s3Bucket: SKILLS_BUCKET ?? '',
      platformSignature: event.platformSignature?.signature ?? '',
      deployedAt: now,
      manifest,
    };
    const registryResult = await writeSkillToRegistryIfEnabled(skillDescriptor);
    registryTarget = { attempted: !registryResult.skipped, ...registryResult };
    if (!registryResult.skipped && registryResult.error) {
      console.error(
        'skill-deployment: Registry dual-write failed (non-fatal): %s',
        registryResult.error
      );
      // Non-fatal: DDB is source of truth in Phase 1. Metric already emitted
      // via registry-writer.mjs. Continue to SUCCESS.
    }
  }

  return {
    ...event,
    deployment_result: 'SUCCESS',
    deploymentId,
    version,
    publishedAt: now,
    targets: { s3: s3Uploaded, dynamodb: ddbRegistered, registry: registryTarget },
    rollbackAvailable: true,
    s3Key,
  };
};
