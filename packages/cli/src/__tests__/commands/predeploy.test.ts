/**
 * Tests for packages/cli/src/commands/predeploy.ts
 *
 * Each test copies a static fixture tree from
 * src/__tests__/fixtures/predeploy/<scenario>/ into a fresh tmp root, then
 * runs the scanner against that root. Fixtures live on disk (not inline
 * strings) so they double as human-readable examples of each failure shape.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  checkBunBundleRequire,
  checkTscBuildForce,
  checkPlaywrightGlob,
  checkCdkCountTripwire,
  findTscForceViolations,
  applyTscForceFix,
  extractBunTestPaths,
  expandTestTarget,
  findExactCountAssertions,
  runPredeployChecks,
} from '../../commands/predeploy';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'predeploy');

let tmpRoot: string;

/**
 * Recursively copy a fixture scenario into tmpRoot.
 * fixtureName must match a subdir under __tests__/fixtures/predeploy/.
 */
function copyFixture(fixtureName: string): void {
  const src = path.join(FIXTURES_DIR, fixtureName);
  if (!fs.existsSync(src)) {
    throw new Error(`Fixture not found: ${src}`);
  }
  copyDir(src, tmpRoot);
}

/**
 * Fixture files that would themselves match bun test's discovery rules
 * (*.test.ts, *.spec.ts) are stored on disk with a trailing `.source`
 * suffix to keep bun from trying to execute them. The suffix is stripped
 * at copy time so the scanner under test sees the realistic filename.
 */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const destName = ent.name.endsWith('.source') ? ent.name.slice(0, -'.source'.length) : ent.name;
    const d = path.join(dest, destName);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-predeploy-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// checkBunBundleRequire

describe('checkBunBundleRequire', () => {
  it('passes when no Dockerfile is present', () => {
    const r = checkBunBundleRequire(tmpRoot);
    expect(r.status).toBe('pass');
  });

  it('fails when NODE_OPTIONS=--require is combined with bun-bundle CMD', () => {
    copyFixture('dockerfile-require-bun-bundle');
    const r = checkBunBundleRequire(tmpRoot);
    expect(r.status).toBe('fail');
    expect(r.details).toContain('Bun-bundled Dockerfile cannot satisfy --require');
    expect(r.details).toContain('SKILL.md');
  });

  it('passes when Dockerfile has no --require trap', () => {
    copyFixture('dockerfile-clean');
    const r = checkBunBundleRequire(tmpRoot);
    expect(r.status).toBe('pass');
  });

  it('warns when --require present but CMD is not bun-bundle', () => {
    copyFixture('dockerfile-require-non-bun');
    const r = checkBunBundleRequire(tmpRoot);
    expect(r.status).toBe('warn');
  });

  it('ignores --require inside a comment', () => {
    copyFixture('dockerfile-require-commented');
    const r = checkBunBundleRequire(tmpRoot);
    expect(r.status).toBe('pass');
  });
});

// checkTscBuildForce

describe('checkTscBuildForce', () => {
  it('passes when no buildspec exists', () => {
    const r = checkTscBuildForce(tmpRoot);
    expect(r.status).toBe('pass');
  });

  it('fails when buildspec-docker.yml has tsc --build without --force', () => {
    copyFixture('tsc-missing-force');
    const r = checkTscBuildForce(tmpRoot);
    expect(r.status).toBe('fail');
    expect(r.details).toContain('--force');
    expect(r.details).toContain('buildspec-docker.yml');
  });

  it('passes when tsc --build includes --force', () => {
    copyFixture('tsc-has-force');
    const r = checkTscBuildForce(tmpRoot);
    expect(r.status).toBe('pass');
  });

  it('also catches buildspec.yml violations with -b short flag', () => {
    copyFixture('tsc-short-flag');
    const findings = findTscForceViolations(tmpRoot);
    expect(findings.length).toBe(1);
    expect(findings[0]?.file).toBe('buildspec.yml');
  });
});

describe('applyTscForceFix', () => {
  it('patches tsc --build lines and returns the number modified', () => {
    copyFixture('tsc-mixed');
    const fixed = applyTscForceFix(tmpRoot);
    expect(fixed).toBe(1);
    const after = fs.readFileSync(path.join(tmpRoot, 'buildspec-docker.yml'), 'utf8');
    expect(after).toContain('bunx tsc --build --force packages/shared/tsconfig.json');
    // idempotent: second run does nothing
    expect(applyTscForceFix(tmpRoot)).toBe(0);
  });

  it('returns 0 when buildspec-docker.yml is absent', () => {
    expect(applyTscForceFix(tmpRoot)).toBe(0);
  });
});

