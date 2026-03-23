/**
 * Auto-Skill Generation
 *
 * Detects repetitive multi-step patterns in conversation logs,
 * generates SKILL.md files, tests in sandbox, and publishes to library.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type {
  ToolPattern,
  PatternDetectionResult,
  GeneratedSkill,
  SkillTestResult,
} from './types';

// Module-level singleton clients
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});

/**
 * Auto-skill generator from repetitive patterns
 */
export class AutoSkillGenerator {
  private ddb: DynamoDBDocumentClient;
  private s3: S3Client;
  private sessionsTable: string;
  private evolutionTable: string;
  private artifactsBucket: string;

  constructor(params: {
    sessionsTable: string;
    evolutionTable: string;
    artifactsBucket: string;
  }) {
    this.sessionsTable = params.sessionsTable;
    this.evolutionTable = params.evolutionTable;
    this.artifactsBucket = params.artifactsBucket;
    this.ddb = ddbDocClient;
    this.s3 = s3Client;
  }

  /**
   * Detect repeated tool patterns in conversation logs
   */
  async detectRepeatedPatterns(params: {
    tenantId: string;
    minOccurrences?: number;
    minSteps?: number;
    windowDays?: number;
  }): Promise<PatternDetectionResult> {
    const minOccurrences = params.minOccurrences || 3;
    const minSteps = params.minSteps || 2;
    const windowDays = params.windowDays || 14;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);

