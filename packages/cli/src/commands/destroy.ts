/**
 * Deployment lifecycle commands - destroy, cleanup, and redeploy
 *
 * CDK runs via `npx cdk` (spawned by Bun.$) to preserve Node.js module resolution.
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
  CodeCommitClient,
  DeleteRepositoryCommand,
} from '@aws-sdk/client-codecommit';
import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
  type AttributeValue,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import * as os from 'os';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';
import { findProjectRoot } from '../utils/project.js';

/**
 * Clean up failed CloudFormation stacks in ROLLBACK_COMPLETE state
 */
async function cleanupFailedStacks(
  client: CloudFormationClient,
  envName: string,
): Promise<number> {
  const command = new ListStacksCommand({
    StackStatusFilter: [StackStatus.ROLLBACK_COMPLETE],
  });

  const response = await client.send(command);
  const prefix = `Chimera-${envName}-`;

  const failedStacks = (response.StackSummaries || [])
    .filter(stack => stack.StackName && stack.StackName.startsWith(prefix))
    .map(stack => stack.StackName!);

  for (const stackName of failedStacks) {
    await client.send(new DeleteStackCommand({ StackName: stackName }));
  }

  return failedStacks.length;
}

/**
 * Export DynamoDB tables from all Chimera stacks for the given environment.
 * Archives are written to ~/.chimera/archives/<env>-<timestamp>/.
 * Returns the archive directory path.
 */
async function exportDataArchive(options: { env: string; region: string; exportPath?: string }): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultDir = path.join(os.homedir(), '.chimera', 'archives', `${options.env}-${timestamp}`);
  const archiveDir = options.exportPath
    ? path.resolve(options.exportPath)
    : defaultDir;
  fs.mkdirSync(archiveDir, { recursive: true });

  const cfClient = new CloudFormationClient({ region: options.region });
  const ddbClient = new DynamoDBClient({ region: options.region });

  const listResp = await cfClient.send(new ListStacksCommand({
    StackStatusFilter: [
      StackStatus.CREATE_COMPLETE,
      StackStatus.UPDATE_COMPLETE,
      StackStatus.UPDATE_ROLLBACK_COMPLETE,
      StackStatus.ROLLBACK_COMPLETE,
    ],
  }));

  const prefix = `Chimera-${options.env}-`;
  const stacks = (listResp.StackSummaries || [])
    .filter(s => s.StackName?.startsWith(prefix))
    .map(s => s.StackName!);

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
      const scanResp = await ddbClient.send(new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey,
      }));
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

  const manifest = { tables, timestamp: new Date().toISOString(), env: options.env, region: options.region };
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
 * Poll CloudFormation stack events every 10 seconds and print new entries.
 * Stops when stopSignal.done is set (caller sets it after CDK process exits).
 * Uses a seen-set to avoid re-printing events across poll cycles.
 */
async function monitorStackEvents(
  client: CloudFormationClient,
  stackName: string,
  stopSignal: { done: boolean },
): Promise<void> {
  const seen = new Set<string>();

  while (!stopSignal.done) {
    try {
      const resp = await client.send(new DescribeStackEventsCommand({ StackName: stackName }));
      const events = resp.StackEvents ?? [];

      // Emit only new events, oldest first
      for (const event of [...events].reverse()) {
        if (event.EventId && !seen.has(event.EventId)) {
          seen.add(event.EventId);
          const ts = event.Timestamp?.toISOString().replace('T', ' ').slice(0, 19) ?? '';
          const status = event.ResourceStatus ?? '';
          const reason = event.ResourceStatusReason ? ` — ${event.ResourceStatusReason}` : '';
          const statusStr = status.includes('FAILED')
            ? color.red(status)
            : status.includes('COMPLETE')
              ? color.green(status)
              : color.gray(status);
          console.log(`  ${color.gray(ts)} ${event.LogicalResourceId} ${statusStr}${reason}`);
        }
      }
    } catch {
      // Stack may be fully deleted mid-poll — exit gracefully
      break;
    }

    await new Promise<void>(r => setTimeout(r, 10_000));
  }
}

