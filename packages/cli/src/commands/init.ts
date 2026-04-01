/**
 * chimera init — interactive wizard to create chimera.toml in the current directory
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  saveWorkspaceConfig,
  findWorkspaceConfig,
  loadCredentials,
  saveCredentials,
  WorkspaceConfig,
} from '../utils/workspace.js';
import { color } from '../lib/color.js';

export const AWS_CREDENTIALS_PATH = path.join(os.homedir(), '.aws', 'credentials');
export const AWS_CONFIG_PATH = path.join(os.homedir(), '.aws', 'config');

export const SUGGESTED_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];

/** Map AWS region to Bedrock cross-region inference profile prefix (us/eu/ap) */
export function getRegionInferencePrefix(region: string): string {
  if (region.startsWith('eu-')) return 'eu';
  if (region.startsWith('ap-')) return 'ap';
  return 'us';
}

/** Return the default Bedrock model ID for a given AWS region */
export function getDefaultModelId(region: string): string {
  const prefix = getRegionInferencePrefix(region);
  return `${prefix}.anthropic.claude-sonnet-4-6-v1:0`;
}

/** Max context token choices (label → value) */
export const MAX_CONTEXT_CHOICES: { name: string; value: number }[] = [
  { name: '200K (default)', value: 200000 },
  { name: '500K', value: 500000 },
  { name: '1M (extended context beta)', value: 1000000 },
];

const PROFILE_SECTION_RE = /^\[([^\]]+)\]/;

/**
 * Parse AWS profile names from credentials and config files.
 * Returns a deduplicated, sorted array.
 * Optional path overrides are used by tests.
 */
export function listAwsProfiles(
  credentialsPath = AWS_CREDENTIALS_PATH,
  configPath = AWS_CONFIG_PATH
): string[] {
  const profiles = new Set<string>();

  if (fs.existsSync(credentialsPath)) {
    const lines = fs.readFileSync(credentialsPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = PROFILE_SECTION_RE.exec(line.trim());
      if (m) {
        profiles.add(m[1].trim());
      }
    }
  }

  if (fs.existsSync(configPath)) {
    const lines = fs.readFileSync(configPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = PROFILE_SECTION_RE.exec(line.trim());
      if (m) {
        const raw = m[1].trim();
        const name = raw.startsWith('profile ') ? raw.slice('profile '.length).trim() : raw;
        profiles.add(name);
      }
    }
  }

  return Array.from(profiles).sort();
}

/**
 * Append a new profile block to the AWS credentials file.
 * Creates the ~/.aws directory (mode 0700) and file (mode 0600) if missing.
 */
export function writeAwsProfile(
  profileName: string,
  accessKeyId: string,
  secretAccessKey: string,
  credentialsPath = AWS_CREDENTIALS_PATH
): void {
  const awsDir = path.dirname(credentialsPath);
  if (!fs.existsSync(awsDir)) {
    fs.mkdirSync(awsDir, { recursive: true, mode: 0o700 });
  }

  const block = `\n[${profileName}]\naws_access_key_id = ${accessKeyId}\naws_secret_access_key = ${secretAccessKey}\n`;

  if (!fs.existsSync(credentialsPath)) {
    fs.writeFileSync(credentialsPath, block.trimStart(), { mode: 0o600 });
  } else {
    fs.appendFileSync(credentialsPath, block);
  }
}

/**
 * Generate a cryptographically random password meeting Cognito's default policy:
 * 12+ chars, at least one uppercase, lowercase, digit, and symbol.
 */
export function generatePassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const symbols = '!@#$%^&*';
  const all = upper + lower + digits + symbols;

  // Start with one of each required character class
  const parts: string[] = [
    upper[crypto.randomInt(upper.length)],
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)],
    lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];

  // Fill to 16 characters total
  while (parts.length < 16) {
    parts.push(all[crypto.randomInt(all.length)]);
  }

  // Fisher-Yates shuffle using crypto.randomInt
  for (let i = parts.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [parts[i], parts[j]] = [parts[j], parts[i]];
  }

  return parts.join('');
}

