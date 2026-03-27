/**
 * chimera doctor — Pre-flight checks for the Chimera platform
 *
 * Runs 5 checks and prints pass/fail for each:
 *   1. AWS credentials
 *   2. Chimera auth tokens
 *   3. API connectivity
 *   4. Cognito pool config
 *   5. CloudFormation stack status
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { loadWorkspaceConfig } from '../utils/workspace';
import { color } from '../lib/color';

const CREDENTIALS_FILE = path.join(os.homedir(), '.chimera', 'credentials');
const AWS_CREDENTIALS_FILE = path.join(os.homedir(), '.aws', 'credentials');

export interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

// ─── Individual checks ────────────────────────────────────────────────────────

export function checkAwsCredentials(): CheckResult {
  const hasEnvKey = Boolean(process.env['AWS_ACCESS_KEY_ID']);
  const hasEnvRole = Boolean(process.env['AWS_ROLE_ARN'] ?? process.env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI']);
  const hasFile = fs.existsSync(AWS_CREDENTIALS_FILE);

  if (hasEnvKey || hasEnvRole || hasFile) {
    return { label: 'AWS credentials', ok: true };
  }
  return {
    label: 'AWS credentials',
    ok: false,
    detail: 'No AWS credentials found. Set AWS_ACCESS_KEY_ID or configure ~/.aws/credentials',
  };
}

export async function checkChimeraAuth(credFile = CREDENTIALS_FILE): Promise<CheckResult> {
  if (!fs.existsSync(credFile)) {
    return {
      label: 'Chimera auth',
      ok: false,
      detail: 'Not logged in. Run `chimera login`',
    };
  }

  try {
    const raw = fs.readFileSync(credFile, 'utf8');
    const creds = JSON.parse(raw) as { accessToken?: string; expiresAt?: string };
    if (!creds.accessToken || !creds.expiresAt) {
      return { label: 'Chimera auth', ok: false, detail: 'Credentials file is malformed' };
    }
    if (new Date(creds.expiresAt) <= new Date()) {
      return {
        label: 'Chimera auth',
        ok: false,
        detail: `Token expired at ${new Date(creds.expiresAt).toLocaleString()}. Run \`chimera login\``,
      };
    }
    const exp = new Date(creds.expiresAt);
    return { label: 'Chimera auth', ok: true, detail: `Expires ${exp.toLocaleString()}` };
  } catch {
    return { label: 'Chimera auth', ok: false, detail: 'Failed to read credentials file' };
  }
}

export async function checkApiConnectivity(baseUrl: string): Promise<CheckResult> {
  if (!baseUrl) {
    return { label: 'API connectivity', ok: false, detail: 'api_url not set in chimera.toml [endpoints]' };
  }
  try {
    const healthUrl = `${baseUrl.replace(/\/$/, '')}/health`;
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      return { label: 'API connectivity', ok: true, detail: healthUrl };
    }
    return { label: 'API connectivity', ok: false, detail: `Health check returned ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { label: 'API connectivity', ok: false, detail: `Unreachable: ${msg}` };
  }
}

export function checkCognitoConfig(): CheckResult {
  const config = loadWorkspaceConfig();
  const poolId = config.endpoints?.cognito_user_pool_id;
  const clientId = config.endpoints?.cognito_client_id;

  if (!poolId && !clientId) {
    return {
      label: 'Cognito pool config',
      ok: false,
      detail: 'cognito_user_pool_id and cognito_client_id not set in chimera.toml [endpoints]',
    };
  }
  if (!poolId) {
    return {
      label: 'Cognito pool config',
      ok: false,
      detail: 'cognito_user_pool_id not set in chimera.toml [endpoints]',
    };
  }
  if (!clientId) {
    return {
      label: 'Cognito pool config',
      ok: false,
      detail: 'cognito_client_id not set in chimera.toml [endpoints]',
    };
  }
  return { label: 'Cognito pool config', ok: true, detail: `Pool: ${poolId}` };
}

// Fixed set of Chimera CloudFormation stacks to check
const CHIMERA_STACKS = [
  'ChimeraNetworkStack',
  'ChimeraDataStack',
  'ChimeraSecurityStack',
  'ChimeraApiStack',
  'ChimeraChatStack',
];

export async function checkStackStatus(region?: string): Promise<CheckResult> {
  const cfn = new CloudFormationClient({ region: region ?? 'us-east-1' });
  const results: string[] = [];
  let allOk = true;

  for (const stackName of CHIMERA_STACKS) {
    try {
      const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const stack = res.Stacks?.[0];
      if (!stack) {
        results.push(`${stackName}: NOT FOUND`);
        allOk = false;
      } else {
        const status = stack.StackStatus ?? 'UNKNOWN';
        const ok = status.endsWith('_COMPLETE') && !status.includes('ROLLBACK');
        if (!ok) allOk = false;
        results.push(`${stackName}: ${status}`);
      }
    } catch {
      results.push(`${stackName}: NOT FOUND`);
      allOk = false;
    }
  }

  return {
    label: 'Stack status',
    ok: allOk,
    detail: results.join(', '),
  };
}

// ─── Output formatting ────────────────────────────────────────────────────────

function printResult(result: CheckResult): void {
  const icon = result.ok ? color.green('✓') : color.red('✗');
  const label = color.bold(result.label);
  const detail = result.detail ? color.dim(` (${result.detail})`) : '';
  console.log(`  ${icon} ${label}${detail}`);
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run pre-flight checks for the Chimera platform')
    .option('--json', 'Output results as JSON')
    .action(async (options: { json?: boolean }) => {
      const config = loadWorkspaceConfig();
      const region = config.aws?.region;
      const baseUrl = config.endpoints?.api_url ?? '';

      if (!options.json) {
        console.log(color.bold('\nChimera Doctor — Pre-flight Checks\n'));
      }

      const checks = await Promise.all([
        Promise.resolve(checkAwsCredentials()),
        checkChimeraAuth(),
        checkApiConnectivity(baseUrl),
        Promise.resolve(checkCognitoConfig()),
        checkStackStatus(region),
      ]);

      if (options.json) {
        const output = {
          status: checks.every((c) => c.ok) ? 'ok' : 'error',
          checks: checks.map((c) => ({ label: c.label, ok: c.ok, detail: c.detail ?? null })),
        };
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      for (const result of checks) {
        printResult(result);
      }

      const allPassed = checks.every((c) => c.ok);
      console.log(
        allPassed
          ? `\n${color.green('All checks passed.')}`
          : `\n${color.red('Some checks failed.')} ${color.dim('Review the items above.')}`,
      );

      if (!allPassed) process.exit(1);
    });
}