/**
 * Delete the CodeCommit repository created by chimera deploy.
 * The repo is not CDK-managed (created via SDK in deploy.ts), so CDK destroy
 * leaves it orphaned — we must delete it explicitly here.
 */
async function deleteCodeCommitRepo(
  client: CodeCommitClient,
  repoName: string,
  keepRepo: boolean,
): Promise<void> {
  if (keepRepo) {
    return;
  }
  try {
    await client.send(new DeleteRepositoryCommand({ repositoryName: repoName }));
  } catch (error: any) {
    if (error.name !== 'RepositoryDoesNotExistException') {
      throw error;
    }
    // Repo already gone — nothing to do
  }
}

/**
 * Reverse dependency order for stack teardown (most dependent stacks first)
 */
const STACK_DESTROY_ORDER = [
  'TenantOnboarding', 'Evolution', 'Orchestration', 'Chat',
  'SkillPipeline', 'Api', 'Observability', 'Pipeline',
  'Data', 'Security', 'Network',
];

/**
 * Reseed DynamoDB tables from a local archive produced by exportDataArchive.
 * Items are in DynamoDB wire format (AttributeValue) so they can be used
 * directly in PutRequest.Item without further marshalling.
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
        const response = await ddbClient.send(new BatchWriteItemCommand({ RequestItems: requestItems }));
        const unprocessed = response.UnprocessedItems?.[tableName];
        if (!unprocessed || unprocessed.length === 0) break;
        if (attempt === MAX_RETRIES) {
          throw new Error(
            `BatchWriteItem failed after ${MAX_RETRIES} retries: ${unprocessed.length} items unprocessed in table "${tableName}"`
          );
        }
        await new Promise<void>(resolve => setTimeout(resolve, delay));
        delay *= 2;
        requestItems = { [tableName]: unprocessed };
      }
    }
  }
}

export function registerDestroyCommands(program: Command): void {
  // chimera destroy — Tear down all CloudFormation stacks
  program
    .command('destroy')
    .description('Tear down all Chimera stacks from the AWS account')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--force', 'Skip confirmation prompt')
    .option('--retain-data', 'Export DynamoDB table data to a local archive before destroying')
    .option('--export-path <path>', 'Export destination (default: ~/.chimera/archives/<env>-<timestamp>)')
    .option('--keep-repo', 'Preserve the CodeCommit repository (skip deletion)')
    .option('--monitor', 'Stream CloudFormation stack events in real-time during destruction')
    .option('--json', 'Output result as JSON')
    .addHelpText('after', `
Examples:
  $ chimera destroy
  $ chimera destroy --force --env prod
  $ chimera destroy --retain-data --export-path ./backup
  $ chimera destroy --json`)
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
        if (wsConfig?.aws?.profile) { process.env.AWS_PROFILE = wsConfig.aws.profile; }

        if (!wsConfig.deployment) {
          if (options.json) {
            console.log(JSON.stringify({ status: 'ok', data: { message: 'Nothing to destroy' } }));
          } else {
            spinner.warn(color.yellow('No deployment configuration found'));
            console.log(color.gray('Nothing to destroy'));
          }
          return;
        }

        if (!options.force && !options.json) {
          spinner.stop();
          const inquirer = await import('inquirer');
          const answers = await inquirer.default.prompt([
            {
              type: 'confirm',
              name: 'confirmed',
              message: color.yellow('⚠️  WARNING: This will delete all Chimera infrastructure. Continue?'),
              default: false,
            },
          ]);

          if (!answers.confirmed) {
            console.log(color.gray('Destruction cancelled'));
            return;
          }

          spinner.start('Destroying infrastructure');
        }

        let archivePath: string | undefined;
        if (options.retainData) {
          if (!options.json) spinner.text = 'Exporting data archive...';
          archivePath = await exportDataArchive({ env, region, exportPath: options.exportPath });
          if (!options.json) {
            spinner.succeed(color.green(`Data archived to ${archivePath}`));
            console.log(color.gray('  Archive path saved to ~/.chimera/last-archive.json for reseeding'));
            spinner.start('Destroying infrastructure');
          }
        }

        const repoRoot = findProjectRoot();
        const safeEnv = env.replace(/[^a-zA-Z0-9-]/g, '');
        const repoName = wsConfig?.workspace?.repository ?? 'chimera';
        const cfClient = new CloudFormationClient({ region });

        if (options.monitor && !options.json) {
          spinner.stop();
          console.log(color.bold('\nMonitoring CloudFormation events (Ctrl-C to abort):\n'));
        } else if (!options.json) {
          console.log(color.gray("  Tip: use --monitor to stream CloudFormation events in real-time"));
        }

        for (const stackSuffix of STACK_DESTROY_ORDER) {
          const stackName = `Chimera-${safeEnv}-${stackSuffix}`;
          if (!options.json && !options.monitor) spinner.text = `Destroying ${stackName}...`;
          if (!options.json && options.monitor) console.log(color.bold(`\n→ Destroying ${stackName}`));

          if (options.monitor && !options.json) {
            // Run CDK destroy in background so we can poll events in parallel
            const stopSignal = { done: false };
            const monitorPromise = monitorStackEvents(cfClient, stackName, stopSignal);
            const proc = Bun.spawn(
              ['npx', 'cdk', 'destroy', stackName, '--force', '--context', `environment=${safeEnv}`],
              { cwd: `${repoRoot}/infra`, stdout: 'ignore', stderr: 'ignore' },
            );
            await proc.exited;
            stopSignal.done = true;
            await monitorPromise;
          } else {
            try {
              // npx spawns Node.js — CDK module resolution works correctly
              await Bun.$`npx cdk destroy ${stackName} --force --context environment=${safeEnv}`
                .cwd(`${repoRoot}/infra`)
                .quiet()
                .nothrow();
            } catch { /* Stack may not exist — continue */ }
          }
        }

        if (!options.json && !options.monitor) spinner.succeed(color.green('All CloudFormation stacks destroyed'));
        if (!options.json && options.monitor) console.log(color.bold('\n✓ All CloudFormation stacks destroyed'));

        // Delete CodeCommit repo after CDK stacks are gone (Pipeline must be
        // destroyed first so the repo is no longer referenced by any trigger).
        if (!options.json) spinner.start(`Deleting CodeCommit repository "${repoName}"...`);
        const ccClient = new CodeCommitClient({ region });
        await deleteCodeCommitRepo(ccClient, repoName, !!options.keepRepo);
        if (!options.json) {
          if (options.keepRepo) {
            spinner.info(color.gray(`CodeCommit repository "${repoName}" preserved (--keep-repo)`));
          } else {
            spinner.succeed(color.green(`CodeCommit repository "${repoName}" deleted`));
          }
        }

        const cur = loadWorkspaceConfig();
        saveWorkspaceConfig({ ...cur, deployment: undefined });

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { env, region, repoName, repoDeleted: !options.keepRepo, archivePath } }));
        } else {
          console.log(color.green('\n✓ Infrastructure destroyed'));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'DESTROY_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Destruction failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });

  // chimera cleanup — Delete stacks stuck in ROLLBACK_COMPLETE state
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
        if (wsConfig?.aws?.profile) { process.env.AWS_PROFILE = wsConfig.aws.profile; }

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
          console.log(color.green(`\n✓ Deleted ${deletedCount} stack(s) in ROLLBACK_COMPLETE state`));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'CLEANUP_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Cleanup failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });

  // chimera redeploy — Clean up failed stacks then retry CDK deployment
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
        if (wsConfig?.aws?.profile) { process.env.AWS_PROFILE = wsConfig.aws.profile; }

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

        // npx spawns Node.js — CDK module resolution works correctly
        await Bun.$`npx cdk deploy --all --require-approval never --context environment=${safeEnv} --context repositoryName=chimera`
          .cwd(`${repoRoot}/infra`);

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
          deployment: { ...cur.deployment, status: 'deployed', last_deployed: new Date().toISOString() },
        });

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { env, region, deletedCount } }));
        } else {
          console.log(color.green('\n✓ Redeploy complete'));
          console.log(color.gray('\nNext step: Run "chimera status" to verify deployment health'));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'REDEPLOY_FAILED' }));
          process.exit(1);
        }
        console.error(color.red('\n✗ Redeploy failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });
}
