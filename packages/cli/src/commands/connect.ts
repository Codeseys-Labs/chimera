/**
 * Connect command - Save deployed API endpoints to local config
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../utils/workspace';

/**
 * Get CloudFormation stack outputs
 */
async function getStackOutputs(
  client: CloudFormationClient,
  stackName: string,
): Promise<Record<string, string>> {
  try {
    const command = new DescribeStacksCommand({ StackName: stackName });
    const response = await client.send(command);

    const outputs: Record<string, string> = {};
    const stack = response.Stacks?.[0];

    if (stack?.Outputs) {
      for (const output of stack.Outputs) {
        if (output.OutputKey && output.OutputValue) {
          outputs[output.OutputKey] = output.OutputValue;
        }
      }
    }

    return outputs;
  } catch (error: any) {
    if (error.name === 'ValidationError') {
      throw new Error(`Stack ${stackName} not found. Ensure deployment completed successfully.`);
    }
    throw error;
  }
}

export function registerConnectCommand(program: Command): void {
  program
    .command('connect')
    .description('Connect to deployed Chimera instance (saves API endpoints to local config)')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .action(async (options) => {
      const spinner = ora('Connecting to Chimera deployment').start();

      try {
        const wsConfig = loadWorkspaceConfig();
        const region = options.region ?? wsConfig?.aws?.region ?? 'us-east-1';
        const env = options.env ?? wsConfig?.workspace?.environment ?? 'dev';
        if (wsConfig?.aws?.profile) { process.env.AWS_PROFILE = wsConfig.aws.profile; }

        const client = new CloudFormationClient({ region });

        // Get API stack outputs
        spinner.text = 'Fetching API Gateway endpoints...';
        const apiStackName = `Chimera-${env}-Api`;
        const apiOutputs = await getStackOutputs(client, apiStackName);

        const apiUrl = apiOutputs.ApiUrl || apiOutputs.RestApiUrl;
        const webSocketUrl = apiOutputs.WebSocketUrl || apiOutputs.WebSocketApiUrl;

        if (!apiUrl) {
          throw new Error('API Gateway URL not found in stack outputs');
        }

        spinner.succeed(chalk.green('API Gateway endpoints retrieved'));

        // Get Security stack outputs
        spinner.start('Fetching Cognito configuration...');
        const securityStackName = `Chimera-${env}-Security`;
        const securityOutputs = await getStackOutputs(client, securityStackName);

        const cognitoUserPoolId = securityOutputs.UserPoolId;
        const cognitoClientId = securityOutputs.WebClientId || securityOutputs.UserPoolClientId;

        if (!cognitoUserPoolId) {
          throw new Error('Cognito User Pool ID not found in stack outputs');
        }

        spinner.succeed(chalk.green('Cognito configuration retrieved'));

        // Update config
        const currentConfig = loadWorkspaceConfig();
        saveWorkspaceConfig({ ...currentConfig, endpoints: { api_url: apiUrl, websocket_url: webSocketUrl, cognito_user_pool_id: cognitoUserPoolId, cognito_client_id: cognitoClientId } });

        console.log(chalk.green('\n✓ Connected to Chimera deployment'));
        console.log(chalk.gray('\nEndpoints:'));
        console.log(chalk.gray(`  API Gateway:  ${apiUrl}`));
        if (webSocketUrl) {
          console.log(chalk.gray(`  WebSocket:    ${webSocketUrl}`));
        }
        console.log(chalk.gray(`  Cognito Pool: ${cognitoUserPoolId}`));
        if (cognitoClientId) {
          console.log(chalk.gray(`  Client ID:    ${cognitoClientId}`));
        }
        console.log(chalk.gray('\nConfiguration saved to chimera.toml'));
      } catch (error: any) {
        spinner.fail(chalk.red('Connection failed'));
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}
