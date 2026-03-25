/**
 * Status command - Check deployment health
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { table } from 'table';
import {
  CloudFormationClient,
  ListStacksCommand,
  StackStatus,
} from '@aws-sdk/client-cloudformation';
import {
  CodePipelineClient,
  GetPipelineStateCommand,
} from '@aws-sdk/client-codepipeline';
import { loadWorkspaceConfig } from '../utils/workspace';

interface StackInfo {
  name: string;
  status: string;
  lastUpdated?: string;
}

/**
 * Get all Chimera stacks
 */
async function getChimeraStacks(
  client: CloudFormationClient,
  envName: string,
): Promise<StackInfo[]> {
  try {
    const command = new ListStacksCommand({
      StackStatusFilter: [
        StackStatus.CREATE_COMPLETE,
        StackStatus.UPDATE_COMPLETE,
        StackStatus.UPDATE_ROLLBACK_COMPLETE,
        StackStatus.CREATE_IN_PROGRESS,
        StackStatus.UPDATE_IN_PROGRESS,
        StackStatus.CREATE_FAILED,
        StackStatus.UPDATE_FAILED,
      ],
    });

    const response = await client.send(command);
    const stacks: StackInfo[] = [];

    const prefix = `Chimera-${envName}-`;

    for (const stack of response.StackSummaries || []) {
      if (stack.StackName && stack.StackName.startsWith(prefix) && stack.StackStatus) {
        stacks.push({
          name: stack.StackName.replace(prefix, ''),
          status: stack.StackStatus,
          lastUpdated: stack.LastUpdatedTime?.toISOString() || stack.CreationTime?.toISOString(),
        });
      }
    }

    // Sort by standard deployment order
    const order = ['Network', 'Data', 'Security', 'Observability', 'Api', 'SkillPipeline', 'Chat', 'Orchestration', 'Evolution', 'TenantOnboarding', 'Pipeline'];
    stacks.sort((a, b) => {
      const aIndex = order.indexOf(a.name);
      const bIndex = order.indexOf(b.name);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    });

    return stacks;
  } catch (error: any) {
    throw new Error(`Failed to list stacks: ${error.message}`);
  }
}

/**
 * Get pipeline execution status
 */
async function getPipelineStatus(
  client: CodePipelineClient,
  pipelineName: string,
): Promise<string> {
  try {
    const command = new GetPipelineStateCommand({ name: pipelineName });
    const response = await client.send(command);

    if (!response.stageStates || response.stageStates.length === 0) {
      return 'No executions';
    }

    // Get latest execution status from first stage
    const latestExecution = response.stageStates[0].latestExecution;
    return latestExecution?.status || 'Unknown';
  } catch (error: any) {
    if (error.name === 'PipelineNotFoundException') {
      return 'Not found';
    }
    return 'Error';
  }
}

/**
 * Format status with color
 */
function formatStatus(status: string): string {
  if (status.includes('COMPLETE')) {
    return chalk.green(status);
  } else if (status.includes('PROGRESS')) {
    return chalk.yellow(status);
  } else if (status.includes('FAILED')) {
    return chalk.red(status);
  } else if (status === 'Succeeded') {
    return chalk.green(status);
  } else if (status === 'InProgress') {
    return chalk.yellow(status);
  } else if (status === 'Failed') {
    return chalk.red(status);
  }
  return chalk.gray(status);
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check Chimera deployment health and status')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--pipeline', 'Show pipeline execution status')
    .action(async (options) => {
      const spinner = ora('Checking deployment status').start();

      try {
        const wsConfig = loadWorkspaceConfig();
        const region = options.region ?? wsConfig?.aws?.region ?? 'us-east-1';
        const env = options.env ?? wsConfig?.workspace?.environment ?? 'dev';
        if (wsConfig?.aws?.profile) { process.env.AWS_PROFILE = wsConfig.aws.profile; }

        if (!wsConfig?.aws?.region && !options.region) {
          spinner.warn(chalk.yellow('No workspace configuration found'));
          return;
        }

        const client = new CloudFormationClient({ region });

        // Get stack statuses
        spinner.text = 'Fetching CloudFormation stack status...';
        const stacks = await getChimeraStacks(client, env);

        if (stacks.length === 0) {
          spinner.warn(chalk.yellow('No stacks found'));
          console.log(chalk.gray(`No Chimera stacks found in ${region}`));
          console.log(chalk.gray('Run "chimera deploy" to deploy infrastructure'));
          return;
        }

        spinner.succeed(chalk.green('Stack status retrieved'));

        // Display stack table
        const tableData = [
          [chalk.bold('Stack'), chalk.bold('Status'), chalk.bold('Last Updated')],
          ...stacks.map((stack) => [
            stack.name,
            formatStatus(stack.status),
            stack.lastUpdated ? new Date(stack.lastUpdated).toLocaleString() : 'N/A',
          ]),
        ];

        console.log('\n' + table(tableData));

        // Get pipeline status if requested
        if (options.pipeline) {
          spinner.start('Checking pipeline status...');
          const pipelineClient = new CodePipelineClient({ region });
          const pipelineName = `Chimera-${env}-Pipeline`;
          const pipelineStatus = await getPipelineStatus(pipelineClient, pipelineName);
          spinner.succeed(chalk.green('Pipeline status retrieved'));

          console.log(chalk.bold('\nPipeline Status:'));
          console.log(`  ${pipelineName}: ${formatStatus(pipelineStatus)}`);
        }

        // Display summary
        const allComplete = stacks.every((s) => s.status.includes('COMPLETE'));
        const anyFailed = stacks.some((s) => s.status.includes('FAILED'));
        const anyInProgress = stacks.some((s) => s.status.includes('PROGRESS'));

        console.log(chalk.bold('\nSummary:'));
        if (allComplete) {
          console.log(chalk.green(`  ✓ All ${stacks.length} stacks deployed successfully`));
        } else if (anyFailed) {
          console.log(chalk.red(`  ✗ ${stacks.filter((s) => s.status.includes('FAILED')).length} stack(s) failed`));
        } else if (anyInProgress) {
          console.log(chalk.yellow(`  ⋯ ${stacks.filter((s) => s.status.includes('PROGRESS')).length} stack(s) in progress`));
        }

        if (wsConfig?.endpoints?.api_url) {
          console.log(chalk.gray(`\n  API Endpoint: ${wsConfig.endpoints.api_url}`));
        }
        if (wsConfig?.endpoints?.websocket_url) {
          console.log(chalk.gray(`  WebSocket:    ${wsConfig.endpoints.websocket_url}`));
        }
      } catch (error: any) {
        spinner.fail(chalk.red('Status check failed'));
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}
