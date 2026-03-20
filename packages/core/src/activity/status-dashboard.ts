/**
 * Status Dashboard
 *
 * Real-time aggregation of agent activity across the platform:
 * - Active session metrics
 * - Agent event tracking
 * - Resource utilization summary
 * - Token usage and cost correlation
 *
 * Provides a unified view for monitoring and observability
 */

import type {
  AgentSession,
  SessionStatus,
  SessionTokenUsage,
} from '@chimera/shared';

/**
 * DynamoDB client interface
 */
export interface DynamoDBClient {
  get(params: any): Promise<any>;
  query(params: any): Promise<any>;
  scan(params: any): Promise<any>;
}

/**
 * Status dashboard configuration
 */
export interface StatusDashboardConfig {
  /** DynamoDB table name for sessions */
  sessionsTableName: string;

  /** DynamoDB table name for cost tracking */
  costTrackingTableName: string;

  /** DynamoDB client */
  dynamodb: DynamoDBClient;

  /** Default page size for queries */
  defaultPageSize?: number;
}

/**
 * Session metrics summary
 */
export interface SessionMetrics {
  totalSessions: number;
  activeSessions: number;
  idleSessions: number;
  terminatedSessions: number;
  totalMessages: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  averageMessagesPerSession: number;
}

/**
 * Agent activity summary
 */
export interface AgentActivitySummary {
  agentId: string;
  sessionCount: number;
  totalMessages: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  averageTokensPerMessage: number;
  lastActivity: string; // ISO 8601
}

/**
 * Tenant activity dashboard
 */
export interface TenantDashboard {
  tenantId: string;
  timestamp: string; // ISO 8601
  sessionMetrics: SessionMetrics;
  topAgents: AgentActivitySummary[];
  recentActivity: RecentActivityItem[];
}

/**
 * Recent activity item
 */
export interface RecentActivityItem {
  sessionId: string;
  agentId: string;
  userId: string;
  status: SessionStatus;
  lastActivity: string; // ISO 8601
  messageCount: number;
  tokenUsage: SessionTokenUsage;
}

/**
 * Query sessions parameters
 */
export interface QuerySessionsParams {
  tenantId: string;
  status?: SessionStatus;
  limit?: number;
  nextToken?: string;
}

/**
 * Query sessions result
 */
export interface QuerySessionsResult {
  sessions: AgentSession[];
  nextToken?: string;
}

/**
 * Status Dashboard
 *
 * Aggregates real-time agent activity for monitoring and observability:
 * 1. Session metrics (active, idle, terminated counts)
 * 2. Token usage across agents
 * 3. Agent-level activity summaries
 * 4. Recent activity feed
 *
 * Use cases:
 * - Operational dashboards showing current platform load
 * - Per-tenant usage monitoring
 * - Agent performance comparison
 * - Resource utilization tracking
 */
export class StatusDashboard {
  private config: StatusDashboardConfig;

  constructor(config: StatusDashboardConfig) {
    this.config = config;
  }

  /**
   * Get comprehensive dashboard for a tenant
   *
   * Aggregates session metrics, top agents, and recent activity
   *
   * @param tenantId - Tenant ID
   * @param options - Query options
   * @returns Tenant dashboard snapshot
   */
  async getTenantDashboard(
    tenantId: string,
    options?: {
      topAgentsLimit?: number;
      recentActivityLimit?: number;
    }
  ): Promise<TenantDashboard> {
    const topAgentsLimit = options?.topAgentsLimit || 10;
    const recentActivityLimit = options?.recentActivityLimit || 20;

    // Query all sessions for tenant
    const sessions = await this.queryAllSessions(tenantId);

    // Calculate session metrics
    const sessionMetrics = this.calculateSessionMetrics(sessions);

    // Aggregate by agent
    const agentSummaries = this.aggregateByAgent(sessions);

    // Sort agents by activity (message count)
    const topAgents = agentSummaries
      .sort((a, b) => b.totalMessages - a.totalMessages)
      .slice(0, topAgentsLimit);

    // Get recent activity (sorted by lastActivity)
    const recentActivity = sessions
      .map(session => this.sessionToActivityItem(session))
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
      .slice(0, recentActivityLimit);

    return {
      tenantId,
      timestamp: new Date().toISOString(),
      sessionMetrics,
      topAgents,
      recentActivity,
    };
  }

  /**
   * Get session metrics for a tenant
   *
   * @param tenantId - Tenant ID
   * @returns Session metrics summary
   */
  async getSessionMetrics(tenantId: string): Promise<SessionMetrics> {
    const sessions = await this.queryAllSessions(tenantId);
    return this.calculateSessionMetrics(sessions);
  }

  /**
   * Query sessions with filtering
   *
   * @param params - Query parameters
   * @returns Query result with pagination
   */
  async querySessions(params: QuerySessionsParams): Promise<QuerySessionsResult> {
    const { tenantId, status, limit, nextToken } = params;

    const queryParams: any = {
      TableName: this.config.sessionsTableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `TENANT#${tenantId}`,
      },
      Limit: limit || this.config.defaultPageSize || 50,
      ScanIndexForward: false, // Most recent first
    };

    // Add status filter if specified
    if (status) {
      queryParams.FilterExpression = '#status = :status';
      queryParams.ExpressionAttributeNames = {
        '#status': 'status',
      };
      queryParams.ExpressionAttributeValues[':status'] = status;
    }

    // Add pagination token if provided
    if (nextToken) {
      queryParams.ExclusiveStartKey = JSON.parse(
        Buffer.from(nextToken, 'base64').toString('utf-8')
      );
    }

    const result = await this.config.dynamodb.query(queryParams);

    const sessions = (result.Items || []) as AgentSession[];

    // Generate next token if there are more results
    const responseNextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : undefined;

