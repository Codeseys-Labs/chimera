/**
 * k6 Load Test for Chimera Platform
 *
 * Tests 1000 concurrent sessions with gradual ramp-up, sustained load,
 * burst traffic, and cool-down phases.
 *
 * Usage:
 *   k6 run tests/load/k6-load-test.js \
 *     --env API_URL=https://api.chimera-staging.example.com \
 *     --env WS_URL=wss://ws.chimera-staging.example.com \
 *     --env TENANT_ID=load-test-tenant \
 *     --env AUTH_TOKEN=$JWT_TOKEN \
 *     --out json=results.json
 *
 * Alternative cloud run:
 *   k6 cloud tests/load/k6-load-test.js
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { randomIntBetween, randomItem } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// ============================================================================
// Configuration
// ============================================================================

const API_URL = __ENV.API_URL || 'http://localhost:8080';
const WS_URL = __ENV.WS_URL || 'ws://localhost:8080';
const TENANT_ID = __ENV.TENANT_ID || 'load-test-tenant';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

// ============================================================================
// Custom Metrics
// ============================================================================

const sessionCreationTime = new Trend('session_creation_time');
const firstTokenTime = new Trend('first_token_time');
const toolInvocationTime = new Trend('tool_invocation_time');
const streamingErrors = new Counter('streaming_errors');
const sessionErrors = new Counter('session_errors');
const errorRate = new Rate('errors');

// ============================================================================
// Load Test Stages
// ============================================================================

export const options = {
  stages: [
    // Ramp-up: 0 → 1000 VUs over 10 minutes
    { duration: '10m', target: 1000 },

    // Sustained: 1000 VUs for 30 minutes
    { duration: '30m', target: 1000 },

    // Burst: 1000 → 2000 VUs over 5 minutes
    { duration: '5m', target: 2000 },

    // Cool-down: 2000 → 0 VUs over 5 minutes
    { duration: '5m', target: 0 },
  ],

  thresholds: {
    // Latency targets
    'http_req_duration': [
      'p(50)<5000',   // p50 < 5s
      'p(95)<10000',  // p95 < 10s
      'p(99)<30000',  // p99 < 30s
    ],

    // Error rate < 5%
    'http_req_failed': ['rate<0.05'],

    // Throughput > 10 requests/sec
    'http_reqs': ['rate>10'],

    // Streaming performance
    'first_token_time': ['p(95)<5000'], // First token < 5s

    // Tool invocation
    'tool_invocation_time': ['p(95)<20000'], // Tool calls < 20s

    // Session creation
    'session_creation_time': ['p(99)<10000'], // Cold start < 10s
  },

  // Cloud execution configuration (optional)
  ext: {
    loadimpact: {
      projectID: 3513189,
      name: 'Chimera 1000 Concurrent Sessions',
      distribution: {
        'amazon:us:ashburn': { loadZone: 'amazon:us:ashburn', percent: 50 },
        'amazon:us:portland': { loadZone: 'amazon:us:portland', percent: 25 },
        'amazon:us:palo alto': { loadZone: 'amazon:us:palo alto', percent: 25 },
      },
    },
  },
};

// ============================================================================
// Test Queries
// ============================================================================

const TEST_QUERIES = [
  // Simple queries (should route to Haiku)
  'What is 2+2?',
  'Say hello',
  'Count to 5',
  'What day is today?',

  // Standard queries (should route to Sonnet)
  'Explain how photosynthesis works',
  'Write a haiku about coding',
  'Compare Python and JavaScript',
  'What are the benefits of cloud computing?',

  // Complex queries (should route to Opus)
  'Analyze the trade-offs between microservices and monolithic architectures',
  'Design a secure multi-tenant authentication system',
  'Explain quantum entanglement and its implications for computing',

  // Tool-heavy queries
  'Search for the latest news on AI',
  'Calculate the factorial of 20',
  'What is the weather in Seattle?',
];

// ============================================================================
// Helper Functions
// ============================================================================

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${AUTH_TOKEN}`,
    'X-Tenant-Id': TENANT_ID,
  };
}

function createSession() {
  const startTime = new Date();

  const url = `${API_URL}/api/v1/tenants/${TENANT_ID}/chat`;
  const payload = JSON.stringify({
    message: 'Initialize session',
    sessionConfig: {
      model: 'auto',
      enableSkills: true,
    },
  });

  const response = http.post(url, payload, {
    headers: getHeaders(),
    timeout: '30s',
  });

  const duration = new Date() - startTime;
  sessionCreationTime.add(duration);

  const success = check(response, {
    'session created': (r) => r.status === 200 || r.status === 201,
    'session has id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.sessionId !== undefined;
      } catch {
        return false;
      }
    },
  });

  if (!success) {
    sessionErrors.add(1);
    errorRate.add(1);
    return null;
  }

  try {
    const body = JSON.parse(response.body);
    return body.sessionId;
  } catch (e) {
    sessionErrors.add(1);
    errorRate.add(1);
    return null;
  }
}

function sendMessage(sessionId, message) {
  const url = `${API_URL}/api/v1/tenants/${TENANT_ID}/chat`;
  const payload = JSON.stringify({
    sessionId,
    message,
  });

  const response = http.post(url, payload, {
    headers: getHeaders(),
    timeout: '60s',
  });

  const success = check(response, {
    'message sent': (r) => r.status === 200,
    'response has content': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.response && body.response.length > 0;
      } catch {
        return false;
      }
    },
  });

  if (!success) {
    errorRate.add(1);
  }

  return response;
}

function sendStreamingMessage(sessionId, message) {
  const wsUrl = `${WS_URL}/${sessionId}`;
  let firstTokenReceived = false;
  let firstTokenTime = null;
  const startTime = new Date();

  const response = ws.connect(wsUrl, {
    headers: getHeaders(),
  }, (socket) => {
    socket.on('open', () => {
      // Send message
      socket.send(JSON.stringify({
        action: 'sendmessage',
        sessionId,
        message,
      }));
    });

    socket.on('message', (data) => {
      // Record first token time
      if (!firstTokenReceived) {
        firstTokenReceived = true;
        firstTokenTime = new Date() - startTime;
        firstTokenTime.add(firstTokenTime);
      }

      // Check if message is complete
      try {
        const event = JSON.parse(data);
        if (event.type === 'message_complete') {
          socket.close();
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    socket.on('error', (e) => {
      streamingErrors.add(1);
      errorRate.add(1);
      console.error('WebSocket error:', e);
    });

    // Timeout after 60 seconds
    socket.setTimeout(() => {
      socket.close();
    }, 60000);
  });

  check(response, {
    'streaming connected': (r) => r && r.status === 101,
  });
}

// ============================================================================
// Test Scenarios
// ============================================================================

/**
 * Scenario 1: REST API Chat (70% of traffic)
 * Synchronous request/response via REST API
 */
