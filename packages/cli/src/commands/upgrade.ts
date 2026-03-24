/**
 * Upgrade commands - apply upstream GitHub changes to CodeCommit while preserving agent edits
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
 * Get GitHub repository URL from package.json
 */
function getGitHubUrl(repoRoot: string): string {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error('package.json not found in project root');
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (!packageJson.repository || !packageJson.repository.url) {
    throw new Error('No repository URL found in package.json');
  }

  // Convert git+https://github.com/user/repo.git to https://github.com/user/repo
  let url = packageJson.repository.url;
  url = url.replace(/^git\+/, '');
  url = url.replace(/\.git$/, '');
  return url;
}

/**
 * Upgrade CodeCommit with latest upstream changes from GitHub
 *
 * Flow:
 * 1. Verify local repo is clean (no uncommitted changes)
 * 2. Configure git remotes (origin=GitHub, codecommit=CodeCommit)
 * 3. Fetch latest from both remotes
 * 4. Create upgrade branch from CodeCommit main (preserves agent edits)
 * 5. Merge upstream GitHub changes into upgrade branch
 * 6. Push merged result to CodeCommit
 */
async function upgradeFromGitHub(
  repoRoot: string,
  region: string,
  repoName: string,
  githubUrl: string,
): Promise<void> {
  // Step 1: Check for uncommitted changes
  if (hasUncommittedChanges(repoRoot)) {
    throw new Error(
      'You have uncommitted changes. Please commit or stash them before upgrading:\n' +
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

  // Step 3: Add or update GitHub remote (origin)
  try {
    execSync('git remote get-url origin', {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execSync(`git remote set-url origin ${githubUrl}`, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(chalk.gray('  Updated GitHub remote (origin)'));
  } catch {
    execSync(`git remote add origin ${githubUrl}`, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(chalk.gray('  Added GitHub remote (origin)'));
  }

  // Step 4: Add or update CodeCommit remote
  const codecommitUrl = getCodeCommitUrl(region, repoName);
  try {
    execSync('git remote get-url codecommit', {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execSync(`git remote set-url codecommit ${codecommitUrl}`, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(chalk.gray('  Updated CodeCommit remote'));
  } catch {
    execSync(`git remote add codecommit ${codecommitUrl}`, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(chalk.gray('  Added CodeCommit remote'));
  }

  // Step 5: Fetch from both remotes
  console.log(chalk.gray('  Fetching from GitHub...'));
  execSync('git fetch origin main', {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  console.log(chalk.gray('  Fetching from CodeCommit...'));
  execSync('git fetch codecommit main', {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Step 6: Get current branch and stash its name
  const originalBranch = execSync('git branch --show-current', {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  // Step 7: Create upgrade branch from CodeCommit main (starts with agent edits)
  const upgradeBranch = `upgrade-${Date.now()}`;
  console.log(chalk.gray(`  Creating upgrade branch: ${upgradeBranch}`));

  try {
    // Start from codecommit/main to preserve agent edits
    execSync(`git checkout -b ${upgradeBranch} codecommit/main`, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    throw new Error(`Failed to create upgrade branch: ${error.message}`);
  }

  // Step 8: Merge upstream GitHub changes into upgrade branch
  console.log(chalk.gray('  Merging upstream GitHub changes...'));
  try {
    execSync('git merge origin/main --no-edit -m "Upgrade: merge upstream GitHub changes"', {
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
      console.error(chalk.yellow('\nMerge conflicts detected during upgrade.'));
      console.error(chalk.gray('To resolve:'));
      console.error(chalk.gray('  1. Review conflicts: git status'));
      console.error(chalk.gray('  2. Edit conflicted files to resolve'));
      console.error(chalk.gray('  3. Stage resolved files: git add <files>'));
      console.error(chalk.gray('  4. Complete merge: git commit'));
      console.error(chalk.gray(`  5. Push to CodeCommit: git push codecommit ${upgradeBranch}:main`));
      console.error(chalk.gray(`  6. Return to original branch: git checkout ${originalBranch}`));
      throw new Error('Merge conflicts require manual resolution');
    }

    // Re-throw if not a merge conflict
    throw error;
  }

  // Step 9: Push merged result to CodeCommit
  console.log(chalk.gray('  Pushing to CodeCommit...'));
  execSync(`git push codecommit ${upgradeBranch}:main`, {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(chalk.gray('  Push successful'));

  // Step 10: Return to original branch and clean up
  console.log(chalk.gray(`  Returning to original branch: ${originalBranch}`));
  execSync(`git checkout ${originalBranch}`, {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Delete upgrade branch (local only)
  execSync(`git branch -D ${upgradeBranch}`, {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Apply upstream GitHub changes to CodeCommit while preserving agent edits')
    .option('--github-url <url>', 'GitHub repository URL (defaults to package.json repository field)')
    .action(async (options) => {
      const spinner = ora('Starting upgrade operation').start();

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

        // Get GitHub URL
        spinner.start('Resolving GitHub upstream URL...');
        const githubUrl = options.githubUrl || getGitHubUrl(repoRoot);
        spinner.succeed(chalk.green(`GitHub upstream: ${githubUrl}`));

        // Upgrade from GitHub
        spinner.start('Upgrading from GitHub...');
        await upgradeFromGitHub(repoRoot, region, repositoryName, githubUrl);
        spinner.succeed(chalk.green('Upgrade complete'));

        console.log(chalk.green('\n✓ CodeCommit upgraded with latest upstream changes'));
        console.log(chalk.gray('\nWhat happened:'));
        console.log(chalk.gray('  1. Fetched latest from GitHub (upstream)'));
        console.log(chalk.gray('  2. Fetched current state from CodeCommit (agent edits)'));
        console.log(chalk.gray('  3. Merged upstream changes with agent edits'));
        console.log(chalk.gray('  4. Pushed merged result to CodeCommit'));
        console.log(chalk.gray('\nNext: Run "chimera sync" to sync your local workspace'));
      } catch (error: any) {
        spinner.fail(chalk.red('Upgrade failed'));
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });
}
