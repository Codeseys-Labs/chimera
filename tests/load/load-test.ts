/**
 * Load tests for Chimera platform.
 * Tests concurrent sessions, sustained load, and scaling behavior.
 *
 * Run with: bun test tests/load/load-test.ts
 * Budget: Should stay under $5.00 per full load test run
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import { TestClient } from '../helpers/test-client';

const LOAD_TEST_CONFIG = {
  apiUrl: process.env.CHIMERA_LOAD_TEST_API_URL || 'https://api.chimera-staging.example.com',
  tenantId: process.env.CHIMERA_LOAD_TEST_TENANT_ID || `load-test-${Date.now()}`,
  authToken: process.env.CHIMERA_LOAD_TEST_AUTH_TOKEN || '',
  timeout: 120000,
  maxBudgetUsd: 5.0,
};

interface LoadTestResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  totalDurationMs: number;
  requestsPerSecond: number;
}

/**
 * Run concurrent requests and collect metrics.
 */
async function runLoadTest(
  concurrency: number,
  requestsPerClient: number,
  messageGenerator: (index: number) => string
): Promise<LoadTestResult> {
  const latencies: number[] = [];
  let successCount = 0;
  let failCount = 0;

  const testStartTime = Date.now();

  const clientPromises = Array.from({ length: concurrency }, async (_, clientIndex) => {
    const client = new TestClient({
      ...LOAD_TEST_CONFIG,
      tenantId: `${LOAD_TEST_CONFIG.tenantId}-${clientIndex}`,
    });

    const session = await client.createSession();

    for (let i = 0; i < requestsPerClient; i++) {
      const start = Date.now();
      try {
        await client.sendMessage({
          sessionId: session.sessionId,
          message: messageGenerator(i),
          timeout: LOAD_TEST_CONFIG.timeout,
        });
        const latency = Date.now() - start;
        latencies.push(latency);
        successCount++;
      } catch (error) {
        failCount++;
        console.error(`Request failed: ${error}`);
      }
    }
  });

  await Promise.all(clientPromises);

  const totalDuration = Date.now() - testStartTime;

  // Calculate percentiles
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const avg = latencies.reduce((sum, val) => sum + val, 0) / latencies.length || 0;

  return {
    totalRequests: successCount + failCount,
    successfulRequests: successCount,
    failedRequests: failCount,
    avgLatencyMs: avg,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    p99LatencyMs: p99,
    totalDurationMs: totalDuration,
    requestsPerSecond: (successCount / totalDuration) * 1000,
  };
}

