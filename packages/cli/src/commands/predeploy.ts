/**
 * chimera predeploy - Offline pre-flight checks run BEFORE chimera deploy.
 *
 * Runs 4 parity checks, each catching a class of pipeline failure this team
 * has already hit. No network calls - filesystem scans only.
 *
 *   1. Bun-bundle --require sand-trap   (chat-gateway Dockerfile)
 *   2. tsc --build without --force      (buildspec-docker.yml)
 *   3. bun test e2e glob pulls Playwright (buildspec.yml + tests/package.json)
 *   4. CDK exact-count tripwire          (infra/test)
 *
 * Each check emits pass/fail with actionable remediation. --fix auto-patches
 * check #2. --json returns a machine-readable summary for scripting.
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { findProjectRoot } from '../utils/project';
import { color } from '../lib/color';

type Status = 'pass' | 'fail' | 'warn';

export interface PredeployCheckResult {
  name: string;
  status: Status;
  details: string;
}

// Check 1: Bun-bundle --require sand-trap

export function checkBunBundleRequire(root: string): PredeployCheckResult {
  const name = 'Bun-bundle --require sand-trap';
  const dockerfile = path.join(root, 'packages/chat-gateway/Dockerfile');
  if (!fs.existsSync(dockerfile)) {
    return {
      name,
      status: 'pass',
      details: 'packages/chat-gateway/Dockerfile not present - skipping.',
    };
  }

  const text = fs.readFileSync(dockerfile, 'utf8');
  const lines = text.split('\n');
  const requireRegex = /NODE_OPTIONS\s*=\s*["']?[^"'\n]*--require[^"'\n]*/;
  const offending: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const stripped = raw.replace(/#.*$/, '');
    if (requireRegex.test(stripped)) {
      offending.push({ line: i + 1, text: raw.trim() });
    }
  }

  const bunServerCmd = /CMD\s*\[\s*"bun"\s*,\s*"(?:[^"]*\/)?server\.js"/.test(text);

  if (offending.length > 0 && bunServerCmd) {
    const where = offending.map((o) => `  L${o.line}: ${o.text}`).join('\n');
    return {
      name,
      status: 'fail',
      details:
        'Bun-bundled Dockerfile cannot satisfy --require <module>. Import the module ' +
        'at top-of-file instead. See ~/.claude/skills/bun-bundle-node-require-flag-incompatible/SKILL.md\n' +
        where,
    };
  }

  if (offending.length > 0) {
    return {
      name,
      status: 'warn',
      details:
        'Found NODE_OPTIONS=--require in Dockerfile but CMD is not bun-bundle shape - verify manually:\n' +
        offending.map((o) => `  L${o.line}: ${o.text}`).join('\n'),
    };
  }

  return { name, status: 'pass', details: 'No --require traps in chat-gateway Dockerfile.' };
}

// Check 2: tsc --build without --force

export interface TscForceFinding {
  file: string;
  line: number;
  text: string;
}

export function findTscForceViolations(root: string): TscForceFinding[] {
  const targets = ['buildspec-docker.yml', 'buildspec.yml'];
  const findings: TscForceFinding[] = [];
  for (const rel of targets) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw) continue;
      // YAML comments — everything after an unquoted `#` is documentation,
      // not a command. Buildspec shell lines start with "- " before the command.
      const trimmed = raw.trim();
      if (trimmed.startsWith('#')) continue;
      if (!/\btsc\s+(?:--build\b|-b\b)/.test(raw)) continue;
      if (/--force\b/.test(raw)) continue;
      findings.push({ file: rel, line: i + 1, text: raw.trim() });
    }
  }
  return findings;
}

export function checkTscBuildForce(root: string): PredeployCheckResult {
  const name = 'tsc --build without --force';
  const findings = findTscForceViolations(root);
  if (findings.length === 0) {
    return { name, status: 'pass', details: 'All tsc --build invocations include --force.' };
  }
  const where = findings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join('\n');
  return {
    name,
    status: 'fail',
    details:
      'CodeBuild fresh checkouts trip TS6305 without --force. Add --force: ' +
      'bunx tsc --build --force <tsconfigs...>\n' +
      where,
  };
}

