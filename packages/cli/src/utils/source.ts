/**
 * Source management utilities - GitHub release downloads, tarball extraction, merge operations
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { execSync } from 'child_process';
import chalk from 'chalk';

export interface SourceLocation {
  type: 'local' | 'github-release';
  path?: string; // For local sources
  owner?: string; // For GitHub releases
  repo?: string; // For GitHub releases
  tag?: string; // For GitHub releases (defaults to 'latest')
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
            // Use tarball_url for source tarball (not zipball)
            resolve(release.tarball_url);
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
  // Create destination directory
  fs.mkdirSync(destDir, { recursive: true });

  // Extract tarball (strips first component - GitHub adds <owner>-<repo>-<sha> prefix)
  // Both paths are application-generated (not user input), wrapped in quotes for safety
  execSync(`tar -xzf "${tarballPath}" -C "${destDir}" --strip-components=1`, {
    stdio: 'inherit',
  });
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
  console.log(chalk.gray(`  Fetching GitHub release: ${owner}/${repo}@${tag}`));

  // Resolve release to tarball URL
  const tarballUrl = await resolveGitHubReleaseUrl(owner, repo, tag);
  console.log(chalk.gray(`  Download URL: ${tarballUrl}`));

  // Create temp directory for download
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'chimera-deploy-'));
  const tarballPath = path.join(tmpDir, 'release.tar.gz');
  const extractDir = path.join(tmpDir, 'source');

  try {
    // Download tarball
    console.log(chalk.gray(`  Downloading tarball...`));
    await downloadFile(tarballUrl, tarballPath);

    // Extract tarball
    console.log(chalk.gray(`  Extracting tarball...`));
    extractTarball(tarballPath, extractDir);

    // Clean up tarball (keep extracted source)
    fs.unlinkSync(tarballPath);

    console.log(chalk.gray(`  Source extracted to: ${extractDir}`));
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
 * Resolve source location to local filesystem path
 * - For local sources: returns the provided path
 * - For GitHub releases: downloads and extracts, returns temp directory path
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
  } else {
    throw new Error(`Unknown source type: ${source.type}`);
  }
}

/**
 * Clean up temporary source directory (only for non-local sources)
 */
export function cleanupSource(sourcePath: string, source: SourceLocation): void {
  // Only clean up temp directories created by fetchGitHubRelease
  if (source.type !== 'local' && sourcePath.startsWith('/tmp/chimera-deploy-')) {
    fs.rmSync(sourcePath, { recursive: true, force: true });
  }
}
