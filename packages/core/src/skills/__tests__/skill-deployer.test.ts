/**
 * Skill Deployer Tests
 *
 * Tests for stage 7 of skill security pipeline
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  SkillDeployer,
  type SkillDeployerConfig,
  type SkillDeploymentMetadata,
} from '../scanners/skill-deployer';

describe('SkillDeployer', () => {
  let deployer: SkillDeployer;
  let skillBundle: Map<string, string>;
  let metadata: SkillDeploymentMetadata;

  beforeEach(() => {
    deployer = new SkillDeployer();

    // Create mock skill bundle
    skillBundle = new Map([
      [
        'SKILL.md',
        `---
name: test-skill
version: 1.0.0
---
# Test Skill
A test skill for deployment.`,
      ],
      [
        'tool.ts',
        `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}`,
      ],
    ]);

    // Create mock metadata
    metadata = {
      name: 'test-skill',
      version: '1.0.0',
      author: 'test-author',
      description: 'A test skill for deployment',
      category: 'developer-tools',
      tags: ['test', 'example'],
      trust_level: 'community',
      permissions_hash: 'sha256-abc123',
      signatures: {
        author: 'ed25519-author-sig',
        platform: 'ed25519-platform-sig',
      },
    };
  });

  describe('Successful Deployment', () => {
    it('should deploy skill to S3 and DynamoDB', async () => {
      const result = await deployer.deploySkill(skillBundle, metadata);

      expect(result.passed).toBe(true);
      expect(result.status).toBe('success');
      expect(result.skill_name).toBe('test-skill');
      expect(result.version).toBe('1.0.0');
      expect(result.s3_key).toBeDefined();
      expect(result.dynamodb_key).toBeDefined();
      expect(result.bundle_sha256).toBeDefined();
      expect(result.deployed_at).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('should generate correct S3 key', async () => {
      const result = await deployer.deploySkill(skillBundle, metadata);

      expect(result.s3_key).toBe('skills/test-skill/1.0.0/bundle.tar.gz');
    });

    it('should generate correct DynamoDB keys', async () => {
      const result = await deployer.deploySkill(skillBundle, metadata);

      expect(result.dynamodb_key?.PK).toBe('SKILL#test-skill');
      expect(result.dynamodb_key?.SK).toBe('VERSION#1.0.0');
    });

    it('should calculate bundle SHA256', async () => {
      const result = await deployer.deploySkill(skillBundle, metadata);

      expect(result.bundle_sha256).toBeDefined();
      expect(result.bundle_sha256?.startsWith('mock-sha256-')).toBe(true);
    });
  });

  describe('Validation', () => {
    it('should fail if SKILL.md is missing', async () => {
      const invalidBundle = new Map([['tool.ts', 'export function test() {}']]);

      const result = await deployer.deploySkill(invalidBundle, metadata);

      expect(result.passed).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('missing SKILL.md');
    });

    it('should fail if name is missing', async () => {
      const invalidMetadata = {
        ...metadata,
        name: '',
      };

      const result = await deployer.deploySkill(skillBundle, invalidMetadata);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('missing name');
    });

    it('should fail if version is missing', async () => {
      const invalidMetadata = {
        ...metadata,
        version: '',
      };

      const result = await deployer.deploySkill(skillBundle, invalidMetadata);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('missing');
    });

    it('should fail if version is not semver', async () => {
      const invalidMetadata = {
        ...metadata,
        version: '1.0', // Invalid: not semver
      };

      const result = await deployer.deploySkill(skillBundle, invalidMetadata);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('Invalid version format');
    });

    it('should accept valid semver versions', async () => {
      const versions = ['1.0.0', '2.5.3', '0.0.1', '10.20.30', '1.0.0-alpha', '2.0.0-beta.1'];

      for (const version of versions) {
        const versionMetadata = { ...metadata, version };
        const result = await deployer.deploySkill(skillBundle, versionMetadata);

        expect(result.passed).toBe(true);
      }
    });

    it('should reject invalid semver versions', async () => {
      const invalidVersions = ['1.0', '1', 'v1.0.0', '1.0.0.0', 'latest'];

      for (const version of invalidVersions) {
        const versionMetadata = { ...metadata, version };
        const result = await deployer.deploySkill(skillBundle, versionMetadata);

        expect(result.passed).toBe(false);
        expect(result.error).toContain('Invalid version format');
      }
    });

    it('should fail if bundle exceeds size limit', async () => {
      // Create a bundle > 50MB
      const largeContent = 'x'.repeat(51 * 1024 * 1024); // 51 MB
      const largeBundle = new Map([
        ['SKILL.md', '# Test'],
        ['large-file.txt', largeContent],
      ]);

      const result = await deployer.deploySkill(largeBundle, metadata);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('exceeds limit');
    });

    it('should accept bundles under size limit', async () => {
      // Create a bundle < 50MB
      const smallContent = 'x'.repeat(1024 * 1024); // 1 MB
      const smallBundle = new Map([
        ['SKILL.md', '# Test'],
        ['file.txt', smallContent],
      ]);

      const result = await deployer.deploySkill(smallBundle, metadata);

      expect(result.passed).toBe(true);
    });
  });

  describe('Dry Run Mode', () => {
    it('should validate without deploying in dry run mode', async () => {
      const dryRunDeployer = new SkillDeployer({ dryRun: true });

      const result = await dryRunDeployer.deploySkill(skillBundle, metadata);

      expect(result.passed).toBe(true);
      expect(result.status).toBe('success');
      expect(result.s3_key).toBeUndefined();
      expect(result.dynamodb_key).toBeUndefined();
      expect(result.bundle_sha256).toBeUndefined();
    });

    it('should detect validation errors in dry run mode', async () => {
      const dryRunDeployer = new SkillDeployer({ dryRun: true });
      const invalidBundle = new Map([['tool.ts', 'code']]); // Missing SKILL.md

      const result = await dryRunDeployer.deploySkill(invalidBundle, metadata);

      expect(result.passed).toBe(false);
      expect(result.error).toContain('missing SKILL.md');
    });
  });

  describe('Configuration', () => {
    it('should use custom S3 bucket', async () => {
      const customDeployer = new SkillDeployer({
        s3Bucket: 'custom-bucket',
        s3KeyPrefix: 'custom-prefix/',
      });

      const result = await customDeployer.deploySkill(skillBundle, metadata);

      expect(result.s3_key).toContain('custom-prefix/');
    });

    it('should use custom DynamoDB table', async () => {
      const customDeployer = new SkillDeployer({
        dynamoDbTable: 'custom-skills-table',
      });

      const result = await customDeployer.deploySkill(skillBundle, metadata);

      expect(result.passed).toBe(true);
      // Table name is used internally, not visible in result
    });

    it('should use custom region', async () => {
      const customDeployer = new SkillDeployer({
        region: 'us-west-2',
      });

      const result = await customDeployer.deploySkill(skillBundle, metadata);

      expect(result.passed).toBe(true);
    });

    it('should support CloudFront cache invalidation', async () => {
      const cfDeployer = new SkillDeployer({
        cloudFrontDistributionId: 'E1234567890ABC',
      });

      const result = await cfDeployer.deploySkill(skillBundle, metadata);

      expect(result.passed).toBe(true);
      // Cache invalidation happens in postDeploymentTasks
    });

    it('should support SNS notifications', async () => {
      const snsDeployer = new SkillDeployer({
        notificationTopicArn: 'arn:aws:sns:us-east-1:123456789012:skill-deploys',
      });

      const result = await snsDeployer.deploySkill(skillBundle, metadata);

      expect(result.passed).toBe(true);
      // SNS publish happens in postDeploymentTasks
    });
  });

  describe('Rollback', () => {
    it('should rollback deployed skill', async () => {
      const result = await deployer.rollbackSkill('test-skill', '1.0.0');

      expect(result.passed).toBe(true);
      expect(result.status).toBe('rolled-back');
      expect(result.skill_name).toBe('test-skill');
      expect(result.version).toBe('1.0.0');
      expect(result.deployed_at).toBeDefined();
    });

    it('should handle rollback errors gracefully', async () => {
      // Rollback of non-existent skill should not throw
      const result = await deployer.rollbackSkill('non-existent-skill', '1.0.0');

      expect(result.passed).toBe(true);
      expect(result.status).toBe('rolled-back');
    });

    it('should rollback on deployment failure if enabled', async () => {
      const rollbackDeployer = new SkillDeployer({
        enableRollback: true,
      });

      // Force deployment failure with invalid bundle
      const invalidBundle = new Map([['tool.ts', 'code']]); // Missing SKILL.md
      const result = await rollbackDeployer.deploySkill(invalidBundle, metadata);

      expect(result.passed).toBe(false);
      expect(result.status).toBe('failed');
      // Rollback happens silently in background
    });

    it('should skip rollback if disabled', async () => {
      const noRollbackDeployer = new SkillDeployer({
        enableRollback: false,
      });

      const invalidBundle = new Map([['tool.ts', 'code']]);
      const result = await noRollbackDeployer.deploySkill(invalidBundle, metadata);

      expect(result.passed).toBe(false);
      // No rollback attempted
    });
  });

  describe('Deployment Check', () => {
    it('should check if skill is deployed', async () => {
      const isDeployed = await deployer.isDeployed('test-skill', '1.0.0');

      // Mock returns false
      expect(isDeployed).toBe(false);
    });

    it('should handle different versions', async () => {
      const v1Deployed = await deployer.isDeployed('test-skill', '1.0.0');
      const v2Deployed = await deployer.isDeployed('test-skill', '2.0.0');

      expect(v1Deployed).toBe(false);
      expect(v2Deployed).toBe(false);
    });
  });

  describe('Multiple Deployments', () => {
    it('should deploy multiple versions of same skill', async () => {
      const v1Metadata = { ...metadata, version: '1.0.0' };
      const v2Metadata = { ...metadata, version: '2.0.0' };

      const result1 = await deployer.deploySkill(skillBundle, v1Metadata);
      const result2 = await deployer.deploySkill(skillBundle, v2Metadata);

      expect(result1.passed).toBe(true);
      expect(result2.passed).toBe(true);
      expect(result1.s3_key).toContain('1.0.0');
      expect(result2.s3_key).toContain('2.0.0');
      expect(result1.dynamodb_key?.SK).toBe('VERSION#1.0.0');
      expect(result2.dynamodb_key?.SK).toBe('VERSION#2.0.0');
    });

    it('should deploy different skills independently', async () => {
      const skill1Metadata = { ...metadata, name: 'skill-1' };
      const skill2Metadata = { ...metadata, name: 'skill-2' };

      const result1 = await deployer.deploySkill(skillBundle, skill1Metadata);
      const result2 = await deployer.deploySkill(skillBundle, skill2Metadata);

      expect(result1.passed).toBe(true);
      expect(result2.passed).toBe(true);
      expect(result1.s3_key).toContain('skill-1');
      expect(result2.s3_key).toContain('skill-2');
      expect(result1.dynamodb_key?.PK).toBe('SKILL#skill-1');
      expect(result2.dynamodb_key?.PK).toBe('SKILL#skill-2');
    });
  });

  describe('Bundle Content', () => {
    it('should handle skill bundles with multiple files', async () => {
      const multiFileBundle = new Map([
        ['SKILL.md', '# Multi-file skill'],
        ['tool.ts', 'export function tool1() {}'],
        ['helper.ts', 'export function helper() {}'],
        ['README.md', '# Documentation'],
        ['tests/test.ts', 'import { test } from "bun:test";'],
      ]);

      const result = await deployer.deploySkill(multiFileBundle, metadata);

      expect(result.passed).toBe(true);
      expect(result.bundle_sha256).toBeDefined();
    });

    it('should handle empty tool files', async () => {
      const emptyToolBundle = new Map([
        ['SKILL.md', '# Skill with empty tool'],
        ['tool.ts', ''],
      ]);

      const result = await deployer.deploySkill(emptyToolBundle, metadata);

      expect(result.passed).toBe(true);
    });

    it('should handle skills with only SKILL.md', async () => {
      const minimalBundle = new Map([['SKILL.md', '# Minimal skill']]);

      const result = await deployer.deploySkill(minimalBundle, metadata);

      expect(result.passed).toBe(true);
    });
  });

  describe('Trust Levels', () => {
    it('should deploy platform skills', async () => {
      const platformMetadata = { ...metadata, trust_level: 'platform' as const };

      const result = await deployer.deploySkill(skillBundle, platformMetadata);

      expect(result.passed).toBe(true);
    });

    it('should deploy verified skills', async () => {
      const verifiedMetadata = { ...metadata, trust_level: 'verified' as const };

      const result = await deployer.deploySkill(skillBundle, verifiedMetadata);

      expect(result.passed).toBe(true);
    });

    it('should deploy community skills', async () => {
      const communityMetadata = { ...metadata, trust_level: 'community' as const };

      const result = await deployer.deploySkill(skillBundle, communityMetadata);

      expect(result.passed).toBe(true);
    });

    it('should deploy private skills', async () => {
      const privateMetadata = { ...metadata, trust_level: 'private' as const };

      const result = await deployer.deploySkill(skillBundle, privateMetadata);

      expect(result.passed).toBe(true);
    });

    it('should deploy experimental skills', async () => {
      const experimentalMetadata = { ...metadata, trust_level: 'experimental' as const };

      const result = await deployer.deploySkill(skillBundle, experimentalMetadata);

      expect(result.passed).toBe(true);
    });
  });

  describe('Metadata Handling', () => {
    it('should handle skills without signatures', async () => {
      const noSigMetadata = {
        ...metadata,
        signatures: undefined,
      };

      const result = await deployer.deploySkill(skillBundle, noSigMetadata);

      expect(result.passed).toBe(true);
    });

    it('should handle skills with partial signatures', async () => {
      const partialSigMetadata = {
        ...metadata,
        signatures: {
          author: 'ed25519-author-sig',
          // platform signature missing
        },
      };

      const result = await deployer.deploySkill(skillBundle, partialSigMetadata);

      expect(result.passed).toBe(true);
    });

    it('should handle long descriptions', async () => {
      const longDescMetadata = {
        ...metadata,
        description: 'x'.repeat(1000), // 1000 char description
      };

      const result = await deployer.deploySkill(skillBundle, longDescMetadata);

      expect(result.passed).toBe(true);
    });

    it('should handle many tags', async () => {
      const manyTagsMetadata = {
        ...metadata,
        tags: Array.from({ length: 50 }, (_, i) => `tag${i}`),
      };

      const result = await deployer.deploySkill(skillBundle, manyTagsMetadata);

      expect(result.passed).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should return error details on failure', async () => {
      const invalidBundle = new Map([['tool.ts', 'code']]);

      const result = await deployer.deploySkill(invalidBundle, metadata);

      expect(result.passed).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toBeTruthy();
    });

    it('should handle validation errors gracefully', async () => {
      const invalidMetadata = {
        ...metadata,
        version: 'invalid',
      };

      const result = await deployer.deploySkill(skillBundle, invalidMetadata);

      expect(result.passed).toBe(false);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('version');
    });
  });
});
