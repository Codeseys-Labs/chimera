/**
 * Deployment lifecycle commands - destroy, cleanup, and redeploy
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  CloudFormationClient,
  ListStacksCommand,
  DeleteStackCommand,
  DescribeStackResourcesCommand,
  StackStatus,
} from '@aws-sdk/client-cloudformation';
import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import * as os from 'os';
import { loadConfig, saveConfig } from '../utils/config';

/**
 * Find project root by walking up directory tree looking for package.json
 * Pure Node.js approach - no git binary required
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not find project root (no package.json found). Run from within the project directory.');
}

/**
 * Clean up failed CloudFormation stacks in ROLLBACK_COMPLETE state
 * Shared by both cleanup and redeploy commands
 */
async function cleanupFailedStacks(
  client: CloudFormationClient,
  envName: string,
): Promise<number> {
  // List stacks in ROLLBACK_COMPLETE state
  const command = new ListStacksCommand({
    StackStatusFilter: [StackStatus.ROLLBACK_COMPLETE],
  });

  const response = await client.send(command);
  const prefix = `Chimera-${envName}-`;

  // Filter to Chimera stacks for this environment
  const failedStacks = (response.StackSummaries || [])
    .filter(stack => stack.StackName && stack.StackName.startsWith(prefix))
    .map(stack => stack.StackName!);

  // Delete each failed stack
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

  // Find all live Chimera stacks for this environment
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

  // Collect DynamoDB table physical IDs across all stacks
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

  // Scan and export each table
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

  // Write manifest
  const manifest = { tables, timestamp: new Date().toISOString(), env: options.env, region: options.region };
  fs.writeFileSync(
    path.join(archiveDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  // Record path of last archive for use by reseed/deploy
  const lastArchiveFile = path.join(os.homedir(), '.chimera', 'last-archive.json');
  fs.writeFileSync(
    lastArchiveFile,
    JSON.stringify({ path: archiveDir, timestamp: manifest.timestamp, env: options.env }),
    'utf8'
  );

  return archiveDir;
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
async function reseedFromArchive(archivePath: string, region: string): Promise<void> {
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

    // BatchWriteItem limit: 25 items per call
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await ddbClient.send(new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: batch.map((item) => ({
            PutRequest: { Item: item },
          })),
        },
      }));
    }
  }
}