// checkPlaywrightGlob

describe('extractBunTestPaths', () => {
  it('extracts paths from a buildspec command line', () => {
    const line = '      - bun test ./packages/shared/ ./packages/core/ ./tests/';
    expect(extractBunTestPaths(line)).toEqual([
      './packages/shared/',
      './packages/core/',
      './tests/',
    ]);
  });

  it('ignores flags', () => {
    const line = 'bun test --coverage ./packages/shared/';
    expect(extractBunTestPaths(line)).toEqual(['./packages/shared/']);
  });

  it('handles chained commands', () => {
    const line = 'bun test integration && bun test helpers';
    expect(extractBunTestPaths(line)).toEqual(['integration', 'helpers']);
  });

  it('returns empty when the line has no bun test', () => {
    expect(extractBunTestPaths('bunx playwright test')).toEqual([]);
  });
});

describe('expandTestTarget', () => {
  it('expands a directory to .test.ts / .spec.ts files inside it', () => {
    copyFixture('expand-testdir');
    const files = expandTestTarget(tmpRoot, 'pkg/');
    expect(files.length).toBe(2);
    expect(files.some((f) => f.endsWith('foo.test.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('bar.spec.ts'))).toBe(true);
  });

  it('returns a single file when target is a file path', () => {
    copyFixture('expand-testdir');
    const files = expandTestTarget(tmpRoot, 'pkg/src/foo.test.ts');
    expect(files.length).toBe(1);
    expect(files[0]).toBe(path.join(tmpRoot, 'pkg/src/foo.test.ts'));
  });

  it('returns [] for a nonexistent target', () => {
    expect(expandTestTarget(tmpRoot, 'does/not/exist')).toEqual([]);
  });
});

describe('checkPlaywrightGlob', () => {
  it('fails when buildspec bun test glob pulls in @playwright/test', () => {
    copyFixture('playwright-contamination');
    const r = checkPlaywrightGlob(tmpRoot);
    expect(r.status).toBe('fail');
    expect(r.details).toContain('@playwright/test');
    expect(r.details).toContain('tests/e2e/chat.spec.ts');
  });

  it('passes when bun test glob does not hit any playwright file', () => {
    copyFixture('playwright-clean');
    const r = checkPlaywrightGlob(tmpRoot);
    expect(r.status).toBe('pass');
  });

  it('passes when nothing runs bun test', () => {
    copyFixture('playwright-no-buntest');
    const r = checkPlaywrightGlob(tmpRoot);
    expect(r.status).toBe('pass');
  });
});

// checkCdkCountTripwire

describe('findExactCountAssertions', () => {
  it('returns [] when infra/test is absent', () => {
    expect(findExactCountAssertions(tmpRoot)).toEqual([]);
  });

  it('finds resourceCountIs, findResources+toBe, and Object.keys+toBe assertions', () => {
    copyFixture('cdk-count-assertions');
    const hits = findExactCountAssertions(tmpRoot);
    expect(hits.length).toBe(3);
    expect(hits.every((h) => h.file === 'infra/test/network-stack.test.ts')).toBe(true);
  });
});

describe('checkCdkCountTripwire', () => {
  it('warns (never fails) when brittle assertions exist', () => {
    copyFixture('cdk-count-single');
    const r = checkCdkCountTripwire(tmpRoot);
    expect(r.status).toBe('warn');
    expect(r.details).toContain('exact-count assertions found');
  });

  it('passes when there are none', () => {
    copyFixture('cdk-no-counts');
    const r = checkCdkCountTripwire(tmpRoot);
    expect(r.status).toBe('pass');
  });
});

// runPredeployChecks integration

describe('runPredeployChecks', () => {
  it('returns all four checks in stable order', () => {
    const results = runPredeployChecks(tmpRoot);
    expect(results.length).toBe(4);
    expect(results[0]?.name).toContain('Bun-bundle');
    expect(results[1]?.name).toContain('tsc --build');
    expect(results[2]?.name).toContain('bun test glob');
    expect(results[3]?.name).toContain('CDK exact-count');
  });

  it('reports failures when multiple checks trip', () => {
    copyFixture('multi-fail');
    const results = runPredeployChecks(tmpRoot);
    const failed = results.filter((r) => r.status === 'fail');
    expect(failed.length).toBeGreaterThanOrEqual(2);
  });
});
