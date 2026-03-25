#!/usr/bin/env bun
/**
 * Release automation script for Chimera
 *
 * This script automates the release process:
 * 1. Determines next semver from git tags (--patch/--minor/--major)
 * 2. Generates release notes from git log (or AI-generated via --ai-notes)
 * 3. Creates an annotated git tag
 * 4. Pushes the tag to trigger GitHub Actions release workflow
 * 5. Monitors the GH Actions run until completion
 *
 * Usage:
 *   bun run release [--patch|--minor|--major] [--dry-run] [--ai-notes]
 *
 * Examples:
 *   bun run release                  # bump patch (default)
 *   bun run release --minor          # bump minor version
 *   bun run release --major          # bump major version
 *   bun run release --dry-run        # preview without tagging
 *   bun run release --ai-notes       # use Claude to generate release notes
 */

import { spawnSync } from 'child_process';

type BumpType = 'patch' | 'minor' | 'major';

/** Synchronous sleep using OS sleep command (avoids Bun-specific API). */
function sleepSync(ms: number): void {
  spawnSync('sleep', [String(ms / 1000)]);
}

interface ReleaseOptions {
  bump: BumpType;
  dryRun: boolean;
  aiNotes: boolean;
}

/**
 * Execute a command safely using spawnSync with argument array.
 * Prevents command injection by not using shell expansion.
 */
function execCmd(
  cmd: string,
  args: string[],
  options: { timeout?: number; ignoreError?: boolean } = {}
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    timeout: options.timeout,
  });

  if (result.error && !options.ignoreError) {
    throw new Error(`Failed to execute ${cmd}: ${result.error.message}`);
  }

  return {
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    status: result.status,
  };
}

function execGit(args: string[]): string {
  const r = execCmd('git', args);
  if (r.status !== 0) {
    throw new Error(`Git command failed: git ${args.join(' ')}\n${r.stderr}`);
  }
  return r.stdout;
}

/**
 * Get the latest git tag (semver-like).
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
 * Parse version string like "v1.2.3" or "1.2.3" into [major, minor, patch].
 */
