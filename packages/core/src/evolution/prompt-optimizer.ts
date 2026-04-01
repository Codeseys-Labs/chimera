/**
 * Prompt Optimizer with A/B Testing
 *
 * Analyzes conversation logs for failures, generates improved prompts,
 * tests them in sandbox, and promotes winners through traffic splitting.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type {
  PromptABExperiment,
  ConversationAnalysis,
  FailurePattern,
  PromptImprovement,
  PromptVariantResult,
  PromptTestCase,
  ISOTimestamp,
} from './types';


/**
 * Prompt optimizer with A/B testing
 */
export class PromptOptimizer {
  private _ddb: DynamoDBDocumentClient | undefined;
  private _s3: S3Client | undefined;
  private evolutionTable: string;
  private sessionsTable: string;
  private artifactsBucket: string;

  private get ddb(): DynamoDBDocumentClient {
    if (!this._ddb) {
      this._ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    }
    return this._ddb;
  }

  private get s3(): S3Client {
    if (!this._s3) {
      this._s3 = new S3Client({});
    }
    return this._s3;
  }

  constructor(params: {
    evolutionTable: string;
    sessionsTable: string;
    artifactsBucket: string;
  }) {
    this.evolutionTable = params.evolutionTable;
    this.sessionsTable = params.sessionsTable;
    this.artifactsBucket = params.artifactsBucket;
  }