export function restApiChat() {
  group('REST API Chat', () => {
    // Create session
    const sessionId = createSession();
    if (!sessionId) return;

    sleep(randomIntBetween(1, 3)); // Think time

    // Send 3-5 messages
    const messageCount = randomIntBetween(3, 5);
    for (let i = 0; i < messageCount; i++) {
      const query = randomItem(TEST_QUERIES);
      sendMessage(sessionId, query);

      sleep(randomIntBetween(2, 5)); // Think time between messages
    }
  });
}

/**
 * Scenario 2: WebSocket Streaming (20% of traffic)
 * Bidirectional streaming via WebSocket API
 */
export function websocketStreaming() {
  group('WebSocket Streaming', () => {
    // Create session
    const sessionId = createSession();
    if (!sessionId) return;

    sleep(randomIntBetween(1, 2));

    // Send streaming message
    const query = randomItem(TEST_QUERIES);
    sendStreamingMessage(sessionId, query);

    sleep(randomIntBetween(3, 7));
  });
}

/**
 * Scenario 3: Tool-Heavy Queries (10% of traffic)
 * Complex queries that trigger MCP tool invocations
 */
export function toolHeavyQueries() {
  group('Tool-Heavy Queries', () => {
    const sessionId = createSession();
    if (!sessionId) return;

    sleep(randomIntBetween(1, 3));

    const toolQueries = TEST_QUERIES.filter(q =>
      q.includes('Search') || q.includes('Calculate') || q.includes('weather')
    );

    const query = randomItem(toolQueries);
    const startTime = new Date();
    const response = sendMessage(sessionId, query);

    const duration = new Date() - startTime;
    toolInvocationTime.add(duration);

    check(response, {
      'tool call succeeded': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.toolCalls && body.toolCalls.length > 0;
        } catch {
          return false;
        }
      },
    });
  });
}

