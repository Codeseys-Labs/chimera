/**
 * Manual Review Scanner Tests
 *
 * Tests for stage 6 of skill security pipeline
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ManualReviewScanner,
  type ManualReviewConfig,
  type SkillReviewMetadata,
} from '../scanners/manual-review';

describe('ManualReviewScanner', () => {
  let scanner: ManualReviewScanner;

  beforeEach(() => {
    scanner = new ManualReviewScanner();
  });

  describe('Platform/Verified Skills', () => {
    it('should auto-approve platform skills', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'aws-tool',
        version: '1.0.0',
        author: 'platform',
        trust_level: 'platform',
        category: 'cloud-ops',
        description: 'AWS SDK tool',
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.passed).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.criteria.auto_approve).toBe(true);
      expect(result.decision?.reason).toContain('Auto-approved');
    });

    it('should auto-approve verified skills', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'popular-skill',
        version: '2.0.0',
        author: 'verified-publisher',
        trust_level: 'verified',
        category: 'productivity',
        description: 'Verified publisher skill',
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.passed).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.criteria.auto_approve).toBe(true);
    });

    it('should skip auto-approval if config disabled', async () => {
      const strictScanner = new ManualReviewScanner({ autoApproveVerified: false });
      const metadata: SkillReviewMetadata = {
        name: 'platform-skill',
        version: '1.0.0',
        author: 'platform',
        trust_level: 'platform',
        category: 'cloud-ops',
        description: 'Platform skill',
      };

      const result = await strictScanner.evaluateSkill(metadata);

      expect(result.criteria.auto_approve).toBe(false);
    });
  });

  describe('Community Skills', () => {
    it('should require review for community skills', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'community-tool',
        version: '1.0.0',
        author: 'community-author',
        trust_level: 'community',
        category: 'developer-tools',
        description: 'Community contributed skill',
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.passed).toBe(false);
      expect(result.status).toBe('pending');
      expect(result.criteria.requires_review).toBe(true);
      expect(result.criteria.reasons).toContain('Community skill requires review');
      expect(result.queue_position).toBeDefined();
      expect(result.estimated_wait_minutes).toBeDefined();
    });

    it('should skip review for community skills if config disabled', async () => {
      const lenientScanner = new ManualReviewScanner({ requireCommunityReview: false });
      const metadata: SkillReviewMetadata = {
        name: 'community-tool',
        version: '1.0.0',
        author: 'community-author',
        trust_level: 'community',
        category: 'developer-tools',
        description: 'Community skill',
      };

      const result = await lenientScanner.evaluateSkill(metadata);

      expect(result.passed).toBe(true);
      expect(result.status).toBe('approved');
    });
  });

  describe('High-Privilege Permissions', () => {
    it('should require review for shell access', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'shell-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'automation',
        description: 'Skill with shell access',
        permissions: {
          shell: {
            allowed: ['ls', 'cat'],
          },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.passed).toBe(false);
      expect(result.status).toBe('pending');
      expect(result.criteria.reasons).toContain('Shell access requested');
      expect(result.criteria.priority).toBe('high');
    });

    it('should require review for network access', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'network-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'integration',
        description: 'Skill with network access',
        permissions: {
          network: true,
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.reasons).toContain('Network access requested');
      expect(result.criteria.requires_review).toBe(true);
    });

    it('should require review for network endpoints', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'api-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'integration',
        description: 'API integration skill',
        permissions: {
          network: {
            endpoints: ['https://api.example.com'],
          },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.reasons).toContain('Network access requested');
    });

    it('should require review for secrets access', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'secrets-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'security',
        description: 'Skill accessing secrets',
        permissions: {
          secrets: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret'],
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.reasons).toContain('Secrets access requested (1 secrets)');
      expect(result.criteria.priority).toBe('high');
    });

    it('should require review for filesystem write access', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'file-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'productivity',
        description: 'File manipulation skill',
        permissions: {
          filesystem: {
            write: ['**/*.txt'],
          },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.reasons).toContain('Filesystem write access requested');
    });
  });

  describe('Scanner Warnings', () => {
    it('should require review for static analysis findings', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'flagged-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'developer-tools',
        description: 'Skill with static analysis warnings',
        scan_result: {
          static_analysis: {
            passed: true, // Passed but with warnings
            findings: ['Medium severity: Large base64 string detected'],
          },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.reasons).toContain('Static analysis findings: 1');
      expect(result.criteria.priority).toBe('high');
    });

    it('should require urgent review for dependency vulnerabilities', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'vuln-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'developer-tools',
        description: 'Skill with vulnerable dependencies',
        scan_result: {
          dependency_audit: {
            passed: true, // Passed but with vulnerabilities
            vulnerabilities: ['CVE-2023-12345: Moderate severity in package@1.0.0'],
          },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.reasons).toContain('Dependency vulnerabilities: 1');
      expect(result.criteria.priority).toBe('urgent');
    });

    it('should require urgent review for sandbox violations', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'violation-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'automation',
        description: 'Skill with sandbox violations',
        scan_result: {
          sandbox_run: {
            passed: true, // Passed but with violations
            violations: ['Network access attempted'],
          },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.reasons).toContain('Sandbox violations: 1');
      expect(result.criteria.priority).toBe('urgent');
    });
  });

  describe('First-Time Authors', () => {
    it('should require review for first-time authors', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'new-author-skill',
        version: '1.0.0',
        author: 'new-author',
        trust_level: 'community',
        category: 'productivity',
        description: 'First skill from new author',
        is_first_time_author: true,
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.reasons).toContain('First-time author');
      expect(result.criteria.priority).toBe('high');
    });

    it('should elevate priority for first-time author with warnings', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'new-author-flagged',
        version: '1.0.0',
        author: 'new-author',
        trust_level: 'community',
        category: 'developer-tools',
        description: 'First-time author with findings',
        is_first_time_author: true,
        scan_result: {
          dependency_audit: {
            passed: true,
            vulnerabilities: ['CVE-2023-12345'],
          },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      // Should remain urgent due to vulnerabilities
      expect(result.criteria.priority).toBe('urgent');
    });
  });

  describe('Skip Review Mode', () => {
    it('should skip all reviews in skip mode', async () => {
      const testScanner = new ManualReviewScanner({ skipReview: true });
      const metadata: SkillReviewMetadata = {
        name: 'test-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'developer-tools',
        description: 'Test skill',
        permissions: {
          shell: { allowed: ['ls'] },
        },
        is_first_time_author: true,
      };

      const result = await testScanner.evaluateSkill(metadata);

      expect(result.passed).toBe(true);
      expect(result.status).toBe('skipped');
      expect(result.decision?.reason).toContain('testing mode');
    });
  });

  describe('Admin Actions', () => {
    it('should approve skill', async () => {
      const decision = await scanner.approveSkill(
        'test-skill',
        '1.0.0',
        'admin-user-123',
        'Looks good'
      );

      expect(decision.status).toBe('approved');
      expect(decision.reviewer).toBe('admin-user-123');
      expect(decision.reviewed_at).toBeDefined();
      expect(decision.notes).toBe('Looks good');
      expect(decision.reason).toContain('Manually approved');
    });

    it('should reject skill', async () => {
      const decision = await scanner.rejectSkill(
        'bad-skill',
        '1.0.0',
        'admin-user-456',
        'Security concerns'
      );

      expect(decision.status).toBe('rejected');
      expect(decision.reviewer).toBe('admin-user-456');
      expect(decision.reviewed_at).toBeDefined();
      expect(decision.reason).toBe('Security concerns');
    });

    it('should get pending reviews', async () => {
      const pending = await scanner.getPendingReviews();

      expect(Array.isArray(pending)).toBe(true);
      // Mock returns empty array
      expect(pending.length).toBe(0);
    });
  });

  describe('Priority Levels', () => {
    it('should assign normal priority for simple community skills', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'simple-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'productivity',
        description: 'Simple skill with no special permissions',
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.priority).toBe('normal');
    });

    it('should assign high priority for privileged skills', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'privileged-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'automation',
        description: 'Skill with shell access',
        permissions: {
          shell: { allowed: ['git'] },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.priority).toBe('high');
    });

    it('should assign urgent priority for security issues', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'security-issue-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'developer-tools',
        description: 'Skill with security findings',
        scan_result: {
          dependency_audit: {
            passed: false,
            vulnerabilities: ['CRITICAL: CVE-2024-00000'],
          },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.priority).toBe('urgent');
    });
  });

  describe('Wait Time Estimation', () => {
    it('should provide queue position and wait time estimate', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'queued-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'productivity',
        description: 'Queued skill',
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.queue_position).toBeDefined();
      expect(result.estimated_wait_minutes).toBeDefined();
      expect(result.estimated_wait_minutes).toBeGreaterThan(0);
    });

    it('should estimate shorter wait for urgent priority', async () => {
      const urgentMetadata: SkillReviewMetadata = {
        name: 'urgent-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'security',
        description: 'Urgent review needed',
        scan_result: {
          sandbox_run: {
            passed: false,
            violations: ['Critical violation'],
          },
        },
      };

      const normalMetadata: SkillReviewMetadata = {
        name: 'normal-skill',
        version: '1.0.0',
        author: 'author',
        trust_level: 'community',
        category: 'productivity',
        description: 'Normal review',
      };

      const urgentResult = await scanner.evaluateSkill(urgentMetadata);
      const normalResult = await scanner.evaluateSkill(normalMetadata);

      expect(urgentResult.estimated_wait_minutes).toBeLessThan(
        normalResult.estimated_wait_minutes!
      );
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle multiple review criteria', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'complex-skill',
        version: '1.0.0',
        author: 'new-author',
        trust_level: 'community',
        category: 'automation',
        description: 'Complex skill requiring review',
        is_first_time_author: true,
        permissions: {
          shell: { allowed: ['git', 'npm'] },
          network: true,
          secrets: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:api-key'],
        },
        scan_result: {
          static_analysis: {
            passed: true,
            findings: ['Medium: setTimeout with string'],
          },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.criteria.reasons.length).toBeGreaterThan(3);
      expect(result.criteria.reasons).toContain('First-time author');
      expect(result.criteria.reasons).toContain('Shell access requested');
      expect(result.criteria.reasons).toContain('Network access requested');
      expect(result.criteria.reasons).toContain('Secrets access requested (1 secrets)');
      expect(result.criteria.priority).toBe('high'); // High from secrets/shell/first-time
    });

    it('should not require review for low-privilege verified skills', async () => {
      const metadata: SkillReviewMetadata = {
        name: 'safe-verified-skill',
        version: '1.0.0',
        author: 'verified-publisher',
        trust_level: 'verified',
        category: 'productivity',
        description: 'Safe skill with minimal permissions',
        permissions: {
          filesystem: {
            read: ['*.md'],
          },
        },
      };

      const result = await scanner.evaluateSkill(metadata);

      expect(result.passed).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.criteria.auto_approve).toBe(true);
    });
  });
});
