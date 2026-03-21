#!/usr/bin/env bun
/**
 * Release automation script for Chimera
 *
 * This script automates the release process:
 * 1. Generates release notes from git log since last tag
 * 2. Creates a git tag with the new version
 * 3. Pushes the tag to trigger GitHub Actions release workflow
 *
 * Usage:
 *   bun scripts/release.ts <version>
 *
 * Example:
 *   bun scripts/release.ts 0.2.0
 */

import { spawnSync } from 'child_process';

interface ReleaseOptions {
  version: string;
  dryRun?: boolean;
}

/**
 * Execute a git command safely using spawnSync with argument array
 * This prevents command injection by not using shell expansion
 */
function execGit(args: string[]): string {
  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    // Don't use shell - pass args array directly for safety
  });

  if (result.error) {
    throw new Error(`Failed to execute git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Git command failed: git ${args.join(' ')}\n${result.stderr}`);
  }

  return result.stdout.trim();
}

/**
 * Get the latest git tag
 */
function getLatestTag(): string | null {
  try {
    const tag = execGit(['describe', '--tags', '--abbrev=0']);
    return tag || null;
  } catch {
    return null;
  }
}

/**
 * Generate release notes from git log since last tag
 */
function generateReleaseNotes(sinceTag: string | null): string {
  const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';

  try {
    const log = execGit([
      'log',
      range,
      '--pretty=format:- %s (%h)',
      '--no-merges',
    ]);

    if (!log) {
      return 'No changes since last release.';
    }

    // Group commits by type (feat, fix, chore, docs, etc.)
    const lines = log.split('\n');
    const grouped: Record<string, string[]> = {
      features: [],
      fixes: [],
      chore: [],
      docs: [],
      other: [],
    };

    for (const line of lines) {
      if (line.startsWith('- feat:') || line.startsWith('- feat(')) {
        grouped.features.push(line.replace(/^- feat(\([^)]+\))?:\s*/, '- '));
      } else if (line.startsWith('- fix:') || line.startsWith('- fix(')) {
        grouped.fixes.push(line.replace(/^- fix(\([^)]+\))?:\s*/, '- '));
      } else if (line.startsWith('- docs:') || line.startsWith('- docs(')) {
        grouped.docs.push(line.replace(/^- docs(\([^)]+\))?:\s*/, '- '));
      } else if (line.startsWith('- chore:') || line.startsWith('- chore(')) {
        grouped.chore.push(line.replace(/^- chore(\([^)]+\))?:\s*/, '- '));
      } else {
        grouped.other.push(line);
      }
    }

    // Build release notes
    const sections: string[] = [];

    if (grouped.features.length > 0) {
      sections.push('### Features\n' + grouped.features.join('\n'));
    }

    if (grouped.fixes.length > 0) {
      sections.push('### Bug Fixes\n' + grouped.fixes.join('\n'));
    }

    if (grouped.docs.length > 0) {
      sections.push('### Documentation\n' + grouped.docs.join('\n'));
    }

    if (grouped.chore.length > 0) {
      sections.push('### Maintenance\n' + grouped.chore.join('\n'));
    }

    if (grouped.other.length > 0) {
      sections.push('### Other Changes\n' + grouped.other.join('\n'));
    }

    return sections.join('\n\n');
  } catch (error) {
    console.error('Failed to generate release notes:', error);
    return 'Release notes generation failed.';
  }
}

/**
 * Validate version format (semantic versioning)
 */
function validateVersion(version: string): boolean {
  const semverRegex = /^v?\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;
  return semverRegex.test(version);
}

/**
 * Create a git tag
 */
function createTag(version: string, releaseNotes: string, dryRun: boolean = false): void {
  const tagName = version.startsWith('v') ? version : `v${version}`;

  console.log(`\n📝 Release notes for ${tagName}:`);
  console.log('─'.repeat(60));
  console.log(releaseNotes);
  console.log('─'.repeat(60));

  if (dryRun) {
    console.log('\n🔍 DRY RUN: Would create tag:', tagName);
    console.log('🔍 DRY RUN: Would push tag to origin');
    return;
  }

  try {
    // Create annotated tag
    execGit(['tag', '-a', tagName, '-m', `Release ${tagName}\n\n${releaseNotes}`]);
    console.log(`\n✓ Created tag: ${tagName}`);

    // Push tag to origin
    execGit(['push', 'origin', tagName]);
    console.log(`✓ Pushed tag to origin: ${tagName}`);

    console.log('\n🚀 GitHub Actions will now build and publish the release!');
    console.log(`   View the workflow at: https://github.com/YOUR_ORG/chimera/actions`);
  } catch (error) {
    console.error('❌ Failed to create or push tag:', error);
    process.exit(1);
  }
}

/**
 * Main release function
 */
function release(options: ReleaseOptions): void {
  const { version, dryRun = false } = options;

  // Validate version format
  if (!validateVersion(version)) {
    console.error('❌ Invalid version format. Use semantic versioning: X.Y.Z or vX.Y.Z');
    console.error('   Examples: 0.2.0, v1.0.0, 1.2.3-beta.1');
    process.exit(1);
  }

  // Ensure we're on a clean working tree
  try {
    const status = execGit(['status', '--porcelain']);
    if (status) {
      console.error('❌ Working tree is not clean. Commit or stash changes first.');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Failed to check git status:', error);
    process.exit(1);
  }

  // Get latest tag
  const latestTag = getLatestTag();
  console.log(`\n📦 Creating release for version: ${version}`);
  if (latestTag) {
    console.log(`   Previous version: ${latestTag}`);
  } else {
    console.log('   This is the first release');
  }

  // Generate release notes
  const releaseNotes = generateReleaseNotes(latestTag);

  // Create and push tag
  createTag(version, releaseNotes, dryRun);
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Chimera Release Automation

Usage:
  bun scripts/release.ts <version> [options]

Arguments:
  version     Version to release (e.g., 0.2.0 or v0.2.0)

Options:
  --dry-run   Preview the release without creating/pushing tags
  --help      Show this help message

Examples:
  bun scripts/release.ts 0.2.0
  bun scripts/release.ts v1.0.0 --dry-run
`);
    process.exit(0);
  }

  const version = args[0];
  const dryRun = args.includes('--dry-run');

  release({ version, dryRun });
}
