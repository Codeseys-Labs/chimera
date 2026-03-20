/**
 * Test HTTP client wrapper for Chimera integration and E2E tests.
 * Provides authenticated requests to API Gateway with tenant context.
 *
 * Based on E2EClient pattern from docs/research/enhancement/06-Testing-Strategy.md
 */

export interface TestClientConfig {
  /** Base API URL (e.g., https://api.chimera-staging.example.com) */
  apiUrl: string;
  /** Authentication token (JWT from Cognito) */
  authToken?: string;
  /** Tenant ID for multi-tenant isolation */
  tenantId: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Budget cap for this test client (USD) */
  maxBudgetUsd?: number;
}

export interface SessionCreateRequest {
  agentType?: string;
  skills?: string[];
  budgetUsd?: number;
}

export interface SessionCreateResponse {
  sessionId: string;
  tenantId: string;
  agentId: string;
  createdAt: string;
}

export interface SendMessageRequest {
  message: string;
  sessionId: string;
  timeout?: number;
}

export interface SendMessageResponse {
  sessionId: string;
  text: string;
  status: 'completed' | 'error' | 'budget_exceeded';
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    total: number;
  };
  toolCallsMade: number;
  toolCalls: ToolCall[];
  durationMs: number;
}

export interface ToolCall {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

export interface StreamChunk {
  sessionId: string;
  text: string;
  chunkType: 'text' | 'tool_use' | 'tool_result' | 'final';
  isFinal: boolean;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * TestClient provides a typed HTTP client for Chimera API testing.
 * Handles authentication, tenant context, and structured request/response parsing.
 *
 * @example
 * ```typescript
 * const client = new TestClient({
 *   apiUrl: 'https://api.chimera-staging.example.com',
 *   authToken: 'Bearer ...',
 *   tenantId: 'test-acme',
 * });
 *
 * const session = await client.createSession({ agentType: 'chatbot' });
 * const response = await client.sendMessage({
 *   sessionId: session.sessionId,
 *   message: 'Hello, agent!',
 * });
 * ```
 */
export class TestClient {
  private config: Required<TestClientConfig>;
  private totalCostUsd: number = 0;

  constructor(config: TestClientConfig) {
    this.config = {
      apiUrl: config.apiUrl,
      authToken: config.authToken || '',
      tenantId: config.tenantId,
      timeout: config.timeout || 30000,
      maxBudgetUsd: config.maxBudgetUsd || 10.0,
    };
  }

  /**
   * Create a new agent session.
   */
  async createSession(
    req: SessionCreateRequest = {}
  ): Promise<SessionCreateResponse> {
    const response = await this.request<SessionCreateResponse>('POST', '/sessions', {
      agent_type: req.agentType || 'chatbot',
      skills: req.skills || [],
      budget_usd: req.budgetUsd,
    });

    if (response.status !== 201) {
      throw new Error(
        `Failed to create session: ${response.status} ${response.statusText}`
      );
    }

    return response.data;
  }

  /**
   * Send a message to an existing session and wait for completion.
   */
  async sendMessage(req: SendMessageRequest): Promise<SendMessageResponse> {
    const timeout = req.timeout || this.config.timeout;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await this.request<SendMessageResponse>(
        'POST',
        `/sessions/${req.sessionId}/messages`,
        { message: req.message },
        { signal: controller.signal }
      );

      if (response.status !== 200) {
        throw new Error(
          `Failed to send message: ${response.status} ${response.statusText}`
        );
      }

      // Track cost
      const costUsd = this.estimateCost(response.data.tokenUsage.total);
      this.totalCostUsd += costUsd;

      if (this.totalCostUsd > this.config.maxBudgetUsd) {
        throw new Error(
          `Test budget exceeded: $${this.totalCostUsd.toFixed(2)} > $${this.config.maxBudgetUsd}`
        );
      }

      return response.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Stream a message response using Server-Sent Events (SSE).
   */
  async *streamMessage(
    sessionId: string,
    message: string
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const response = await fetch(
      `${this.config.apiUrl}/sessions/${sessionId}/messages/stream`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ message }),
      }
    );

    if (!response.ok) {
      throw new Error(`Stream failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.substring(6);
            if (data === '[DONE]') {
              return;
            }
            try {
              const chunk = JSON.parse(data) as StreamChunk;
              yield chunk;
            } catch (error) {
              console.warn('Failed to parse SSE chunk:', data);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Get session details.
   */
  async getSession(sessionId: string): Promise<{ sessionId: string; tenantId: string; state: Record<string, unknown> }> {
    const response = await this.request<{ sessionId: string; tenantId: string; state: Record<string, unknown> }>(
      'GET',
      `/sessions/${sessionId}`
    );

    if (response.status !== 200) {
      throw new Error(`Failed to get session: ${response.status} ${response.statusText}`);
    }

    return response.data;
  }

  /**
   * List installed skills for the tenant.
   */
  async listSkills(): Promise<{ name: string; version: string; trustLevel: string }[]> {
    const response = await this.request<{ skills: { name: string; version: string; trustLevel: string }[] }>(
      'GET',
      '/skills'
    );

    if (response.status !== 200) {
      throw new Error(`Failed to list skills: ${response.status} ${response.statusText}`);
    }

    return response.data.skills;
  }

  /**
   * Install a skill for the tenant.
   */
  async installSkill(skillName: string): Promise<void> {
    const response = await this.request('POST', '/skills', {
      skill_name: skillName,
    });

    if (response.status !== 201) {
      throw new Error(`Failed to install skill: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Get current period usage/cost for the tenant.
   */
  async getCurrentPeriodCost(): Promise<number> {
    const response = await this.request<{ cost_usd: number }>(
      'GET',
      `/tenants/${this.config.tenantId}/usage`
    );

    if (response.status !== 200) {
      throw new Error(`Failed to get usage: ${response.status} ${response.statusText}`);
    }

    return response.data.cost_usd;
  }

  /**
   * Get total cost accumulated by this test client.
   */
  getTotalCost(): number {
    return this.totalCostUsd;
  }

  /**
   * Reset cost tracking (useful between test cases).
   */
  resetCostTracking(): void {
    this.totalCostUsd = 0;
  }

  /**
   * Generic HTTP request helper.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestInit
  ): Promise<{ status: number; statusText: string; data: T }> {
    const url = `${this.config.apiUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: this.buildHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    });

    let data: T;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = (await response.json()) as T;
    } else {
      data = (await response.text()) as T;
    }

    return {
      status: response.status,
      statusText: response.statusText,
      data,
    };
  }

  /**
   * Build request headers with auth and tenant context.
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-ID': this.config.tenantId,
    };

    if (this.config.authToken) {
      headers['Authorization'] = this.config.authToken.startsWith('Bearer ')
        ? this.config.authToken
        : `Bearer ${this.config.authToken}`;
    }

    return headers;
  }

  /**
   * Estimate cost from token count (rough approximation).
   * Claude Sonnet 4.6: $3/MTok input, $15/MTok output (assume 50/50 split).
   */
  private estimateCost(totalTokens: number): number {
    const avgCostPerToken = ((3 + 15) / 2) / 1_000_000;
    return totalTokens * avgCostPerToken;
  }
}
