/**
 * Performance Profiler Tests
 *
 * Tests for stage 5 of skill security pipeline
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  PerformanceProfiler,
  PerformanceProfilerConfig,
  TestExecutionContext,
} from '../scanners/performance-profiler';

describe('PerformanceProfiler', () => {
  let profiler: PerformanceProfiler;

  beforeEach(() => {
    profiler = new PerformanceProfiler();
  });

  describe('Test Profiling', () => {
    it('should profile single test execution', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1500, // 1.5 seconds
          output: 'Test output here',
          toolCalls: ['tool-1', 'tool-2'],
          resourceUsage: {
            cpuTimeMs: 800,
            memoryPeakBytes: 50 * 1024 * 1024, // 50 MB
          },
        },
      ];

      const skillContent = 'Skill content for token estimation';

      const result = await profiler.profileTests(contexts, skillContent);

      expect(result.passed).toBe(true);
      expect(result.testMetrics.length).toBe(1);
      expect(result.testMetrics[0].testName).toBe('test-1');
      expect(result.testMetrics[0].latencyMs).toBe(1500);
      expect(result.testMetrics[0].tokenUsage).toBeDefined();
      expect(result.aggregateMetrics.totalTokens).toBeGreaterThan(0);
    });

    it('should profile multiple test executions', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          output: 'Output 1',
          resourceUsage: { cpuTimeMs: 500, memoryPeakBytes: 40 * 1024 * 1024 },
        },
        {
          testName: 'test-2',
          duration: 2000,
          output: 'Output 2',
          resourceUsage: { cpuTimeMs: 800, memoryPeakBytes: 60 * 1024 * 1024 },
        },
        {
          testName: 'test-3',
          duration: 1500,
          output: 'Output 3',
          resourceUsage: { cpuTimeMs: 600, memoryPeakBytes: 45 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.testMetrics.length).toBe(3);
      expect(result.aggregateMetrics.totalCpuMs).toBe(1900); // 500 + 800 + 600
    });
  });

  describe('Token Estimation', () => {
    it('should estimate input and output tokens', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          output: 'a'.repeat(400), // ~100 tokens
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const skillContent = 'b'.repeat(400); // ~100 tokens

      const result = await profiler.profileTests(contexts, skillContent);

      const metrics = result.testMetrics[0];
      expect(metrics.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(metrics.tokenUsage.outputTokens).toBeGreaterThan(0);
      expect(metrics.tokenUsage.totalTokens).toBe(
        metrics.tokenUsage.inputTokens + metrics.tokenUsage.outputTokens
      );
    });

    it('should estimate cost based on token usage', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          output: 'a'.repeat(4000), // ~1000 tokens
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'b'.repeat(4000)); // ~1000 tokens

      const metrics = result.testMetrics[0];
      expect(metrics.tokenUsage.estimatedCost).toBeGreaterThan(0);
      expect(result.aggregateMetrics.totalCost).toBeGreaterThan(0);
    });

    it('should use custom pricing configuration', async () => {
      const customProfiler = new PerformanceProfiler({
        pricing: {
          inputTokens: 1.0, // $1 per 1M input tokens
          outputTokens: 2.0, // $2 per 1M output tokens
        },
      });

      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          output: 'a'.repeat(400),
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const result = await customProfiler.profileTests(contexts, 'b'.repeat(400));

      expect(result.testMetrics[0].tokenUsage.estimatedCost).toBeGreaterThan(0);
    });
  });

  describe('Latency Metrics', () => {
    it('should compute latency percentiles', async () => {
      const contexts: TestExecutionContext[] = [
        { testName: 'test-1', duration: 1000, resourceUsage: { cpuTimeMs: 500, memoryPeakBytes: 10 * 1024 * 1024 } },
        { testName: 'test-2', duration: 2000, resourceUsage: { cpuTimeMs: 500, memoryPeakBytes: 10 * 1024 * 1024 } },
        { testName: 'test-3', duration: 1500, resourceUsage: { cpuTimeMs: 500, memoryPeakBytes: 10 * 1024 * 1024 } },
        { testName: 'test-4', duration: 3000, resourceUsage: { cpuTimeMs: 500, memoryPeakBytes: 10 * 1024 * 1024 } },
        { testName: 'test-5', duration: 2500, resourceUsage: { cpuTimeMs: 500, memoryPeakBytes: 10 * 1024 * 1024 } },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.aggregateMetrics.latency.min).toBe(1000);
      expect(result.aggregateMetrics.latency.max).toBe(3000);
      expect(result.aggregateMetrics.latency.p50).toBeGreaterThan(0);
      expect(result.aggregateMetrics.latency.p95).toBeGreaterThan(0);
      expect(result.aggregateMetrics.latency.p99).toBeGreaterThan(0);
      expect(result.aggregateMetrics.latency.mean).toBeGreaterThan(0);
    });

    it('should handle single test latency', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1234,
          resourceUsage: { cpuTimeMs: 500, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.aggregateMetrics.latency.min).toBe(1234);
      expect(result.aggregateMetrics.latency.max).toBe(1234);
      expect(result.aggregateMetrics.latency.mean).toBe(1234);
      expect(result.aggregateMetrics.latency.p50).toBe(1234);
    });
  });

  describe('Memory Metrics', () => {
    it('should track peak memory usage', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 100 * 1024 * 1024 }, // 100 MB
        },
        {
          testName: 'test-2',
          duration: 1000,
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 200 * 1024 * 1024 }, // 200 MB
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.aggregateMetrics.peakMemoryMb).toBe(200);
      expect(result.aggregateMetrics.avgMemoryMb).toBe(150); // (100 + 200) / 2
    });

    it('should include memory details per test', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 50 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      const metrics = result.testMetrics[0];
      expect(metrics.memoryUsage.peakRss).toBe(50 * 1024 * 1024);
      expect(metrics.memoryUsage.heapUsed).toBeGreaterThan(0);
      expect(metrics.memoryUsage.heapTotal).toBeGreaterThan(0);
    });
  });

  describe('Throughput Calculation', () => {
    it('should calculate throughput (requests per second)', async () => {
      const contexts: TestExecutionContext[] = [
        { testName: 'test-1', duration: 1000, resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 } }, // 1s
        { testName: 'test-2', duration: 1000, resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 } }, // 1s
        { testName: 'test-3', duration: 1000, resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 } }, // 1s
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      // 3 requests in 3 seconds = 1 RPS
      expect(result.aggregateMetrics.throughput).toBeCloseTo(1.0, 1);
    });
  });

  describe('Cold Start Measurement', () => {
    it('should measure cold start latency', async () => {
      const profiler = new PerformanceProfiler({ measureColdStart: true });

      const contexts: TestExecutionContext[] = [
        { testName: 'test-1', duration: 5000, resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 } }, // Cold start
        { testName: 'test-2', duration: 1000, resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 } }, // Warm
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.coldStartLatencyMs).toBe(5000);
    });

    it('should skip cold start measurement when disabled', async () => {
      const profiler = new PerformanceProfiler({ measureColdStart: false });

      const contexts: TestExecutionContext[] = [
        { testName: 'test-1', duration: 5000, resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 } },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.coldStartLatencyMs).toBeUndefined();
    });
  });

  describe('Performance Violations', () => {
    it('should detect token limit violation', async () => {
      const profiler = new PerformanceProfiler({ maxTokensPerTest: 100 });

      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          output: 'a'.repeat(1000), // ~250 tokens (exceeds 100)
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations.some(v => v.type === 'token-limit')).toBe(true);
    });

    it('should detect latency violation', async () => {
      const profiler = new PerformanceProfiler({ maxLatencyMs: 1000 });

      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 5000, // Exceeds 1000ms limit
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === 'latency')).toBe(true);
      expect(result.violations[0].actual).toBe(5000);
      expect(result.violations[0].threshold).toBe(1000);
    });

    it('should detect memory violation', async () => {
      const profiler = new PerformanceProfiler({ maxMemoryMb: 100 });

      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 200 * 1024 * 1024 }, // 200 MB
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === 'memory')).toBe(true);
    });

    it('should detect cost violation', async () => {
      const profiler = new PerformanceProfiler({
        maxCostPerTest: 0.001, // $0.001 limit
        pricing: { inputTokens: 100.0, outputTokens: 200.0 }, // High pricing to trigger violation
      });

      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          output: 'a'.repeat(4000), // ~1000 tokens
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'b'.repeat(4000));

      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === 'cost')).toBe(true);
    });

    it('should detect throughput violation', async () => {
      const profiler = new PerformanceProfiler({ minThroughput: 10 }); // Require 10 RPS

      const contexts: TestExecutionContext[] = [
        { testName: 'test-1', duration: 5000, resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 } }, // Slow
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.passed).toBe(false);
      expect(result.violations.some(v => v.type === 'throughput')).toBe(true);
    });

    it('should pass with no violations', async () => {
      const profiler = new PerformanceProfiler({
        maxTokensPerTest: 100_000,
        maxLatencyMs: 30_000,
        maxMemoryMb: 512,
        maxCostPerTest: 1.0,
      });

      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1500,
          output: 'reasonable output',
          resourceUsage: { cpuTimeMs: 500, memoryPeakBytes: 50 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.passed).toBe(true);
      expect(result.violations.length).toBe(0);
    });
  });

  describe('Violation Details', () => {
    it('should include test name in violation', async () => {
      const profiler = new PerformanceProfiler({ maxLatencyMs: 1000 });

      const contexts: TestExecutionContext[] = [
        {
          testName: 'slow-test',
          duration: 5000,
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      const violation = result.violations.find(v => v.type === 'latency');
      expect(violation?.testName).toBe('slow-test');
    });

    it('should include severity level', async () => {
      const profiler = new PerformanceProfiler({ maxTokensPerTest: 100 });

      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          output: 'a'.repeat(1000),
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      const violation = result.violations.find(v => v.type === 'token-limit');
      expect(violation?.severity).toBe('high');
    });

    it('should include threshold and actual values', async () => {
      const profiler = new PerformanceProfiler({ maxMemoryMb: 100 });

      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 150 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      const violation = result.violations.find(v => v.type === 'memory');
      expect(violation?.actual).toBe(150);
      expect(violation?.threshold).toBe(100);
      expect(violation?.unit).toBe('MB');
    });
  });

  describe('Metadata', () => {
    it('should include scanner version', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.scannerVersion).toBeDefined();
      expect(result.scannerVersion).toBe('1.0.0');
    });

    it('should include profiling timestamp', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.profiledAt).toBeDefined();
      expect(new Date(result.profiledAt).getTime()).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty test list', async () => {
      const contexts: TestExecutionContext[] = [];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.testMetrics.length).toBe(0);
      expect(result.aggregateMetrics.totalTokens).toBe(0);
      expect(result.passed).toBe(true); // No violations
    });

    it('should handle missing resource usage', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          // Missing resourceUsage
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.testMetrics[0].memoryUsage.peakRss).toBe(0);
      expect(result.testMetrics[0].cpuTimeMs).toBe(0);
    });

    it('should handle missing output', async () => {
      const contexts: TestExecutionContext[] = [
        {
          testName: 'test-1',
          duration: 1000,
          resourceUsage: { cpuTimeMs: 100, memoryPeakBytes: 10 * 1024 * 1024 },
          // Missing output
        },
      ];

      const result = await profiler.profileTests(contexts, 'skill content');

      expect(result.testMetrics[0].tokenUsage.outputTokens).toBeGreaterThanOrEqual(0);
    });
  });
});
