/**
 * Deployment lifecycle commands - destroy, cleanup, and redeploy
 *
 * Destroy uses a 3-phase approach:
 * 1. Trigger CodeBuild (the Deploy project) to run `cdk destroy` on all application stacks
 * 2. Delete the Pipeline CFN stack (bootstrap infra: CodePipeline, CodeBuild, ECR)
 * 3. Delete the CodeCommit repository (SDK-created, not CFN-managed)
 *
 * This way the CLI only manages what it creates (the bootstrap), and the pipeline's
 * CodeBuild project handles destroying everything it deployed — including any stacks
 * the agent may have added via self-evolution.
 */

import { Command } from 'commander';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import {
  CloudFormationClient,
  ListStacksCommand,
  DeleteStackCommand,
  DescribeStackResourcesCommand,
  DescribeStackEventsCommand,
  StackStatus,
} from '@aws-sdk/client-cloudformation';
import {
  CodeBuildClient,
  StartBuildCommand,
  BatchGetBuildsCommand,
} from '@aws-sdk/client-codebuild';
import { CodeCommitClient, DeleteRepositoryCommand } from '@aws-sdk/client-codecommit';
import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
  UpdateTableCommand,
  type AttributeValue,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import * as os from 'os';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';
import { findProjectRoot } from '../utils/project.js';

// ─── Utility functions ───────────────────────────────────────────────────────

/**
 * Clean up failed CloudFormation stacks in ROLLBACK_COMPLETE state
 */
async function cleanupFailedStacks(client: CloudFormationClient, envName: string): Promise<number> {
  const command = new ListStacksCommand({
    StackStatusFilter: [StackStatus.ROLLBACK_COMPLETE],
  });

  const response = await client.send(command);
  const prefix = `Chimera-${envName}-`;

  const failedStacks = (response.StackSummaries || [])
    .filter((stack) => stack.StackName && stack.StackName.startsWith(prefix))
    .map((stack) => stack.StackName!);

  for (const stackName of failedStacks) {
    await client.send(new DeleteStackCommand({ StackName: stackName }));
  }

  return failedStacks.length;
}

/**
 * Export DynamoDB tables from all Chimera stacks for the given environment.
 */
