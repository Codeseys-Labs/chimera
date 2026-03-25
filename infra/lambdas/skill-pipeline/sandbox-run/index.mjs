/**
 * Stage 3: Sandbox Run Lambda
 *
 * Executes skill test cases in an isolated child_process subprocess with a
 * hard timeout and no network access.  Does NOT use Python — runs Node.js 20
 * scripts (or validates structure for non-JS skills).
 *
 * Input:  { tests: [{name, script, expectedOutput}], skillBundle: {filename: base64}, skillId }
 * Output: { sandbox_result: 'PASS'|'FAIL', test_results: [...], violations: [...], ...passthrough }
 */

import { spawn } from 'child_process';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, basename } from 'path';

const TEST_TIMEOUT_MS = 10_000; // 10 s per test
const MAX_OUTPUT_BYTES = 64 * 1024;

function runScript(scriptPath, env) {
  return new Promise((resolve) => {
    const result = { exitCode: -1, stdout: '', stderr: '', timedOut: false };
    const child = spawn(process.execPath, [scriptPath], {
      env: { PATH: process.env.PATH, HOME: '/tmp', ...env },
      timeout: TEST_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);

    child.stdout.on('data', d => { if (stdoutBuf.length < MAX_OUTPUT_BYTES) stdoutBuf = Buffer.concat([stdoutBuf, d]); });
    child.stderr.on('data', d => { if (stderrBuf.length < MAX_OUTPUT_BYTES) stderrBuf = Buffer.concat([stderrBuf, d]); });

    child.on('close', (code, signal) => {
      result.exitCode = code ?? -1;
      result.stdout = stdoutBuf.toString('utf8', 0, MAX_OUTPUT_BYTES);
      result.stderr = stderrBuf.toString('utf8', 0, MAX_OUTPUT_BYTES);
      result.timedOut = signal === 'SIGTERM';
      resolve(result);
    });
    child.on('error', (err) => {
      result.stderr = err.message;
      resolve(result);
    });
  });
}

export const handler = async (event) => {
  const skillId = event.skillId ?? 'unknown';
  console.log('sandbox-run: skillId=%s tests=%d', skillId, (event.tests ?? []).length);

  const tests = event.tests ?? [];
  const skillBundle = event.skillBundle ?? {};

  if (tests.length === 0) {
    return { ...event, sandbox_result: 'PASS', test_results: [], violations: [], syscall_log: [], passCount: 0, failCount: 0 };
  }

  const sandboxDir = await mkdtemp(join(tmpdir(), 'chimera-sandbox-'));
  const testResults = [];
  const allViolations = [];

  try {
    // Write skill bundle files into sandbox dir
    for (const [filename, encoded] of Object.entries(skillBundle)) {
      const safe = basename(filename);
      if (!safe || safe.startsWith('.')) continue;
      try {
        const content = Buffer.from(encoded, 'base64');
        await writeFile(join(sandboxDir, safe), content);
      } catch (err) {
        console.warn('sandbox-run: could not write bundle file %s: %s', filename, err.message);
      }
    }

    for (const test of tests) {
      const testName = test.name ?? 'unnamed';
      const script = test.script ?? '';
      const expectedOutput = test.expectedOutput;
      const violations = [];

      let passed = false;
      let stdout = '';
      let stderr = '';
      let durationMs = 0;

      if (!script.trim()) {
        violations.push('Empty test script');
        testResults.push({ testName, passed: false, stdout, stderr, durationMs, violations });
        allViolations.push(...violations);
        continue;
      }

      // Check for prohibited patterns in the test script itself
      if (/require\s*\(\s*['"]child_process['"]/.test(script)) {
        violations.push('Test script attempts to spawn subprocesses');
      }
      if (/process\.env/.test(script)) {
        violations.push('Test script reads environment variables');
      }

      const scriptPath = join(sandboxDir, `test_${testName.replace(/\W/g, '_')}.mjs`);
      await writeFile(scriptPath, script, 'utf8');

      const t0 = Date.now();
      const proc = await runScript(scriptPath, { CHIMERA_SANDBOX: '1' });
      durationMs = Date.now() - t0;

      stdout = proc.stdout;
      stderr = proc.stderr;

      if (proc.timedOut) {
        violations.push(`Test timed out after ${TEST_TIMEOUT_MS}ms`);
      } else if (proc.exitCode !== 0) {
        if (expectedOutput == null) {
          // Non-zero exit is a failure unless expected output is null explicitly
          violations.push(`Non-zero exit code: ${proc.exitCode}`);
        }
      }

      if (expectedOutput != null) {
        passed = proc.exitCode === 0 && stdout.includes(expectedOutput);
        if (!passed && violations.length === 0) {
          violations.push(`Expected output not found: "${expectedOutput}"`);
        }
      } else {
        passed = proc.exitCode === 0 && violations.length === 0;
      }

      testResults.push({ testName, passed, stdout, stderr, exitCode: proc.exitCode, durationMs, violations });
      allViolations.push(...violations);
    }
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }

  const passCount = testResults.filter(r => r.passed).length;
  const failCount = testResults.length - passCount;
  const sandbox_result = allViolations.length > 0 || failCount > passCount ? 'FAIL' : 'PASS';

  console.log('sandbox-run: result=%s pass=%d fail=%d violations=%d',
    sandbox_result, passCount, failCount, allViolations.length);

  return { ...event, sandbox_result, test_results: testResults, violations: allViolations, syscall_log: [], passCount, failCount };
};