// ============================================================================
// Default Test Function
// ============================================================================

export default function () {
  // Weighted scenario selection
  const rand = Math.random();

  if (rand < 0.7) {
    // 70% REST API
    restApiChat();
  } else if (rand < 0.9) {
    // 20% WebSocket
    websocketStreaming();
  } else {
    // 10% Tool-heavy
    toolHeavyQueries();
  }
}

// ============================================================================
// Lifecycle Hooks
// ============================================================================

export function setup() {
  console.log('=== Chimera Load Test Starting ===');
  console.log(`API URL: ${API_URL}`);
  console.log(`WebSocket URL: ${WS_URL}`);
  console.log(`Tenant ID: ${TENANT_ID}`);
  console.log(`Target: 1000 concurrent sessions`);
  console.log(`Duration: 50 minutes (10m ramp + 30m sustain + 5m burst + 5m cool)`);
  console.log('');

  // Validate connectivity
  const healthCheck = http.get(`${API_URL}/health`);
  if (healthCheck.status !== 200) {
    throw new Error(`Health check failed: ${healthCheck.status}`);
  }

  console.log('Health check passed. Starting load test...');
  return { startTime: new Date() };
}

export function teardown(data) {
  const duration = new Date() - data.startTime;
  console.log('');
  console.log('=== Load Test Complete ===');
  console.log(`Total duration: ${Math.floor(duration / 1000)}s`);
  console.log('Review results in k6 Cloud or results.json');
}

// ============================================================================
// Custom Summary
// ============================================================================

export function handleSummary(data) {
  return {
    'results.json': JSON.stringify(data, null, 2),
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
  };
}

function textSummary(data, options) {
  const indent = options.indent || '';
  const colors = options.enableColors || false;

  let summary = '\n';
  summary += `${indent}==============================================\n`;
  summary += `${indent}     Chimera Load Test Summary\n`;
  summary += `${indent}==============================================\n\n`;

  summary += `${indent}HTTP Metrics:\n`;
  summary += `${indent}  Total Requests: ${data.metrics.http_reqs.values.count}\n`;
  summary += `${indent}  Failed Requests: ${data.metrics.http_req_failed.values.rate * 100}%\n`;
  summary += `${indent}  Requests/sec: ${data.metrics.http_reqs.values.rate.toFixed(2)}\n`;
  summary += `${indent}  Duration p50: ${data.metrics.http_req_duration.values['p(50)']}ms\n`;
  summary += `${indent}  Duration p95: ${data.metrics.http_req_duration.values['p(95)']}ms\n`;
  summary += `${indent}  Duration p99: ${data.metrics.http_req_duration.values['p(99)']}ms\n\n`;

  summary += `${indent}Custom Metrics:\n`;
  summary += `${indent}  Session Creation (p99): ${data.metrics.session_creation_time.values['p(99)']}ms\n`;
  summary += `${indent}  First Token (p95): ${data.metrics.first_token_time.values['p(95)']}ms\n`;
  summary += `${indent}  Tool Invocation (p95): ${data.metrics.tool_invocation_time.values['p(95)']}ms\n`;
  summary += `${indent}  Session Errors: ${data.metrics.session_errors.values.count}\n`;
  summary += `${indent}  Streaming Errors: ${data.metrics.streaming_errors.values.count}\n\n`;

  summary += `${indent}Virtual Users:\n`;
  summary += `${indent}  Peak VUs: ${data.metrics.vus_max.values.max}\n`;
  summary += `${indent}  Iterations: ${data.metrics.iterations.values.count}\n`;
  summary += `${indent}  Avg Iteration Duration: ${data.metrics.iteration_duration.values.avg}ms\n\n`;

  summary += `${indent}==============================================\n`;

  return summary;
}
