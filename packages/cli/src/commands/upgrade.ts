/**
 * Upgrade commands - apply upstream GitHub changes to CodeCommit while preserving agent edits
 * Pure AWS SDK for CodeCommit operations - no git remote credential helper or pip dependencies
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
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
 * Run a git command using spawnSync (safe: arguments are passed as array, no shell injection)
 * Throws on non-zero exit code unless ignoreError is true
 */
function git(cwd: string, args: string[], ignoreError = false): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!ignoreError && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
  }
  return (result.stdout || '').trim();
}

/**
 * Check if git working directory has uncommitted changes
 */
function hasUncommittedChanges(cwd: string): boolean {
  try {
    const output = git(cwd, ['status', '--porcelain']);
    return output.length > 0;
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
  let url = packageJson.repository.url as string;
  url = url.replace(/^git\+/, '');
  url = url.replace(/\.git$/, '');
  return url;
}

/**
 * Upgrade CodeCommit with latest upstream changes from GitHub
 *
 * Flow:
 * 1. Verify local repo is clean (no uncommitted changes)
 * 2. Fetch CodeCommit state via SDK (no git remote needed)
 * 3. Fetch GitHub upstream via standard git (no credential helper needed for GitHub)
 * 4. Create upgrade branch, apply CodeCommit state, commit
 * 5. Merge upstream GitHub changes into upgrade branch
 * 6. Push merged result to CodeCommit via CreateCommit API (no git remote needed)
 * 7. Return to original branch and clean up
 *
 * Pure AWS SDK for CodeCommit - no git-remote-codecommit or pip dependencies
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
        '  git commit -m "your message"',
    );
  }

  const client = new CodeCommitClient({ region });

  // Step 2: Fetch CodeCommit state via SDK (replaces: git fetch codecommit main)
  console.log(chalk.gray('  Fetching CodeCommit state via SDK...'));
  const ccFiles = await getFilesFromCodeCommit(client, repoName, 'main');
  console.log(chalk.gray(`  Received ${ccFiles.length} files from CodeCommit`));

  // Step 3: Set up GitHub remote and fetch (standard git, no credential helper needed)
  try {
    git(repoRoot, ['remote', 'get-url', 'origin']);
    git(repoRoot, ['remote', 'set-url', 'origin', githubUrl]);
    console.log(chalk.gray('  Updated GitHub remote (origin)'));
  } catch {
    git(repoRoot, ['remote', 'add', 'origin', githubUrl]);
    console.log(chalk.gray('  Added GitHub remote (origin)'));
  }

  console.log(chalk.gray('  Fetching from GitHub...'));
  git(repoRoot, ['fetch', 'origin', 'main']);

  // Step 4: Record current branch, create upgrade branch
  const originalBranch = git(repoRoot, ['branch', '--show-current']);
  const upgradeBranch = `upgrade-${Date.now()}`;
  console.log(chalk.gray(`  Creating upgrade branch: ${upgradeBranch}`));
  git(repoRoot, ['checkout', '-b', upgradeBranch]);

  try {
    // Step 5: Write CodeCommit files to disk (CodeCommit state with agent edits)
    console.log(chalk.gray('  Applying CodeCommit state to upgrade branch...'));
    for (const file of ccFiles) {
      const localPath = path.join(repoRoot, file.path);
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }
      fs.writeFileSync(localPath, file.content);
    }

    // Commit CC state so git can merge it with GitHub changes
    git(repoRoot, ['add', '-A']);
    try {
      git(repoRoot, ['commit', '-m', 'CodeCommit state (agent edits)']);
    } catch {
      // Nothing to commit — CC and local are already identical
      console.log(chalk.gray('  No changes from CodeCommit (already up to date)'));
    }

    // Step 6: Merge upstream GitHub changes
    console.log(chalk.gray('  Merging upstream GitHub changes...'));
    try {
      git(repoRoot, ['merge', 'origin/main', '--no-edit', '-m', 'Upgrade: merge upstream GitHub changes']);
      console.log(chalk.gray('  Merge successful (no conflicts)'));
    } catch (error: any) {
      // Check if merge conflict occurred
      const status = git(repoRoot, ['status'], true);

      if (status.includes('Unmerged paths') || status.includes('both modified')) {
        console.error(chalk.yellow('\nMerge conflicts detected during upgrade.'));
        console.error(chalk.gray('To resolve:'));
        console.error(chalk.gray('  1. Review conflicts: git status'));
        console.error(chalk.gray('  2. Edit conflicted files to resolve'));
        console.error(chalk.gray('  3. Stage resolved files: git add <files>'));
        console.error(chalk.gray('  4. Complete merge: git commit'));
        console.error(chalk.gray(`  5. Push to CodeCommit: chimera sync`));
        console.error(chalk.gray(`  6. Return to original branch: git checkout ${originalBranch}`));
        throw new Error('Merge conflicts require manual resolution');
      }

      throw error;
    }

    // Step 7: Push merged result to CodeCommit via SDK (replaces: git push codecommit)
    console.log(chalk.gray('  Pushing merged result to CodeCommit...'));
    await pushToCodeCommit(
      client,
      repoName,
      repoRoot,
      'main',
      'Upgrade: merge upstream GitHub changes',
    );
    console.log(chalk.gray('  Push successful'));
  } finally {
    // Step 8: Return to original branch and clean up upgrade branch
    console.log(chalk.gray(`  Returning to original branch: ${originalBranch}`));
    git(repoRoot, ['checkout', originalBranch], true);
    git(repoRoot, ['branch', '-D', upgradeBranch], true);
  }
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
