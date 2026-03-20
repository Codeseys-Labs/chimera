/**
 * Session management commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { table } from 'table';
import { loadConfig } from '../utils/config';

export function registerSessionCommands(program: Command): void {
  const session = program
    .command('session')
    .description('Manage agent sessions');

  session
    .command('create')
    .description('Create a new agent session')
    .option('-u, --user <userId>', 'User ID')
    .option('-m, --model <model>', 'Model ID (e.g., claude-opus-4-6)', 'claude-sonnet-4-5')
    .action(async (options) => {
      const config = loadConfig();

      if (!config.currentTenant) {
        console.error(chalk.red('No tenant selected. Use "chimera tenant create" first.'));
        process.exit(1);
      }

      const spinner = ora('Creating session').start();

      try {
        const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        const sessionData = {
          sessionId,
          tenantId: config.currentTenant,
          userId: options.user || 'default-user',
          model: options.model,
          status: 'active',
          createdAt: new Date().toISOString(),
        };

        spinner.succeed(chalk.green(`Session created: ${sessionId}`));
        console.log(JSON.stringify(sessionData, null, 2));
      } catch (error) {
        spinner.fail(chalk.red('Failed to create session'));
        throw error;
      }
    });

  session
    .command('list')
    .description('List active sessions')
    .option('-u, --user <userId>', 'Filter by user ID')
    .action((options) => {
      const config = loadConfig();

      if (!config.currentTenant) {
        console.error(chalk.red('No tenant selected. Use "chimera tenant create" first.'));
        process.exit(1);
      }

      console.log(chalk.yellow('Querying active sessions...'));
      console.log(chalk.gray(`Tenant: ${config.currentTenant}`));

      if (options.user) {
        console.log(chalk.gray(`User filter: ${options.user}`));
      }

      // Mock data for demonstration
      const sessions = [
        ['Session ID', 'User', 'Model', 'Status', 'Created'],
        ['session-123', 'user-001', 'claude-sonnet-4-5', 'active', '2026-03-20 10:00'],
        ['session-456', 'user-002', 'claude-opus-4-6', 'active', '2026-03-20 11:30'],
      ];

      console.log(table(sessions));
    });

  session
    .command('terminate <session-id>')
    .description('Terminate an active session')
    .action(async (sessionId: string) => {
      const spinner = ora(`Terminating session ${sessionId}`).start();

      try {
        // Mock termination
        await new Promise((resolve) => setTimeout(resolve, 500));
        spinner.succeed(chalk.green(`Session terminated: ${sessionId}`));
      } catch (error) {
        spinner.fail(chalk.red('Failed to terminate session'));
        throw error;
      }
    });
}
