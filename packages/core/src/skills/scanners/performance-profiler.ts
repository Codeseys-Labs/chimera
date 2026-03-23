/**
 * Performance Profiling Scanner
 *
 * Stage 5 of 7-stage skill security pipeline
 * Measures token cost, latency, memory usage in sandbox execution
 *
 * Reference: docs/research/architecture-reviews/Chimera-Skill-Ecosystem-Design.md § 4.2
 *
 * Metrics Collected:
 * - Token cost: Input + output tokens per test case
 * - Latency: P50, P95, P99 response times
 * - Memory: Peak RSS, heap usage
 * - Throughput: Requests per second
 * - Cold start: First invocation overhead
 */

/**
 * Token usage statistics
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number; // USD
}

/**
 * Latency percentiles (milliseconds)
 */
export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
  mean: number;
}

/**
 * Memory usage statistics (bytes)
 */
export interface MemoryUsage {
  peakRss: number; // Resident Set Size
  heapUsed: number;
  heapTotal: number;
  external: number; // C++ objects bound to JS
}

/**
 * Performance metrics for a single test case
 */
export interface TestPerformanceMetrics {
  testName: string;
  tokenUsage: TokenUsage;
  latencyMs: number;
  memoryUsage: MemoryUsage;
  cpuTimeMs: number;
  throughput?: number; // Requests per second (for load tests)
}

/**
 * Performance profiling result
 */
export interface PerformanceProfilingResult {
  passed: boolean;
  testMetrics: TestPerformanceMetrics[];
  aggregateMetrics: {
    totalTokens: number;
    totalCost: number; // USD
    latency: LatencyPercentiles;
    avgMemoryMb: number;
    peakMemoryMb: number;
    totalCpuMs: number;
    throughput?: number; // Average RPS
  };
  coldStartLatencyMs?: number;
  violations: PerformanceViolation[];
  profiledAt: string;
  scannerVersion: string;
}

/**
 * Performance violation (threshold exceeded)
 */
export interface PerformanceViolation {
  type: 'token-limit' | 'latency' | 'memory' | 'throughput' | 'cost';
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  testName?: string;
  actual: number;
  threshold: number;
  unit: string;
}

/**
 * Performance profiler configuration
 */
export interface PerformanceProfilerConfig {
  /** Maximum tokens per test (fail if exceeded) */
  maxTokensPerTest?: number;
  /** Maximum latency in milliseconds (fail if exceeded) */
  maxLatencyMs?: number;
  /** Maximum memory in MB (fail if exceeded) */
  maxMemoryMb?: number;
  /** Maximum cost per test in USD (fail if exceeded) */
  maxCostPerTest?: number;
  /** Minimum throughput (requests/sec, fail if below) */
  minThroughput?: number;
  /** Model pricing (USD per 1M tokens) */
  pricing?: {
    inputTokens: number; // e.g., 3.00 for Claude Sonnet
    outputTokens: number; // e.g., 15.00 for Claude Sonnet
  };
  /** Enable cold start measurement */
  measureColdStart?: boolean;
  /** Number of warmup iterations before profiling */
  warmupIterations?: number;
}

/**
 * Test execution context (from sandbox runner)
 */
export interface TestExecutionContext {
  testName: string;
  duration: number; // milliseconds
  output?: string;
  toolCalls?: string[];
  resourceUsage?: {
    cpuTimeMs: number;
    memoryPeakBytes: number;
  };
}

/**
 * Performance Profiler
 *
 * Measures resource usage and performance characteristics:
 * - Token consumption (input/output)
 * - Response latency (P50, P95, P99)
 * - Memory footprint (RSS, heap)
 * - CPU utilization
 * - Throughput (RPS)
 * - Cold start overhead
 *
 * Used to enforce cost and performance SLAs on marketplace skills.
 * Skills exceeding thresholds are flagged for optimization or rejection.
 */
export class PerformanceProfiler {
  private config: PerformanceProfilerConfig;
  private readonly SCANNER_VERSION = '1.0.0';

  // Default pricing: Claude Sonnet 4 (as of 2024)
  private readonly DEFAULT_INPUT_PRICE = 3.0; // USD per 1M tokens
  private readonly DEFAULT_OUTPUT_PRICE = 15.0; // USD per 1M tokens

