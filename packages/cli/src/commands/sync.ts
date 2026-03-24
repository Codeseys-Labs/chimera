/**
 * Sync commands - bidirectional sync between local workspace and CodeCommit
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { loadConfig } from '../utils/config';

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
  throw new Error('Could not find project root (no package.json found). Run from within the project directory.');
}

/**
 * Get CodeCommit HTTPS URL with credential helper
 */
function getCodeCommitUrl(region: string, repoName: string): string {
  // Sanitize inputs to prevent injection
  const safeRegion = region.replace(/[^a-z0-9-]/g, '');
  const safeRepoName = repoName.replace(/[^a-zA-Z0-9_-]/g, '');
  return `codecommit::${safeRegion}://${safeRepoName}`;
}

/**
 * Check if git working directory has uncommitted changes
 */
function hasUncommittedChanges(cwd: string): boolean {
  try {
    const status = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Sync local changes with CodeCommit (bidirectional)
 *
 * Flow:
 * 1. Verify local repo is clean (no uncommitted changes)
 * 2. Add CodeCommit as remote if not exists
 * 3. Fetch latest from CodeCommit
 * 4. Merge CodeCommit changes into local (preserve local changes)
 * 5. Push merged result back to CodeCommit
 */
async function syncWithCodeCommit(
  repoRoot: string,
  region: string,
  repoName: string,
): Promise<void> {
  // Step 1: Check for uncommitted changes
  if (hasUncommittedChanges(repoRoot)) {
    throw new Error(
      'You have uncommitted changes. Please commit or stash them before syncing:\n' +
      '  git add .\n' +
      '  git commit -m "your message"'
    );
  }

  // Step 2: Configure git credential helper for CodeCommit
  console.log(chalk.gray('  Configuring CodeCommit credential helper...'));
  execSync('git config credential.helper "!aws codecommit credential-helper $@"', {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  execSync('git config credential.UseHttpPath true', {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Step 3: Add or update CodeCommit remote
  const codecommitUrl = getCodeCommitUrl(region, repoName);
  try {
    // Check if remote exists
    execSync('git remote get-url codecommit', {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Update URL if it exists
    execSync(`git remote set-url codecommit ${codecommitUrl}`, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(chalk.gray('  Updated CodeCommit remote'));
  } catch {
    // Add new remote if it doesn't exist
    execSync(`git remote add codecommit ${codecommitUrl}`, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(chalk.gray('  Added CodeCommit remote'));
  }

  // Step 4: Fetch from CodeCommit
  console.log(chalk.gray('  Fetching from CodeCommit...'));
  execSync('git fetch codecommit main', {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Step 5: Get current branch
  const currentBranch = execSync('git branch --show-current', {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  // Step 6: Merge CodeCommit changes into local
  console.log(chalk.gray('  Merging CodeCommit changes...'));
  try {
    execSync('git merge codecommit/main --no-edit', {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(chalk.gray('  Merge successful (no conflicts)'));
  } catch (error: any) {
    // Check if merge conflict occurred
    const status = execSync('git status', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (status.includes('Unmerged paths') || status.includes('both modified')) {
      throw new Error(
        'Merge conflicts detected. Please resolve conflicts manually:\n' +
        '  1. Run: git status\n' +
        '  2. Edit conflicted files\n' +
        '  3. Run: git add <resolved-files>\n' +
        '  4. Run: git commit\n' +
        '  5. Re-run: chimera sync'
      );
    }

    // Re-throw if not a merge conflict
    throw error;
  }

  // Step 7: Push merged result to CodeCommit
  console.log(chalk.gray('  Pushing to CodeCommit...'));
  execSync(`git push codecommit ${currentBranch}:main`, {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(chalk.gray('  Push successful'));
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Bidirectional sync between local workspace and CodeCommit (merge agent edits with local changes)')
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
        console.log(chalk.gray('  2. Merged agent edits with your local changes'));
        console.log(chalk.gray('  3. Pushed merged result back to CodeCommit'));
      } catch (error: any) {
        spinner.fail(chalk.red('Sync failed'));
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}