describe('Load Tests', () => {
  beforeAll(() => {
    console.log('=== Load Test Suite Starting ===');
    console.log(`API URL: ${LOAD_TEST_CONFIG.apiUrl}`);
    console.log(`Tenant Prefix: ${LOAD_TEST_CONFIG.tenantId}`);
    console.log(`Budget Cap: $${LOAD_TEST_CONFIG.maxBudgetUsd}`);
  });

  describe('Baseline Performance', () => {
    test('single client - 10 sequential requests', async () => {
      const result = await runLoadTest(1, 10, (i) => `Request ${i + 1}: What is 2+2?`);

      console.log('Baseline Results:', result);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(9); // At least 90% success
      expect(result.p50LatencyMs).toBeLessThan(10000); // p50 < 10s
      expect(result.p99LatencyMs).toBeLessThan(30000); // p99 < 30s
    }, 300000); // 5 min timeout
  });

  describe('Concurrent Sessions', () => {
    test('10 concurrent clients - 5 requests each', async () => {
      const result = await runLoadTest(10, 5, (i) => `Concurrent request ${i + 1}`);

      console.log('Concurrency Test (10 clients):', result);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(45); // 90% success
      expect(result.p95LatencyMs).toBeLessThan(15000); // p95 < 15s under load
    }, 600000); // 10 min timeout
  });

  describe('Sustained Load', () => {
    test('5 clients - 20 requests each (100 total)', async () => {
      const result = await runLoadTest(5, 20, (i) => `Sustained request ${i + 1}: Say hello`);

      console.log('Sustained Load Results:', result);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(90); // 90% success
      expect(result.requestsPerSecond).toBeGreaterThan(0.5); // At least 0.5 req/sec throughput
      expect(result.avgLatencyMs).toBeLessThan(20000); // avg < 20s
    }, 900000); // 15 min timeout
  });

  describe('Burst Traffic', () => {
    test('50 clients - 2 requests each (spike pattern)', async () => {
      const result = await runLoadTest(50, 2, (i) => `Burst ${i + 1}`);

      console.log('Burst Traffic Results:', result);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(80); // 80% success under burst
      expect(result.p99LatencyMs).toBeLessThan(60000); // p99 < 60s under burst
    }, 600000); // 10 min timeout
  });

  describe('Cold Start Performance', () => {
    test('measure cold start latency for new sessions', async () => {
      const coldStartLatencies: number[] = [];

      // Create 10 new sessions and measure first-invocation latency
      for (let i = 0; i < 10; i++) {
        const client = new TestClient({
          ...LOAD_TEST_CONFIG,
          tenantId: `cold-start-${Date.now()}-${i}`,
        });

        const start = Date.now();
        const session = await client.createSession();
        await client.sendMessage({
          sessionId: session.sessionId,
          message: 'ping',
        });
        const latency = Date.now() - start;

        coldStartLatencies.push(latency);

        // Wait between iterations to ensure cold start
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      coldStartLatencies.sort((a, b) => a - b);
      const p50 = coldStartLatencies[Math.floor(coldStartLatencies.length * 0.5)];
      const p99 = coldStartLatencies[Math.floor(coldStartLatencies.length * 0.99)];

      console.log('Cold Start Latencies:', {
        p50,
        p99,
        all: coldStartLatencies,
      });

      expect(p50).toBeLessThan(5000); // p50 < 5s cold start
      expect(p99).toBeLessThan(10000); // p99 < 10s cold start
    }, 300000); // 5 min timeout
  });

  describe('Streaming Performance Under Load', () => {
    test('10 concurrent streaming sessions', async () => {
      const streamLatencies: number[] = [];

      const streamPromises = Array.from({ length: 10 }, async (_, i) => {
        const client = new TestClient({
          ...LOAD_TEST_CONFIG,
          tenantId: `stream-load-${Date.now()}-${i}`,
        });

        const session = await client.createSession();

        const start = Date.now();
        let firstChunkTime: number | null = null;

        for await (const chunk of client.streamMessage(session.sessionId, 'Count to 5')) {
          if (!firstChunkTime) {
            firstChunkTime = Date.now();
          }
        }

        const latency = firstChunkTime! - start;
        streamLatencies.push(latency);
      });

      await Promise.all(streamPromises);

      streamLatencies.sort((a, b) => a - b);
      const p95 = streamLatencies[Math.floor(streamLatencies.length * 0.95)];

      console.log('Streaming First Token Latency (10 concurrent):', {
        p50: streamLatencies[Math.floor(streamLatencies.length * 0.5)],
        p95,
        all: streamLatencies,
      });

      expect(p95).toBeLessThan(5000); // p95 first token < 5s
    }, 300000); // 5 min timeout
  });

  describe('Tool Invocation Performance', () => {
    test('concurrent skill usage', async () => {
      const client = new TestClient(LOAD_TEST_CONFIG);

      // Install web-search skill
      try {
        await client.installSkill('web-search');
      } catch {
        // Already installed
      }

      const result = await runLoadTest(5, 3, (i) => `Search for query ${i + 1}`);

      console.log('Tool Invocation Load Results:', result);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(12); // 80% success with tools
      expect(result.p95LatencyMs).toBeLessThan(20000); // p95 < 20s with tools
    }, 600000); // 10 min timeout
  });

  describe('Error Rate Under Load', () => {
    test('error rate should stay below 5%', async () => {
      const result = await runLoadTest(10, 10, (i) => `Load test ${i + 1}`);

      const errorRate = result.failedRequests / result.totalRequests;

      console.log('Error Rate Results:', {
        totalRequests: result.totalRequests,
        failed: result.failedRequests,
        errorRate: `${(errorRate * 100).toFixed(2)}%`,
      });

      expect(errorRate).toBeLessThan(0.05); // < 5% error rate
    }, 600000); // 10 min timeout
  });
});
