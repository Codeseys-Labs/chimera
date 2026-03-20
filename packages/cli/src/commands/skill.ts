/**
 * Skill management commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { table } from 'table';
import { loadConfig } from '../utils/config';

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command('skill')
    .description('Manage agent skills');

  skill
    .command('list')
    .description('List installed skills')
    .option('--category <category>', 'Filter by category')
    .action((options) => {
      const config = loadConfig();

      if (!config.currentTenant) {
        console.error(chalk.red('No tenant selected. Use "chimera tenant create" first.'));
        process.exit(1);
      }

      console.log(chalk.yellow('Querying installed skills...'));
      console.log(chalk.gray(`Tenant: ${config.currentTenant}`));

      if (options.category) {
        console.log(chalk.gray(`Category filter: ${options.category}`));
      }

      // Mock data for demonstration
      const skills = [
        ['Skill Name', 'Version', 'Category', 'Status'],
        ['web-search', '1.0.0', 'research', 'enabled'],
        ['code-review', '2.1.0', 'development', 'enabled'],
        ['data-analysis', '1.5.0', 'analytics', 'disabled'],
      ];

      console.log(table(skills));
    });

  skill
    .command('install <skill-name>')
    .description('Install a skill from the marketplace')
    .option('-v, --version <version>', 'Skill version', 'latest')
    .action(async (skillName: string, options) => {
      const config = loadConfig();

      if (!config.currentTenant) {
        console.error(chalk.red('No tenant selected. Use "chimera tenant create" first.'));
        process.exit(1);
      }

      const spinner = ora(`Installing skill: ${skillName}@${options.version}`).start();

      try {
        // Mock installation
        await new Promise((resolve) => setTimeout(resolve, 1000));

        spinner.succeed(chalk.green(`Skill installed: ${skillName}@${options.version}`));
        console.log(chalk.gray('Run "chimera skill enable <skill-name>" to activate'));
      } catch (error) {
        spinner.fail(chalk.red('Failed to install skill'));
        throw error;
      }
    });

  skill
    .command('enable <skill-name>')
    .description('Enable an installed skill')
    .action(async (skillName: string) => {
      const spinner = ora(`Enabling skill: ${skillName}`).start();

      try {
        // Mock enable
        await new Promise((resolve) => setTimeout(resolve, 300));
        spinner.succeed(chalk.green(`Skill enabled: ${skillName}`));
      } catch (error) {
        spinner.fail(chalk.red('Failed to enable skill'));
        throw error;
      }
    });

  skill
    .command('disable <skill-name>')
    .description('Disable a skill')
    .action(async (skillName: string) => {
      const spinner = ora(`Disabling skill: ${skillName}`).start();

      try {
        // Mock disable
        await new Promise((resolve) => setTimeout(resolve, 300));
        spinner.succeed(chalk.green(`Skill disabled: ${skillName}`));
      } catch (error) {
        spinner.fail(chalk.red('Failed to disable skill'));
        throw error;
      }
    });

  skill
    .command('uninstall <skill-name>')
    .description('Uninstall a skill')
    .option('--force', 'Skip confirmation')
    .action(async (skillName: string) => {
      const spinner = ora(`Uninstalling skill: ${skillName}`).start();

      try {
        // Mock uninstall
        await new Promise((resolve) => setTimeout(resolve, 500));
        spinner.succeed(chalk.green(`Skill uninstalled: ${skillName}`));
      } catch (error) {
        spinner.fail(chalk.red('Failed to uninstall skill'));
        throw error;
      }
    });
}
