/**
 * Tests for packages/cli/src/commands/upgrade.ts
 *
 * Verifies exported helper functions and CLI flag registration.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Command } from 'commander';
import {
  findProjectRoot,
  git,
  hasUncommittedChanges,
  getGitHubUrl,
} from '../../commands/upgrade';
import { registerUpgradeCommand } from '../../commands/upgrade';

let tmpDir: string;

beforeEach(() => {
  // Use realpathSync to resolve macOS /var -> /private/var symlink
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-upgrade-test-')));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── findProjectRoot ──────────────────────────────────────────────────────────

describe('findProjectRoot', () => {
  it('finds package.json in current directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    const original = process.cwd();
    process.chdir(tmpDir);
    try {
      const root = findProjectRoot();
      expect(root).toBe(tmpDir);
    } finally {
      process.chdir(original);
    }
  });

  it('finds package.json by walking up from subdirectory', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    const subDir = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(subDir, { recursive: true });
    const original = process.cwd();
    process.chdir(subDir);
    try {
      const root = findProjectRoot();
      expect(root).toBe(tmpDir);
    } finally {
      process.chdir(original);
    }
  });

  it('throws when no package.json found', () => {
    // Use /tmp itself (no package.json at filesystem root)
    const original = process.cwd();
    process.chdir('/tmp');
    try {
      expect(() => findProjectRoot()).toThrow('Could not find project root');
    } finally {
      process.chdir(original);
    }
  });
});

// ─── git ─────────────────────────────────────────────────────────────────────

describe('git', () => {
  beforeEach(async () => {
    // Initialize a real git repo in tmpDir for git command tests
    await Bun.$`git init ${tmpDir}`.quiet();
    await Bun.$`git -C ${tmpDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${tmpDir} config user.name "Test"`.quiet();
  });

  it('returns stdout on success', async () => {
    const result = await git(tmpDir, ['rev-parse', '--git-dir']);
    expect(result.trim()).toBe('.git');
  });

  it('throws on failure when ignoreError is false', async () => {
    await expect(git(tmpDir, ['rev-parse', 'HEAD'])).rejects.toThrow();
  });

  it('returns empty string on failure when ignoreError is true', async () => {
    const result = await git(tmpDir, ['rev-parse', 'HEAD'], true);
    expect(result).toBe('');
  });
});

// ─── hasUncommittedChanges ───────────────────────────────────────────────────

describe('hasUncommittedChanges', () => {
  beforeEach(async () => {
    await Bun.$`git init ${tmpDir}`.quiet();
    await Bun.$`git -C ${tmpDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${tmpDir} config user.name "Test"`.quiet();
    // Create initial commit so HEAD exists
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hello');
    await Bun.$`git -C ${tmpDir} add -A`.quiet();
    await Bun.$`git -C ${tmpDir} commit -m "init"`.quiet();
  });

  it('returns false when working directory is clean', async () => {
    const result = await hasUncommittedChanges(tmpDir);
    expect(result).toBe(false);
  });

  it('returns true when there are uncommitted changes', async () => {
    fs.writeFileSync(path.join(tmpDir, 'newfile.txt'), 'new content');
    const result = await hasUncommittedChanges(tmpDir);
    expect(result).toBe(true);
  });
});

// ─── getGitHubUrl ─────────────────────────────────────────────────────────────

describe('getGitHubUrl', () => {
  it('extracts repository URL from package.json', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ repository: { url: 'https://github.com/org/repo' } }),
    );
    const url = await getGitHubUrl(tmpDir);
    expect(url).toBe('https://github.com/org/repo');
  });

  it('strips git+ prefix', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ repository: { url: 'git+https://github.com/org/repo' } }),
    );
    const url = await getGitHubUrl(tmpDir);
    expect(url).toBe('https://github.com/org/repo');
  });

  it('strips .git suffix', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ repository: { url: 'https://github.com/org/repo.git' } }),
    );
    const url = await getGitHubUrl(tmpDir);
    expect(url).toBe('https://github.com/org/repo');
  });

  it('strips both git+ prefix and .git suffix', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ repository: { url: 'git+https://github.com/org/repo.git' } }),
    );
    const url = await getGitHubUrl(tmpDir);
    expect(url).toBe('https://github.com/org/repo');
  });

  it('throws when package.json is missing', async () => {
    await expect(getGitHubUrl(tmpDir)).rejects.toThrow('package.json not found');
  });

  it('throws when repository field is missing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));
    await expect(getGitHubUrl(tmpDir)).rejects.toThrow('No repository URL found');
  });
});

// ─── --dry-run flag registration ──────────────────────────────────────────────

describe('upgrade command registration', () => {
  it('registers --dry-run flag', () => {
    const program = new Command();
    registerUpgradeCommand(program);
    const upgradeCmd = program.commands.find((c) => c.name() === 'upgrade');
    expect(upgradeCmd).toBeDefined();
    const helpText = upgradeCmd!.helpInformation();
    expect(helpText).toContain('--dry-run');
  });

  it('registers --json flag', () => {
    const program = new Command();
    registerUpgradeCommand(program);
    const upgradeCmd = program.commands.find((c) => c.name() === 'upgrade');
    const helpText = upgradeCmd!.helpInformation();
    expect(helpText).toContain('--json');
  });

  it('registers --github-url option', () => {
    const program = new Command();
    registerUpgradeCommand(program);
    const upgradeCmd = program.commands.find((c) => c.name() === 'upgrade');
    const helpText = upgradeCmd!.helpInformation();
    expect(helpText).toContain('--github-url');
  });
});
