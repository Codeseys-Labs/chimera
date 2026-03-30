/**
 * chimera doctor — Pre-flight checks for the Chimera platform
 *
 * Runs 7 checks and prints pass/fail for each:
 *   1. AWS credentials
 *   2. Chimera auth tokens
 *   3. API connectivity
 *   4. Cognito pool config
 *   5. CloudFormation stack status (all 11 stacks)
 *   6. chimera.toml schema (required fields)
 *   7. Toolchain (bun, npx, aws CLI)
 */

import { Command } from 'commander';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { loadWorkspaceConfig, findWorkspaceConfig } from '../utils/workspace';
import { isOfflineError } from '../utils/aws-errors';
import TOML from 'smol-toml';
import { color } from '../lib/color';

const CREDENTIALS_FILE = path.join(os.homedir(), '.chimera', 'credentials');
const AWS_CREDENTIALS_FILE = path.join(os.homedir(), '.aws', 'credentials');

export interface CheckResult {
  label: string;
  ok: boolean;
  detail?: string;
}

// ─── Individual checks ────────────────────────────────────────────────────────

export function checkAwsCredentials(awsProfile?: string): CheckResult {
  const hasEnvKey = Boolean(process.env['AWS_ACCESS_KEY_ID']);
  const hasEnvRole = Boolean(process.env['AWS_ROLE_ARN'] ?? process.env['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI']);
  const hasFile = fs.existsSync(AWS_CREDENTIALS_FILE);
  const hasProfile = Boolean(process.env['AWS_PROFILE'] ?? process.env['AWS_DEFAULT_PROFILE'] ?? awsProfile);

  if (hasEnvKey || hasEnvRole || hasFile || hasProfile) {
    return { label: 'AWS credentials', ok: true };
  }
  return {
    label: 'AWS credentials',
    ok: false,
    detail: 'No AWS credentials found. Set AWS_ACCESS_KEY_ID, AWS_PROFILE, or configure ~/.aws/credentials',
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
    const parsed = TOML.parse(raw) as { auth?: { access_token?: string; expires_at?: string } };
    if (!parsed.auth?.access_token || !parsed.auth?.expires_at) {
      return { label: 'Chimera auth', ok: false, detail: 'Credentials file is malformed' };
    }
    if (new Date(parsed.auth.expires_at) <= new Date()) {
      return {
        label: 'Chimera auth',
        ok: false,
        detail: `Token expired at ${new Date(parsed.auth.expires_at).toLocaleString()}. Run \`chimera login\``,
      };
    }
    const exp = new Date(parsed.auth.expires_at);
    return { label: 'Chimera auth', ok: true, detail: `Expires ${exp.toLocaleString()}` };
  } catch {
    return { label: 'Chimera auth', ok: false, detail: 'Failed to read credentials file' };
  }
}

export async function checkApiConnectivity(baseUrl: string, chatUrl?: string): Promise<CheckResult> {
  // Prefer chat_url (ECS ALB) for health check — api_url (API Gateway) returns 403 on /health
  const healthBase = chatUrl || baseUrl;
  if (!healthBase) {
    return { label: 'API connectivity', ok: false, detail: 'api_url not set in chimera.toml [endpoints]' };
  }
  try {
    const healthUrl = `${healthBase.replace(/\/$/, '')}/health`;
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      return { label: 'API connectivity', ok: true, detail: healthUrl };
    }
    return { label: 'API connectivity', ok: false, detail: `Health check returned ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = isOfflineError(err) ? '. Check your network connection or VPN' : '';
    return { label: 'API connectivity', ok: false, detail: `Unreachable: ${msg}${hint}` };
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

// Chimera stack suffixes — actual names follow Chimera-{env}-{Suffix} pattern.
// Kept in sync with STACK_DESTROY_ORDER in destroy.ts (all 11 deployed stacks).
const CHIMERA_STACK_SUFFIXES = [
  'Network', 'Data', 'Security', 'Observability',
  'Api', 'Pipeline', 'SkillPipeline', 'Chat',
  'Orchestration', 'Evolution', 'TenantOnboarding',
];

export async function checkStackStatus(region?: string, env?: string): Promise<CheckResult> {
  const resolvedEnv = env ?? 'dev';
  const stackNames = CHIMERA_STACK_SUFFIXES.map((s) => `Chimera-${resolvedEnv}-${s}`);
  // When region is undefined, CloudFormationClient resolves from AWS SDK chain
  // (AWS_DEFAULT_REGION, ~/.aws/config, instance metadata, etc.) rather than
  // hard-coding us-east-1 which would silently query the wrong region.
  const cfn = new CloudFormationClient(region ? { region } : {});
  const results: string[] = [];
  let allOk = true;

  for (const stackName of stackNames) {
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
    } catch (err) {
      if (isOfflineError(err)) {
        return {
          label: 'Stack status',
          ok: false,
          detail: 'Cannot reach AWS CloudFormation. Check your network connection or VPN.',
        };
      }
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

export function checkTomlSchema(): CheckResult {
  const tomlPath = findWorkspaceConfig();
  if (!tomlPath) {
    return {
      label: 'chimera.toml schema',
      ok: false,
      detail: 'No chimera.toml found. Run "chimera init" in your project directory.',
    };
  }
  const config = loadWorkspaceConfig();
  const missing: string[] = [];
  if (!config.aws?.region) missing.push('[aws] region');
  if (!config.workspace?.environment) missing.push('[workspace] environment');
  if (missing.length > 0) {
    return {
      label: 'chimera.toml schema',
      ok: false,
      detail: `Missing required fields: ${missing.join(', ')}`,
    };
  }
  return { label: 'chimera.toml schema', ok: true, detail: tomlPath };
}

export function checkToolchain(): CheckResult {
  const tools: { name: string; args: string[] }[] = [
    { name: 'bun', args: ['--version'] },
    { name: 'npx', args: ['--version'] },
    { name: 'aws', args: ['--version'] },
  ];
  const missing: string[] = [];
  for (const tool of tools) {
    try {
      execFileSync(tool.name, tool.args, { stdio: 'ignore' });
    } catch {
      missing.push(tool.name);
    }
  }
  if (missing.length > 0) {
    return {
      label: 'Toolchain',
      ok: false,
      detail: `Missing: ${missing.join(', ')}. Install the missing tools and retry.`,
    };
  }
  return { label: 'Toolchain', ok: true };
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
    .option('--region <region>', 'AWS region override (default: read from chimera.toml [aws] region)')
    .addHelpText('after', `
Examples:
  $ chimera doctor
  $ chimera doctor --region us-west-2
  $ chimera doctor --json`)
    .action(async (options: { json?: boolean; region?: string }) => {
      const config = loadWorkspaceConfig();
      const region = options.region ?? config.aws?.region;
      const env = config.workspace?.environment;
      const baseUrl = config.endpoints?.api_url ?? '';
      const chatUrl = config.endpoints?.chat_url;

      if (!options.json) {
        console.log(color.bold('\nChimera Doctor — Pre-flight Checks\n'));
      }

      const checks = await Promise.all([
        Promise.resolve(checkAwsCredentials(config.aws?.profile)),
        checkChimeraAuth(),
        checkApiConnectivity(baseUrl, chatUrl),
        Promise.resolve(checkCognitoConfig()),
        checkStackStatus(region, env),
        Promise.resolve(checkTomlSchema()),
        Promise.resolve(checkToolchain()),
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
