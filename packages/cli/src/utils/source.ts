/**
 * Source management utilities - GitHub release downloads, tarball extraction, merge operations
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { execSync, execFileSync } from 'child_process';
import { color } from '../lib/color';

export interface SourceLocation {
  type: 'local' | 'github-release' | 'git-clone';
  path?: string; // For local sources
  owner?: string; // For GitHub releases
  repo?: string; // For GitHub releases
  tag?: string; // For GitHub releases (defaults to 'latest') OR git-clone tag to checkout
  remote?: string; // For git-clone: custom git remote URL
  branch?: string; // For git-clone: specific branch to checkout
}

/**
 * Resolve GitHub release to download URL
 * Uses GitHub API to get latest release tarball URL
 */
async function resolveGitHubReleaseUrl(
  owner: string,
  repo: string,
  tag: string = 'latest',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const apiUrl =
      tag === 'latest'
        ? `https://api.github.com/repos/${owner}/${repo}/releases/latest`
        : `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;

    const options = {
      headers: {
        'User-Agent': 'chimera-cli',
        Accept: 'application/vnd.github.v3+json',
      },
    };

    https
      .get(apiUrl, options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API returned ${res.statusCode}: ${data}`));
            return;
          }

          try {
            const release = JSON.parse(data);
            // Find the chimera-agent-*.tar.gz release asset (not the generic source tarball)
            const asset = (release.assets || []).find(
              (a: { name: string }) =>
                a.name.startsWith('chimera-agent-') && a.name.endsWith('.tar.gz'),
            );
            if (!asset) {
              reject(
                new Error(
                  `No chimera-agent-*.tar.gz asset found in release ${release.tag_name}. ` +
                    `Ensure the release was built with the build-agent-archive workflow job.`,
                ),
              );
              return;
            }
            resolve(asset.browser_download_url);
          } catch (err) {
            reject(new Error(`Failed to parse GitHub API response: ${err}`));
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Download file from URL to destination path
 */
function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    https
      .get(url, (res) => {
        // Follow redirects (GitHub returns 302)
        if (res.statusCode === 302 || res.statusCode === 301) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) {
            reject(new Error('Redirect without location header'));
            return;
          }
          downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });

    file.on('error', (err) => {
      fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

/**
 * Extract tarball to destination directory
 * Uses tar command (available on all Unix systems and modern Windows)
 *
 * Note: Uses execSync with application-controlled paths (mkdtempSync output).
 * Paths are quoted to prevent any shell interpretation issues.
 */
function extractTarball(tarballPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });

  // GitHub's auto-generated source archives wrap contents in <owner>-<repo>-<sha>/
  // so --strip-components=1 is correct for them. Our custom chimera-agent-*.tar.gz
  // is built from repo root with no wrapper (packages/, infra/, scripts/ at top
  // level), so stripping would delete those directories. Detect by peeking at the
  // first tarball entry: if it's a single top-level dir (no slash before its
  // trailing /), the archive is wrapped.
  const listing = execFileSync('tar', ['-tzf', tarballPath], {
    encoding: 'utf-8',
  });
  const firstEntry = listing.split('\n')[0]?.trim() ?? '';
  const isWrapped =
    firstEntry.endsWith('/') &&
    firstEntry.replace(/\/$/, '').indexOf('/') === -1;

  const tarArgs = ['-xzf', tarballPath, '-C', destDir];
  if (isWrapped) tarArgs.push('--strip-components=1');
  execFileSync('tar', tarArgs, { stdio: 'inherit' });
}

/**
 * Download GitHub release tarball, extract to temporary directory
 * Returns path to extracted directory
 */
export async function fetchGitHubRelease(
  owner: string,
  repo: string,
  tag: string = 'latest',
): Promise<string> {
  console.log(color.gray(`  Fetching GitHub release: ${owner}/${repo}@${tag}`));

  // Resolve release to tarball URL
  const tarballUrl = await resolveGitHubReleaseUrl(owner, repo, tag);
  console.log(color.gray(`  Download URL: ${tarballUrl}`));

  // Create temp directory for download
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'chimera-deploy-'));
  const tarballPath = path.join(tmpDir, 'release.tar.gz');
  const extractDir = path.join(tmpDir, 'source');

  try {
    // Download tarball
    console.log(color.gray(`  Downloading tarball...`));
    await downloadFile(tarballUrl, tarballPath);

    // Extract tarball
    console.log(color.gray(`  Extracting tarball...`));
    extractTarball(tarballPath, extractDir);

    // Clean up tarball (keep extracted source)
    fs.unlinkSync(tarballPath);

    console.log(color.gray(`  Source extracted to: ${extractDir}`));
    return extractDir;
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Clone a git remote at an optional branch or tag to a temporary directory
 * Uses execFileSync to avoid shell injection from user-supplied remote/branch/tag
 * Returns path to cloned directory
 */
export async function fetchGitClone(
  remote: string,
  branch?: string,
  tag?: string,
): Promise<string> {
  const ref = branch ?? tag;
  console.log(
    color.gray(`  Cloning git remote: ${remote}${ref ? `@${ref}` : ''}`),
  );

  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'chimera-deploy-'));
  const cloneDir = path.join(tmpDir, 'source');

  try {
    const args = ['clone', '--depth', '1'];
    if (ref) {
      args.push('--branch', ref);
    }
    args.push(remote, cloneDir);

    execFileSync('git', args, { stdio: 'inherit' });

    console.log(color.gray(`  Cloned to: ${cloneDir}`));
    return cloneDir;
  } catch (error) {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Resolve source location to local filesystem path
 * - For local sources: returns the provided path
 * - For GitHub releases: downloads and extracts, returns temp directory path
 * - For git-clone: clones remote repo, returns temp directory path
 */
export async function resolveSourcePath(source: SourceLocation): Promise<string> {
  if (source.type === 'local') {
    if (!source.path) {
      throw new Error('Local source requires path');
    }
    if (!fs.existsSync(source.path)) {
      throw new Error(`Local source path does not exist: ${source.path}`);
    }
    return source.path;
  } else if (source.type === 'github-release') {
    if (!source.owner || !source.repo) {
      throw new Error('GitHub release source requires owner and repo');
    }
    return await fetchGitHubRelease(source.owner, source.repo, source.tag);
  } else if (source.type === 'git-clone') {
    if (!source.remote) {
      throw new Error('git-clone source requires remote URL (--remote <url>)');
    }
    return await fetchGitClone(source.remote, source.branch, source.tag);
  } else {
    throw new Error(`Unknown source type: ${(source as SourceLocation).type}`);
  }
}

/**
 * Clean up temporary source directory (only for non-local sources)
 */
export function cleanupSource(sourcePath: string, source: SourceLocation): void {
  // Only clean up temp directories created by fetchGitHubRelease or fetchGitClone
  if (source.type !== 'local' && sourcePath.startsWith('/tmp/chimera-deploy-')) {
    fs.rmSync(sourcePath, { recursive: true, force: true });
  }
}
