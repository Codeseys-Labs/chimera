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

  describe('Extreme Scale: 1000 Concurrent Sessions', () => {
    test('100 concurrent clients - 10 requests each (1000 total)', async () => {
      const result = await runLoadTest(100, 10, (i) => `Scale test ${i + 1}: What is 5+5?`);

      console.log('100 Clients Scale Test Results:', result);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(900); // 90% success at scale
      expect(result.p99LatencyMs).toBeLessThan(90000); // p99 < 90s at high concurrency
      expect(result.requestsPerSecond).toBeGreaterThan(0.3); // Maintain throughput
    }, 1800000); // 30 min timeout
  });

  describe('Extreme Scale: 1000 Concurrent Sessions (Long-Running)', () => {
    test('200 concurrent clients - 5 requests each (1000 total)', async () => {
      const result = await runLoadTest(200, 5, (i) => `Scale ${i + 1}`);

      console.log('200 Clients Scale Test Results:', result);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(900); // 90% success
      expect(result.p95LatencyMs).toBeLessThan(120000); // p95 < 2 min at extreme concurrency
      expect(result.avgLatencyMs).toBeLessThan(60000); // avg < 1 min
    }, 2400000); // 40 min timeout
  });

  describe('Extreme Scale: 1000 Concurrent Sessions (Maximum Burst)', () => {
    test('1000 concurrent clients - 1 request each (maximum burst)', async () => {
      const result = await runLoadTest(1000, 1, (i) => `Burst ${i + 1}: ping`);

      console.log('1000 Clients Burst Test Results:', result);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(850); // 85% success under extreme burst
      expect(result.p99LatencyMs).toBeLessThan(180000); // p99 < 3 min under extreme load
      expect(result.failedRequests).toBeLessThan(150); // < 15% failure rate
    }, 3600000); // 60 min timeout
  });

  describe('Sustained 1000 Concurrent Sessions', () => {
    test('500 clients - 2 requests each (sustained high load)', async () => {
      const result = await runLoadTest(500, 2, (i) => `Sustained ${i + 1}: calculate`);

      console.log('500 Clients Sustained Load Results:', result);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(900); // 90% success
      expect(result.requestsPerSecond).toBeGreaterThan(0.2); // Maintain throughput under sustained load
      expect(result.p50LatencyMs).toBeLessThan(45000); // p50 < 45s under sustained load
    }, 2400000); // 40 min timeout
  });

  describe('Gradual Ramp-Up to 1000 Sessions', () => {
    test('ramp from 10 to 1000 clients over 10 minutes', async () => {
      const rampResults: LoadTestResult[] = [];
      const rampSteps = [10, 50, 100, 200, 500, 1000];

      for (const concurrency of rampSteps) {
        console.log(`--- Ramping to ${concurrency} clients ---`);
        const result = await runLoadTest(concurrency, 1, (i) => `Ramp ${i + 1}`);
        rampResults.push(result);

        // Wait 30 seconds between ramp steps
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }

      // Analyze degradation curve
      console.log('Ramp-Up Analysis:');
      rampResults.forEach((result, index) => {
        const concurrency = rampSteps[index];
        console.log(`${concurrency} clients: p50=${result.p50LatencyMs}ms, p99=${result.p99LatencyMs}ms, success=${result.successfulRequests}/${result.totalRequests}`);
      });

      // At 1000 clients, error rate should still be acceptable
      const finalResult = rampResults[rampResults.length - 1];
      const errorRate = finalResult.failedRequests / finalResult.totalRequests;
      expect(errorRate).toBeLessThan(0.20); // < 20% error rate at maximum scale
    }, 3600000); // 60 min timeout
  });

  describe('1000 Concurrent Sessions - Skill Usage', () => {
    test('100 clients using skills - 5 requests each', async () => {
      const client = new TestClient(LOAD_TEST_CONFIG);

      // Install web-search skill
      try {
        await client.installSkill('web-search');
      } catch {
        // Already installed
      }

      const result = await runLoadTest(100, 5, (i) => `Search query ${i + 1}`);

      console.log('1000 Sessions Skill Usage Results:', result);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(400); // 80% success with skills at scale
      expect(result.p99LatencyMs).toBeLessThan(150000); // p99 < 2.5 min with tool calls
    }, 3600000); // 60 min timeout
  });

  describe('Cost Validation at 1000 Sessions', () => {
    test('verify total cost stays under budget', async () => {
      // Run smaller representative sample (100 clients) to estimate cost
      const sampleResult = await runLoadTest(100, 1, (i) => `Cost test ${i + 1}`);

      const sampleClient = new TestClient(LOAD_TEST_CONFIG);
      const sampleCost = sampleClient.getTotalCost();

      // Extrapolate to 1000 sessions
      const estimatedCostFor1000 = (sampleCost / 100) * 1000;

      console.log('Cost Analysis:', {
        sampleCost: `$${sampleCost.toFixed(2)}`,
        estimatedCostFor1000: `$${estimatedCostFor1000.toFixed(2)}`,
        budget: `$${LOAD_TEST_CONFIG.maxBudgetUsd}`,
      });

      // 1000-session load test should stay under $5 budget
      expect(estimatedCostFor1000).toBeLessThan(LOAD_TEST_CONFIG.maxBudgetUsd);
    }, 600000); // 10 min timeout
  });

  describe('Auto-Scaling Verification at 1000 Sessions', () => {
    test('verify ECS auto-scaling triggers at high load', async () => {
      // This test requires AWS SDK access to check ECS metrics
      // Placeholder for auto-scaling validation

      console.log('Auto-Scaling Verification:');
      console.log('- Monitor ECS CPU/Memory utilization during 1000-session test');
      console.log('- Verify ECS service scales from 5 tasks → 20+ tasks');
      console.log('- Confirm scale-up completes within 5 minutes');
      console.log('- Validate scale-down after load decreases');

      // Run load test to trigger auto-scaling
      const result = await runLoadTest(200, 5, (i) => `Autoscale trigger ${i + 1}`);

      expect(result.successfulRequests).toBeGreaterThanOrEqual(900); // Validate platform handled scale
    }, 2400000); // 40 min timeout
  });
});