/**
 * Validate an email address format.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Create a chimera.toml workspace configuration file')
    .option('--profile <profile>', 'AWS profile name (skip prompt)')
    .option('--region <region>', 'AWS region (skip prompt)')
    .option('--env <env>', 'Environment name (skip prompt)')
    .option('--repo <repo>', 'CodeCommit repository name (skip prompt)')
    .option('--admin-email <email>', 'Admin user email (skip prompt)')
    .option('--admin-password <password>', 'Admin user password (skip prompt, use - to auto-generate)')
    .option('--model <model-id>', 'Bedrock inference profile model ID (skip prompt)')
    .option('--prompt-caching', 'Enable Anthropic prompt caching beta (skip prompt)')
    .option('--no-prompt-caching', 'Disable Anthropic prompt caching beta (skip prompt)')
    .option('--max-context-tokens <tokens>', 'Max context tokens: 200000, 500000, or 1000000 (skip prompt)', parseInt)
    .option('--json', 'Output result as JSON')
    .addHelpText('after', `
Examples:
  $ chimera init
  $ chimera init --region us-east-1 --env dev --admin-email admin@example.com
  $ chimera init --profile my-profile --admin-password - --json
  $ chimera init --model us.anthropic.claude-opus-4-6-v1:0 --prompt-caching --max-context-tokens 1000000`)
    .action(async (options) => {
      try {
        const existing = findWorkspaceConfig(process.cwd());
        if (existing) {
          const { overwrite } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'overwrite',
              message: `chimera.toml already exists at ${existing}. Overwrite?`,
              default: false,
            },
          ]);
          if (!overwrite) {
            if (options.json) {
              console.log(JSON.stringify({ status: 'error', error: 'Aborted', code: 'ABORTED' }));
            } else {
              console.log(color.yellow('Aborted.'));
            }
            return;
          }
        }

        if (!options.json) {
          console.log(color.blue('\nChimera Workspace Setup\n'));
        }

        // ── AWS Profile ─────────────────────────────────────────────────────
        let profile: string = options.profile ?? '';

        if (!profile) {
          const existingProfiles = listAwsProfiles();
          const CREATE_NEW = '[ Create new profile ]';

          if (existingProfiles.length > 0) {
            const { profileChoice } = await inquirer.prompt([
              {
                type: 'list',
                name: 'profileChoice',
                message: 'AWS profile:',
                choices: [
                  ...existingProfiles,
                  new inquirer.Separator(),
                  CREATE_NEW,
                ],
              },
            ]);

            if (profileChoice !== CREATE_NEW) {
              profile = profileChoice as string;
            }
          }

          if (!profile) {
            const answers = await inquirer.prompt([
              {
                type: 'input',
                name: 'profileName',
                message: 'Profile name:',
                default: 'chimera',
                validate: (input: string) =>
                  /^[a-zA-Z0-9_-]+$/.test(input) ||
                  'Profile name must contain only letters, numbers, hyphens, and underscores',
              },
              {
                type: 'input',
                name: 'accessKeyId',
                message: 'AWS Access Key ID:',
                validate: (input: string) =>
                  (input.startsWith('AK') && input.length >= 20) ||
                  'Access Key ID must start with "AK" and be at least 20 characters',
              },
              {
                type: 'password',
                name: 'secretAccessKey',
                message: 'AWS Secret Access Key:',
                mask: '*',
                validate: (input: string) =>
                  input.length >= 20 || 'Secret Access Key must be at least 20 characters',
              },
            ]);

            writeAwsProfile(
              answers.profileName as string,
              answers.accessKeyId as string,
              answers.secretAccessKey as string
            );
            profile = answers.profileName as string;
            if (!options.json) {
              console.log(color.green(`Profile "${profile}" written to ${AWS_CREDENTIALS_PATH}`));
            }
          }
        }

        // ── Region ───────────────────────────────────────────────────────────
        let region: string = options.region ?? '';

        if (!region) {
          const OTHER = '[ Other ]';
          const { regionChoice } = await inquirer.prompt([
            {
              type: 'list',
              name: 'regionChoice',
              message: 'AWS region:',
              choices: [
                ...SUGGESTED_REGIONS,
                new inquirer.Separator(),
                OTHER,
              ],
              default: 'us-east-1',
            },
          ]);

          if (regionChoice === OTHER) {
            const { customRegion } = await inquirer.prompt([
              {
                type: 'input',
                name: 'customRegion',
                message: 'Enter AWS region:',
                validate: (input: string) =>
                  /^[a-z]{2}-[a-z]+-[0-9]+$/.test(input) || 'Region must match pattern like us-east-1',
              },
            ]);
            region = customRegion as string;
          } else {
            region = regionChoice as string;
          }
        }

        // ── Environment ───────────────────────────────────────────────────────
        let environment: string = options.env ?? '';

        if (!environment) {
          const { env } = await inquirer.prompt([
            {
              type: 'input',
              name: 'env',
              message: 'Environment name:',
              default: 'dev',
              validate: (input: string) =>
                /^[a-z][a-z0-9-]*$/.test(input) ||
                'Must start with a lowercase letter, contain only lowercase letters, numbers, and hyphens',
            },
          ]);
          environment = env as string;
        }

        // ── Model Selection ──────────────────────────────────────────────────
        let modelId: string = options.model ?? '';

        if (!modelId) {
          const prefix = getRegionInferencePrefix(region);
          const CUSTOM = '[ Custom model ID ]';
          const modelChoices = [
            { name: `Claude Sonnet 4.6 (recommended) — ${prefix}.anthropic.claude-sonnet-4-6-v1:0`, value: `${prefix}.anthropic.claude-sonnet-4-6-v1:0` },
            { name: `Claude Opus 4.6 — ${prefix}.anthropic.claude-opus-4-6-v1:0`, value: `${prefix}.anthropic.claude-opus-4-6-v1:0` },
            { name: `Claude Haiku 4.5 — ${prefix}.anthropic.claude-haiku-4-5-20251001-v1:0`, value: `${prefix}.anthropic.claude-haiku-4-5-20251001-v1:0` },
            new inquirer.Separator(),
            CUSTOM,
          ];

          const { modelChoice } = await inquirer.prompt([
            {
              type: 'list',
              name: 'modelChoice',
              message: 'Bedrock model:',
              choices: modelChoices,
              default: `${prefix}.anthropic.claude-sonnet-4-6-v1:0`,
            },
          ]);

          if (modelChoice === CUSTOM) {
            const { customModel } = await inquirer.prompt([
              {
                type: 'input',
                name: 'customModel',
                message: 'Model ID (e.g. us.anthropic.claude-sonnet-4-6-v1:0):',
                validate: (input: string) =>
                  input.trim().length > 0 || 'Model ID is required',
              },
            ]);
            modelId = (customModel as string).trim();
          } else {
            modelId = modelChoice as string;
          }
        }

        // ── Prompt Caching ───────────────────────────────────────────────────
        let promptCaching: boolean;

        if (options.promptCaching !== undefined) {
          promptCaching = options.promptCaching as boolean;
        } else {
          const { enableCaching } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'enableCaching',
              message: 'Enable prompt caching? (reduces cost for repeated context)',
              default: false,
            },
          ]);
          promptCaching = enableCaching as boolean;
        }

        // ── Max Context Tokens ───────────────────────────────────────────────
        let maxContextTokens: number = options.maxContextTokens ?? 0;

        if (!maxContextTokens) {
          const { contextChoice } = await inquirer.prompt([
            {
              type: 'list',
              name: 'contextChoice',
              message: 'Max context tokens:',
              choices: MAX_CONTEXT_CHOICES.map((c) => ({ name: c.name, value: c.value })),
              default: 200000,
            },
          ]);
          maxContextTokens = contextChoice as number;
        }

        // ── Repository ────────────────────────────────────────────────────────
        let repository: string = options.repo ?? '';

        if (!repository) {
          const { repo } = await inquirer.prompt([
            {
              type: 'input',
              name: 'repo',
              message: 'CodeCommit repository name:',
              default: 'chimera',
              validate: (input: string) => input.trim().length > 0 || 'Repository name is required',
            },
          ]);
          repository = (repo as string).trim();
        }

        // ── Admin User ────────────────────────────────────────────────────────
        let adminEmail: string = options.adminEmail ?? '';
        let adminPassword = '';
        let passwordWasGenerated = false;

        if (!adminEmail) {
          const { email } = await inquirer.prompt([
            {
              type: 'input',
              name: 'email',
              message: 'Admin email:',
              validate: (input: string) =>
                isValidEmail(input.trim()) || 'Enter a valid email address',
            },
          ]);
          adminEmail = (email as string).trim();
        }

        if (options.adminPassword === '-' || !options.adminPassword) {
          if (!options.adminPassword) {
            const AUTO_GENERATE = 'Auto-generate (recommended)';
            const ENTER_MANUALLY = 'Enter manually';
            const { passwordChoice } = await inquirer.prompt([
              {
                type: 'list',
                name: 'passwordChoice',
                message: 'Admin password:',
                choices: [AUTO_GENERATE, ENTER_MANUALLY],
                default: AUTO_GENERATE,
              },
            ]);

            if (passwordChoice === ENTER_MANUALLY) {
              const { pwd } = await inquirer.prompt([
                {
                  type: 'password',
                  name: 'pwd',
                  message: 'Password (min 12 chars, upper+lower+digit+symbol):',
                  mask: '*',
                  validate: (input: string) => {
                    if (input.length < 12) return 'Password must be at least 12 characters';
                    if (!/[A-Z]/.test(input)) return 'Must contain at least one uppercase letter';
                    if (!/[a-z]/.test(input)) return 'Must contain at least one lowercase letter';
                    if (!/[0-9]/.test(input)) return 'Must contain at least one digit';
                    if (!/[^A-Za-z0-9]/.test(input)) return 'Must contain at least one symbol';
                    return true;
                  },
                },
              ]);
              adminPassword = pwd as string;
            } else {
              adminPassword = generatePassword();
              passwordWasGenerated = true;
            }
          } else {
            adminPassword = generatePassword();
            passwordWasGenerated = true;
          }
        } else {
          adminPassword = options.adminPassword as string;
        }

        // ── Write chimera.toml ────────────────────────────────────────────────
        const config: WorkspaceConfig = {
          aws: { profile, region },
          workspace: { environment, repository },
          auth: { admin_email: adminEmail },
          model: {
            model_id: modelId,
            prompt_caching: promptCaching,
            max_tokens: maxContextTokens,
            temperature: 0.7,
          },
        };

        saveWorkspaceConfig(config, process.cwd());

        // ── Save admin password to ~/.chimera/credentials ─────────────────────
        const creds = loadCredentials();
        saveCredentials({ ...creds, admin: { password: adminPassword } });

        if (options.json) {
          console.log(JSON.stringify({
            status: 'ok',
            data: {
              profile,
              region,
              environment,
              repository,
              admin_email: adminEmail,
              password_generated: passwordWasGenerated,
              ...(passwordWasGenerated ? { admin_password: adminPassword } : {}),
              model: {
                model_id: modelId,
                prompt_caching: promptCaching,
                max_tokens: maxContextTokens,
                temperature: 0.7,
              },
            },
          }));
        } else {
          console.log(color.green('\nchimera.toml created successfully\n'));
          console.log(`  Profile:     ${color.cyan(profile)}`);
          console.log(`  Region:      ${color.cyan(region)}`);
          console.log(`  Environment: ${color.cyan(environment)}`);
          console.log(`  Repository:  ${color.cyan(repository)}`);
          console.log(`  Admin email: ${color.cyan(adminEmail)}`);
          if (passwordWasGenerated) {
            console.log(`  Admin password (generated): ${color.yellow(adminPassword)}`);
            console.log(color.gray('  (saved to ~/.chimera/credentials)'));
          } else {
            console.log(color.gray('  Admin password saved to ~/.chimera/credentials'));
          }
          console.log(`  Model:       ${color.cyan(modelId)}`);
          console.log(`  Prompt cache: ${color.cyan(String(promptCaching))}`);
          console.log(`  Max tokens:  ${color.cyan(String(maxContextTokens))}`);
          console.log(color.yellow('\nRemember to add chimera.toml to your .gitignore'));
          console.log(color.gray('\nNext steps:'));
          console.log(color.gray('  1. chimera deploy    -- deploy infrastructure'));
          console.log(color.gray('  2. chimera endpoints -- save API endpoints'));
          console.log(color.gray('  3. chimera setup     -- provision admin user in Cognito'));
          console.log(color.gray('  4. chimera login     -- authenticate'));
        }
      } catch (err: unknown) {
        const isTtyError =
          err instanceof Error &&
          (err.constructor.name === 'ExitPromptError' || err.message.includes('User force closed'));
        if (isTtyError) {
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: 'Aborted', code: 'ABORTED' }));
          } else {
            console.log(color.yellow('\nAborted.'));
          }
          return;
        }
        if (options.json) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(JSON.stringify({ status: 'error', error: msg, code: 'INIT_FAILED' }));
          process.exit(1);
        }
        console.error(color.red('Error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