export function applyTscForceFix(root: string): number {
  const target = path.join(root, 'buildspec-docker.yml');
  if (!fs.existsSync(target)) return 0;
  const original = fs.readFileSync(target, 'utf8');
  let patchedCount = 0;
  const patched = original
    .split('\n')
    .map((raw) => {
      if (!/\btsc\s+(?:--build\b|-b\b)/.test(raw)) return raw;
      if (/--force\b/.test(raw)) return raw;
      patchedCount++;
      return raw.replace(/\btsc\s+(--build\b|-b\b)/, 'tsc $1 --force');
    })
    .join('\n');
  if (patchedCount > 0) {
    fs.writeFileSync(target, patched, 'utf8');
  }
  return patchedCount;
}

// Check 3: bun test e2e glob sucks in Playwright

const PLAYWRIGHT_IMPORT = /from\s+['"]@playwright\/test['"]/;

export function extractBunTestPaths(line: string): string[] {
  const cleaned = line.replace(/^\s*-\s*/, '').trim();
  const out: string[] = [];
  const re = /\bbun\s+test\s+([^&|;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const argStr = (m[1] ?? '').trim();
    if (!argStr) continue;
    for (const tok of argStr.split(/\s+/)) {
      if (!tok) continue;
      if (tok.startsWith('-')) continue;
      out.push(tok);
    }
  }
  return out;
}

export function expandTestTarget(root: string, target: string): string[] {
  const abs = path.resolve(root, target);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  if (!stat.isDirectory()) return [];

  const results: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile()) {
        if (/\.(test|spec)\.(t|j)sx?$/.test(ent.name)) {
          results.push(p);
        }
      }
    }
  };
  walk(abs);
  return results;
}

export function checkPlaywrightGlob(root: string): PredeployCheckResult {
  const name = 'bun test glob vs @playwright/test';
  const sources = [
    { file: 'buildspec.yml', content: readIfExists(root, 'buildspec.yml') },
    { file: 'buildspec-docker.yml', content: readIfExists(root, 'buildspec-docker.yml') },
    { file: 'tests/package.json', content: readIfExists(root, 'tests/package.json') },
    { file: 'package.json', content: readIfExists(root, 'package.json') },
  ];

  const contamination: { source: string; target: string; file: string }[] = [];
  for (const src of sources) {
    if (!src.content) continue;
    const lines = src.content.split('\n');
    for (const line of lines) {
      for (const tgt of extractBunTestPaths(line)) {
        for (const f of expandTestTarget(root, tgt)) {
          const body = safeRead(f);
          if (!body) continue;
          // Exclude the predeploy.test fixtures — the test file contains the
          // @playwright/test string as a literal to generate fixture source.
          if (/\bpredeploy\.test\.tsx?$/.test(f)) continue;
          if (PLAYWRIGHT_IMPORT.test(body)) {
            contamination.push({ source: src.file, target: tgt, file: path.relative(root, f) });
          }
        }
      }
    }
  }

  if (contamination.length === 0) {
    return { name, status: 'pass', details: 'No `bun test` glob pulls in @playwright/test.' };
  }
  const where = contamination
    .map((c) => `  ${c.source}: "bun test ${c.target}" -> ${c.file}`)
    .join('\n');
  return {
    name,
    status: 'fail',
    details:
      'bun test glob matched a file that imports @playwright/test. Narrow the glob or use ' +
      '`--exclude`. Playwright tests run via `bunx playwright test`, not `bun test`.\n' +
      where,
  };
}

function readIfExists(root: string, rel: string): string | null {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? safeRead(p) : null;
}

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// Check 4: CDK template-count tripwire

const RESOURCE_COUNT_IS = /\.resourceCountIs\s*\(\s*['"][^'"]+['"]\s*,\s*(\d+)\s*\)/g;
const FIND_RESOURCES_TO_BE =
  /findResources\s*\([^)]*\)[^\n]*\.length\s*\)?\s*\.toBe\s*\(\s*(\d+)\s*\)/g;
const OBJECT_KEYS_TO_BE = /Object\.keys\s*\([^)]+\)\s*\.length\s*\)\s*\.toBe\s*\(\s*(\d+)\s*\)/g;

export interface CountAssertion {
  file: string;
  line: number;
  text: string;
}