async function exportDataArchive(options: {
  env: string;
  region: string;
  exportPath?: string;
}): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultDir = path.join(os.homedir(), '.chimera', 'archives', `${options.env}-${timestamp}`);
  const archiveDir = options.exportPath ? path.resolve(options.exportPath) : defaultDir;
  fs.mkdirSync(archiveDir, { recursive: true });

  const cfClient = new CloudFormationClient({ region: options.region });
  const ddbClient = new DynamoDBClient({ region: options.region });

  const listResp = await cfClient.send(
    new ListStacksCommand({
      StackStatusFilter: [
        StackStatus.CREATE_COMPLETE,
        StackStatus.UPDATE_COMPLETE,
        StackStatus.UPDATE_ROLLBACK_COMPLETE,
      ],
    })
  );

  const prefix = `Chimera-${options.env}-`;
  const stacks = (listResp.StackSummaries || [])
    .filter((s) => s.StackName?.startsWith(prefix))
    .map((s) => s.StackName!);

  const tables: string[] = [];
  for (const stackName of stacks) {
    const resourcesResp = await cfClient.send(
      new DescribeStackResourcesCommand({ StackName: stackName })
    );
    for (const resource of resourcesResp.StackResources || []) {
      if (
        resource.ResourceType === 'AWS::DynamoDB::Table' &&
        resource.PhysicalResourceId &&
        !tables.includes(resource.PhysicalResourceId)
      ) {
        tables.push(resource.PhysicalResourceId);
      }
    }
  }

  for (const tableName of tables) {
    const items: Record<string, AttributeValue>[] = [];
    let lastKey: Record<string, AttributeValue> | undefined;

    do {
      const scanResp = await ddbClient.send(
        new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey })
      );
      items.push(...(scanResp.Items || []));
      lastKey = scanResp.LastEvaluatedKey;
    } while (lastKey);

    const safeTableName = tableName.replace(/[^a-zA-Z0-9-]/g, '_');
    fs.writeFileSync(
      path.join(archiveDir, `${safeTableName}.json`),
      JSON.stringify(items, null, 2),
      'utf8'
    );
  }

  const manifest = {
    tables,
    timestamp: new Date().toISOString(),
    env: options.env,
    region: options.region,
  };
  fs.writeFileSync(
    path.join(archiveDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  const lastArchiveFile = path.join(os.homedir(), '.chimera', 'last-archive.json');
  fs.writeFileSync(
    lastArchiveFile,
    JSON.stringify({ path: archiveDir, timestamp: manifest.timestamp, env: options.env }),
    'utf8'
  );

  return archiveDir;
}

/**
 * Check whether a CloudFormation stack exists and is in a deletable state.
 */
async function stackExists(client: CloudFormationClient, stackName: string): Promise<boolean> {
  try {
    const resp = await client.send(
      new ListStacksCommand({
        StackStatusFilter: [
          StackStatus.CREATE_COMPLETE,
          StackStatus.UPDATE_COMPLETE,
          StackStatus.UPDATE_ROLLBACK_COMPLETE,
          StackStatus.ROLLBACK_COMPLETE,
          StackStatus.CREATE_FAILED,
          StackStatus.DELETE_FAILED,
          StackStatus.DELETE_IN_PROGRESS,
          StackStatus.CREATE_IN_PROGRESS,
          StackStatus.UPDATE_IN_PROGRESS,
        ],
      })
    );
    return (resp.StackSummaries ?? []).some((s) => s.StackName === stackName);
  } catch {
    return false;
  }
}

/**
 * Wait for a CloudFormation stack to reach DELETE_COMPLETE.
 */
async function waitForStackDelete(
  client: CloudFormationClient,
  stackName: string,
  timeoutMs = 20 * 60 * 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, 15_000));
    const exists = await stackExists(client, stackName);
    if (!exists) return;
  }
  throw new Error(`Timed out waiting for ${stackName} to delete after ${timeoutMs / 60000}m`);
}

/**
 * Delete the CodeCommit repository created by chimera deploy.
 */
async function deleteCodeCommitRepo(
  client: CodeCommitClient,
  repoName: string,
  keepRepo: boolean
): Promise<void> {
  if (keepRepo) return;
  try {
    await client.send(new DeleteRepositoryCommand({ repositoryName: repoName }));
  } catch (error: any) {
    if (error.name !== 'RepositoryDoesNotExistException') throw error;
  }
}

/**
 * Empty all objects (and versions) from an S3 bucket.
 */
async function emptyS3Bucket(bucketName: string, s3Client: S3Client): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  let isTruncated = true;

  try {
    while (isTruncated) {
      const resp = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: bucketName,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        })
      );

      const toDelete = [
        ...(resp.Versions ?? []).map((v) => ({ Key: v.Key!, VersionId: v.VersionId })),
        ...(resp.DeleteMarkers ?? []).map((m) => ({ Key: m.Key!, VersionId: m.VersionId })),
      ].filter((o) => o.Key);

      if (toDelete.length > 0) {
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: toDelete, Quiet: true },
          })
        );
      }

      isTruncated = !!resp.IsTruncated;
      keyMarker = resp.NextKeyMarker;
      versionIdMarker = resp.NextVersionIdMarker;
    }
  } catch (err: any) {
    if (err.name === 'NoSuchBucket' || err.Code === 'NoSuchBucket') return;
    throw err;
  }
}

/**
 * Enumerate S3 buckets in a CFN stack and empty each.
 */
async function emptyStackS3Buckets(
  stackName: string,
  cfClient: CloudFormationClient,
  s3Client: S3Client
): Promise<void> {
  let resources;
  try {
    const resp = await cfClient.send(new DescribeStackResourcesCommand({ StackName: stackName }));
    resources = resp.StackResources ?? [];
  } catch {
    return;
  }

  const buckets = resources
    .filter((r) => r.ResourceType === 'AWS::S3::Bucket' && r.PhysicalResourceId)
    .map((r) => r.PhysicalResourceId!);

  for (const bucket of buckets) {
    await emptyS3Bucket(bucket, s3Client);
  }
}

