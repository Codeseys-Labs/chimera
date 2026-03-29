/**
 * Sync commands - bidirectional sync between local workspace and CodeCommit
 * Pure AWS SDK approach - no git remote, credential helper, or pip dependencies
 */

import { Command } from 'commander';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { CodeCommitClient } from '@aws-sdk/client-codecommit';
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { pushToCodeCommit, getFilesFromCodeCommit } from '../utils/codecommit.js';
import { color } from '../lib/color.js';
import { findProjectRoot } from '../utils/project.js';

/**
 * Prompt the user to confirm before overwriting local files.
 * Returns true if the user confirms (or --yes was passed).
 */
async function confirmOverwrite(fileCount: number, yes: boolean): Promise<boolean> {
  if (yes) return true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `Sync will overwrite ${fileCount} local file(s). Continue? [y/N] `,
      (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === 'y');
      },
    );
  });
}

/**
 * Sync local changes with CodeCommit (bidirectional)
 */
async function syncWithCodeCommit(
  repoRoot: string,
  region: string,
  repoName: string,
  yes: boolean,
): Promise<void> {
  const client = new CodeCommitClient({ region });

  // Step 1: Pull — fetch all files from CodeCommit and write to local disk
  console.log(color.gray('  Pulling files from CodeCommit...'));
  const ccFiles = await getFilesFromCodeCommit(client, repoName, 'main');
  console.log(color.gray(`  Received ${ccFiles.length} files from CodeCommit`));

  if (ccFiles.length > 0) {
    const confirmed = await confirmOverwrite(ccFiles.length, yes);
    if (!confirmed) {
      console.log(color.yellow('  Sync cancelled'));
      return;
    }
  }

  for (const file of ccFiles) {
    const localPath = path.join(repoRoot, file.path);
    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    fs.writeFileSync(localPath, file.content);
  }
  console.log(color.gray('  Local workspace updated'));

  // Step 2: Push — send local state back to CodeCommit
  console.log(color.gray('  Pushing local state to CodeCommit...'));
  await pushToCodeCommit(client, repoName, repoRoot, 'main', 'Sync: local workspace');
  console.log(color.gray('  Push complete'));
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description(
      'Bidirectional sync between local workspace and CodeCommit (merge agent edits with local changes)',
    )
    .option('--yes', 'Skip overwrite confirmation prompt')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      const spinner = ora('Starting sync operation').start();
      if (options.json) spinner.stop();

      try {
        const wsConfig = loadWorkspaceConfig();
        const region = wsConfig?.aws?.region;
        const repositoryName = wsConfig?.workspace?.repository;
        if (!region || !repositoryName) {
          if (options.json) {
            console.log(JSON.stringify({ status: 'error', error: 'No workspace configuration found', code: 'NO_CONFIG' }));
            process.exit(1);
          }
          spinner.fail(color.red('No workspace configuration found'));
          console.error(color.red('Run chimera init to configure your workspace'));
          process.exit(1);
        }
        if (wsConfig?.aws?.profile) { process.env.AWS_PROFILE = wsConfig.aws.profile; }
        if (!options.json) spinner.succeed(color.green('Workspace: ' + repositoryName + ' in ' + region));

        if (!options.json) spinner.start('Locating project root...');
        const repoRoot = findProjectRoot();
        if (!options.json) spinner.succeed(color.green(`Project root: ${repoRoot}`));

        if (!options.json) spinner.start('Syncing with CodeCommit...');
        if (options.json) {
          // In JSON mode, suppress interactive prompt
          await syncWithCodeCommit(repoRoot, region, repositoryName, true);
        } else {
          spinner.stop();
          await syncWithCodeCommit(repoRoot, region, repositoryName, options.yes ?? false);
          spinner.succeed(color.green('Sync complete'));
        }

        if (options.json) {
          console.log(JSON.stringify({ status: 'ok', data: { repository: repositoryName, region } }));
        } else {
          console.log(color.green('\n✓ Local workspace synced with CodeCommit'));
          console.log(color.gray('\nWhat happened:'));
          console.log(color.gray('  1. Fetched latest agent edits from CodeCommit'));
          console.log(color.gray('  2. Applied agent edits to local workspace'));
          console.log(color.gray('  3. Pushed merged result back to CodeCommit'));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ status: 'error', error: error.message, code: 'SYNC_FAILED' }));
          process.exit(1);
        }
        spinner.fail(color.red('Sync failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });
}