export function findExactCountAssertions(root: string): CountAssertion[] {
  const testDir = path.join(root, 'infra/test');
  if (!fs.existsSync(testDir)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && /\.test\.tsx?$/.test(ent.name)) files.push(p);
    }
  };
  walk(testDir);

  const out: CountAssertion[] = [];
  for (const f of files) {
    const body = safeRead(f);
    if (!body) continue;
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw) continue;
      RESOURCE_COUNT_IS.lastIndex = 0;
      FIND_RESOURCES_TO_BE.lastIndex = 0;
      OBJECT_KEYS_TO_BE.lastIndex = 0;
      if (
        RESOURCE_COUNT_IS.test(raw) ||
        FIND_RESOURCES_TO_BE.test(raw) ||
        OBJECT_KEYS_TO_BE.test(raw)
      ) {
        out.push({ file: path.relative(root, f), line: i + 1, text: raw.trim() });
      }
    }
  }
  return out;
}

export function checkCdkCountTripwire(root: string): PredeployCheckResult {
  const name = 'CDK exact-count assertion tripwire';
  const hits = findExactCountAssertions(root);
  if (hits.length === 0) {
    return { name, status: 'pass', details: 'No brittle exact-count assertions in infra/test.' };
  }
  const preview = hits.slice(0, 10).map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');
  const more = hits.length > 10 ? `\n  ...and ${hits.length - 10} more` : '';
  return {
    name,
    status: 'warn',
    details:
      `${hits.length} exact-count assertions found. Adding a CDK resource in these stacks ` +
      'will break these tests. See ~/.claude/skills/cdk-resource-count-test-tripwire/SKILL.md\n' +
      preview +
      more,
  };
}

// Output formatting

function iconFor(status: Status): string {
  if (status === 'pass') return color.green('✓');
  if (status === 'fail') return color.red('✗');
  return color.yellow('⚠');
}

function printResult(r: PredeployCheckResult): void {
  console.log(`  ${iconFor(r.status)} ${color.bold(r.name)}`);
  if (r.details) {
    for (const line of r.details.split('\n')) {
      console.log(`    ${color.dim(line)}`);
    }
  }
}

// Runner

export function runPredeployChecks(root: string): PredeployCheckResult[] {
  return [
    checkBunBundleRequire(root),
    checkTscBuildForce(root),
    checkPlaywrightGlob(root),
    checkCdkCountTripwire(root),
  ];
}

// Command registration

export function registerPredeployCommand(program: Command): void {
  program
    .command('predeploy')
    .description('Run offline pre-flight parity checks before `chimera deploy`')
    .option('--json', 'Output results as JSON')
    .option(
      '--fix',
      'Auto-remediate fixable issues (currently: tsc --force in buildspec-docker.yml)'
    )
    .addHelpText(
      'after',
      `
Examples:
  $ chimera predeploy
  $ chimera predeploy --fix
  $ chimera predeploy --json`
    )
    .action((options: { json?: boolean; fix?: boolean }) => {
      const root = findProjectRoot();

      if (options.fix) {
        const fixed = applyTscForceFix(root);
        if (!options.json) {
          if (fixed > 0) {
            console.log(
              color.green(`Patched ${fixed} tsc --build line(s) in buildspec-docker.yml`)
            );
          } else {
            console.log(color.dim('No tsc --build lines needed patching.'));
          }
        }
      }

      const checks = runPredeployChecks(root);

      if (options.json) {
        const output = {
          status: checks.some((c) => c.status === 'fail')
            ? 'fail'
            : checks.some((c) => c.status === 'warn')
              ? 'warn'
              : 'pass',
          checks: checks.map((c) => ({
            name: c.name,
            passed: c.status === 'pass',
            status: c.status,
            details: c.details,
          })),
        };
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(color.bold('\nChimera Predeploy - Parity Checks\n'));
        for (const r of checks) printResult(r);
        const failed = checks.filter((c) => c.status === 'fail').length;
        const warned = checks.filter((c) => c.status === 'warn').length;
        if (failed > 0) {
          console.log(
            `\n${color.red(`${failed} check(s) failed.`)} ${color.dim('Fix the items above before `chimera deploy`.')}`
          );
        } else if (warned > 0) {
          console.log(
            `\n${color.yellow(`${warned} warning(s).`)} ${color.dim('Safe to deploy, but review the items above.')}`
          );
        } else {
          console.log(`\n${color.green('All parity checks passed.')}`);
        }
      }

      if (checks.some((c) => c.status === 'fail')) process.exit(1);
    });
}
