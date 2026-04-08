/**
 * chimera diff — Show differences between local workspace and CodeCommit
 *
 * Compares local infra/ and packages/ directories against the CodeCommit
 * repository to show what the agent has changed remotely or what local
 * changes haven't been pushed yet.
 */
import { Command } from 'commander';
import { CodeCommitClient, GetFileCommand, GetFolderCommand } from '@aws-sdk/client-codecommit';
import { loadWorkspaceConfig } from '../utils/workspace';
import { findProjectRoot } from '../utils/project';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

interface FileDiff {
  path: string;
  status: 'added_remote' | 'added_local' | 'modified' | 'deleted_remote' | 'deleted_local';
}

async function getRemoteFiles(
  client: CodeCommitClient,
  repoName: string,
  branch: string,
  folderPath: string
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(path: string) {
    try {
      const resp = await client.send(
        new GetFolderCommand({
          repositoryName: repoName,
          folderPath: path,
          commitSpecifier: branch,
        })
      );

      for (const file of resp.files || []) {
        if (file.absolutePath) {
          try {
            const fileResp = await client.send(
              new GetFileCommand({
                repositoryName: repoName,
                filePath: file.absolutePath,
                commitSpecifier: branch,
              })
            );
            if (fileResp.fileContent) {
              const content = Buffer.from(fileResp.fileContent).toString('utf-8');
              const hash = createHash('sha256').update(content).digest('hex');
              files.set(file.absolutePath, hash);
            }
          } catch {
            /* skip unreadable files */
          }
        }
      }

      for (const sub of resp.subFolders || []) {
        if (sub.absolutePath) {
          // Skip node_modules, .git, dist, cdk.out
          const name = sub.absolutePath.split('/').pop() || '';
          if (['node_modules', '.git', 'dist', 'cdk.out', '.next'].includes(name)) continue;
          await walk(sub.absolutePath);
        }
      }
    } catch {
      /* folder doesn't exist in remote */
    }
  }

  await walk(folderPath);
  return files;
}

function getLocalFiles(rootDir: string, subPath: string): Map<string, string> {
  const files = new Map<string, string>();

  function walk(dir: string, prefix: string) {
    try {
      for (const entry of readdirSync(dir)) {
        if (['node_modules', '.git', 'dist', 'cdk.out', '.next', 'bun.lock'].includes(entry))
          continue;
        const fullPath = join(dir, entry);
        const relPath = prefix ? `${prefix}/${entry}` : entry;
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, relPath);
        } else {
          const content = readFileSync(fullPath, 'utf-8');
          const hash = createHash('sha256').update(content).digest('hex');
          files.set(relPath, hash);
        }
      }
    } catch {
      /* skip unreadable dirs */
    }
  }

  walk(join(rootDir, subPath), subPath);
  return files;
}

export const diffCommand = new Command('diff')
  .description('Show differences between local workspace and CodeCommit repository')
  .option('--path <path>', 'Limit diff to a specific subdirectory (e.g., infra/lib)')
  .option('--summary', 'Show only file counts, not individual files')
  .action(async (options) => {
    try {
      const config = loadWorkspaceConfig();
      const repoName = config?.workspace?.repository || 'chimera';
      const region = config?.aws?.region || process.env.AWS_REGION || 'us-west-2';
      const branch = 'main';

      // Set AWS profile from chimera.toml if configured
      if (config?.aws?.profile) {
        process.env.AWS_PROFILE = config.aws.profile;
      }

      const projectRoot = findProjectRoot();

      console.log(`Comparing local workspace with CodeCommit/${repoName}@${branch}...`);
      console.log();

      const client = new CodeCommitClient({ region });
      const paths = options.path
        ? [options.path]
        : ['infra', 'packages', 'buildspec.yml', 'buildspec-docker.yml'];

      const allDiffs: FileDiff[] = [];

      for (const subPath of paths) {
        const remoteFiles = await getRemoteFiles(client, repoName, branch, subPath);
        const localFiles = getLocalFiles(projectRoot, subPath);

        // Files only in remote (agent added)
        for (const [filePath] of Array.from(remoteFiles.entries())) {
          if (!localFiles.has(filePath)) {
            allDiffs.push({ path: filePath, status: 'added_remote' });
          }
        }

        // Files only in local (not pushed)
        for (const [filePath] of Array.from(localFiles.entries())) {
          if (!remoteFiles.has(filePath)) {
            allDiffs.push({ path: filePath, status: 'added_local' });
          }
        }

        // Files in both but different content
        for (const [filePath, remoteHash] of Array.from(remoteFiles.entries())) {
          const localHash = localFiles.get(filePath);
          if (localHash && localHash !== remoteHash) {
            allDiffs.push({ path: filePath, status: 'modified' });
          }
        }
      }

      if (allDiffs.length === 0) {
        console.log('No differences found. Local workspace matches CodeCommit.');
        return;
      }

      // Group by status
      const groups = {
        added_remote: allDiffs.filter((d) => d.status === 'added_remote'),
        added_local: allDiffs.filter((d) => d.status === 'added_local'),
        modified: allDiffs.filter((d) => d.status === 'modified'),
      };

      if (options.summary) {
        console.log(`  Added in CodeCommit (not local):  ${groups.added_remote.length}`);
        console.log(`  Added locally (not in CodeCommit): ${groups.added_local.length}`);
        console.log(`  Modified (content differs):        ${groups.modified.length}`);
        console.log(`  Total differences:                 ${allDiffs.length}`);
      } else {
        if (groups.added_remote.length > 0) {
          console.log(`  Remote-only (${groups.added_remote.length}):`);
          groups.added_remote.forEach((d) => console.log(`    + ${d.path}`));
          console.log();
        }
        if (groups.added_local.length > 0) {
          console.log(`  Local-only (${groups.added_local.length}):`);
          groups.added_local.forEach((d) => console.log(`    - ${d.path}`));
          console.log();
        }
        if (groups.modified.length > 0) {
          console.log(`  Modified (${groups.modified.length}):`);
          groups.modified.forEach((d) => console.log(`    ~ ${d.path}`));
          console.log();
        }
        console.log(`Total: ${allDiffs.length} difference(s)`);
      }
    } catch (error: any) {
      console.error(`Diff failed: ${error.message}`);
      process.exit(1);
    }
  });