  /**
   * Analyze recent conversation logs for failure patterns
   */
  async analyzeConversationLogs(params: {
    tenantId: string;
    daysBack?: number;
  }): Promise<ConversationAnalysis> {
    const daysBack = params.daysBack || 7;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffISO = cutoff.toISOString();

    // Query recent sessions for this tenant
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.sessionsTable,
        KeyConditionExpression: 'PK = :pk AND SK > :cutoff',
        ExpressionAttributeValues: {
          ':pk': `TENANT#${params.tenantId}`,
          ':cutoff': `SESSION#${cutoffISO}`,
        },
      })
    );

    const sessions = result.Items || [];
    const failures: FailurePattern[] = [];
    const corrections: FailurePattern[] = [];

    // Analyze each session's conversation log
    for (const session of sessions) {
      const log = this.parseConversationLog(session.conversationLog);

      for (let i = 0; i < log.length; i++) {
        const turn = log[i];

        // Detect tool call failures
        if (turn.role === 'tool' && turn.status === 'error') {
          failures.push({
            sessionId: session.SK,
            turn: i,
            tool: turn.toolName,
            error: turn.content?.substring(0, 200),
          });
        }

        // Detect user corrections
        if (turn.role === 'user') {
          const content = turn.content?.toLowerCase() || '';
          const correctionSignals = [
            'no,',
            "that's wrong",
            'i meant',
            'not what i asked',
            'try again',
            'incorrect',
            'please fix',
          ];

          if (correctionSignals.some((sig) => content.includes(sig))) {
            corrections.push({
              sessionId: session.SK,
              turn: i,
              userMessage: turn.content?.substring(0, 300),
              priorAssistantMessage: log[i - 1]?.content?.substring(0, 300),
            });
          }
        }
      }
    }

    return {
      tenantId: params.tenantId,
      periodDays: daysBack,
      totalSessions: sessions.length,
      failureCount: failures.length,
      correctionCount: corrections.length,
      topFailures: failures.slice(0, 10),
      topCorrections: corrections.slice(0, 10),
    };
  }

  /**
   * Create a prompt A/B experiment
   */
  async createABExperiment(params: {
    tenantId: string;
    currentPromptS3: string;
    improvedPromptS3: string;
    trafficSplit?: number;
    durationHours?: number;
  }): Promise<PromptABExperiment> {
    const experimentId = `ab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (params.durationHours || 24) * 60 * 60 * 1000);

    const experiment: PromptABExperiment = {
      experimentId,
      tenantId: params.tenantId,
      variantAPromptS3: params.currentPromptS3,
      variantBPromptS3: params.improvedPromptS3,
      trafficSplit: params.trafficSplit || 0.1, // Default 10% to variant B
      startedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      variantAScores: { quality: 0, cost: 0, n: 0 },
      variantBScores: { quality: 0, cost: 0, n: 0 },
      status: 'running',
      promotedVariant: null,
      cedarApproval: 'ALLOW', // Would come from safety harness
    };

    // Store in DynamoDB
    await this.ddb.send(
      new PutCommand({
        TableName: this.evolutionTable,
        Item: {
          PK: `TENANT#${params.tenantId}`,
          SK: `PROMPT_AB#${experimentId}`,
          ...experiment,
        },
      })
    );

    return experiment;
  }

  /**
   * Select which prompt variant to use for a request
   */
  async selectPromptVariant(params: {
    tenantId: string;
    experimentId: string;
  }): Promise<'a' | 'b'> {
    const experiment = await this.getExperiment(params.tenantId, params.experimentId);

    if (!experiment || experiment.status !== 'running') {
      return 'a'; // Default to control
    }

    // Check if experiment has expired
    if (new Date(experiment.expiresAt) < new Date()) {
      await this.completeExperiment(params.tenantId, params.experimentId);
      return 'a';
    }

    // Traffic splitting
    const rand = Math.random();
    return rand < experiment.trafficSplit ? 'b' : 'a';
  }

  /**
   * Record the outcome of a prompt variant
   */
  async recordVariantOutcome(params: {
    tenantId: string;
    experimentId: string;
    variant: 'a' | 'b';
    qualityScore: number;
    cost: number;
    latencyMs?: number;
  }): Promise<void> {
    const field = params.variant === 'a' ? 'variantAScores' : 'variantBScores';

    await this.ddb.send(
      new UpdateCommand({
        TableName: this.evolutionTable,
        Key: {
          PK: `TENANT#${params.tenantId}`,
          SK: `PROMPT_AB#${params.experimentId}`,
        },
        UpdateExpression: `SET ${field}.quality = ${field}.quality + :q, ${field}.cost = ${field}.cost + :c, ${field}.n = ${field}.n + :one, ${field}.latencyMs = if_not_exists(${field}.latencyMs, :zero) + :l`,
        ExpressionAttributeValues: {
          ':q': params.qualityScore,
          ':c': params.cost,
          ':one': 1,
          ':zero': 0,
          ':l': params.latencyMs || 0,
        },
      })
    );
  }

  /**
   * Complete an A/B experiment and promote winner
   */
  async completeExperiment(
    tenantId: string,
    experimentId: string
  ): Promise<{ winner: 'a' | 'b'; reason: string }> {
    const experiment = await this.getExperiment(tenantId, experimentId);
    if (!experiment) {
      throw new Error(`Experiment ${experimentId} not found`);
    }

    // Calculate average scores
    const aQuality = experiment.variantAScores.n > 0
      ? experiment.variantAScores.quality / experiment.variantAScores.n
      : 0;
    const bQuality = experiment.variantBScores.n > 0
      ? experiment.variantBScores.quality / experiment.variantBScores.n
      : 0;

    const aCost = experiment.variantAScores.n > 0
      ? experiment.variantAScores.cost / experiment.variantAScores.n
      : 0;
    const bCost = experiment.variantBScores.n > 0
      ? experiment.variantBScores.cost / experiment.variantBScores.n
      : 0;

    // Determine winner (quality > 5% improvement, or cost < 10% with similar quality)
    let winner: 'a' | 'b' = 'a';
    let reason = 'Control variant retained (insufficient improvement)';

    if (bQuality > aQuality * 1.05) {
      winner = 'b';
      reason = `Variant B improved quality by ${((bQuality - aQuality) / aQuality * 100).toFixed(1)}%`;
    } else if (bCost < aCost * 0.9 && Math.abs(bQuality - aQuality) < 0.03) {
      winner = 'b';
      reason = `Variant B reduced cost by ${((aCost - bCost) / aCost * 100).toFixed(1)}% with similar quality`;
    }

    // Update experiment
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.evolutionTable,
        Key: {
          PK: `TENANT#${tenantId}`,
          SK: `PROMPT_AB#${experimentId}`,
        },
        UpdateExpression: 'SET #status = :completed, promotedVariant = :winner',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':completed': 'completed',
          ':winner': winner,
        },
      })
    );

    return { winner, reason };
  }

  /**
   * Test prompt variant against golden dataset
   */
  async testPromptVariant(params: {
    tenantId: string;
    variantPrompt: string;
    goldenDatasetS3Key: string;
  }): Promise<PromptVariantResult> {
    // Load golden dataset from S3
    const dataset = await this.loadGoldenDataset(params.goldenDatasetS3Key);

    const results: Array<{
      caseId: string;
      score: number;
      latencyMs: number;
      tokensUsed: number;
    }> = [];

    // Test each case (in production, would use Bedrock agent with variant prompt)
    for (const testCase of dataset.cases) {
      // Simulate test execution
      // In production: invoke Bedrock agent with variant prompt
      const startTime = Date.now();
      const score = await this.runTestCase(params.variantPrompt, testCase);
      const latencyMs = Date.now() - startTime;

      results.push({
        caseId: testCase.id,
        score,
        latencyMs,
        tokensUsed: 1000, // Would come from actual invocation
      });
    }

    const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
    const avgTokens = results.reduce((sum, r) => sum + r.tokensUsed, 0) / results.length;
    const passRate = results.filter((r) => r.score > 0.8).length / results.length;

    return {
      variantId: `v-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      avgQualityScore: parseFloat(avgScore.toFixed(4)),
      avgTokensPerCase: Math.round(avgTokens),
      passRate: parseFloat(passRate.toFixed(4)),
      details: results,
    };
  }

  /**
   * Get active experiments for tenant
   */
  async getActiveExperiments(tenantId: string): Promise<PromptABExperiment[]> {
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.evolutionTable,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        FilterExpression: '#status = :running',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':pk': `TENANT#${tenantId}`,
          ':prefix': 'PROMPT_AB#',
          ':running': 'running',
        },
      })
    );

    return (result.Items || []) as PromptABExperiment[];
  }

  /**
   * Store prompt in S3
   */
  async storePrompt(tenantId: string, promptContent: string): Promise<string> {
    const key = `prompts/${tenantId}/${Date.now()}-${Math.random().toString(36).substring(2, 9)}.txt`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.artifactsBucket,
        Key: key,
        Body: promptContent,
        ContentType: 'text/plain',
      })
    );

    return key;
  }

  /**
   * Load prompt from S3
   */
  async loadPrompt(s3Key: string): Promise<string> {
    const result = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.artifactsBucket,
        Key: s3Key,
      })
    );

    return await result.Body!.transformToString();
  }

  // Private helper methods

  private async getExperiment(
    tenantId: string,
    experimentId: string
  ): Promise<PromptABExperiment | null> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.evolutionTable,
        Key: {
          PK: `TENANT#${tenantId}`,
          SK: `PROMPT_AB#${experimentId}`,
        },
      })
    );

    return result.Item as PromptABExperiment | null;
  }

  private parseConversationLog(logData: any): any[] {
    if (typeof logData === 'string') {
      try {
        return JSON.parse(logData);
      } catch {
        return [];
      }
    }
    return Array.isArray(logData) ? logData : [];
  }

  private async loadGoldenDataset(s3Key: string): Promise<{ cases: PromptTestCase[] }> {
    const result = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.artifactsBucket,
        Key: s3Key,
      })
    );

    const content = await result.Body!.transformToString();
    return JSON.parse(content);
  }

  private async runTestCase(prompt: string, testCase: PromptTestCase): Promise<number> {
    // Placeholder for production Bedrock agent invocation
    // Production implementation would:
    // 1. Invoke Bedrock agent with variant prompt + test input
    // 2. Get agent response
    // 3. Compute similarity score using:
    //    - Bedrock embeddings (cosine similarity) OR
    //    - LLM-as-judge (Claude evaluating response quality)
    //
    // Simulation logic: score based on prompt length and test case category
    // as a proxy for prompt quality (longer, more specific prompts score higher)

    const baseScore = 0.6;
    const promptLengthBonus = Math.min(0.2, prompt.length / 5000); // Up to 0.2 for long prompts
    const categoryBonus = testCase.category ? 0.1 : 0; // 0.1 if categorized
    const randomVariance = (Math.random() - 0.5) * 0.2; // ±0.1 variance

    const score = Math.max(0, Math.min(1,
      baseScore + promptLengthBonus + categoryBonus + randomVariance
    ));

    return score;
  }
}

/**
 * Create a prompt optimizer instance
 */
export function createPromptOptimizer(params: {
  evolutionTable: string;
  sessionsTable: string;
  artifactsBucket: string;
}): PromptOptimizer {
  return new PromptOptimizer(params);
}
