/**
 * chimera setup — provision admin user in Cognito after infrastructure deployment
 *
 * Reads admin credentials from chimera.toml ([auth] admin_email) and
 * ~/.chimera/credentials ([admin] password), then creates the user in the
 * deployed Cognito user pool and adds them to the 'admin' group.
 */

import { Command } from 'commander';
import ora from 'ora';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  loadWorkspaceConfig,
  loadCredentials,
} from '../utils/workspace.js';
import { color } from '../lib/color.js';

/**
 * Look up the Cognito user pool ID from CloudFormation when not in chimera.toml.
 */
async function resolveUserPoolId(
  cfnClient: CloudFormationClient,
  env: string,
): Promise<string> {
  const stackName = `Chimera-${env}-Security`;
  const command = new DescribeStacksCommand({ StackName: stackName });
  const response = await cfnClient.send(command);
  const stack = response.Stacks?.[0];
  if (!stack) {
    throw new Error(`Stack ${stackName} not found. Has the infrastructure been deployed?`);
  }
  const output = stack.Outputs?.find((o) => o.OutputKey === 'UserPoolId');
  if (!output?.OutputValue) {
    throw new Error(`UserPoolId output not found in ${stackName}. Deployment may be incomplete.`);
  }
  return output.OutputValue;
}

/**
 * Create the admin Cognito user, set a permanent password, and add to admin group.
 * Returns true if created, false if the user already existed.
 */
export async function provisionAdminUser(
  cognitoClient: CognitoIdentityProviderClient,
  userPoolId: string,
  email: string,
  password: string,
): Promise<boolean> {
  let created = true;

  try {
    await cognitoClient.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      MessageAction: 'SUPPRESS', // Don't send welcome email
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }));
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      created = false;
    } else {
      throw err;
    }
  }

  // Set a permanent password so the user is not forced to change it on first login
  await cognitoClient.send(new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId,
    Username: email,
    Password: password,
    Permanent: true,
  }));

  // Add to the admin group (idempotent — no error if already a member)
  await cognitoClient.send(new AdminAddUserToGroupCommand({
    UserPoolId: userPoolId,
    Username: email,
    GroupName: 'admin',
  }));

  return created;
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Provision admin user in Cognito after infrastructure deployment')
    .option('--env <environment>', 'Environment name (overrides chimera.toml)')
    .option('--user-pool-id <id>', 'Cognito user pool ID (overrides chimera.toml endpoints)')
    .option('--email <email>', 'Admin email (overrides chimera.toml auth.admin_email)')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      const spinner = ora('Setting up admin user').start();
      if (options.json) spinner.stop();

      try {
        const wsConfig = loadWorkspaceConfig();
        const creds = loadCredentials();
        const region = wsConfig?.aws?.region ?? 'us-east-1';
        const env = options.env ?? wsConfig?.workspace?.environment ?? 'dev';

        if (wsConfig?.aws?.profile) {
          process.env.AWS_PROFILE = wsConfig.aws.profile;
        }

        // Resolve admin email
        const email = options.email ?? wsConfig?.auth?.admin_email;
        if (!email) {
          const msg = 'Admin email not found. Run "chimera init" first or pass --email.';
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_EMAIL' }));
            process.exit(1);
          }
          spinner.fail(color.red(msg));
          process.exit(1);
        }

        // Resolve admin password
        const password = creds?.admin?.password;
        if (!password) {
          const msg = 'Admin password not found in ~/.chimera/credentials. Run "chimera init" first.';
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: msg, code: 'NO_PASSWORD' }));
            process.exit(1);
          }
          spinner.fail(color.red(msg));
          process.exit(1);
        }

        // Resolve user pool ID
        let userPoolId = options.userPoolId ?? wsConfig?.endpoints?.cognito_user_pool_id;

        if (!userPoolId) {
          if (!options.json) spinner.text = 'Looking up Cognito user pool from CloudFormation...';
          const cfnClient = new CloudFormationClient({ region });
          userPoolId = await resolveUserPoolId(cfnClient, env);
          if (!options.json) spinner.succeed(color.green(`User pool: ${userPoolId}`));
        } else {
          if (!options.json) spinner.succeed(color.green(`User pool: ${userPoolId}`));
        }

        if (!options.json) spinner.start(`Creating admin user ${email}...`);
        const cognitoClient = new CognitoIdentityProviderClient({ region });
        const created = await provisionAdminUser(cognitoClient, userPoolId, email, password);

        if (options.json) {
          console.log(JSON.stringify({
            status: 'ok',
            data: { email, userPoolId, env, created },
          }));
        } else {
          if (created) {
            spinner.succeed(color.green(`Admin user created: ${email}`));
          } else {
            spinner.succeed(color.yellow(`Admin user already exists: ${email} (password + group updated)`));
          }
          console.log(color.gray('\nAdmin user is in the "admin" group with permanent password set.'));
          console.log(color.gray('Run "chimera login" to authenticate.'));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'SETUP_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Setup failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });
}