  constructor(config: PerformanceProfilerConfig = {}) {
    this.config = {
      maxTokensPerTest: config.maxTokensPerTest || 100_000, // 100K tokens
      maxLatencyMs: config.maxLatencyMs || 30_000, // 30 seconds
      maxMemoryMb: config.maxMemoryMb || 512, // 512 MB
      maxCostPerTest: config.maxCostPerTest || 0.5, // $0.50 per test
      minThroughput: config.minThroughput, // Optional
      pricing: config.pricing || {
        inputTokens: this.DEFAULT_INPUT_PRICE,
        outputTokens: this.DEFAULT_OUTPUT_PRICE,
      },
      measureColdStart: config.measureColdStart ?? true,
      warmupIterations: config.warmupIterations || 1,
    };
  }

  /**
   * Profile performance of test executions
   *
   * @param testContexts - Array of test execution contexts from sandbox
   * @param skillContent - Skill content (for token estimation)
   * @returns Performance profiling result
   */
  async profileTests(
    testContexts: TestExecutionContext[],
    skillContent: string
  ): Promise<PerformanceProfilingResult> {
    const testMetrics: TestPerformanceMetrics[] = [];
    const violations: PerformanceViolation[] = [];
    const latencies: number[] = [];

    // Measure cold start (first test)
    let coldStartLatency: number | undefined;
    if (this.config.measureColdStart && testContexts.length > 0) {
      coldStartLatency = testContexts[0].duration;
    }

    // Profile each test
    for (const context of testContexts) {
      const metrics = await this.profileTest(context, skillContent);
      testMetrics.push(metrics);
      latencies.push(metrics.latencyMs);

      // Check for violations
      this.checkViolations(metrics, violations);
    }

    // Compute aggregate metrics
    const totalTokens = testMetrics.reduce((sum, m) => sum + m.tokenUsage.totalTokens, 0);
    const totalCost = testMetrics.reduce((sum, m) => sum + m.tokenUsage.estimatedCost, 0);
    const totalCpuMs = testMetrics.reduce((sum, m) => sum + m.cpuTimeMs, 0);
    const avgMemoryMb =
      testMetrics.reduce((sum, m) => sum + m.memoryUsage.peakRss / (1024 * 1024), 0) /
      testMetrics.length;
    const peakMemoryMb = Math.max(
      ...testMetrics.map(m => m.memoryUsage.peakRss / (1024 * 1024))
    );

    // Compute latency percentiles
    const latency = this.computePercentiles(latencies);

    // Compute throughput (if applicable)
    let throughput: number | undefined;
    if (testMetrics.length > 0) {
      const totalTimeSeconds = testMetrics.reduce((sum, m) => sum + m.latencyMs, 0) / 1000;
      throughput = testMetrics.length / totalTimeSeconds;

      // Check throughput violation
      if (this.config.minThroughput && throughput < this.config.minThroughput) {
        violations.push({
          type: 'throughput',
          severity: 'medium',
          message: `Throughput below minimum (${throughput.toFixed(2)} < ${this.config.minThroughput} RPS)`,
          actual: throughput,
          threshold: this.config.minThroughput,
          unit: 'RPS',
        });
      }
    }

    // Determine overall pass/fail
    const passed = violations.length === 0;

    return {
      passed,
      testMetrics,
      aggregateMetrics: {
        totalTokens,
        totalCost,
        latency,
        avgMemoryMb,
        peakMemoryMb,
        totalCpuMs,
        throughput,
      },
      coldStartLatencyMs: coldStartLatency,
      violations,
      profiledAt: new Date().toISOString(),
      scannerVersion: this.SCANNER_VERSION,
    };
  }

  /**
   * Profile a single test execution
   */
  private async profileTest(
    context: TestExecutionContext,
    skillContent: string
  ): Promise<TestPerformanceMetrics> {
    // Estimate token usage
    const tokenUsage = this.estimateTokenUsage(skillContent, context.output || '');

    // Extract memory usage
    const memoryUsage: MemoryUsage = {
      peakRss: context.resourceUsage?.memoryPeakBytes || 0,
      heapUsed: context.resourceUsage?.memoryPeakBytes || 0, // Mock: use same value
      heapTotal: (context.resourceUsage?.memoryPeakBytes || 0) * 1.2, // Mock: 20% headroom
      external: 0, // Mock: no external allocations
    };

    return {
      testName: context.testName,
      tokenUsage,
      latencyMs: context.duration,
      memoryUsage,
      cpuTimeMs: context.resourceUsage?.cpuTimeMs || 0,
    };
  }

