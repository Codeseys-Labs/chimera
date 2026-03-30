/**
 * Session management commands
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import { table } from 'table';
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { apiClient, guardAuth } from '../lib/api-client.js';
import { color } from '../lib/color.js';

interface Session {
  sessionId: string;
  tenantId: string;
  userId: string;
  model: string;
  status: string;
  createdAt: string;
}

export function registerSessionCommands(program: Command): void {
  const session = program
    .command('session')
    .description('Manage agent sessions');

  session
    .command('create')
    .description('Create a new agent session')
    .option('-u, --user <userId>', 'User ID')
    .option('-m, --model <model>', 'Model ID (e.g., claude-opus-4-6)', 'claude-sonnet-4-5')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      const wsConfig = loadWorkspaceConfig();

      if (!(wsConfig as any).current_tenant) {
        const msg = 'No tenant selected. Use "chimera tenant switch <id>" first.';
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_TENANT' }));
          process.exit(1);
        }
        console.error(color.red(msg));
        process.exit(1);
      }

      const spinner = ora('Creating session').start();
      if (options.json) spinner.stop();

      try {
        guardAuth();
        const created = await apiClient.post<Session>('/sessions', {
          tenantId: (wsConfig as any).current_tenant,
          userId: options.user || 'default-user',
          model: options.model,
        });

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: created }));
        } else {
          spinner.succeed(color.green(`Session created: ${created.sessionId}`));
          console.log(JSON.stringify(created, null, 2));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'SESSION_CREATE_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to create session'));
        console.error(color.red(error.message || 'An unexpected error occurred'));
        process.exit(1);
      }
    });

  session
    .command('list')
    .description('List active sessions')
    .option('-u, --user <userId>', 'Filter by user ID')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      const wsConfig = loadWorkspaceConfig();

      if (!(wsConfig as any).current_tenant) {
        const msg = 'No tenant selected. Use "chimera tenant switch <id>" first.';
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_TENANT' }));
          process.exit(1);
        }
        console.error(color.red(msg));
        process.exit(1);
      }

      const spinner = ora('Fetching sessions').start();
      if (options.json) spinner.stop();

      try {
        guardAuth();
        const url = options.user ? `/sessions?userId=${encodeURIComponent(options.user)}` : '/sessions';
        const sessions = await apiClient.get<Session[]>(url);

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: sessions }));
          return;
        }

        spinner.succeed(color.green('Sessions retrieved'));

        if (sessions.length === 0) {
          console.log(color.yellow('No active sessions found.'));
          return;
        }

        const rows = [
          ['Session ID', 'User', 'Model', 'Status', 'Created'],
          ...sessions.map((s) => [
            s.sessionId,
            s.userId,
            s.model,
            s.status,
            new Date(s.createdAt).toLocaleString(),
          ]),
        ];
        console.log(table(rows));
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'SESSION_LIST_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to list sessions'));
        console.error(color.red(error.message || 'An unexpected error occurred'));
        process.exit(1);
      }
    });

  session
    .command('terminate <session-id>')
    .description('Terminate an active session')
    .option('--force', 'Skip confirmation')
    .option('--json', 'Output result as JSON')
    .action(async (sessionId: string, options) => {
      if (!options.force && !options.json) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Terminate session "${sessionId}"?`,
            default: false,
          },
        ]);

        if (!confirm) {
          console.log(color.yellow('Termination cancelled'));
          return;
        }
      }

      const spinner = ora(`Terminating session ${sessionId}`).start();
      if (options.json) spinner.stop();

      try {
        guardAuth();
        await apiClient.delete(`/sessions/${encodeURIComponent(sessionId)}`);

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { sessionId } }));
        } else {
          spinner.succeed(color.green(`Session terminated: ${sessionId}`));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'SESSION_TERMINATE_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to terminate session'));
        console.error(color.red(error.message || 'An unexpected error occurred'));
        process.exit(1);
      }
    });
}
