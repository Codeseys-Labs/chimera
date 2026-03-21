/**
 * Unit tests for Auto-Skill Generation
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AutoSkillGenerator } from '../../../packages/core/src/evolution/auto-skill-gen';
import type {
  ToolPattern,
  PatternDetectionResult,
  GeneratedSkill,
} from '../../../packages/core/src/evolution/types';

describe('AutoSkillGenerator', () => {
  let generator: AutoSkillGenerator;
  const mockTables = {
    sessionsTable: 'test-sessions',
    evolutionTable: 'test-evolution',
    artifactsBucket: 'test-artifacts',
  };

  beforeEach(() => {
    generator = new AutoSkillGenerator(mockTables);
  });

  describe('detectRepeatedPatterns', () => {
    it('should detect patterns with sufficient occurrences', async () => {
      // Mock DynamoDB query to return sessions with tool sequences
      const mockSessions = [
        {
          conversationLog: JSON.stringify([
            {
              role: 'assistant',
              toolCalls: [
                { name: 'Read' },
                { name: 'Grep' },
                { name: 'Edit' },
              ],
            },
          ]),
        },
        {
          conversationLog: JSON.stringify([
            {
              role: 'assistant',
              toolCalls: [
                { name: 'Read' },
                { name: 'Grep' },
                { name: 'Edit' },
              ],
            },
          ]),
        },
        {
          conversationLog: JSON.stringify([
            {
              role: 'assistant',
              toolCalls: [
                { name: 'Read' },
                { name: 'Grep' },
                { name: 'Edit' },
              ],
            },
          ]),
        },
      ];

      // @ts-expect-error - accessing private property for testing
      const originalSend = generator.ddb.send;
      // @ts-expect-error - mocking private client
      generator.ddb.send = mock(() =>
        Promise.resolve({
          Items: mockSessions,
        })
      );

      const result = await generator.detectRepeatedPatterns({
        tenantId: 'test-tenant',
        minOccurrences: 3,
        minSteps: 2,
      });

      expect(result.tenantId).toBe('test-tenant');
      expect(result.sessionsAnalyzed).toBe(3);
      expect(result.patternsFound).toBeGreaterThan(0);
      expect(result.topPatterns[0].pattern).toContain('Read');

      // Restore
      // @ts-expect-error - restoring mock
      generator.ddb.send = originalSend;
    });

    it('should filter patterns below minimum occurrences', async () => {
      const mockSessions = [
        {
          conversationLog: JSON.stringify([
            {
              role: 'assistant',
              toolCalls: [{ name: 'Read' }, { name: 'Write' }],
            },
          ]),
        },
        {
          conversationLog: JSON.stringify([
            {
              role: 'assistant',
              toolCalls: [{ name: 'Bash' }, { name: 'Grep' }],
            },
          ]),
        },
      ];

      // @ts-expect-error - mocking
      generator.ddb.send = mock(() =>
        Promise.resolve({ Items: mockSessions })
      );

      const result = await generator.detectRepeatedPatterns({
        tenantId: 'test-tenant',
        minOccurrences: 3, // No pattern appears 3 times
      });

      expect(result.patternsFound).toBe(0);
    });

    it('should respect time window for pattern detection', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 5);

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 20);

      // Mock should filter by date in query
      // @ts-expect-error - mocking
      generator.ddb.send = mock((command: any) => {
        const cutoffDate = command.input.ExpressionAttributeValues[':cutoff'];
        expect(cutoffDate).toBeDefined();
        return Promise.resolve({ Items: [] });
      });

      await generator.detectRepeatedPatterns({
        tenantId: 'test-tenant',
        windowDays: 14,
      });
    });

    it('should handle malformed conversation logs gracefully', async () => {
      const mockSessions = [
        { conversationLog: 'invalid json' },
        { conversationLog: null },
        { conversationLog: undefined },
        { conversationLog: { not: 'an array' } },
      ];

      // @ts-expect-error - mocking
      generator.ddb.send = mock(() =>
        Promise.resolve({ Items: mockSessions })
      );

      const result = await generator.detectRepeatedPatterns({
        tenantId: 'test-tenant',
      });

      expect(result.patternsFound).toBe(0);
      expect(result.sessionsAnalyzed).toBe(4);
    });

    it('should limit pattern length to 7 steps maximum', async () => {
      const longSequence = Array.from({ length: 15 }, (_, i) => ({
        name: `Tool${i}`,
      }));

      const mockSessions = [
        {
          conversationLog: JSON.stringify([
            {
              role: 'assistant',
              toolCalls: longSequence,
            },
          ]),
        },
      ];

      // @ts-expect-error - mocking
      generator.ddb.send = mock(() =>
        Promise.resolve({ Items: mockSessions })
      );

      const result = await generator.detectRepeatedPatterns({
        tenantId: 'test-tenant',
        minOccurrences: 1,
      });

      // All patterns should be <= 7 steps
      for (const pattern of result.topPatterns) {
        expect(pattern.steps).toBeLessThanOrEqual(7);
      }
    });
  });

  describe('generateSkillFromPattern', () => {
    it('should generate valid SKILL.md content', async () => {
      const pattern: ToolPattern = {
        pattern: ['Read', 'Grep', 'Edit'],
        occurrences: 5,
        steps: 3,
        exampleFullSequence: ['Read', 'Grep', 'Edit', 'Write'],
        confidence: 0.85,
      };

      const result = await generator.generateSkillFromPattern({
        pattern,
        tenantId: 'test-tenant',
      });

      expect(result.skillName).toBeTruthy();
      expect(result.skillMd).toContain('# ');
      expect(result.skillMd).toContain('## When to Use');
      expect(result.skillMd).toContain('## Steps');
      expect(result.skillMd).toContain('Read');
      expect(result.skillMd).toContain('Grep');
      expect(result.skillMd).toContain('Edit');
      expect(result.confidence).toBe(0.85);
    });

    it('should include metadata in generated skill', async () => {
      const pattern: ToolPattern = {
        pattern: ['Bash'],
        occurrences: 10,
        steps: 1,
        exampleFullSequence: ['Bash'],
        confidence: 0.9,
      };

      const result = await generator.generateSkillFromPattern({
        pattern,
        tenantId: 'tenant-123',
      });

      expect(result.metadata.tenantId).toBe('tenant-123');
      expect(result.metadata.occurrences).toBe(10);
      expect(result.metadata.generatedAt).toBeTruthy();
    });

    it('should derive meaningful skill names', async () => {
      const patterns: ToolPattern[] = [
        {
          pattern: ['Read', 'Read', 'Read'],
          occurrences: 3,
          steps: 3,
          exampleFullSequence: [],
          confidence: 0.5,
        },
        {
          pattern: ['Read', 'Write'],
          occurrences: 3,
          steps: 2,
          exampleFullSequence: [],
          confidence: 0.5,
        },
        {
          pattern: ['Read', 'Grep', 'Edit'],
          occurrences: 3,
          steps: 3,
          exampleFullSequence: [],
          confidence: 0.5,
        },
      ];

      const results = await Promise.all(
        patterns.map((p) =>
          generator.generateSkillFromPattern({ pattern: p, tenantId: 'test' })
        )
      );

      expect(results[0].skillName).toContain('Read');
      expect(results[1].skillName).toContain('Read');
      expect(results[1].skillName).toContain('Write');
      expect(results[2].skillName).toContain('Read');
      expect(results[2].skillName).toContain('Edit');
    });
  });

  describe('testSkillInSandbox', () => {
    it('should return test results with pass/fail counts', async () => {
      const testInputs = [
        { input: 'test1' },
        { input: 'test2' },
        { input: 'test3' },
      ];

      const result = await generator.testSkillInSandbox({
        skillMd: '# Test Skill',
        testInputs,
      });

      expect(result.totalTests).toBe(3);
      expect(result.passed).toBeGreaterThanOrEqual(0);
      expect(result.passed).toBeLessThanOrEqual(3);
      expect(result.failed).toBe(result.totalTests - result.passed);
      expect(result.passRate).toBeGreaterThanOrEqual(0);
      expect(result.passRate).toBeLessThanOrEqual(1);
    });

    it('should include execution metrics for each test', async () => {
      const result = await generator.testSkillInSandbox({
        skillMd: '# Test',
        testInputs: [{ test: 'data' }],
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].input).toBeDefined();
      expect(result.results[0].executionMs).toBeGreaterThan(0);
    });
  });

  describe('publishSkill', () => {
    it('should upload skill to S3 and register in DynamoDB', async () => {
      const skill: GeneratedSkill = {
        skillName: 'test-skill',
        skillMd: '# Test Skill',
        pattern: ['Read', 'Write'],
        confidence: 0.9,
        metadata: {
          generatedAt: new Date().toISOString(),
          tenantId: 'test-tenant',
          occurrences: 5,
        },
      };

      const testResults = {
        totalTests: 5,
        passed: 4,
        failed: 1,
        passRate: 0.8,
        results: [],
      };

      // @ts-expect-error - mocking
      generator.s3.send = mock(() => Promise.resolve({}));
      // @ts-expect-error - mocking
      generator.ddb.send = mock(() => Promise.resolve({}));

      const result = await generator.publishSkill({
        tenantId: 'test-tenant',
        skill,
        testResults,
      });

      expect(result.skillId).toBeTruthy();
      expect(result.s3Key).toContain('test-tenant');
      expect(result.s3Key).toContain('test-skill');
    });

    it('should include test results in DynamoDB metadata', async () => {
      const skill: GeneratedSkill = {
        skillName: 'skill-with-tests',
        skillMd: '# Skill',
        pattern: ['Tool1'],
        confidence: 0.95,
        metadata: {
          generatedAt: new Date().toISOString(),
          tenantId: 'tenant-456',
          occurrences: 10,
        },
      };

      const testResults = {
        totalTests: 10,
        passed: 9,
        failed: 1,
        passRate: 0.9,
        results: [],
      };

      let capturedItem: any;

      // @ts-expect-error - mocking
      generator.s3.send = mock(() => Promise.resolve({}));
      // @ts-expect-error - mocking
      generator.ddb.send = mock((command: any) => {
        if (command.constructor.name === 'PutCommand') {
          capturedItem = command.input.Item;
        }
        return Promise.resolve({});
      });

      await generator.publishSkill({
        tenantId: 'tenant-456',
        skill,
        testResults,
      });

      expect(capturedItem.testResults.passRate).toBe(0.9);
      expect(capturedItem.testResults.passed).toBe(9);
    });
  });

  describe('getAutoGeneratedSkills', () => {
    it('should retrieve skills for tenant', async () => {
      const mockSkills = [
        {
          skillName: 'skill-1',
          pattern: ['Read', 'Write'],
          confidence: 0.9,
          metadata: { tenantId: 'test-tenant', generatedAt: '2026-01-01' },
        },
        {
          skillName: 'skill-2',
          pattern: ['Bash'],
          confidence: 0.85,
          metadata: { tenantId: 'test-tenant', generatedAt: '2026-01-02' },
        },
      ];

      // @ts-expect-error - mocking
      generator.ddb.send = mock(() =>
        Promise.resolve({ Items: mockSkills })
      );

      const result = await generator.getAutoGeneratedSkills('test-tenant');

      expect(result).toHaveLength(2);
      expect(result[0].skillName).toBe('skill-1');
      expect(result[1].skillName).toBe('skill-2');
    });

    it('should handle empty results', async () => {
      // @ts-expect-error - mocking
      generator.ddb.send = mock(() => Promise.resolve({ Items: [] }));

      const result = await generator.getAutoGeneratedSkills('empty-tenant');

      expect(result).toHaveLength(0);
    });
  });

  describe('confidence calculation', () => {
    it('should compute higher confidence for frequent patterns', async () => {
      // Test the private computePatternConfidence method indirectly
      const mockSessions = (count: number, pattern: string[]) =>
        Array.from({ length: count }, () => ({
          conversationLog: JSON.stringify([
            {
              role: 'assistant',
              toolCalls: pattern.map((name) => ({ name })),
            },
          ]),
        }));

      // High frequency pattern (5 out of 10 sessions)
      // @ts-expect-error - mocking
      generator.ddb.send = mock(() =>
        Promise.resolve({
          Items: [
            ...mockSessions(5, ['Read', 'Edit']),
            ...mockSessions(5, ['Other', 'Tools']),
          ],
        })
      );

      const highFreqResult = await generator.detectRepeatedPatterns({
        tenantId: 'test',
        minOccurrences: 3,
      });

      // Low frequency pattern (3 out of 100 sessions)
      // @ts-expect-error - mocking
      generator.ddb.send = mock(() =>
        Promise.resolve({
          Items: [
            ...mockSessions(3, ['Read', 'Edit']),
            ...mockSessions(97, ['Other', 'Tools']),
          ],
        })
      );

      const lowFreqResult = await generator.detectRepeatedPatterns({
        tenantId: 'test',
        minOccurrences: 3,
      });

      const highConf = highFreqResult.topPatterns.find((p) =>
        p.pattern.includes('Read')
      )?.confidence;
      const lowConf = lowFreqResult.topPatterns.find((p) =>
        p.pattern.includes('Read')
      )?.confidence;

      if (highConf && lowConf) {
        expect(highConf).toBeGreaterThan(lowConf);
      }
    });
  });
});
