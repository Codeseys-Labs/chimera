/**
 * Tenant management commands
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import { table } from 'table';
import { formatOutput } from '../utils/output.js';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../utils/workspace.js';
import { apiClient, guardAuth } from '../lib/api-client.js';
import { color } from '../lib/color.js';

interface Tenant {
  tenantId: string;
  name: string;
  tier: string;
  region: string;
  status: string;
  createdAt: string;
}

export function registerTenantCommands(program: Command): void {
  const tenant = program
    .command('tenant')
    .description('Manage Chimera tenants')
    .addHelpText('after', `
Examples:
  $ chimera tenant list                       # list all tenants
  $ chimera tenant create -n "My Org"         # create a tenant
  $ chimera tenant switch ten-abc123          # switch active tenant
  $ chimera tenant delete ten-abc123 --force  # delete without prompt
  $ chimera tenant list --json                # machine-readable list`);

  tenant
    .command('create')
    .description('Create a new tenant')
    .option('-n, --name <name>', 'Tenant name')
    .option('-t, --tier <tier>', 'Subscription tier (basic|advanced|premium)', 'basic')
    .option('--region <region>', 'AWS region', 'us-east-1')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      const spinner = ora('Creating tenant').start();
      if (options.json) spinner.stop();

      try {
        let { name, tier, region } = options;

        if (!name && !options.json) {
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
              choices: ['basic', 'advanced', 'premium'],
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

        if (!name) {
          const msg = 'Tenant name is required. Use -n flag or run without --json for interactive mode.';
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'MISSING_NAME' }));
            process.exit(1);
          }
          throw new Error(msg);
        }

        guardAuth();
        const created = await apiClient.post<Tenant>('/tenants', {
          name,
          tier,
          deploymentModel: region,
        });

        // Track current tenant in workspace config
        const wsConfig = loadWorkspaceConfig();
        saveWorkspaceConfig({ ...wsConfig, current_tenant: created.tenantId } as any);

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: created }));
        } else {
          spinner.succeed(color.green(`Tenant created: ${created.tenantId}`));
          console.log(formatOutput(created));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'TENANT_CREATE_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to create tenant'));
        console.error(color.red(error.message || 'An unexpected error occurred'));
        process.exit(1);
      }
    });

  tenant
    .command('list')
    .description('List all tenants')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      const spinner = ora('Fetching tenants').start();
      if (options.json) spinner.stop();

      try {
        guardAuth();
        const tenants = await apiClient.get<Tenant[]>('/tenants');
        const wsConfig = loadWorkspaceConfig() as any;
        const currentTenantId = wsConfig?.current_tenant as string | undefined;

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: tenants }));
          return;
        }

        spinner.succeed(color.green('Tenants retrieved'));

        if (tenants.length === 0) {
          console.log(color.yellow('No tenants found. Create one with "chimera tenant create"'));
          return;
        }

        const rows = [
          ['ID', 'Name', 'Tier', 'Region', 'Status', 'Created'],
          ...tenants.map((t) => [
            t.tenantId === currentTenantId ? color.green(`${t.tenantId} *`) : t.tenantId,
            t.name,
            t.tier,
            t.region,
            t.status,
            new Date(t.createdAt).toLocaleString(),
          ]),
        ];

        console.log(table(rows));
        console.log(color.dim('* = current tenant'));
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'TENANT_LIST_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to list tenants'));
        console.error(color.red(error.message || 'An unexpected error occurred'));
        process.exit(1);
      }
    });

  tenant
    .command('switch <tenant-id>')
    .description('Switch to a different tenant (updates current tenant in chimera.toml)')
    .option('--json', 'Output result as JSON')
    .action((tenantId: string, options: { json?: boolean }) => {
      const wsConfig = loadWorkspaceConfig();
      saveWorkspaceConfig({ ...wsConfig, current_tenant: tenantId } as any);
      if (options.json) {
        console.log(JSON.stringify({ status: 'ok', data: { tenantId, status: 'switched' } }));
      } else {
        console.log(color.green(`Switched to tenant: ${tenantId}`));
      }
    });

  tenant
    .command('delete <tenant-id>')
    .description('Delete a tenant')
    .option('--force', 'Skip confirmation')
    .option('--json', 'Output result as JSON')
    .action(async (tenantId: string, options) => {
      if (!options.force && !options.json) {
        const { confirm } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Delete tenant "${tenantId}"? This cannot be undone.`,
            default: false,
          },
        ]);

        if (!confirm) {
          console.log(color.yellow('Deletion cancelled'));
          return;
        }
      }

      const spinner = ora(`Deleting tenant ${tenantId}`).start();
      if (options.json) spinner.stop();

      try {
        guardAuth();
        await apiClient.delete(`/tenants/${encodeURIComponent(tenantId)}`);

        // Clear current tenant if we just deleted it
        const wsConfig = loadWorkspaceConfig() as any;
        if (wsConfig?.current_tenant === tenantId) {
          saveWorkspaceConfig({ ...wsConfig, current_tenant: undefined } as any);
        }

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { tenantId } }));
        } else {
          spinner.succeed(color.green(`Tenant deleted: ${tenantId}`));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'TENANT_DELETE_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Failed to delete tenant'));
        console.error(color.red(error.message || 'An unexpected error occurred'));
        process.exit(1);
      }
    });
}
