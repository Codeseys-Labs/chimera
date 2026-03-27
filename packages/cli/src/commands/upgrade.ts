/**
 * Upgrade commands - apply upstream GitHub changes to CodeCommit while preserving agent edits
 * Pure AWS SDK for CodeCommit operations - no git remote credential helper or pip dependencies
 */

import { Command } from 'commander';
import ora from 'ora';
import * as path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { CodeCommitClient } from '@aws-sdk/client-codecommit';
import { loadWorkspaceConfig } from '../utils/workspace.js';
import { pushToCodeCommit, getFilesFromCodeCommit } from '../utils/codecommit.js';
import { color } from '../lib/color.js';

/**
 * Find project root by walking up directory tree looking for package.json
 */
export function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    'Could not find project root (no package.json found). Run from within the project directory.',
  );
}

/**
 * Run a git command using Bun.$ (safe: arguments are app-controlled, no shell injection risk)
 * Throws on non-zero exit code unless ignoreError is true
 */
export async function git(cwd: string, args: string[], ignoreError = false): Promise<string> {
  try {
    return await Bun.$`git ${args}`.cwd(cwd).quiet().text();
  } catch (err: any) {
    if (ignoreError) return '';
    throw new Error(err.stderr?.toString() || err.message || `git ${args[0]} failed`);
  }
}

/**
 * Check if git working directory has uncommitted changes
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  try {
    const output = await git(cwd, ['status', '--porcelain']);
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get GitHub repository URL from package.json
 */
export async function getGitHubUrl(repoRoot: string): Promise<string> {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!(await Bun.file(packageJsonPath).exists())) {
    throw new Error('package.json not found in project root');
  }

  const packageJson = (await Bun.file(packageJsonPath).json()) as {
    repository?: { url?: string };
  };
  if (!packageJson.repository || !packageJson.repository.url) {
    throw new Error('No repository URL found in package.json');
  }

  let url = packageJson.repository.url as string;
  url = url.replace(/^git\+/, '');
  url = url.replace(/\.git$/, '');
  return url;
}

/**
 * Upgrade CodeCommit with latest upstream changes from GitHub
 */