function parseVersion(version: string): [number, number, number] {
  const clean = version.replace(/^v/, '');
  const parts = clean.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Cannot parse version: ${version}`);
  }
  return [parts[0], parts[1], parts[2]];
}

/**
 * Compute the next version string given the latest tag and bump type.
 */
function computeNextVersion(latestTag: string | null, bump: BumpType): string {
  if (!latestTag) {
    return 'v0.1.0';
  }
  const [major, minor, patch] = parseVersion(latestTag);
  switch (bump) {
    case 'major':
      return `v${major + 1}.0.0`;
    case 'minor':
      return `v${major}.${minor + 1}.0`;
    case 'patch':
    default:
      return `v${major}.${minor}.${patch + 1}`;
  }
}

/**
 * Generate release notes from git log since last tag, grouped by commit type.
 */
function generateReleaseNotes(sinceTag: string | null): string {
  const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';

  let log: string;
  try {
    log = execGit(['log', range, '--pretty=format:- %s (%h)', '--no-merges']);
  } catch (error) {
    console.error('Failed to generate release notes:', error);
    return 'Release notes generation failed.';
  }

  if (!log) {
    return 'No changes since last release.';
  }

  const lines = log.split('\n');
  const grouped: Record<string, string[]> = {
    features: [],
    fixes: [],
    docs: [],
    chore: [],
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

  const sections: string[] = [];
  if (grouped.features.length > 0) sections.push('### Features\n' + grouped.features.join('\n'));
  if (grouped.fixes.length > 0) sections.push('### Bug Fixes\n' + grouped.fixes.join('\n'));
  if (grouped.docs.length > 0) sections.push('### Documentation\n' + grouped.docs.join('\n'));
  if (grouped.chore.length > 0) sections.push('### Maintenance\n' + grouped.chore.join('\n'));
  if (grouped.other.length > 0) sections.push('### Other Changes\n' + grouped.other.join('\n'));

  return sections.join('\n\n');
}

/**
 * Use Claude CLI to generate polished release notes from raw git log.
 * Falls back to standard notes if claude is unavailable or fails.
 */
function generateAiReleaseNotes(rawLog: string, version: string): string {
  const prompt = `You are writing release notes for Chimera ${version}, a multi-tenant AI agent platform.

Given this git log, write concise, polished release notes in markdown. Group by features, bug fixes, and improvements. Focus on user-facing impact. Be brief and clear.

Git log:
${rawLog}

Write only the release notes markdown, no preamble.`;

  console.log('🤖 Generating AI release notes via Claude...');
  const result = execCmd('claude', ['--print', prompt], { timeout: 30000, ignoreError: true });

  if (result.status === 0 && result.stdout) {
    return result.stdout;
  }

  console.warn('⚠️  Claude unavailable or failed, falling back to standard release notes.');
  return '';
}

/**
 * Wait for a GitHub Actions workflow run for release.yml and monitor until complete.
 * Returns the final status.
 */
function monitorGhActionsRun(_tagName: string): 'success' | 'failure' | 'cancelled' | 'timeout' | 'skipped' {
  // Check if gh CLI is available
  const ghCheck = execCmd('gh', ['--version'], { ignoreError: true });
  if (ghCheck.status !== 0) {
    console.warn('⚠️  gh CLI not available — skipping GH Actions monitoring.');
    return 'skipped';
  }

  console.log('\n⏳ Waiting 8s for GitHub Actions to pick up the new tag...');
  sleepSync(8000);

  const timeoutMs = 30 * 60 * 1000; // 30 minutes
  const pollIntervalMs = 15000; // 15 seconds
  const startTime = Date.now();

  // Find the run triggered by the tag push
  let runId: string | null = null;
  let findAttempts = 0;

  while (!runId && Date.now() - startTime < 60000) {
    findAttempts++;
    const listResult = execCmd(
      'gh',
      ['run', 'list', '--workflow=release.yml', '--limit=3', '--json', 'databaseId,status,headBranch,createdAt'],
      { ignoreError: true }
    );

    if (listResult.status === 0 && listResult.stdout) {
      try {
        const runs = JSON.parse(listResult.stdout) as Array<{
          databaseId: number;
          status: string;
          headBranch: string;
          createdAt: string;
        }>;
        const recent = runs.find(
          r => r.status === 'queued' || r.status === 'in_progress' || r.status === 'completed'
        );
        if (recent) {
          runId = String(recent.databaseId);
          console.log(`\n🔍 Found workflow run: ${runId} (${recent.status})`);
        }
      } catch {
        // JSON parse failed, try again
      }
    }

    if (!runId) {
      if (findAttempts < 4) {
        console.log(`   Waiting for run to appear (attempt ${findAttempts})...`);
        sleepSync(5000);
      } else {
        break;
      }
    }
  }

  if (!runId) {
    console.warn('⚠️  Could not find workflow run. Check GitHub Actions manually.');
    return 'skipped';
  }

  console.log(`\n📊 Monitoring run ${runId} (timeout: 30min)...`);

  while (Date.now() - startTime < timeoutMs) {
    const viewResult = execCmd('gh', ['run', 'view', runId, '--json', 'status,conclusion,jobs'], {
      ignoreError: true,
    });

    if (viewResult.status === 0 && viewResult.stdout) {
      try {
        const run = JSON.parse(viewResult.stdout) as {
          status: string;
          conclusion: string | null;
          jobs?: Array<{ name: string; status: string; conclusion: string | null }>;
        };
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        if (run.status === 'completed') {
          const conclusion = run.conclusion ?? 'unknown';
          if (conclusion === 'success') {
            console.log(`\n✅ Workflow completed successfully (${elapsed}s)`);
            return 'success';
          } else if (conclusion === 'failure') {
            console.log(`\n❌ Workflow failed (${elapsed}s)`);
            console.log(`   View details: gh run view ${runId}`);
            return 'failure';
          } else {
            console.log(`\n⚠️  Workflow ended with: ${conclusion} (${elapsed}s)`);
            return 'cancelled';
          }
        }

        // Print job status summary
        if (run.jobs && run.jobs.length > 0) {
          const jobSummary = run.jobs
            .map(j =>
              `${j.status === 'completed' ? (j.conclusion === 'success' ? '✓' : '✗') : '⏳'} ${j.name}`
            )
            .join('  ');
          process.stdout.write(`\r   [${elapsed}s] ${run.status}: ${jobSummary}     `);
        } else {
          process.stdout.write(`\r   [${elapsed}s] ${run.status}...     `);
        }
      } catch {
        // JSON parse failed
      }
    }

    sleepSync(pollIntervalMs);
  }

  console.log('\n⏰ Monitoring timed out after 30 minutes.');
  console.log(`   View run: gh run view ${runId}`);
  return 'timeout';
}

/**
 * Verify the GitHub release was created successfully after the workflow.
 */
function verifyRelease(tagName: string): void {
  const ghCheck = execCmd('gh', ['--version'], { ignoreError: true });
  if (ghCheck.status !== 0) return;

  console.log('\n🔎 Verifying GitHub release...');
  const result = execCmd('gh', ['release', 'view', tagName, '--json', 'tagName,name,assets'], {
    ignoreError: true,
  });

  if (result.status === 0 && result.stdout) {
    try {
      const rel = JSON.parse(result.stdout) as {
        tagName: string;
        name: string;
        assets: Array<{ name: string }>;
      };
      console.log(`✅ Release: ${rel.name} (${rel.tagName})`);
      if (rel.assets.length > 0) {
        console.log(`   Assets (${rel.assets.length}):`);
        for (const asset of rel.assets) {
          console.log(`   - ${asset.name}`);
        }
      } else {
        console.log('   No assets yet (still building?)');
      }
    } catch {
      console.log('   Release found but could not parse details.');
    }
  } else {
    console.warn(`⚠️  Could not verify release for ${tagName}`);
  }
}

/**
 * Main release function.
 */
function release(options: ReleaseOptions): void {
  const { bump, dryRun, aiNotes } = options;

  // Ensure clean working tree
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

  // Determine next version
  const latestTag = getLatestTag();
  const nextVersion = computeNextVersion(latestTag, bump);
  const tagName = nextVersion;

  console.log(`\n📦 Chimera Release`);
  console.log(`   Bump:     ${bump}`);
  console.log(`   Previous: ${latestTag ?? '(none)'}`);
  console.log(`   Next:     ${nextVersion}`);

  // Generate release notes
  let releaseNotes: string;
  const sinceTag = latestTag;

  if (aiNotes) {
    const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';
    let rawLog = '';
    try {
      rawLog = execGit(['log', range, '--pretty=format:%s (%h)', '--no-merges']);
    } catch {
      rawLog = '';
    }
    const aiResult = generateAiReleaseNotes(rawLog, nextVersion);
    releaseNotes = aiResult || generateReleaseNotes(sinceTag);
  } else {
    releaseNotes = generateReleaseNotes(sinceTag);
  }

  // Display release notes
  console.log(`\n📝 Release notes for ${tagName}:`);
  console.log('─'.repeat(60));
  console.log(releaseNotes);
  console.log('─'.repeat(60));

  if (dryRun) {
    console.log('\n🔍 DRY RUN: Would create annotated tag:', tagName);
    console.log('🔍 DRY RUN: Would push tag to origin to trigger release.yml');
    console.log('🔍 DRY RUN: Would monitor GH Actions run until complete');
    return;
  }

  // Create annotated tag
  try {
    execGit(['tag', '-a', tagName, '-m', `Release ${tagName}\n\n${releaseNotes}`]);
    console.log(`\n✓ Created tag: ${tagName}`);
  } catch (error) {
    console.error('❌ Failed to create tag:', error);
    process.exit(1);
  }

  // Push tag to trigger release workflow
  try {
    execGit(['push', 'origin', tagName]);
    console.log(`✓ Pushed tag to origin: ${tagName}`);
    console.log('\n🚀 GitHub Actions release workflow triggered!');
  } catch (error) {
    console.error('❌ Failed to push tag:', error);
    console.error('   Tag was created locally. To retry: git push origin', tagName);
    process.exit(1);
  }

  // Monitor the GH Actions run
  const runResult = monitorGhActionsRun(tagName);

  if (runResult === 'success') {
    verifyRelease(tagName);
    console.log(`\n🎉 Release ${tagName} published successfully!`);
  } else if (runResult === 'skipped') {
    console.log(`\n📌 Tag ${tagName} pushed. Monitor release workflow manually.`);
  } else {
    console.log(`\n⚠️  Workflow ended with status: ${runResult}`);
    console.log('   Check GitHub Actions for details.');
    process.exit(1);
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Chimera Release Automation

Usage:
  bun run release [options]

Options:
  --patch     Bump patch version: 1.2.3 → 1.2.4 (default)
  --minor     Bump minor version: 1.2.3 → 1.3.0
  --major     Bump major version: 1.2.3 → 2.0.0
  --dry-run   Preview the release without creating/pushing tags
  --ai-notes  Use Claude to generate polished release notes
  --help      Show this help message

Examples:
  bun run release                    # bump patch
  bun run release --minor            # bump minor
  bun run release --major --dry-run  # preview major bump
  bun run release --ai-notes         # AI-generated release notes
`);
    process.exit(0);
  }

  let bump: BumpType = 'patch';
  if (args.includes('--major')) bump = 'major';
  else if (args.includes('--minor')) bump = 'minor';

  const dryRun = args.includes('--dry-run');
  const aiNotes = args.includes('--ai-notes');

  release({ bump, dryRun, aiNotes });
}
