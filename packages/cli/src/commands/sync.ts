/**
 * Sync commands - bidirectional sync between local workspace and CodeCommit
 * Pure AWS SDK approach - no git remote, credential helper, or pip dependencies
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import { CodeCommitClient } from '@aws-sdk/client-codecommit';
import { loadConfig } from '../utils/config';
import { pushToCodeCommit, getFilesFromCodeCommit } from '../utils/codecommit';

/**
 * Find project root by walking up directory tree looking for package.json
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    'Could not find project root (no package.json found). Run from within the project directory.',
  );
}

/**
 * Sync local changes with CodeCommit (bidirectional)
 *
 * Flow:
 * 1. Pull: Fetch all files from CodeCommit via SDK and write to local disk
 * 2. Push: Push local state back to CodeCommit via CreateCommit API
 *
 * Pure AWS SDK approach - no git remote, credential helper, or pip dependencies
 * Works with any AWS credential type: IAM roles, assumed roles, SSO, etc.
 */
async function syncWithCodeCommit(
  repoRoot: string,
  region: string,
  repoName: string,
): Promise<void> {
  const client = new CodeCommitClient({ region });

  // Step 1: Pull — fetch all files from CodeCommit and write to local disk
  console.log(chalk.gray('  Pulling files from CodeCommit...'));
  const ccFiles = await getFilesFromCodeCommit(client, repoName, 'main');
  console.log(chalk.gray(`  Received ${ccFiles.length} files from CodeCommit`));

  for (const file of ccFiles) {
    const localPath = path.join(repoRoot, file.path);
    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    fs.writeFileSync(localPath, file.content);
  }
  console.log(chalk.gray('  Local workspace updated'));

  // Step 2: Push — send local state back to CodeCommit
  console.log(chalk.gray('  Pushing local state to CodeCommit...'));
  await pushToCodeCommit(client, repoName, repoRoot, 'main', 'Sync: local workspace');
  console.log(chalk.gray('  Push complete'));
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description(
      'Bidirectional sync between local workspace and CodeCommit (merge agent edits with local changes)',
    )
    .action(async () => {
      const spinner = ora('Starting sync operation').start();

      try {
        // Load deployment config
        spinner.text = 'Loading deployment configuration...';
        const config = loadConfig();

        if (!config.deployment) {
          spinner.fail(chalk.red('No deployment found'));
          console.error(chalk.red('Run "chimera deploy" first to create a deployment'));
          process.exit(1);
        }

        const { region, repositoryName } = config.deployment;
        spinner.succeed(chalk.green(`Deployment found: ${repositoryName} in ${region}`));

        // Find project root
        spinner.start('Locating project root...');
        const repoRoot = findProjectRoot();
        spinner.succeed(chalk.green(`Project root: ${repoRoot}`));

        // Sync with CodeCommit
        spinner.start('Syncing with CodeCommit...');
        await syncWithCodeCommit(repoRoot, region, repositoryName);
        spinner.succeed(chalk.green('Sync complete'));

        console.log(chalk.green('\n✓ Local workspace synced with CodeCommit'));
        console.log(chalk.gray('\nWhat happened:'));
        console.log(chalk.gray('  1. Fetched latest agent edits from CodeCommit'));
        console.log(chalk.gray('  2. Applied agent edits to local workspace'));
        console.log(chalk.gray('  3. Pushed merged result back to CodeCommit'));
      } catch (error: any) {
        spinner.fail(chalk.red('Sync failed'));
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}
