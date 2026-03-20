/**
 * Tenant management commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { table } from 'table';
import { formatOutput, TenantConfig } from '../utils/output';
import { loadConfig, saveConfig } from '../utils/config';

export function registerTenantCommands(program: Command): void {
  const tenant = program
    .command('tenant')
    .description('Manage Chimera tenants');

  tenant
    .command('create')
    .description('Create a new tenant')
    .option('-n, --name <name>', 'Tenant name')
    .option('-t, --tier <tier>', 'Subscription tier (basic|advanced|enterprise)', 'basic')
    .option('--region <region>', 'AWS region', 'us-east-1')
    .action(async (options) => {
      const spinner = ora('Creating tenant').start();

      try {
        // Interactive prompts if options not provided
        let { name, tier, region } = options;

        if (!name) {
          const answers = await inquirer.prompt([
            {
              type: 'input',
              name: 'name',
              message: 'Tenant name:',
              validate: (input) => input.length > 0 || 'Name is required',
            },
            {
              type: 'list',
              name: 'tier',
              message: 'Subscription tier:',
              choices: ['basic', 'advanced', 'enterprise'],
              default: tier,
            },
            {
              type: 'input',
              name: 'region',
              message: 'AWS region:',
              default: region,
            },
          ]);
          name = answers.name;
          tier = answers.tier;
          region = answers.region;
        }

        // Generate tenant ID
        const tenantId = `tenant-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

        const tenantConfig: TenantConfig = {
          tenantId,
          name,
          tier,
          region,
          createdAt: new Date().toISOString(),
          status: 'active',
        };

        // Save to config
        const config = loadConfig();
        config.tenants = config.tenants || [];
        config.tenants.push(tenantConfig);
        config.currentTenant = tenantId;
        saveConfig(config);

        spinner.succeed(chalk.green(`Tenant created: ${tenantId}`));
        console.log(formatOutput(tenantConfig));
      } catch (error) {
        spinner.fail(chalk.red('Failed to create tenant'));
        throw error;
      }
    });

  tenant
    .command('list')
    .description('List all tenants')
    .action(() => {
      const config = loadConfig();
      const tenants = config.tenants || [];

      if (tenants.length === 0) {
        console.log(chalk.yellow('No tenants found. Create one with "chimera tenant create"'));
        return;
      }

      const data = [
        ['ID', 'Name', 'Tier', 'Region', 'Status', 'Created'],
        ...tenants.map((t) => [
          t.tenantId === config.currentTenant ? chalk.green(`${t.tenantId} *`) : t.tenantId,
          t.name,
          t.tier,
          t.region,
          t.status,
          new Date(t.createdAt).toLocaleString(),
        ]),
      ];

      console.log(table(data));
      console.log(chalk.gray(`* = current tenant`));
    });

  tenant
    .command('switch <tenant-id>')
    .description('Switch to a different tenant')
    .action((tenantId: string) => {
      const config = loadConfig();
      const tenant = config.tenants?.find((t) => t.tenantId === tenantId);

      if (!tenant) {
        console.error(chalk.red(`Tenant not found: ${tenantId}`));
        process.exit(1);
      }

      config.currentTenant = tenantId;
      saveConfig(config);

      console.log(chalk.green(`Switched to tenant: ${tenant.name} (${tenantId})`));
    });

  tenant
    .command('delete <tenant-id>')
    .description('Delete a tenant')
    .option('--force', 'Skip confirmation')
    .action(async (tenantId: string, options) => {
      const config = loadConfig();
      const tenant = config.tenants?.find((t) => t.tenantId === tenantId);

      if (!tenant) {
        console.error(chalk.red(`Tenant not found: ${tenantId}`));
        process.exit(1);
      }

      if (!options.force) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Delete tenant "${tenant.name}" (${tenantId})? This cannot be undone.`,
            default: false,
          },
        ]);

        if (!confirm) {
          console.log(chalk.yellow('Deletion cancelled'));
          return;
        }
      }

      config.tenants = config.tenants?.filter((t) => t.tenantId !== tenantId) || [];

      if (config.currentTenant === tenantId) {
        config.currentTenant = config.tenants[0]?.tenantId || null;
      }

      saveConfig(config);
      console.log(chalk.green(`Tenant deleted: ${tenantId}`));
    });
}
