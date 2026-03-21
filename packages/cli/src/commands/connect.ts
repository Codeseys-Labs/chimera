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
import { loadConfig, saveConfig } from '../utils/config';

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
    .option('--region <region>', 'AWS region', 'us-east-1')
    .option('--env <environment>', 'Environment name', 'dev')
    .action(async (options) => {
      const spinner = ora('Connecting to Chimera deployment').start();

      try {
        const config = loadConfig();

        if (!config.deployment) {
          throw new Error('No deployment found. Run "chimera deploy" first.');
        }

        const client = new CloudFormationClient({ region: options.region });

        // Get API stack outputs
        spinner.text = 'Fetching API Gateway endpoints...';
        const apiStackName = `Chimera-${options.env}-Api`;
        const apiOutputs = await getStackOutputs(client, apiStackName);

        const apiUrl = apiOutputs.ApiUrl || apiOutputs.RestApiUrl;
        const webSocketUrl = apiOutputs.WebSocketUrl || apiOutputs.WebSocketApiUrl;

        if (!apiUrl) {
          throw new Error('API Gateway URL not found in stack outputs');
        }

        spinner.succeed(chalk.green('API Gateway endpoints retrieved'));

        // Get Security stack outputs
        spinner.start('Fetching Cognito configuration...');
        const securityStackName = `Chimera-${options.env}-Security`;
        const securityOutputs = await getStackOutputs(client, securityStackName);

        const cognitoUserPoolId = securityOutputs.UserPoolId;
        const cognitoClientId = securityOutputs.WebClientId || securityOutputs.UserPoolClientId;

        if (!cognitoUserPoolId) {
          throw new Error('Cognito User Pool ID not found in stack outputs');
        }

        spinner.succeed(chalk.green('Cognito configuration retrieved'));

        // Update config
        config.deployment.apiUrl = apiUrl;
        config.deployment.webSocketUrl = webSocketUrl;
        config.deployment.cognitoUserPoolId = cognitoUserPoolId;
        config.deployment.cognitoClientId = cognitoClientId;
        config.deployment.region = options.region;
        saveConfig(config);

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
        console.log(chalk.gray('\nConfiguration saved to ~/.chimera/config.json'));
      } catch (error: any) {
        spinner.fail(chalk.red('Connection failed'));
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}