export function registerDestroyCommands(program: Command): void {
  // chimera destroy - Tear down all CloudFormation stacks using CDK
  program
    .command('destroy')
    .description('Tear down all Chimera stacks from the AWS account')
    .option('--region <region>', 'AWS region', 'us-east-1')
    .option('--env <environment>', 'Environment name', 'dev')
    .option('--force', 'Skip confirmation prompt')
    .option('--retain-data', 'Export DynamoDB table data to a local archive before destroying')
    .option('--export-path <path>', 'Export destination (default: ~/.chimera/archives/<env>-<timestamp>)')
    .action(async (options) => {
      const spinner = ora('Starting Chimera destruction').start();

      try {
        const config = loadConfig();

        if (!config.deployment) {
          spinner.warn(chalk.yellow('No deployment configuration found'));
          console.log(chalk.gray('Nothing to destroy'));
          return;
        }

        // Confirmation prompt (unless --force flag provided)
        if (!options.force) {
          spinner.stop();

          // Dynamic import of inquirer for confirmation
          const inquirer = await import('inquirer');
          const answers = await inquirer.default.prompt([
            {
              type: 'confirm',
              name: 'confirmed',
              message: chalk.yellow('⚠️  WARNING: This will delete all Chimera infrastructure. Continue?'),
              default: false,
            },
          ]);

          if (!answers.confirmed) {
            console.log(chalk.gray('Destruction cancelled'));
            return;
          }

          spinner.start('Destroying infrastructure');
        }

        // Export data archive before destroying if --retain-data is set
        if (options.retainData) {
          spinner.text = 'Exporting data archive...';
          const archivePath = await exportDataArchive({
            env: options.env,
            region: options.region,
            exportPath: options.exportPath,
          });
          spinner.succeed(chalk.green(`Data archived to ${archivePath}`));
          console.log(chalk.gray('  Archive path saved to ~/.chimera/last-archive.json for reseeding'));
          spinner.start('Destroying infrastructure');
        }

        // Find project root
        const repoRoot = findProjectRoot();

        // Sanitize environment name to prevent command injection
        const safeEnv = options.env.replace(/[^a-zA-Z0-9-]/g, '');

        // Destroy stacks in reverse dependency order (must use npx — bunx breaks CDK instanceof checks)
        // safeEnv is sanitized: only [a-zA-Z0-9-] characters allowed
        for (const stackSuffix of STACK_DESTROY_ORDER) {
          const stackName = `Chimera-${safeEnv}-${stackSuffix}`;
          spinner.text = `Destroying ${stackName}...`;
          try {
            execSync(
              `cd infra && npx cdk destroy ${stackName} --force --context environment=${safeEnv}`,
              {
                cwd: repoRoot,
                stdio: ['pipe', 'pipe', 'pipe'],
              }
            );
          } catch {
            // Stack may not exist or already deleted — continue with remaining stacks
          }
        }

        spinner.succeed(chalk.green('All CloudFormation stacks destroyed'));

        // Clear deployment config
        config.deployment = undefined;
        saveConfig(config);

        console.log(chalk.green('\n✓ Infrastructure destroyed'));
      } catch (error: any) {
        spinner.fail(chalk.red('Destruction failed'));
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });

  // chimera cleanup - Delete stacks stuck in ROLLBACK_COMPLETE state
  program
    .command('cleanup')
    .description('Delete Chimera stacks stuck in ROLLBACK_COMPLETE state')
    .option('--region <region>', 'AWS region', 'us-east-1')
    .option('--env <environment>', 'Environment name', 'dev')
    .action(async (options) => {
      const spinner = ora('Starting cleanup').start();

      try {
        const client = new CloudFormationClient({ region: options.region });

        spinner.text = 'Scanning for failed stacks...';
        const deletedCount = await cleanupFailedStacks(client, options.env);

        if (deletedCount === 0) {
          spinner.succeed(chalk.green('No failed stacks found'));
          console.log(chalk.gray('All stacks are in a healthy state'));
        } else {
          spinner.succeed(chalk.green(`Cleaned up ${deletedCount} failed stack(s)`));
          console.log(chalk.green(`\n✓ Deleted ${deletedCount} stack(s) in ROLLBACK_COMPLETE state`));
        }
      } catch (error: any) {
        spinner.fail(chalk.red('Cleanup failed'));
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });

  // chimera redeploy - Clean up failed stacks then retry CDK deployment
  program
    .command('redeploy')
    .description('Clean up failed stacks then retry CDK deployment')
    .option('--region <region>', 'AWS region', 'us-east-1')
    .option('--env <environment>', 'Environment name', 'dev')
    .option('--reseed <path>', 'Reseed DynamoDB tables from exported data archive')
    .action(async (options) => {
      console.log(chalk.bold('Chimera Redeploy\n'));

      try {
        const config = loadConfig();
        const client = new CloudFormationClient({ region: options.region });

        // Step 1: Clean up failed stacks
        console.log(chalk.bold('1. Cleaning up failed stacks\n'));
        const spinner = ora('Scanning for failed stacks...').start();
        const deletedCount = await cleanupFailedStacks(client, options.env);

        if (deletedCount === 0) {
          spinner.succeed(chalk.green('No failed stacks found'));
        } else {
          spinner.succeed(chalk.green(`Cleaned up ${deletedCount} failed stack(s)`));
        }

        // Step 2: Deploy infrastructure
        console.log(chalk.bold('\n2. Deploying infrastructure\n'));
        spinner.start('Running CDK deploy (this may take 15-30 minutes)...');

        // Find project root
        const repoRoot = findProjectRoot();

        // Sanitize environment name to prevent command injection
        const safeEnv = options.env.replace(/[^a-zA-Z0-9-]/g, '');

        // Run CDK deploy
        execSync(
          `cd infra && npx cdk deploy --all --require-approval never --context environment=${safeEnv} --context repositoryName=chimera`,
          {
            cwd: repoRoot,
            stdio: 'inherit',
          }
        );

        spinner.succeed(chalk.green('Deployment complete'));

        // Step 3: Reseed from archive (optional)
        if (options.reseed) {
          console.log(chalk.bold('\n3. Reseeding DynamoDB tables\n'));
          const reseedPath = path.resolve(options.reseed);
          if (!fs.existsSync(reseedPath)) {
            throw new Error(`Reseed archive not found: ${reseedPath}`);
          }
          spinner.start('Reimporting archived data...');
          await reseedFromArchive(reseedPath, options.region);
          spinner.succeed(chalk.green(`Data reseeded from ${reseedPath}`));
        }

        // Update config
        if (!config.deployment) {
          config.deployment = {
            accountId: '',
            region: options.region,
            repositoryName: 'chimera',
            status: 'deployed',
            lastDeployed: new Date().toISOString(),
          };
        } else {
          config.deployment.status = 'deployed';
          config.deployment.lastDeployed = new Date().toISOString();
        }
        saveConfig(config);

        console.log(chalk.green('\n✓ Redeploy complete'));
        console.log(chalk.gray('\nNext step: Run "chimera status" to verify deployment health'));
      } catch (error: any) {
        console.error(chalk.red('\n✗ Redeploy failed'));
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}