/**
 * Disable DynamoDB deletion protection on all tables in a stack.
 */
async function disableDdbDeletionProtection(
  stackName: string,
  cfClient: CloudFormationClient,
  ddbClient: DynamoDBClient
): Promise<void> {
  let resources;
  try {
    const resp = await cfClient.send(new DescribeStackResourcesCommand({ StackName: stackName }));
    resources = resp.StackResources ?? [];
  } catch {
    return;
  }

  const tables = resources
    .filter(
      (r) =>
        (r.ResourceType === 'AWS::DynamoDB::Table' ||
          r.ResourceType === 'AWS::DynamoDB::GlobalTable') &&
        r.PhysicalResourceId
    )
    .map((r) => r.PhysicalResourceId!);

  for (const table of tables) {
    try {
      await ddbClient.send(
        new UpdateTableCommand({ TableName: table, DeletionProtectionEnabled: false })
      );
    } catch {
      // Table may not exist or already unprotected
    }
  }
}

// ─── Phase 1: Trigger CodeBuild to run cdk destroy ──────────────────────────

/**
 * Start a standalone CodeBuild build on the Deploy project that runs
 * `cdk destroy --all` via buildspec-destroy.yml. This leverages the existing
 * IAM permissions on the Deploy CodeBuild project (sts:AssumeRole on cdk-* roles).
 *
 * Returns the build ID for status polling.
 */
async function startDestroyBuild(
  cbClient: CodeBuildClient,
  projectName: string,
  envName: string
): Promise<string> {
  // The Deploy project is a PipelineProject — it can't be started standalone
  // without overriding the artifact type. We override to NO_ARTIFACTS since
  // the destroy build produces no output artifacts.
  const resp = await cbClient.send(
    new StartBuildCommand({
      projectName,
      buildspecOverride: 'buildspec-destroy.yml',
      sourceTypeOverride: 'CODECOMMIT',
      sourceLocationOverride: `https://git-codecommit.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/v1/repos/chimera`,
      artifactsOverride: { type: 'NO_ARTIFACTS' },
      environmentVariablesOverride: [{ name: 'ENV_NAME', value: envName, type: 'PLAINTEXT' }],
    })
  );

  const buildId = resp.build?.id;
  if (!buildId) throw new Error('CodeBuild StartBuild returned no build ID');
  return buildId;
}

/**
 * Poll a CodeBuild build until it completes. Returns true if succeeded, false if failed.
 */
async function waitForBuild(
  cbClient: CodeBuildClient,
  buildId: string,
  onStatus?: (phase: string, status: string) => void,
  timeoutMs = 60 * 60 * 1000 // 60 min — CDK destroy can be slow
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, 15_000));

    const resp = await cbClient.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = resp.builds?.[0];
    if (!build) continue;

    const phase = build.currentPhase ?? 'UNKNOWN';
    const status = build.buildStatus ?? 'IN_PROGRESS';

    if (onStatus) onStatus(phase, status);

    if (status === 'SUCCEEDED') return true;
    if (['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'].includes(status)) {
      return false;
    }
  }

  throw new Error(`Timed out waiting for CodeBuild build after ${timeoutMs / 60000}m`);
}

// ─── Reseed ─────────────────────────────────────────────────────────────────

/**
 * Reseed DynamoDB tables from a local archive.
 */
