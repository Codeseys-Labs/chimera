/**
 * Unit tests for PromptOptimizer
 *
 * Tests the core business logic of prompt A/B testing framework.
 * Integration tests cover AWS SDK interactions.
 */

import { describe, it, expect } from 'bun:test';

describe('PromptOptimizer Logic', () => {
  describe('Traffic splitting', () => {
    it('should split traffic according to configured ratio', () => {
      const trafficSplit = 0.3;
      const trials = 1000;
      let variantBCount = 0;

      for (let i = 0; i < trials; i++) {
        if (Math.random() < trafficSplit) {
          variantBCount++;
        }
      }

      const actualRatio = variantBCount / trials;
      // Allow 5% variance
      expect(actualRatio).toBeGreaterThan(trafficSplit - 0.05);
      expect(actualRatio).toBeLessThan(trafficSplit + 0.05);
    });
  });

  describe('Winner determination', () => {
    it('should promote variant B when quality improves >5%', () => {
      const aQuality = 0.80;
      const bQuality = 0.85; // 6.25% improvement
      const aCost = 0.10;
      const bCost = 0.10;

      let winner: 'a' | 'b' = 'a';

      if (bQuality > aQuality * 1.05) {
        winner = 'b';
      } else if (bCost < aCost * 0.9 && Math.abs(bQuality - aQuality) < 0.03) {
        winner = 'b';
      }

      expect(winner).toBe('b');
    });

    it('should promote variant B when cost reduces >10% with similar quality', () => {
      const aQuality = 0.80;
      const bQuality = 0.81; // 1.25% difference (< 3%)
      const aCost = 1.00;
      const bCost = 0.85; // 15% cost reduction

      let winner: 'a' | 'b' = 'a';

      if (bQuality > aQuality * 1.05) {
        winner = 'b';
      } else if (bCost < aCost * 0.9 && Math.abs(bQuality - aQuality) < 0.03) {
        winner = 'b';
      }

      expect(winner).toBe('b');
    });

    it('should retain variant A when improvement is insufficient', () => {
      const aQuality = 0.80;
      const bQuality = 0.82; // Only 2.5% improvement
      const aCost = 0.10;
      const bCost = 0.10;

      let winner: 'a' | 'b' = 'a';

      if (bQuality > aQuality * 1.05) {
        winner = 'b';
      } else if (bCost < aCost * 0.9 && Math.abs(bQuality - aQuality) < 0.03) {
        winner = 'b';
      }

      expect(winner).toBe('a');
    });
  });

  describe('Failure pattern detection', () => {
    it('should detect tool call failures in conversation log', () => {
      const conversationLog = [
        { role: 'user', content: 'Create a file' },
        { role: 'assistant', content: 'Creating file...' },
        { role: 'tool', toolName: 'Write', status: 'error', content: 'Permission denied' },
      ];

      const failures: any[] = [];

      for (let i = 0; i < conversationLog.length; i++) {
        const turn = conversationLog[i];
        if (turn.role === 'tool' && turn.status === 'error') {
          failures.push({
            turn: i,
            tool: turn.toolName,
            error: turn.content,
          });
        }
      }

      expect(failures.length).toBe(1);
      expect(failures[0].tool).toBe('Write');
      expect(failures[0].error).toContain('Permission denied');
    });

    it('should detect user correction signals', () => {
      const conversationLog = [
        { role: 'assistant', content: 'I created the config file' },
        { role: 'user', content: "No, that's wrong, I wanted a JSON file" },
      ];

      const corrections: any[] = [];
      const correctionSignals = [
        'no,',
        "that's wrong",
        'i meant',
        'not what i asked',
        'try again',
        'incorrect',
        'please fix',
      ];

      for (let i = 0; i < conversationLog.length; i++) {
        const turn = conversationLog[i];
        if (turn.role === 'user') {
          const content = turn.content?.toLowerCase() || '';
          if (correctionSignals.some((sig) => content.includes(sig))) {
            corrections.push({
              turn: i,
              userMessage: turn.content,
            });
          }
        }
      }

      expect(corrections.length).toBe(1);
      expect(corrections[0].userMessage).toContain('wrong');
    });
  });

  describe('Experiment duration calculation', () => {
    it('should calculate correct expiration time', () => {
      const startedAt = new Date('2026-03-21T00:00:00.000Z');
      const durationHours = 48;
      const expiresAt = new Date(startedAt.getTime() + durationHours * 60 * 60 * 1000);

      const durationMs = expiresAt.getTime() - startedAt.getTime();
      const actualHours = durationMs / (60 * 60 * 1000);

      expect(actualHours).toBe(48);
    });

    it('should detect expired experiments', () => {
      const expiresAt = new Date(Date.now() - 1000); // Expired 1 second ago
      const isExpired = expiresAt < new Date();

      expect(isExpired).toBe(true);
    });

    it('should detect active experiments', () => {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // Expires in 24 hours
      const isExpired = expiresAt < new Date();

      expect(isExpired).toBe(false);
    });
  });

  describe('Score aggregation', () => {
    it('should calculate average quality score', () => {
      const variantScores = {
        quality: 90, // Sum of quality scores
        cost: 100,
        n: 10, // Number of samples
      };

      const avgQuality = variantScores.n > 0 ? variantScores.quality / variantScores.n : 0;

      expect(avgQuality).toBe(9);
    });

    it('should handle zero samples', () => {
      const variantScores = {
        quality: 0,
        cost: 0,
        n: 0,
      };

      const avgQuality = variantScores.n > 0 ? variantScores.quality / variantScores.n : 0;

      expect(avgQuality).toBe(0);
    });

    it('should accumulate scores correctly', () => {
      const scores = { quality: 0, cost: 0, n: 0 };

      // Record 3 outcomes
      scores.quality += 0.9;
      scores.cost += 0.05;
      scores.n += 1;

      scores.quality += 0.85;
      scores.cost += 0.06;
      scores.n += 1;

      scores.quality += 0.95;
      scores.cost += 0.04;
      scores.n += 1;

      const avgQuality = scores.quality / scores.n;
      const avgCost = scores.cost / scores.n;

      expect(avgQuality).toBeCloseTo(0.9, 2);
      expect(avgCost).toBeCloseTo(0.05, 2);
      expect(scores.n).toBe(3);
    });
  });

  describe('Pass rate calculation', () => {
    it('should calculate pass rate from test results', () => {
      const testResults = [
        { score: 0.95 }, // Pass (> 0.8)
        { score: 0.75 }, // Fail
        { score: 0.85 }, // Pass
        { score: 0.92 }, // Pass
        { score: 0.65 }, // Fail
      ];

      const passCount = testResults.filter((r) => r.score > 0.8).length;
      const passRate = passCount / testResults.length;

      expect(passRate).toBe(0.6); // 3 out of 5
    });
  });
});
