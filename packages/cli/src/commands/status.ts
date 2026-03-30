/**
 * Status command - Check deployment health
 */

import { Command } from 'commander';
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
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';

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
    return color.green(status);
  } else if (status.includes('PROGRESS')) {
    return color.yellow(status);
  } else if (status.includes('FAILED')) {
    return color.red(status);
  } else if (status === 'Succeeded') {
    return color.green(status);
  } else if (status === 'InProgress') {
    return color.yellow(status);
  } else if (status === 'Failed') {
    return color.red(status);
  }
  return color.gray(status);
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check Chimera deployment health and status')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--pipeline', 'Show pipeline execution status')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      const spinner = ora('Checking deployment status').start();
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

        if (!options.json) spinner.text = 'Fetching CloudFormation stack status...';
        const stacks = await getChimeraStacks(client, env);

        if (stacks.length === 0) {
          if (options.json) {
            console.log(JSON.stringify({ status: 'ok', data: { stacks: [], region, env } }));
          } else {
            spinner.warn(color.yellow('No stacks found'));
            console.log(color.gray(`No Chimera stacks found in ${region}`));
            console.log(color.gray('Run "chimera deploy" to deploy infrastructure'));
          }
          return;
        }

        let pipelineStatus: string | undefined;
        if (options.pipeline) {
          if (!options.json) spinner.text = 'Checking pipeline status...';
          const pipelineClient = new CodePipelineClient({ region });
          const pipelineName = `Chimera-${env}-Pipeline`;
          pipelineStatus = await getPipelineStatus(pipelineClient, pipelineName);
        }

        if (options.json) {
          console.log(JSON.stringify({
            status: 'ok',
            data: {
              stacks: stacks.map(s => ({
                name: s.name,
                status: s.status,
                lastUpdated: s.lastUpdated,
              })),
              pipelineStatus,
              endpoints: wsConfig?.endpoints,
            },
          }));
          return;
        }

        spinner.succeed(color.green('Stack status retrieved'));

        const tableData = [
          [color.bold('Stack'), color.bold('Status'), color.bold('Last Updated')],
          ...stacks.map((stack) => [
            stack.name,
            formatStatus(stack.status),
            stack.lastUpdated ? new Date(stack.lastUpdated).toLocaleString() : 'N/A',
          ]),
        ];

        console.log('\n' + table(tableData));

        if (options.pipeline && pipelineStatus !== undefined) {
          spinner.succeed(color.green('Pipeline status retrieved'));
          const pipelineName = `Chimera-${env}-Pipeline`;
          console.log(color.bold('\nPipeline Status:'));
          console.log(`  ${pipelineName}: ${formatStatus(pipelineStatus)}`);
        }

        const allComplete = stacks.every((s) => s.status.includes('COMPLETE'));
        const anyFailed = stacks.some((s) => s.status.includes('FAILED'));
        const anyInProgress = stacks.some((s) => s.status.includes('PROGRESS'));

        console.log(color.bold('\nSummary:'));
        if (allComplete) {
          console.log(color.green(`  ✓ All ${stacks.length} stacks deployed successfully`));
        } else if (anyFailed) {
          console.log(color.red(`  ✗ ${stacks.filter((s) => s.status.includes('FAILED')).length} stack(s) failed`));
        } else if (anyInProgress) {
          console.log(color.yellow(`  ⋯ ${stacks.filter((s) => s.status.includes('PROGRESS')).length} stack(s) in progress`));
        }

        if (wsConfig?.endpoints?.api_url) {
          console.log(color.gray(`\n  API Endpoint: ${wsConfig.endpoints.api_url}`));
        }
        if (wsConfig?.endpoints?.websocket_url) {
          console.log(color.gray(`  WebSocket:    ${wsConfig.endpoints.websocket_url}`));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'STATUS_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Status check failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });
}