  /**
   * Estimate token usage from content
   *
   * Mock implementation using character count heuristic (1 token ≈ 4 chars)
   * In production, use tiktoken or model-specific tokenizer
   */
  private estimateTokenUsage(input: string, output: string): TokenUsage {
    // Simple heuristic: 1 token ≈ 4 characters
    const inputTokens = Math.ceil(input.length / 4);
    const outputTokens = Math.ceil(output.length / 4);
    const totalTokens = inputTokens + outputTokens;

    // Calculate cost
    const inputCost = (inputTokens / 1_000_000) * this.config.pricing!.inputTokens;
    const outputCost = (outputTokens / 1_000_000) * this.config.pricing!.outputTokens;
    const estimatedCost = inputCost + outputCost;

    return {
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost,
    };
  }

  /**
   * Check for performance violations
   */
  private checkViolations(
    metrics: TestPerformanceMetrics,
    violations: PerformanceViolation[]
  ): void {
    // Token limit violation
    if (
      this.config.maxTokensPerTest &&
      metrics.tokenUsage.totalTokens > this.config.maxTokensPerTest
    ) {
      violations.push({
        type: 'token-limit',
        severity: 'high',
        message: `Token usage exceeds limit for test "${metrics.testName}"`,
        testName: metrics.testName,
        actual: metrics.tokenUsage.totalTokens,
        threshold: this.config.maxTokensPerTest,
        unit: 'tokens',
      });
    }

    // Latency violation
    if (this.config.maxLatencyMs && metrics.latencyMs > this.config.maxLatencyMs) {
      violations.push({
        type: 'latency',
        severity: 'high',
        message: `Latency exceeds limit for test "${metrics.testName}"`,
        testName: metrics.testName,
        actual: metrics.latencyMs,
        threshold: this.config.maxLatencyMs,
        unit: 'ms',
      });
    }

    // Memory violation
    const memoryMb = metrics.memoryUsage.peakRss / (1024 * 1024);
    if (this.config.maxMemoryMb && memoryMb > this.config.maxMemoryMb) {
      violations.push({
        type: 'memory',
        severity: 'high',
        message: `Memory usage exceeds limit for test "${metrics.testName}"`,
        testName: metrics.testName,
        actual: memoryMb,
        threshold: this.config.maxMemoryMb,
        unit: 'MB',
      });
    }

    // Cost violation
    if (
      this.config.maxCostPerTest &&
      metrics.tokenUsage.estimatedCost > this.config.maxCostPerTest
    ) {
      violations.push({
        type: 'cost',
        severity: 'medium',
        message: `Estimated cost exceeds limit for test "${metrics.testName}"`,
        testName: metrics.testName,
        actual: metrics.tokenUsage.estimatedCost,
        threshold: this.config.maxCostPerTest,
        unit: 'USD',
      });
    }
  }

  /**
   * Compute latency percentiles
   */
  private computePercentiles(latencies: number[]): LatencyPercentiles {
    if (latencies.length === 0) {
      return { p50: 0, p95: 0, p99: 0, max: 0, min: 0, mean: 0 };
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);

    return {
      p50: this.percentile(sorted, 0.5),
      p95: this.percentile(sorted, 0.95),
      p99: this.percentile(sorted, 0.99),
      max: sorted[sorted.length - 1],
      min: sorted[0],
      mean: sum / sorted.length,
    };
  }

  /**
   * Calculate percentile value
   */
  private percentile(sortedArray: number[], p: number): number {
    if (sortedArray.length === 0) return 0;
    if (p <= 0) return sortedArray[0];
    if (p >= 1) return sortedArray[sortedArray.length - 1];

    const index = (sortedArray.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index % 1;

    if (lower === upper) {
      return sortedArray[lower];
    }

    return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
  }
}
