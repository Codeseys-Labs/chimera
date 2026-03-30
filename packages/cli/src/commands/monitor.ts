/**
 * Monitor command - Watch active CloudFormation stack operations in real-time.
 *
 * Polls DescribeStackEvents every 10 seconds (configurable) and streams events
 * to the terminal until all watched stacks reach a terminal state.
 *
 * Usage:
 *   chimera monitor                    # auto-detect active stacks for current env
 *   chimera monitor --stack MyStack    # watch a specific stack by name
 *   chimera monitor --env prod         # watch prod environment
 *   chimera monitor --interval 5       # poll every 5 seconds
 */

import { Command } from 'commander';
import ora from 'ora';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';
import { monitorStack, findActiveStacks, type MonitorOutcome } from '../utils/cf-monitor.js';

export function registerMonitorCommand(program: Command): void {
  program
    .command('monitor')
    .description('Watch active CloudFormation stack operations in real-time')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--stack <stack>', 'Monitor a specific stack by full name (skips auto-detection)')
    .option('--interval <seconds>', 'Polling interval in seconds (default: 10)', '10')
    .option('--history', 'Show all historical events, not just new ones')
    .option('--json', 'Output result as JSON')
    .addHelpText('after', `
Examples:
  $ chimera monitor
  $ chimera monitor --env prod
  $ chimera monitor --stack Chimera-dev-Api
  $ chimera monitor --interval 5 --history
  $ chimera monitor --json`)
    .action(async (options) => {
      const spinner = ora('Checking for active stacks').start();
      if (options.json) spinner.stop();

      // Stop spinner cleanly on Ctrl+C
      process.on('SIGINT', () => {
        if (!options.json) console.log(color.gray('\n\nMonitoring stopped'));
        process.exit(0);
      });

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

        const pollMs = Math.max(1_000, parseInt(options.interval, 10) * 1_000);
        const showHistory: boolean = options.history ?? false;

        const client = new CloudFormationClient({ region });

        let stackNames: string[];

        if (options.stack) {
          stackNames = [options.stack as string];
          if (!options.json) spinner.succeed(color.green(`Monitoring stack: ${options.stack}`));
        } else {
          const safeEnv = env.replace(/[^a-zA-Z0-9-]/g, '');
          const envPrefix = `Chimera-${safeEnv}-`;
          stackNames = await findActiveStacks(client, envPrefix);

          if (stackNames.length === 0) {
            if (options.json) {
              console.log(JSON.stringify({
                status: 'ok',
                data: { active: [], message: 'No active stacks found' },
              }));
            } else {
              spinner.warn(color.yellow('No active CloudFormation operations found'));
              console.log(color.gray(`\nNo Chimera-${safeEnv}-* stacks are currently in progress.`));
              console.log(color.gray('Run "chimera status" to see all stack states.'));
            }
            return;
          }

          if (!options.json) {
            spinner.succeed(color.green(`Found ${stackNames.length} active stack(s)`));
            for (const name of stackNames) {
              console.log(color.gray(`  • ${name}`));
            }
          }
        }

        if (!options.json) {
          console.log(color.gray(`\nStreaming events every ${pollMs / 1_000}s (Ctrl+C to stop)...\n`));
        }

        // Monitor stacks sequentially — each gets a clear header block.
        // Sequential ordering keeps output readable; CDK typically progresses
        // through stacks in a defined dependency order anyway.
        const results: Array<{ stackName: string; outcome: MonitorOutcome }> = [];

        for (const stackName of stackNames) {
          if (!options.json) {
            console.log(color.bold(`\n┌─ ${stackName} ${'─'.repeat(Math.max(0, 60 - stackName.length))}`));
          }

          const outcome = await monitorStack(client, stackName, pollMs, showHistory);
          results.push({ stackName, outcome });

          if (!options.json) {
            const icon = outcome === 'complete' ? color.green('✓') : outcome === 'not_found' ? color.yellow('?') : color.red('✗');
            console.log(color.bold(`└─ ${stackName}: ${icon}`));
          }
        }

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { results, env, region } }));
        } else {
          const anyFailed = results.some(r => r.outcome === 'failed');
          const anyNotFound = results.some(r => r.outcome === 'not_found');

          console.log(color.bold('\n─── Summary ───'));
          for (const { stackName, outcome } of results) {
            const shortName = stackName.replace(`Chimera-${env.replace(/[^a-zA-Z0-9-]/g, '')}-`, '');
            const label = outcome === 'complete'
              ? color.green('✓ complete')
              : outcome === 'not_found'
                ? color.yellow('? not found')
                : color.red('✗ failed');
            console.log(`  ${label}  ${color.gray(shortName)}`);
          }

          if (anyFailed) {
            console.log(color.red('\nOne or more stacks failed. Run "chimera status" for details.'));
            process.exit(1);
          } else if (anyNotFound) {
            console.log(color.yellow('\nOne or more stacks were not found.'));
          } else {
            console.log(color.green('\nAll stacks completed successfully.'));
          }
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'MONITOR_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Monitor failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });
}