export async function reseedFromArchive(archivePath: string, region: string): Promise<void> {
  const manifestPath = path.join(archivePath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Archive manifest not found at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const ddbClient = new DynamoDBClient({ region });

  for (const tableName of manifest.tables as string[]) {
    const safeTableName = tableName.replace(/[^a-zA-Z0-9-]/g, '_');
    const filePath = path.join(archivePath, `${safeTableName}.json`);
    if (!fs.existsSync(filePath)) continue;

    const items: Record<string, AttributeValue>[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      let requestItems: Record<string, WriteRequest[]> = {
        [tableName]: batch.map((item) => ({ PutRequest: { Item: item } })),
      };

      const MAX_RETRIES = 5;
      let delay = 100;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const response = await ddbClient.send(
          new BatchWriteItemCommand({ RequestItems: requestItems })
        );
        const unprocessed = response.UnprocessedItems?.[tableName];
        if (!unprocessed || unprocessed.length === 0) break;
        if (attempt === MAX_RETRIES) {
          throw new Error(
            `BatchWriteItem failed after ${MAX_RETRIES} retries: ${unprocessed.length} items unprocessed`
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        requestItems = { [tableName]: unprocessed };
      }
    }
  }
}

// ─── Command registration ───────────────────────────────────────────────────

export function registerDestroyCommands(program: Command): void {
  // ─── chimera destroy ──────────────────────────────────────────────────────
  program
    .command('destroy')
    .description('Tear down all Chimera infrastructure from the AWS account')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--force', 'Skip confirmation prompt')
    .option('--retain-data', 'Export DynamoDB table data before destroying')
    .option('--export-path <path>', 'Export destination for --retain-data')
    .option('--keep-repo', 'Preserve the CodeCommit repository')
    .option('--monitor', 'Stream CodeBuild log events in real-time')
    .option('--json', 'Output result as JSON')
    .addHelpText(
      'after',
      `
Destroy lifecycle:
  Phase 1: Trigger CodeBuild to run \`cdk destroy\` on all application stacks
           (the pipeline's Deploy project already has CDK permissions)
  Phase 2: Delete the Pipeline stack (CodePipeline, CodeBuild, ECR, artifacts)
  Phase 3: Delete the CodeCommit repository

The CLI only manages the bootstrap resources it created. The CodeBuild project
handles destroying everything the pipeline deployed — including any stacks the
agent may have self-evolved.

Examples:
  $ chimera destroy
  $ chimera destroy --force
  $ chimera destroy --retain-data --export-path ./backup
  $ chimera destroy --force --keep-repo`
    )
    .action(async (options) => {
      const spinner = ora('Starting Chimera destruction').start();
      if (options.json) spinner.stop();

      try {
        const wsConfig = loadWorkspaceConfig();
        const region = options.region ?? wsConfig?.aws?.region;
        if (!region) {
          const msg = 'No AWS region configured. Run "chimera init" to set up your workspace.';
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_REGION' }));
            process.exit(1);
          }
          spinner.fail(color.red(msg));
          process.exit(1);
        }
        const env = options.env ?? wsConfig?.workspace?.environment ?? 'dev';
        if (wsConfig?.aws?.profile) {
          process.env.AWS_PROFILE = wsConfig.aws.profile;
        }

        if (!wsConfig.deployment) {
          if (options.json) {
            console.log(JSON.stringify({ status: 'ok', data: { message: 'Nothing to destroy' } }));
          } else {
            spinner.warn(color.yellow('No deployment configuration found'));
            console.log(color.gray('Nothing to destroy'));
          }
          return;
        }

        // Confirmation prompt
        if (!options.force && !options.json) {
          spinner.stop();
          const inquirer = await import('inquirer');
          const answers = await inquirer.default.prompt([
            {
              type: 'confirm',
              name: 'confirmed',
              message: color.yellow(
                '⚠️  WARNING: This will delete all Chimera infrastructure. Continue?'
              ),
              default: false,
            },
          ]);
          if (!answers.confirmed) {
            console.log(color.gray('Destruction cancelled'));
            return;
          }
          spinner.start('Destroying infrastructure');
        }

        const safeEnv = env.replace(/[^a-zA-Z0-9-]/g, '');
        const repoName = wsConfig?.workspace?.repository ?? 'chimera';
        const cfClient = new CloudFormationClient({ region });
        const cbClient = new CodeBuildClient({ region });
        const ddbClient = new DynamoDBClient({ region });
        const s3Client = new S3Client({ region });

        // ── Optional: export data archive ──────────────────────────────────
        let archivePath: string | undefined;
        if (options.retainData) {
          if (!options.json) spinner.text = 'Exporting data archive...';
          archivePath = await exportDataArchive({ env, region, exportPath: options.exportPath });
          if (!options.json) {
            spinner.succeed(color.green(`Data archived to ${archivePath}`));
            spinner.start('Destroying infrastructure');
          }
        }

        // ── Pre-destroy: disable DDB protection on ALL Chimera stacks ──────
        // This must happen before CDK destroy runs, because CDK destroy will
        // fail on tables with deletion protection enabled.
        if (!options.json) spinner.text = 'Disabling DynamoDB deletion protection...';
        const listResp = await cfClient.send(
          new ListStacksCommand({
            StackStatusFilter: [
              StackStatus.CREATE_COMPLETE,
              StackStatus.UPDATE_COMPLETE,
              StackStatus.UPDATE_ROLLBACK_COMPLETE,
            ],
          })
        );
        const chimeraStacks = (listResp.StackSummaries ?? [])
          .filter((s) => s.StackName?.startsWith(`Chimera-${safeEnv}-`))
          .map((s) => s.StackName!);

        for (const stackName of chimeraStacks) {
          await disableDdbDeletionProtection(stackName, cfClient, ddbClient);
          await emptyStackS3Buckets(stackName, cfClient, s3Client);
        }

        // ── Phase 1: Trigger CodeBuild to run cdk destroy ──────────────────
        const deployProjectName = `chimera-deploy-${safeEnv}`;
        const pipelineStackName = `Chimera-${safeEnv}-Pipeline`;

        const pipelineExists = await stackExists(cfClient, pipelineStackName);
        if (!pipelineExists) {
          if (!options.json) {
            spinner.warn(color.yellow('Pipeline stack not found — nothing to destroy'));
          }
          // Still try to clean up CodeCommit
          const ccClient = new CodeCommitClient({ region });
          await deleteCodeCommitRepo(ccClient, repoName, !!options.keepRepo);
          const cur = loadWorkspaceConfig();
          saveWorkspaceConfig({ ...cur, deployment: undefined, endpoints: undefined });
          return;
        }

        if (!options.json) {
          spinner.succeed(color.green('Pre-destroy cleanup complete'));
          console.log(color.bold('\nPhase 1: Triggering CodeBuild to destroy application stacks'));
          spinner.start(`Starting CodeBuild project: ${deployProjectName}...`);
        }

        const buildId = await startDestroyBuild(cbClient, deployProjectName, safeEnv);
        if (!options.json) {
          spinner.succeed(color.green(`CodeBuild started: ${buildId}`));
          spinner.start('Waiting for CDK destroy to complete (this may take 15-30 minutes)...');
        }

        const buildSucceeded = await waitForBuild(cbClient, buildId, (phase, status) => {
          if (!options.json && options.monitor) {
            console.log(color.gray(`  [CodeBuild] Phase: ${phase}  Status: ${status}`));
          }
        });

        if (!buildSucceeded) {
          if (!options.json) {
            spinner.fail(color.red('CodeBuild cdk destroy failed'));
            console.log(
              color.yellow(
                '\nThe CodeBuild destroy build failed. Check CloudWatch logs for details:'
              )
            );
            console.log(
              color.gray(
                `  aws logs tail /aws/codebuild/${deployProjectName} --since 30m --region ${region}`
              )
            );
            console.log(color.yellow('\nFalling back to direct CloudFormation stack deletion...'));
          }
          // Fallback: try direct DeleteStack on remaining app stacks
          // This handles the case where CDK destroy fails (e.g., circular deps)
          for (const stackName of chimeraStacks) {
            if (stackName === pipelineStackName) continue; // Skip Pipeline — deleted in Phase 2
            const exists = await stackExists(cfClient, stackName);
            if (!exists) continue;
            try {
              await cfClient.send(new DeleteStackCommand({ StackName: stackName }));
              await waitForStackDelete(cfClient, stackName);
            } catch (err: any) {
              if (!options.json) {
                console.log(color.red(`  Failed to delete ${stackName}: ${err.message}`));
              }
            }
          }
        } else {
          if (!options.json) {
            spinner.succeed(color.green('Phase 1 complete: all application stacks destroyed'));
          }
        }

        // ── Phase 2: Delete the Pipeline stack ─────────────────────────────
        if (!options.json) {
          console.log(color.bold('\nPhase 2: Deleting Pipeline bootstrap stack'));
          spinner.start(`Destroying ${pipelineStackName}...`);
        }

        // Empty Pipeline stack's S3 buckets (artifact bucket)
        await emptyStackS3Buckets(pipelineStackName, cfClient, s3Client);

        const pipelineStillExists = await stackExists(cfClient, pipelineStackName);
        if (pipelineStillExists) {
          await cfClient.send(new DeleteStackCommand({ StackName: pipelineStackName }));

          if (options.monitor && !options.json) {
            spinner.stop();
            // Simple poll-based monitoring
            const start = Date.now();
            while (Date.now() - start < 20 * 60 * 1000) {
              await new Promise<void>((r) => setTimeout(r, 15_000));
              const exists = await stackExists(cfClient, pipelineStackName);
              if (!exists) break;
              console.log(color.gray(`  ${pipelineStackName}: DELETE_IN_PROGRESS...`));
            }
          } else {
            await waitForStackDelete(cfClient, pipelineStackName);
          }
        }

        if (!options.json) {
          spinner.succeed(color.green('Phase 2 complete: Pipeline stack destroyed'));
        }

        // ── Phase 3: Delete CodeCommit repository ──────────────────────────
        if (!options.json) {
          console.log(color.bold('\nPhase 3: Deleting CodeCommit repository'));
          spinner.start(`Deleting repository "${repoName}"...`);
        }

        const ccClient = new CodeCommitClient({ region });
        await deleteCodeCommitRepo(ccClient, repoName, !!options.keepRepo);

        if (!options.json) {
          if (options.keepRepo) {
            spinner.info(color.gray(`Repository "${repoName}" preserved (--keep-repo)`));
          } else {
            spinner.succeed(color.green(`Repository "${repoName}" deleted`));
          }
        }

        // ── Cleanup: update chimera.toml ───────────────────────────────────
        const cur = loadWorkspaceConfig();
        saveWorkspaceConfig({ ...cur, deployment: undefined, endpoints: undefined });

        if (options.json) {
          console.log(
            JSON.stringify({
              status: 'ok',
              data: { env, region, repoName, repoDeleted: !options.keepRepo, archivePath },
            })
          );
        } else {
          console.log(color.green('\n✓ Infrastructure destroyed'));
          console.log(color.gray('  All Chimera resources have been removed from the account.'));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(
            JSON.stringify({ status: 'error', error: error.message, code: 'DESTROY_FAILED' })
          );
          process.exit(1);
        }
        spinner.fail(color.red('Destruction failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });

  // ─── chimera cleanup ────────────────────────────────────────────────────────
  program
    .command('cleanup')
    .description('Delete Chimera stacks stuck in ROLLBACK_COMPLETE state')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      const spinner = ora('Starting cleanup').start();
      if (options.json) spinner.stop();

      try {
        const wsConfig = loadWorkspaceConfig();
        const region = options.region ?? wsConfig?.aws?.region;
        if (!region) {
          const msg = 'No AWS region configured. Run "chimera init" to set up your workspace.';
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_REGION' }));
            process.exit(1);
          }
          spinner.fail(color.red(msg));
          process.exit(1);
        }
        const env = options.env ?? wsConfig?.workspace?.environment ?? 'dev';
        if (wsConfig?.aws?.profile) {
          process.env.AWS_PROFILE = wsConfig.aws.profile;
        }

        const client = new CloudFormationClient({ region });

        if (!options.json) spinner.text = 'Scanning for failed stacks...';
        const deletedCount = await cleanupFailedStacks(client, env);

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { deletedCount, env, region } }));
          return;
        }

        if (deletedCount === 0) {
          spinner.succeed(color.green('No failed stacks found'));
          console.log(color.gray('All stacks are in a healthy state'));
        } else {
          spinner.succeed(color.green(`Cleaned up ${deletedCount} failed stack(s)`));
          console.log(
            color.green(`\n✓ Deleted ${deletedCount} stack(s) in ROLLBACK_COMPLETE state`)
          );
        }
      } catch (error: any) {
        if (options.json) {
          console.log(
            JSON.stringify({ status: 'error', error: error.message, code: 'CLEANUP_FAILED' })
          );
          process.exit(1);
        }
        spinner.fail(color.red('Cleanup failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });

  // ─── chimera redeploy ───────────────────────────────────────────────────────
  program
    .command('redeploy')
    .description('Clean up failed stacks then retry CDK deployment')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--reseed <path>', 'Reseed DynamoDB tables from exported data archive')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      if (!options.json) console.log(color.bold('Chimera Redeploy\n'));

      try {
        const wsConfig = loadWorkspaceConfig();
        const region = options.region ?? wsConfig?.aws?.region;
        if (!region) {
          const msg = 'No AWS region configured. Run "chimera init" to set up your workspace.';
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_REGION' }));
            process.exit(1);
          }
          console.error(color.red(`✗ ${msg}`));
          process.exit(1);
        }
        const env = options.env ?? wsConfig?.workspace?.environment ?? 'dev';
        if (wsConfig?.aws?.profile) {
          process.env.AWS_PROFILE = wsConfig.aws.profile;
        }

        const client = new CloudFormationClient({ region });

        if (!options.json) console.log(color.bold('1. Cleaning up failed stacks\n'));
        const spinner = ora('Scanning for failed stacks...').start();
        if (options.json) spinner.stop();

        const deletedCount = await cleanupFailedStacks(client, env);

        if (!options.json) {
          if (deletedCount === 0) {
            spinner.succeed(color.green('No failed stacks found'));
          } else {
            spinner.succeed(color.green(`Cleaned up ${deletedCount} failed stack(s)`));
          }
        }

        if (!options.json) console.log(color.bold('\n2. Deploying infrastructure\n'));
        if (!options.json) spinner.start('Running CDK deploy (this may take 15-30 minutes)...');

        const repoRoot = findProjectRoot();
        const safeEnv = env.replace(/[^a-zA-Z0-9-]/g, '');

        await Bun.$`npx cdk deploy --all --require-approval never --context environment=${safeEnv} --context repositoryName=chimera`.cwd(
          `${repoRoot}/infra`
        );

        if (!options.json) spinner.succeed(color.green('Deployment complete'));

        if (options.reseed) {
          if (!options.json) console.log(color.bold('\n3. Reseeding DynamoDB tables\n'));
          const reseedPath = path.resolve(options.reseed);
          if (!fs.existsSync(reseedPath)) {
            throw new Error(`Reseed archive not found: ${reseedPath}`);
          }
          if (!options.json) spinner.start('Reimporting archived data...');
          await reseedFromArchive(reseedPath, region);
          if (!options.json) spinner.succeed(color.green(`Data reseeded from ${reseedPath}`));
        }

        const cur = loadWorkspaceConfig();
        saveWorkspaceConfig({
          ...cur,
          deployment: {
            ...cur.deployment,
            status: 'deployed',
            last_deployed: new Date().toISOString(),
          },
        });

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { env, region, deletedCount } }));
        } else {
          console.log(color.green('\n✓ Redeploy complete'));
          console.log(color.gray('\nNext step: Run "chimera status" to verify deployment health'));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(
            JSON.stringify({ status: 'error', error: error.message, code: 'REDEPLOY_FAILED' })
          );
          process.exit(1);
        }
        console.error(color.red('\n✗ Redeploy failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });
}
