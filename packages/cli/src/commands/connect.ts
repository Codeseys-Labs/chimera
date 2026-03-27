/**
 * Connect / Endpoints command — save deployed API endpoints to local config.
 * "chimera connect" is deprecated; use "chimera endpoints" instead.
 */

import { Command } from 'commander';
import ora from 'ora';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';

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

async function runEndpoints(options: {
  region?: string;
  env?: string;
  json?: boolean;
}): Promise<void> {
  const spinner = ora('Connecting to Chimera deployment').start();
  if (options.json) spinner.stop();

  try {
    const wsConfig = loadWorkspaceConfig();
    const region = options.region ?? wsConfig?.aws?.region ?? 'us-east-1';
    const env = options.env ?? wsConfig?.workspace?.environment ?? 'dev';
    if (wsConfig?.aws?.profile) { process.env.AWS_PROFILE = wsConfig.aws.profile; }

    const client = new CloudFormationClient({ region });

    if (!options.json) spinner.text = 'Fetching API Gateway endpoints...';
    const apiStackName = `Chimera-${env}-Api`;
    const apiOutputs = await getStackOutputs(client, apiStackName);

    const apiUrl = apiOutputs.ApiUrl || apiOutputs.RestApiUrl;
    const webSocketUrl = apiOutputs.WebSocketUrl || apiOutputs.WebSocketApiUrl;

    if (!apiUrl) {
      throw new Error('API Gateway URL not found in stack outputs');
    }

    if (!options.json) spinner.succeed(color.green('API Gateway endpoints retrieved'));

    if (!options.json) spinner.start('Fetching Cognito configuration...');
    const securityStackName = `Chimera-${env}-Security`;
    const securityOutputs = await getStackOutputs(client, securityStackName);

    const cognitoUserPoolId = securityOutputs.UserPoolId;
    const cognitoClientId = securityOutputs.WebClientId || securityOutputs.UserPoolClientId;
    const cognitoDomain = securityOutputs.HostedUIDomain;

    if (!cognitoUserPoolId) {
      throw new Error('Cognito User Pool ID not found in stack outputs');
    }

    if (!options.json) spinner.succeed(color.green('Cognito configuration retrieved'));

    const currentConfig = loadWorkspaceConfig();
    saveWorkspaceConfig({
      ...currentConfig,
      aws: {
        ...currentConfig?.aws,
        region,
      },
      endpoints: {
        api_url: apiUrl,
        websocket_url: webSocketUrl,
        cognito_user_pool_id: cognitoUserPoolId,
        cognito_client_id: cognitoClientId,
        ...(cognitoDomain ? { cognito_domain: cognitoDomain } : {}),
      },
    });

    if (options.json) {
      console.log(JSON.stringify({
        status: 'ok',
        data: {
          region,
          api_url: apiUrl,
          websocket_url: webSocketUrl,
          cognito_user_pool_id: cognitoUserPoolId,
          cognito_client_id: cognitoClientId,
          cognito_domain: cognitoDomain,
        },
      }));
    } else {
      console.log(color.green('\n✓ Connected to Chimera deployment'));
      console.log(color.gray('\nEndpoints:'));
      console.log(color.gray(`  API Gateway:  ${apiUrl}`));
      if (webSocketUrl) {
        console.log(color.gray(`  WebSocket:    ${webSocketUrl}`));
      }
      console.log(color.gray(`  Cognito Pool: ${cognitoUserPoolId}`));
      if (cognitoClientId) {
        console.log(color.gray(`  Client ID:    ${cognitoClientId}`));
      }
      if (cognitoDomain) {
        console.log(color.gray(`  Hosted UI:    https://${cognitoDomain}.auth.${region}.amazoncognito.com`));
      }
      console.log(color.gray('\nConfiguration saved to chimera.toml'));
    }
  } catch (error: any) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', error: error.message, code: 'CONNECTION_FAILED' }));
      process.exit(1);
    }
    spinner.fail(color.red('Connection failed'));
    console.error(color.red(error.message));
    process.exit(1);
  }
}

export function registerConnectCommand(program: Command): void {
  // Main command: chimera endpoints
  program
    .command('endpoints')
    .description('Fetch deployed API endpoints and save to local config (chimera.toml)')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--json', 'Output result as JSON')
    .action((options) => runEndpoints(options));

  // Deprecated alias: chimera connect
  program
    .command('connect')
    .description('(deprecated) Use "chimera endpoints" instead')
    .option('--region <region>', 'AWS region')
    .option('--env <environment>', 'Environment name')
    .option('--json', 'Output result as JSON')
    .action((options) => {
      if (!options.json) {
        console.warn(color.yellow('"connect" is deprecated, use "endpoints"'));
      }
      return runEndpoints(options);
    });
}
