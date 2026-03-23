/**
 * Sandbox Runner Tests
 *
 * Tests for stage 3 of skill security pipeline (isolated test execution)
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SandboxRunner, SandboxConfig } from '../scanners/sandbox-runner';
import { SkillTestCase } from '@chimera/shared';

describe('SandboxRunner', () => {
  let runner: SandboxRunner;

  beforeEach(() => {
    runner = new SandboxRunner();
  });

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const runner = new SandboxRunner();
      expect(runner).toBeDefined();
    });

    it('should accept custom timeout', () => {
      const runner = new SandboxRunner({ timeout: 30000 });
      expect(runner).toBeDefined();
    });

    it('should accept custom memory limit', () => {
      const runner = new SandboxRunner({ maxMemory: 256 * 1024 * 1024 });
      expect(runner).toBeDefined();
    });

    it('should accept allowed paths configuration', () => {
      const runner = new SandboxRunner({
        allowedPaths: {
          read: ['/tmp', '/workspace'],
          write: ['/tmp/output'],
        },
      });
      expect(runner).toBeDefined();
    });

    it('should accept network configuration', () => {
      const runner = new SandboxRunner({ allowNetwork: true });
      expect(runner).toBeDefined();
    });

    it('should accept syscall logging configuration', () => {
      const runner = new SandboxRunner({ logSyscalls: true });
      expect(runner).toBeDefined();
    });
  });

  describe('Bundle Validation', () => {
    it('should detect missing SKILL.md', async () => {
      const bundle = new Map([['tool.js', 'export function test() {}']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result.violations.some(v => v.message.includes('Missing required SKILL.md'))).toBe(
        true
      );
    });

    it('should accept valid bundle with SKILL.md', async () => {
      const bundle = new Map([
        ['SKILL.md', '# Test Skill'],
        ['tool.js', 'export function test() {}'],
      ]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      const skillMdViolations = result.violations.filter(v =>
        v.message.includes('Missing required SKILL.md')
      );
      expect(skillMdViolations.length).toBe(0);
    });

    it('should detect binary files', async () => {
      const bundle = new Map([
        ['SKILL.md', '# Test'],
        ['malware.exe', 'binary content'],
      ]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result.violations.some(v => v.message.includes('Binary file detected'))).toBe(true);
    });

    it('should detect oversized bundles', async () => {
      const largeContent = 'a'.repeat(60 * 1024 * 1024); // 60MB
      const bundle = new Map([
        ['SKILL.md', '# Test'],
        ['large.txt', largeContent],
      ]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result.violations.some(v => v.message.includes('Bundle size exceeds'))).toBe(true);
    });
  });

  describe('Test Execution', () => {
    it('should execute test cases', async () => {
      const bundle = new Map([
        ['SKILL.md', '# Test Skill'],
        ['tool.js', 'export function greet() { return "hello"; }'],
      ]);

      const tests: SkillTestCase[] = [
        {
          name: 'test-greet',
          input: 'say hello',
          expect: {
            tool_calls: ['greet'],
            output_contains: ['hello'],
          },
        },
      ];

      const result = await runner.runTests(tests, bundle);

      expect(result.testResults.length).toBe(1);
      expect(result.testResults[0].testName).toBe('test-greet');
    });

    it('should track test duration', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [
        {
          name: 'test-1',
          input: 'test',
          expect: { tool_calls: ['test'] },
        },
      ];

      const result = await runner.runTests(tests, bundle);

      expect(result.testResults[0].duration).toBeGreaterThanOrEqual(0);
    });

    it('should handle multiple test cases', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [
        { name: 'test-1', input: 'test1', expect: { tool_calls: ['fn1'] } },
        { name: 'test-2', input: 'test2', expect: { tool_calls: ['fn2'] } },
        { name: 'test-3', input: 'test3', expect: { tool_calls: ['fn3'] } },
      ];

      const result = await runner.runTests(tests, bundle);

      expect(result.testResults.length).toBe(3);
      expect(result.testResults.map(t => t.testName)).toEqual(['test-1', 'test-2', 'test-3']);
    });
  });

  describe('Resource Usage Tracking', () => {
    it('should track CPU time', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result.resourceUsage).toHaveProperty('cpuTimeMs');
      expect(typeof result.resourceUsage.cpuTimeMs).toBe('number');
    });

    it('should track memory usage', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result.resourceUsage).toHaveProperty('memoryPeakBytes');
      expect(typeof result.resourceUsage.memoryPeakBytes).toBe('number');
    });

    it('should track disk I/O', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result.resourceUsage).toHaveProperty('diskReadBytes');
      expect(result.resourceUsage).toHaveProperty('diskWriteBytes');
    });

    it('should track network usage', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result.resourceUsage).toHaveProperty('networkBytesOut');
    });
  });

  describe('Syscall Logging', () => {
    it('should log syscalls when enabled', async () => {
      const runner = new SandboxRunner({ logSyscalls: true });
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [
        {
          name: 'test-io',
          input: 'test',
          expect: { tool_calls: ['readFile'] },
        },
      ];

      const result = await runner.runTests(tests, bundle);

      expect(Array.isArray(result.syscallLog)).toBe(true);
    });

    it('should not log syscalls when disabled', async () => {
      const runner = new SandboxRunner({ logSyscalls: false });
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result.syscallLog.length).toBe(0);
    });

    it('should include syscall details', async () => {
      const runner = new SandboxRunner({ logSyscalls: true });
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [
        {
          name: 'test',
          input: 'test',
          expect: { tool_calls: ['test'] },
        },
      ];

      const result = await runner.runTests(tests, bundle);

      if (result.syscallLog.length > 0) {
        const entry = result.syscallLog[0];
        expect(entry).toHaveProperty('syscall');
        expect(entry).toHaveProperty('args');
        expect(entry).toHaveProperty('result');
        expect(entry).toHaveProperty('timestamp');
        expect(['allowed', 'denied']).toContain(entry.result);
      }
    });
  });

  describe('Violation Types', () => {
    it('should categorize violations correctly', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      result.violations.forEach(violation => {
        expect(violation).toHaveProperty('type');
        expect(violation).toHaveProperty('message');
        expect(violation).toHaveProperty('severity');
        expect(violation).toHaveProperty('timestamp');

        expect(['network-access', 'filesystem-access', 'syscall-denied', 'resource-limit', 'timeout', 'permission-violation']).toContain(
          violation.type
        );
        expect(['critical', 'high', 'medium', 'low']).toContain(violation.severity);
      });
    });
  });

  describe('Result Structure', () => {
    it('should return valid result structure', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('testResults');
      expect(result).toHaveProperty('violations');
      expect(result).toHaveProperty('syscallLog');
      expect(result).toHaveProperty('resourceUsage');
      expect(result).toHaveProperty('scannedAt');

      expect(typeof result.passed).toBe('boolean');
      expect(Array.isArray(result.testResults)).toBe(true);
      expect(Array.isArray(result.violations)).toBe(true);
      expect(Array.isArray(result.syscallLog)).toBe(true);
    });

    it('should validate test execution result structure', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [
        {
          name: 'test',
          input: 'test',
          expect: { tool_calls: ['test'] },
        },
      ];

      const result = await runner.runTests(tests, bundle);

      if (result.testResults.length > 0) {
        const testResult = result.testResults[0];
        expect(testResult).toHaveProperty('testName');
        expect(testResult).toHaveProperty('passed');
        expect(testResult).toHaveProperty('duration');
        expect(typeof testResult.testName).toBe('string');
        expect(typeof testResult.passed).toBe('boolean');
        expect(typeof testResult.duration).toBe('number');
      }
    });
  });

  describe('Pass/Fail Logic', () => {
    it('should pass with clean bundle and passing tests', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [
        {
          name: 'test',
          input: 'test',
          expect: { tool_calls: ['test'] },
        },
      ];

      const result = await runner.runTests(tests, bundle);

      if (result.violations.length === 0) {
        expect(result.passed).toBe(true);
      }
    });

    it('should fail with bundle violations', async () => {
      const bundle = new Map([
        ['SKILL.md', '# Test'],
        ['malware.exe', 'binary'],
      ]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result.passed).toBe(false);
    });
  });

  describe('Timestamp Format', () => {
    it('should return ISO 8601 formatted scannedAt', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(isoRegex.test(result.scannedAt)).toBe(true);
    });

    it('should timestamp violations', async () => {
      const bundle = new Map([['malware.exe', 'binary']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      result.violations.forEach(violation => {
        const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
        expect(isoRegex.test(violation.timestamp)).toBe(true);
      });
    });
  });

  describe('Test Expectations', () => {
    it('should handle tool_calls expectations', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [
        {
          name: 'test',
          input: 'test',
          expect: { tool_calls: ['function1', 'function2'] },
        },
      ];

      const result = await runner.runTests(tests, bundle);

      expect(result.testResults[0].toolCalls).toBeDefined();
    });

    it('should handle output_contains expectations', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [
        {
          name: 'test',
          input: 'test',
          expect: { output_contains: ['success', 'complete'] },
        },
      ];

      const result = await runner.runTests(tests, bundle);

      expect(result.testResults[0]).toBeDefined();
    });

    it('should handle output_not_contains expectations', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [
        {
          name: 'test',
          input: 'test',
          expect: { output_not_contains: ['error', 'fail'] },
        },
      ];

      const result = await runner.runTests(tests, bundle);

      expect(result.testResults[0]).toBeDefined();
    });
  });

  describe('Empty Test Cases', () => {
    it('should handle no test cases', async () => {
      const bundle = new Map([['SKILL.md', '# Test']]);
      const tests: SkillTestCase[] = [];

      const result = await runner.runTests(tests, bundle);

      expect(result.testResults.length).toBe(0);
      expect(result).toHaveProperty('passed');
    });
  });
});
