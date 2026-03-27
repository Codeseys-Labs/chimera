/**
 * Skill management commands
 */

import { Command } from 'commander';
import ora from 'ora';
import { table } from 'table';
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { apiClient } from '../lib/api-client.js';
import { color } from '../lib/color.js';

interface Skill {
  name: string;
  version: string;
  category: string;
  status: string;
}

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command('skill')
    .description('Manage agent skills');

  skill
    .command('list')
    .description('List installed skills')
    .option('--category <category>', 'Filter by category')
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

      const spinner = ora('Fetching skills').start();
      if (options.json) spinner.stop();

      try {
        const url = options.category
          ? `/skills?category=${encodeURIComponent(options.category)}`
          : '/skills';
        const skills = await apiClient.get<Skill[]>(url);

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: skills }));
          return;
        }

        spinner.succeed(color.green('Skills retrieved'));

        if (skills.length === 0) {
          console.log(color.yellow('No skills installed.'));
          return;
        }

        const rows = [
          ['Skill Name', 'Version', 'Category', 'Status'],
          ...skills.map((s) => [s.name, s.version, s.category, s.status]),
        ];
        console.log(table(rows));
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'SKILL_LIST_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to list skills'));
        throw error;
      }
    });

  skill
    .command('install <skill-name>')
    .description('Install a skill from the marketplace')
    .option('-v, --version <version>', 'Skill version', 'latest')
    .option('--json', 'Output result as JSON')
    .action(async (skillName: string, options) => {
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

      const spinner = ora(`Installing skill: ${skillName}@${options.version}`).start();
      if (options.json) spinner.stop();

      try {
        const installed = await apiClient.post<Skill>('/skills', {
          name: skillName,
          version: options.version,
          tenantId: (wsConfig as any).current_tenant,
        });

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: installed }));
        } else {
          spinner.succeed(color.green(`Skill installed: ${skillName}@${options.version}`));
          console.log(color.gray('Run "chimera skill enable <skill-name>" to activate'));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'SKILL_INSTALL_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to install skill'));
        throw error;
      }
    });

  skill
    .command('enable <skill-name>')
    .description('Enable an installed skill')
    .option('--json', 'Output result as JSON')
    .action(async (skillName: string, options) => {
      const spinner = ora(`Enabling skill: ${skillName}`).start();
      if (options.json) spinner.stop();

      try {
        // Enable via PATCH /skills/:name or similar — endpoint TBD per API spec
        await apiClient.post(`/skills/${encodeURIComponent(skillName)}/enable`, {});

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { name: skillName, status: 'enabled' } }));
        } else {
          spinner.succeed(color.green(`Skill enabled: ${skillName}`));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'SKILL_ENABLE_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to enable skill'));
        throw error;
      }
    });

  skill
    .command('disable <skill-name>')
    .description('Disable a skill')
    .option('--json', 'Output result as JSON')
    .action(async (skillName: string, options) => {
      const spinner = ora(`Disabling skill: ${skillName}`).start();
      if (options.json) spinner.stop();

      try {
        await apiClient.post(`/skills/${encodeURIComponent(skillName)}/disable`, {});

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { name: skillName, status: 'disabled' } }));
        } else {
          spinner.succeed(color.green(`Skill disabled: ${skillName}`));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'SKILL_DISABLE_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to disable skill'));
        throw error;
      }
    });

  skill
    .command('uninstall <skill-name>')
    .description('Uninstall a skill')
    .option('--force', 'Skip confirmation')
    .option('--json', 'Output result as JSON')
    .action(async (skillName: string, options) => {
      const spinner = ora(`Uninstalling skill: ${skillName}`).start();
      if (options.json) spinner.stop();

      try {
        await apiClient.delete(`/skills/${encodeURIComponent(skillName)}`);

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { name: skillName } }));
        } else {
          spinner.succeed(color.green(`Skill uninstalled: ${skillName}`));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'SKILL_UNINSTALL_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to uninstall skill'));
        throw error;
      }
    });
}