    return {
      sessions,
      nextToken: responseNextToken,
    };
  }

  /**
   * Get activity summary for a specific agent
   *
   * @param tenantId - Tenant ID
   * @param agentId - Agent ID
   * @returns Agent activity summary
   */
  async getAgentActivity(
    tenantId: string,
    agentId: string
  ): Promise<AgentActivitySummary | null> {
    const sessions = await this.queryAllSessions(tenantId);
    const agentSessions = sessions.filter(s => s.agentId === agentId);

    if (agentSessions.length === 0) {
      return null;
    }

    return this.createAgentSummary(agentId, agentSessions);
  }

  /**
   * Get recent activity for a tenant
   *
   * @param tenantId - Tenant ID
   * @param limit - Maximum number of items (default 20)
   * @returns Recent activity items sorted by time
   */
  async getRecentActivity(
    tenantId: string,
    limit: number = 20
  ): Promise<RecentActivityItem[]> {
    const result = await this.querySessions({
      tenantId,
      limit,
    });

    return result.sessions.map(session => this.sessionToActivityItem(session));
  }

  /**
   * Get active sessions count
   *
   * @param tenantId - Tenant ID
   * @returns Number of active sessions
   */
  async getActiveSessionsCount(tenantId: string): Promise<number> {
    const result = await this.querySessions({
      tenantId,
      status: 'active',
      limit: 1000, // Reasonable upper bound
    });

    // Count all pages if needed
    let count = result.sessions.length;
    let nextToken = result.nextToken;

    while (nextToken) {
      const nextResult = await this.querySessions({
        tenantId,
        status: 'active',
        nextToken,
        limit: 1000,
      });
      count += nextResult.sessions.length;
      nextToken = nextResult.nextToken;
    }

    return count;
  }

  /**
   * Query all sessions for a tenant (internal helper)
   *
   * @param tenantId - Tenant ID
   * @returns All sessions for the tenant
   */
  private async queryAllSessions(tenantId: string): Promise<AgentSession[]> {
    const sessions: AgentSession[] = [];
    let nextToken: string | undefined = undefined;

    do {
      const result = await this.querySessions({
        tenantId,
        nextToken,
        limit: 1000,
      });

      sessions.push(...result.sessions);
      nextToken = result.nextToken;
    } while (nextToken);

    return sessions;
  }

  /**
   * Calculate session metrics from session array
   *
   * @param sessions - Array of agent sessions
   * @returns Session metrics summary
   */
  private calculateSessionMetrics(sessions: AgentSession[]): SessionMetrics {
    let activeSessions = 0;
    let idleSessions = 0;
    let terminatedSessions = 0;
    let totalMessages = 0;
    let totalTokensInput = 0;
    let totalTokensOutput = 0;

    for (const session of sessions) {
      // Count by status
      if (session.status === 'active') activeSessions++;
      else if (session.status === 'idle') idleSessions++;
      else if (session.status === 'terminated') terminatedSessions++;

      // Accumulate metrics
      totalMessages += session.messageCount;
      totalTokensInput += session.tokenUsage.input;
      totalTokensOutput += session.tokenUsage.output;
    }

    const averageMessagesPerSession =
      sessions.length > 0 ? totalMessages / sessions.length : 0;

    return {
      totalSessions: sessions.length,
      activeSessions,
      idleSessions,
      terminatedSessions,
      totalMessages,
      totalTokensInput,
      totalTokensOutput,
      averageMessagesPerSession,
    };
  }

  /**
   * Aggregate sessions by agent
   *
   * @param sessions - Array of agent sessions
   * @returns Array of agent summaries
   */
  private aggregateByAgent(sessions: AgentSession[]): AgentActivitySummary[] {
    const agentMap = new Map<string, AgentSession[]>();

    // Group sessions by agent
    for (const session of sessions) {
      const existing = agentMap.get(session.agentId) || [];
      existing.push(session);
      agentMap.set(session.agentId, existing);
    }

    // Create summaries for each agent
    const summaries: AgentActivitySummary[] = [];
    for (const [agentId, agentSessions] of agentMap.entries()) {
      summaries.push(this.createAgentSummary(agentId, agentSessions));
    }

    return summaries;
  }

  /**
   * Create agent summary from sessions
   *
   * @param agentId - Agent ID
   * @param sessions - Agent's sessions
   * @returns Agent activity summary
   */
  private createAgentSummary(
    agentId: string,
    sessions: AgentSession[]
  ): AgentActivitySummary {
    let totalMessages = 0;
    let totalTokensInput = 0;
    let totalTokensOutput = 0;
    let lastActivity = sessions[0]?.lastActivity || new Date().toISOString();

    for (const session of sessions) {
      totalMessages += session.messageCount;
      totalTokensInput += session.tokenUsage.input;
      totalTokensOutput += session.tokenUsage.output;

      // Track most recent activity
      if (session.lastActivity > lastActivity) {
        lastActivity = session.lastActivity;
      }
    }

    const totalTokens = totalTokensInput + totalTokensOutput;
    const averageTokensPerMessage =
      totalMessages > 0 ? totalTokens / totalMessages : 0;

    return {
      agentId,
      sessionCount: sessions.length,
      totalMessages,
      totalTokensInput,
      totalTokensOutput,
      averageTokensPerMessage,
      lastActivity,
    };
  }

  /**
   * Convert session to activity item
   *
   * @param session - Agent session
   * @returns Recent activity item
   */
  private sessionToActivityItem(session: AgentSession): RecentActivityItem {
    return {
      sessionId: session.sessionId,
      agentId: session.agentId,
      userId: session.userId,
      status: session.status,
      lastActivity: session.lastActivity,
      messageCount: session.messageCount,
      tokenUsage: session.tokenUsage,
    };
  }
}