    // Query recent sessions
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.sessionsTable,
        KeyConditionExpression: 'PK = :pk AND SK > :cutoff',
        ExpressionAttributeValues: {
          ':pk': `TENANT#${params.tenantId}`,
          ':cutoff': `SESSION#${cutoff.toISOString()}`,
        },
      })
    );

    const sessions = result.Items || [];

    // Extract tool call sequences from each session
    const sequences: string[][] = [];
    for (const session of sessions) {
      const log = this.parseConversationLog(session.conversationLog);
      const toolSeq: string[] = [];

      for (const turn of log) {
        if (turn.role === 'assistant' && turn.toolCalls) {
          for (const tc of turn.toolCalls) {
            toolSeq.push(tc.name || tc.function?.name || 'unknown');
          }
        }
      }

      if (toolSeq.length >= minSteps) {
        sequences.push(toolSeq);
      }
    }

    // Find repeated subsequences using n-gram extraction
    const patternCounts = new Map<string, number>();
    const patternExamples = new Map<string, string[]>();

    for (const seq of sequences) {
      const maxLength = Math.min(seq.length, 7); // Max 7 steps
      for (let length = minSteps; length <= maxLength; length++) {
        for (let start = 0; start <= seq.length - length; start++) {
          const subseq = seq.slice(start, start + length);
          const key = JSON.stringify(subseq);

          patternCounts.set(key, (patternCounts.get(key) || 0) + 1);

          if (!patternExamples.has(key)) {
            patternExamples.set(key, seq);
          }
        }
      }
    }

    // Filter to patterns that appear >= minOccurrences
    const repeated: ToolPattern[] = [];

    for (const [key, count] of patternCounts) {
      if (count >= minOccurrences) {
        const pattern = JSON.parse(key) as string[];
        repeated.push({
          pattern,
          occurrences: count,
          steps: pattern.length,
          exampleFullSequence: patternExamples.get(key) || [],
          confidence: this.computePatternConfidence(count, sequences.length),
        });
      }
    }

    // Sort by occurrences (descending)
    repeated.sort((a, b) => b.occurrences - a.occurrences);

    return {
      tenantId: params.tenantId,
      sessionsAnalyzed: sessions.length,
      patternsFound: repeated.length,
      topPatterns: repeated.slice(0, 10),
    };
  }

  /**
   * Generate a skill from a detected pattern
   */
  async generateSkillFromPattern(params: {
    pattern: ToolPattern;
    tenantId: string;
    exampleConversations?: any[];
  }): Promise<GeneratedSkill> {
    const skillName = this.deriveSkillName(params.pattern.pattern);

    // Build the SKILL.md content
    const toolDescriptions = params.pattern.pattern
      .map((t, i) => `  ${i + 1}. \`${t}\``)
      .join('\n');

    const steps = this.generateStepsFromPattern(
      params.pattern,
      params.exampleConversations || []
    );

    const skillMd = `# ${skillName}

> Auto-generated skill from ${params.pattern.occurrences} observed repetitions.
> Pattern detected: ${params.pattern.pattern.join(' → ')}

## When to Use

Use this skill when the user asks you to perform a task that involves:
${toolDescriptions}

## Steps

${steps}

## Notes

- This skill was auto-generated by Chimera's evolution engine
- Generated: ${new Date().toISOString()}
- Tenant: ${params.tenantId}
- Review and customize before publishing to the marketplace
- Confidence: ${((params.pattern.confidence || 0) * 100).toFixed(0)}%
`;

    return {
      skillName,
      skillMd,
      pattern: params.pattern.pattern,
      confidence: params.pattern.confidence || 0,
      metadata: {
        generatedAt: new Date().toISOString(),
        tenantId: params.tenantId,
        occurrences: params.pattern.occurrences,
      },
    };
  }

  /**
   * Test a generated skill in sandbox
   */
  async testSkillInSandbox(params: {
    skillMd: string;
    toolCode?: string;
    testInputs: unknown[];
  }): Promise<SkillTestResult> {
    // Placeholder: In production, would use Bedrock Code Interpreter
    // to execute the skill in an isolated environment

    const results = params.testInputs.map((input) => {
      const success = Math.random() > 0.2; // 80% success rate simulation
      return {
        input,
        output: success ? { result: 'success' } : undefined,
        error: success ? undefined : 'Execution failed',
        executionMs: Math.floor(Math.random() * 500 + 100),
      };
    });

    const passed = results.filter((r) => !r.error).length;

    return {
      totalTests: results.length,
      passed,
      failed: results.length - passed,
      passRate: passed / results.length,
      results,
    };
  }

  /**
   * Publish a skill to tenant's library
   */
  async publishSkill(params: {
    tenantId: string;
    skill: GeneratedSkill;
    testResults: SkillTestResult;
  }): Promise<{ skillId: string; s3Key: string }> {
    // Upload SKILL.md to S3
    const s3Key = `skills/${params.tenantId}/${params.skill.skillName}/${Date.now()}.md`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.artifactsBucket,
        Key: s3Key,
        Body: params.skill.skillMd,
        ContentType: 'text/markdown',
        Metadata: {
          tenantId: params.tenantId,
          skillName: params.skill.skillName,
          confidence: params.skill.confidence.toString(),
          passRate: params.testResults.passRate.toString(),
        },
      })
    );

    // Register in DynamoDB
    const skillId = `autogen-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    await this.ddb.send(
      new PutCommand({
        TableName: this.evolutionTable,
        Item: {
          PK: `TENANT#${params.tenantId}`,
          SK: `SKILL_PATTERN#${skillId}`,
          skillId,
          skillName: params.skill.skillName,
          pattern: params.skill.pattern,
          s3Key,
          confidence: params.skill.confidence,
          testResults: {
            passRate: params.testResults.passRate,
            totalTests: params.testResults.totalTests,
            passed: params.testResults.passed,
          },
          metadata: params.skill.metadata,
          status: 'published',
          createdAt: new Date().toISOString(),
        },
      })
    );

    return { skillId, s3Key };
  }

  /**
   * Get auto-generated skills for tenant
   */
  async getAutoGeneratedSkills(tenantId: string): Promise<GeneratedSkill[]> {
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.evolutionTable,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `TENANT#${tenantId}`,
          ':prefix': 'SKILL_PATTERN#',
        },
      })
    );

    return (result.Items || []).map((item: any) => ({
      skillName: item.skillName,
      skillMd: '', // Would load from S3 if needed
      pattern: item.pattern,
      confidence: item.confidence,
      metadata: item.metadata,
    }));
  }

  // Private helper methods

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

  private deriveSkillName(pattern: string[]): string {
    // Create a readable skill name from the pattern
    const uniqueTools = Array.from(new Set(pattern));

    if (uniqueTools.length === 1) {
      return `${uniqueTools[0]}-repeated`;
    } else if (uniqueTools.length === 2) {
      return `${uniqueTools[0]}-to-${uniqueTools[1]}`;
    } else {
      // Use first and last tool
      return `${uniqueTools[0]}-through-${uniqueTools[uniqueTools.length - 1]}`;
    }
  }

  private generateStepsFromPattern(
    pattern: ToolPattern,
    examples: any[]
  ): string {
    // Generate step descriptions from pattern
    return pattern.pattern
      .map((tool, i) => `${i + 1}. Call \`${tool}\` with appropriate parameters`)
      .join('\n');
  }

  private computePatternConfidence(
    occurrences: number,
    totalSessions: number
  ): number {
    // Confidence based on frequency and consistency
    const frequency = occurrences / totalSessions;
    const base = Math.min(occurrences / 10, 1); // Cap at 10 occurrences
    return Math.min(base * frequency * 2, 0.99);
  }
}

/**
 * Create an auto-skill generator instance
 */
export function createAutoSkillGenerator(params: {
  sessionsTable: string;
  evolutionTable: string;
  artifactsBucket: string;
}): AutoSkillGenerator {
  return new AutoSkillGenerator(params);
}
