/**
 * chimera init — interactive wizard to create chimera.toml in the current directory
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { saveWorkspaceConfig, findWorkspaceConfig, WorkspaceConfig } from '../utils/workspace.js';
import { color } from '../lib/color.js';

export const AWS_CREDENTIALS_PATH = path.join(os.homedir(), '.aws', 'credentials');
export const AWS_CONFIG_PATH = path.join(os.homedir(), '.aws', 'config');

export const SUGGESTED_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];

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

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Create a chimera.toml workspace configuration file')
    .option('--profile <profile>', 'AWS profile name (skip prompt)')
    .option('--region <region>', 'AWS region (skip prompt)')
    .option('--env <env>', 'Environment name (skip prompt)')
    .option('--repo <repo>', 'CodeCommit repository name (skip prompt)')
    .option('--json', 'Output result as JSON')
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

        // ── Write chimera.toml ────────────────────────────────────────────────
        const config: WorkspaceConfig = {
          aws: { profile, region },
          workspace: { environment, repository },
        };

        saveWorkspaceConfig(config, process.cwd());

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { profile, region, environment, repository } }));
        } else {
          console.log(color.green('\nchimera.toml created successfully\n'));
          console.log(`  Profile:     ${color.cyan(profile)}`);
          console.log(`  Region:      ${color.cyan(region)}`);
          console.log(`  Environment: ${color.cyan(environment)}`);
          console.log(`  Repository:  ${color.cyan(repository)}`);
          console.log(color.yellow('\nRemember to add chimera.toml to your .gitignore'));
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
