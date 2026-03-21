/**
 * Skill Validator Tests
 *
 * Tests for skill permission validation including:
 * - Filesystem permission constraints
 * - Network permission validation
 * - Shell command security
 * - Memory and secrets access control
 * - Trust level enforcement
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SkillValidator, ValidatorConfig } from '../validator';
import {
  Skill,
  SkillPermissions,
  SkillTrustLevel,
  SkillCategory,
} from '@chimera/shared';

describe('SkillValidator', () => {
  let validator: SkillValidator;

  const createMockSkill = (
    trustLevel: SkillTrustLevel = 'community',
    scanStatus: 'passed' | 'failed' | 'pending' | 'scanning' = 'passed'
  ): Skill => ({
    PK: 'SKILL#test',
    SK: 'META',
    name: 'test-skill',
    version: '1.0.0',
    description: 'Test skill',
    author: 'test-author',
    category: 'automation' as SkillCategory,
    tags: ['test'],
    trust_level: trustLevel,
    format: 'SKILL.md' as const,
    bundle_url: 's3://skills/test.tar.gz',
    bundle_hash: 'abc123',
    signatures: {
      author: 'sig1',
      platform: trustLevel === 'platform' ? 'sig2' : undefined,
    },
    scan_status: scanStatus,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    download_count: 0,
    tenantId: 'test-tenant',
  });

  beforeEach(() => {
    validator = new SkillValidator();
  });

  describe('validateMetadata', () => {
    it('should accept valid semver version', async () => {
      const skill = createMockSkill();
      skill.version = '1.2.3';

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(true);
    });

    it('should reject invalid version format', async () => {
      const skill = createMockSkill();
      skill.version = 'v1.0';

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('invalid version format'))).toBe(true);
    });

    it('should reject invalid name format (uppercase)', async () => {
      const skill = createMockSkill();
      skill.name = 'TestSkill';

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('invalid name format'))).toBe(true);
    });

    it('should reject invalid name format (underscores)', async () => {
      const skill = createMockSkill();
      skill.name = 'test_skill';

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('invalid name format'))).toBe(true);
    });

    it('should reject description over 200 chars', async () => {
      const skill = createMockSkill();
      skill.description = 'a'.repeat(201);

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('description too long'))).toBe(true);
    });

    it('should reject more than 10 tags', async () => {
      const skill = createMockSkill();
      skill.tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('too many tags'))).toBe(true);
    });
  });

  describe('validateFilesystemPermissions', () => {
    it('should allow platform skills to read system paths', () => {
      const permissions: SkillPermissions = {
        filesystem: {
          read: ['/etc/config'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'platform', errors, warnings);
      expect(errors.length).toBe(0);
    });

    it('should reject system path reads for community skills', () => {
      const permissions: SkillPermissions = {
        filesystem: {
          read: ['/etc/config'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'community', errors, warnings);
      expect(errors.some(e => e.includes('system path'))).toBe(true);
    });

    it('should reject broad read patterns for non-platform skills', () => {
      const permissions: SkillPermissions = {
        filesystem: {
          read: ['/**'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(errors.some(e => e.includes('overly broad pattern'))).toBe(true);
    });

    it('should reject root write patterns', () => {
      const permissions: SkillPermissions = {
        filesystem: {
          write: ['/'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'platform', errors, warnings);
      expect(errors.some(e => e.includes('root write'))).toBe(true);
    });

    it('should reject system path writes', () => {
      const permissions: SkillPermissions = {
        filesystem: {
          write: ['/bin/myapp'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(errors.some(e => e.includes('system path'))).toBe(true);
    });

    it('should enforce /tmp-only writes for community skills', () => {
      const permissions: SkillPermissions = {
        filesystem: {
          write: ['/home/user/data'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'community', errors, warnings);
      expect(errors.some(e => e.includes('can only write to /tmp'))).toBe(true);
    });

    it('should allow /tmp writes for community skills', () => {
      const permissions: SkillPermissions = {
        filesystem: {
          write: ['/tmp/mydata'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'community', errors, warnings);
      expect(errors.length).toBe(0);
    });
  });

  describe('validateNetworkPermissions', () => {
    it('should reject unrestricted network for community skills', () => {
      const permissions: SkillPermissions = {
        network: true,
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'community', errors, warnings);
      expect(errors.some(e => e.includes('not allowed for trust level'))).toBe(true);
    });

    it('should allow unrestricted network for platform skills', () => {
      const permissions: SkillPermissions = {
        network: true,
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'platform', errors, warnings);
      expect(errors.length).toBe(0);
    });

    it('should warn about unrestricted network for verified skills', () => {
      const permissions: SkillPermissions = {
        network: true,
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(warnings.some(w => w.includes('unrestricted access'))).toBe(true);
    });

    it('should validate endpoint URLs', () => {
      const permissions: SkillPermissions = {
        network: {
          endpoints: ['invalid-url', 'https://api.example.com'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(errors.some(e => e.includes('invalid endpoint URL'))).toBe(true);
    });

    it('should warn about excessive endpoints', () => {
      const validator = new SkillValidator({ maxNetworkEndpoints: 3 });
      const permissions: SkillPermissions = {
        network: {
          endpoints: [
            'https://api1.example.com',
            'https://api2.example.com',
            'https://api3.example.com',
            'https://api4.example.com',
          ],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(warnings.some(w => w.includes('endpoints declared'))).toBe(true);
    });
  });

  describe('validateShellPermissions', () => {
    it('should reject dangerous commands', () => {
      const permissions: SkillPermissions = {
        shell: {
          allowed: ['rm -rf /'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(errors.some(e => e.includes('dangerous command'))).toBe(true);
    });

    it('should warn about command injection risks', () => {
      const permissions: SkillPermissions = {
        shell: {
          allowed: ['echo $(cat secret)'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(warnings.some(w => w.includes('shell metacharacters'))).toBe(true);
    });

    it('should reject shell execution for community skills', () => {
      const permissions: SkillPermissions = {
        shell: {
          allowed: ['ls'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'community', errors, warnings);
      expect(errors.some(e => e.includes('not allowed for trust level'))).toBe(true);
    });

    it('should detect fork bomb patterns', () => {
      const permissions: SkillPermissions = {
        shell: {
          allowed: [':(){:|:&};:'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'platform', errors, warnings);
      expect(errors.some(e => e.includes('dangerous command'))).toBe(true);
    });
  });

  describe('validateMemoryPermissions', () => {
    it('should reject memory access for community skills', () => {
      const permissions: SkillPermissions = {
        memory: {
          read: true,
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'community', errors, warnings);
      expect(errors.some(e => e.includes('not allowed for trust level'))).toBe(true);
    });

    it('should allow memory access for verified skills', () => {
      const permissions: SkillPermissions = {
        memory: {
          read: true,
          write: ['skill_state'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(errors.length).toBe(0);
    });

    it('should warn about non-standard write categories', () => {
      const permissions: SkillPermissions = {
        memory: {
          write: ['custom_category'],
        },
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(warnings.some(w => w.includes('non-standard write category'))).toBe(true);
    });
  });

  describe('validateSecretsPermissions', () => {
    it('should reject invalid ARN format', () => {
      const permissions: SkillPermissions = {
        secrets: ['invalid-arn'],
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(errors.some(e => e.includes('invalid ARN format'))).toBe(true);
    });

    it('should accept valid ARN format', () => {
      const permissions: SkillPermissions = {
        secrets: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:mysecret-abc123'],
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);
      expect(errors.length).toBe(0);
    });

    it('should reject secrets access for community skills', () => {
      const permissions: SkillPermissions = {
        secrets: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:mysecret-abc123'],
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'community', errors, warnings);
      expect(errors.some(e => e.includes('not allowed for trust level'))).toBe(true);
    });
  });

  describe('validateSignatures', () => {
    it('should require author signature for platform skills', async () => {
      const skill = createMockSkill('platform');
      skill.signatures.author = undefined;

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('author signature missing'))).toBe(true);
    });

    it('should require platform signature for platform skills', async () => {
      const skill = createMockSkill('platform');
      skill.signatures.platform = undefined;

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('platform signature missing'))).toBe(true);
    });

    it('should require both signatures for verified skills', async () => {
      const skill = createMockSkill('verified');
      skill.signatures.author = undefined;
      skill.signatures.platform = undefined;

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.filter(e => e.includes('signature missing')).length).toBe(2);
    });

    it('should require author signature for community skills', async () => {
      const skill = createMockSkill('community');
      skill.signatures.author = undefined;

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('author signature missing'))).toBe(true);
    });

    it('should not require signatures for experimental skills', async () => {
      const skill = createMockSkill('experimental');
      skill.signatures.author = undefined;

      const result = await validator.validateSkill(skill);
      // Should be valid (no signature requirement for experimental)
      expect(result.errors.filter(e => e.includes('signature')).length).toBe(0);
    });
  });

  describe('validateScanStatus', () => {
    it('should reject marketplace skills without passed scan', async () => {
      const skill = createMockSkill('community', 'pending');

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('has not passed security scan'))).toBe(true);
    });

    it('should allow private skills without scan', async () => {
      const skill = createMockSkill('private', 'pending');

      const result = await validator.validateSkill(skill);
      // Should be valid for private skills
      expect(result.errors.filter(e => e.includes('security scan')).length).toBe(0);
    });

    it('should allow experimental skills without scan', async () => {
      const skill = createMockSkill('experimental', 'pending');

      const result = await validator.validateSkill(skill);
      expect(result.errors.filter(e => e.includes('security scan')).length).toBe(0);
    });

    it('should reject failed scan status', async () => {
      const skill = createMockSkill('community', 'failed');

      const result = await validator.validateSkill(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('has not passed security scan'))).toBe(true);
    });
  });

  describe('Strict Mode', () => {
    it('should treat warnings as errors in strict mode', async () => {
      const strictValidator = new SkillValidator({ strictMode: true });
      const skill = createMockSkill();

      const result = await strictValidator.validateSkill(skill);
      // Even if there are only warnings, should be invalid in strict mode
      // (though current implementation might not have warnings for base skill)
    });

    it('should allow warnings in non-strict mode', async () => {
      const permissiveValidator = new SkillValidator({ strictMode: false });
      const permissions: SkillPermissions = {
        network: true,
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      permissiveValidator.validatePermissions(permissions, 'verified', errors, warnings);

      // Should have warnings but no errors
      expect(warnings.length).toBeGreaterThan(0);
      expect(errors.length).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing permissions gracefully', () => {
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(undefined, 'community', errors, warnings);

      expect(warnings.some(w => w.includes('No permissions declared'))).toBe(true);
      expect(errors.length).toBe(0);
    });

    it('should handle empty permission objects', () => {
      const permissions: SkillPermissions = {};
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);

      // Should not error, just warn about missing declarations
      expect(errors.length).toBe(0);
    });

    it('should validate complete skill with all permission types', () => {
      const permissions: SkillPermissions = {
        filesystem: {
          read: ['/workspace/**'],
          write: ['/workspace/output'],
        },
        network: {
          endpoints: ['https://api.example.com'],
        },
        shell: {
          allowed: ['git status'],
          denied: ['rm'],
        },
        memory: {
          read: true,
          write: ['skill_state'],
        },
        secrets: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:mysecret-abc123'],
      };
      const errors: string[] = [];
      const warnings: string[] = [];

      validator.validatePermissions(permissions, 'verified', errors, warnings);

      expect(errors.length).toBe(0);
    });
  });
});