async function upgradeFromGitHub(
  repoRoot: string,
  region: string,
  repoName: string,
  githubUrl: string,
  dryRun = false,
): Promise<void> {
  if (await hasUncommittedChanges(repoRoot)) {
    throw new Error(
      'You have uncommitted changes. Please commit or stash them before upgrading:\n' +
        '  git add .\n' +
        '  git commit -m "your message"',
    );
  }

  const client = new CodeCommitClient({ region });

  console.log(color.gray('  Fetching CodeCommit state via SDK...'));
  const ccFiles = await getFilesFromCodeCommit(client, repoName, 'main');
  console.log(color.gray(`  Received ${ccFiles.length} files from CodeCommit`));

  try {
    await git(repoRoot, ['remote', 'get-url', 'origin']);
    await git(repoRoot, ['remote', 'set-url', 'origin', githubUrl]);
    console.log(color.gray('  Updated GitHub remote (origin)'));
  } catch {
    await git(repoRoot, ['remote', 'add', 'origin', githubUrl]);
    console.log(color.gray('  Added GitHub remote (origin)'));
  }

  console.log(color.gray('  Fetching from GitHub...'));
  await git(repoRoot, ['fetch', 'origin', 'main']);

  const originalBranch = await git(repoRoot, ['branch', '--show-current']);
  const upgradeBranch = `upgrade-${Date.now()}`;
  console.log(color.gray(`  Creating upgrade branch: ${upgradeBranch}`));
  await git(repoRoot, ['checkout', '-b', upgradeBranch]);

  try {
    console.log(color.gray('  Applying CodeCommit state to upgrade branch...'));
    let changedCount = 0;
    const totalCount = ccFiles.length;
    for (const file of ccFiles) {
      const localPath = path.join(repoRoot, file.path);
      const localFile = Bun.file(localPath);
      if (await localFile.exists()) {
        const localContent = Buffer.from(await localFile.arrayBuffer());
        if (localContent.equals(file.content)) continue;
      } else {
        mkdirSync(path.dirname(localPath), { recursive: true });
      }
      await Bun.write(localPath, file.content);
      changedCount++;
    }
    console.log(
      color.gray(
        `  Applied ${changedCount} changed file(s) (skipped ${totalCount - changedCount} unchanged)`,
      ),
    );

    await git(repoRoot, ['add', '-A']);
    try {
      await git(repoRoot, ['commit', '-m', 'CodeCommit state (agent edits)']);
    } catch {
      console.log(color.gray('  No changes from CodeCommit (already up to date)'));
    }

    if (dryRun) {
      console.log(color.gray('  Dry run: computing diff against upstream GitHub...'));
      const diffStat = await git(repoRoot, ['diff', '--stat', 'HEAD', 'origin/main'], true);
      if (diffStat.trim()) {
        console.log(color.yellow('\nFiles that would change:'));
        console.log(diffStat);
      } else {
        console.log(color.green('\nNo changes from upstream GitHub (already up to date)'));
      }
      return;
    }

    console.log(color.gray('  Merging upstream GitHub changes...'));
    try {
      await git(repoRoot, [
        'merge',
        'origin/main',
        '--no-edit',
        '-m',
        'Upgrade: merge upstream GitHub changes',
      ]);
      console.log(color.gray('  Merge successful (no conflicts)'));
    } catch (error: any) {
      const status = await git(repoRoot, ['status'], true);

      if (status.includes('Unmerged paths') || status.includes('both modified')) {
        console.error(color.yellow('\nMerge conflicts detected during upgrade.'));
        console.error(color.gray('To resolve:'));
        console.error(color.gray('  1. Review conflicts: git status'));
        console.error(color.gray('  2. Edit conflicted files to resolve'));
        console.error(color.gray('  3. Stage resolved files: git add <files>'));
        console.error(color.gray('  4. Complete merge: git commit'));
        console.error(color.gray(`  5. Push to CodeCommit: chimera sync`));
        console.error(color.gray(`  6. Return to original branch: git checkout ${originalBranch}`));
        throw new Error('Merge conflicts require manual resolution');
      }

      throw error;
    }

    console.log(color.gray('  Pushing merged result to CodeCommit...'));
    try {
      await pushToCodeCommit(
        client,
        repoName,
        repoRoot,
        'main',
        'Upgrade: merge upstream GitHub changes',
      );
      console.log(color.gray('  Push successful'));
    } catch (pushError: any) {
      console.error(color.yellow('\n  Push to CodeCommit failed — rolling back local changes'));
      throw new Error(
        `CodeCommit push failed (local state will be restored): ${pushError.message}`,
      );
    }
  } finally {
    console.log(color.gray(`  Returning to original branch: ${originalBranch}`));
    await git(repoRoot, ['checkout', originalBranch], true);
    await git(repoRoot, ['branch', '-D', upgradeBranch], true);
  }
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Apply upstream GitHub changes to CodeCommit while preserving agent edits')
    .option('--github-url <url>', 'GitHub repository URL (defaults to package.json repository field)')
    .option('--dry-run', 'Show what changes would be applied without merging')
    .option('--json', 'Output result as JSON')
    .action(async (options) => {
      const spinner = ora('Starting upgrade operation').start();
      if (options.json) spinner.stop();

      try {
        const wsConfig = loadWorkspaceConfig();
        const region = wsConfig?.aws?.region;
        const repositoryName = wsConfig?.workspace?.repository;
        if (!region || !repositoryName) {
          if (options.json) {
            console.log(
              JSON.stringify({
                status: 'error',
                error: 'No workspace configuration found',
                code: 'NO_CONFIG',
              }),
            );
            process.exit(1);
          }
          spinner.fail(color.red('No workspace configuration found'));
          console.error(color.red('Run chimera init to configure your workspace'));
          process.exit(1);
        }
        if (wsConfig?.aws?.profile) {
          process.env.AWS_PROFILE = wsConfig.aws.profile;
        }
        if (!options.json) spinner.succeed(color.green('Workspace: ' + repositoryName + ' in ' + region));

        if (!options.json) spinner.start('Locating project root...');
        const repoRoot = findProjectRoot();
        if (!options.json) spinner.succeed(color.green(`Project root: ${repoRoot}`));

        if (!options.json) spinner.start('Resolving GitHub upstream URL...');
        const githubUrl = options.githubUrl || (await getGitHubUrl(repoRoot));
        if (!options.json) spinner.succeed(color.green(`GitHub upstream: ${githubUrl}`));

        if (options.dryRun) {
          if (!options.json) spinner.start('Checking for upstream changes (dry run)...');
        } else {
          if (!options.json) spinner.start('Upgrading from GitHub...');
        }
        await upgradeFromGitHub(repoRoot, region, repositoryName, githubUrl, options.dryRun);
        if (options.dryRun) {
          if (!options.json) spinner.succeed(color.green('Dry run complete'));
        } else {
          if (!options.json) spinner.succeed(color.green('Upgrade complete'));
        }

        if (options.json) {
          console.log(
            JSON.stringify({
              status: 'ok',
              data: { githubUrl, repository: repositoryName, dryRun: options.dryRun ?? false },
            }),
          );
        } else if (!options.dryRun) {
          console.log(color.green('\n✓ CodeCommit upgraded with latest upstream changes'));
          console.log(color.gray('\nWhat happened:'));
          console.log(color.gray('  1. Fetched latest from GitHub (upstream)'));
          console.log(color.gray('  2. Fetched current state from CodeCommit (agent edits)'));
          console.log(color.gray('  3. Merged upstream changes with agent edits'));
          console.log(color.gray('  4. Pushed merged result to CodeCommit'));
          console.log(color.gray('\nNext: Run "chimera sync" to sync your local workspace'));
        }
      } catch (error: any) {
        if (options.json) {
          console.log(
            JSON.stringify({ status: 'error', error: error.message, code: 'UPGRADE_FAILED' }),
          );
          process.exit(1);
        }
        spinner.fail(color.red('Upgrade failed'));
        console.error(color.red(error.message));
        process.exit(1);
      }
    });
}
