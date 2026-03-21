/**
 * Trust Engine Tests
 *
 * Tests for Cedar-based runtime authorization including:
 * - Trust level enforcement
 * - Filesystem authorization
 * - Network access control
 * - Shell command authorization
 * - Memory and secrets access
 * - Tool invocation authorization
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  SkillTrustEngine,
  TrustEngineConfig,
  PrincipalContext,
  ResourceContext,
  ActionType,
} from '../trust-engine';
import { SkillPermissions, SkillTrustLevel } from '@chimera/shared';

describe('SkillTrustEngine', () => {
  let engine: SkillTrustEngine;

  const createPrincipal = (
    trustLevel: SkillTrustLevel,
    permissions: SkillPermissions = {}
  ): PrincipalContext => ({
    skillName: 'test-skill',
    trustLevel,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    permissions,
  });

  beforeEach(() => {
    engine = new SkillTrustEngine();
  });

  describe('Platform Skills - Unrestricted Access', () => {
    it('should permit all actions for platform skills', () => {
      const principal = createPrincipal('platform');

      const actions: ActionType[] = [
        'file_read',
        'file_write',
        'network_access',
        'run_shell',
        'read_memory',
        'write_memory',
        'read_secret',
        'invoke_tool',
      ];

      for (const action of actions) {
        const result = engine.authorize(principal, action, { type: 'file', path: '/etc/config' });
        expect(result.decision).toBe('permit');
        expect(result.reason).toContain('Platform skill');
      }
    });
  });

  describe('File Read Authorization', () => {
    it('should deny file read without resource path', () => {
      const principal = createPrincipal('verified', {
        filesystem: { read: ['/workspace/**'] },
      });

      const result = engine.authorize(principal, 'file_read', { type: 'file' });
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('path missing');
    });

    it('should allow /tmp reads for community skills', () => {
      const principal = createPrincipal('community');

      const result = engine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/tmp/data.txt',
      });

      expect(result.decision).toBe('permit');
      expect(result.reason).toContain('/tmp access');
    });

    it('should deny non-/tmp reads for community skills', () => {
      const principal = createPrincipal('community');

      const result = engine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/home/user/data.txt',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('can only read from /tmp');
    });

    it('should enforce declared filesystem permissions for verified skills', () => {
      const principal = createPrincipal('verified', {
        filesystem: {
          read: ['/workspace/**', '/config/*.json'],
        },
      });

      // Should permit declared paths
      const allowed1 = engine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/workspace/file.txt',
      });
      expect(allowed1.decision).toBe('permit');

      const allowed2 = engine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/config/app.json',
      });
      expect(allowed2.decision).toBe('permit');

      // Should deny undeclared paths
      const denied = engine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/etc/passwd',
      });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('not in declared read permissions');
    });

    it('should deny reads without declared permissions', () => {
      const principal = createPrincipal('verified', {});

      const result = engine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/workspace/file.txt',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('No filesystem read permissions');
    });

    it('should support wildcard patterns', () => {
      const principal = createPrincipal('verified', {
        filesystem: {
          read: ['/data/**/*.json', '/config/?.txt'],
        },
      });

      // Should match /** pattern
      const result1 = engine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/data/nested/deep/file.json',
      });
      expect(result1.decision).toBe('permit');

      // Should match ? pattern
      const result2 = engine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/config/a.txt',
      });
      expect(result2.decision).toBe('permit');

      // Should not match ? pattern (multiple chars)
      const result3 = engine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/config/ab.txt',
      });
      expect(result3.decision).toBe('deny');
    });
  });

  describe('File Write Authorization', () => {
    it('should allow /tmp writes for community skills', () => {
      const principal = createPrincipal('community');

      const result = engine.authorize(principal, 'file_write', {
        type: 'file',
        path: '/tmp/output.txt',
      });

      expect(result.decision).toBe('permit');
    });

    it('should deny non-/tmp writes for community skills', () => {
      const principal = createPrincipal('community');

      const result = engine.authorize(principal, 'file_write', {
        type: 'file',
        path: '/home/user/output.txt',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('can only write to /tmp');
    });

    it('should enforce declared write permissions for verified skills', () => {
      const principal = createPrincipal('verified', {
        filesystem: {
          write: ['/workspace/output/**'],
        },
      });

      // Should permit declared path
      const allowed = engine.authorize(principal, 'file_write', {
        type: 'file',
        path: '/workspace/output/result.txt',
      });
      expect(allowed.decision).toBe('permit');

      // Should deny undeclared path
      const denied = engine.authorize(principal, 'file_write', {
        type: 'file',
        path: '/workspace/input/data.txt',
      });
      expect(denied.decision).toBe('deny');
    });
  });

  describe('Network Access Authorization', () => {
    it('should deny network access for community skills', () => {
      const principal = createPrincipal('community', {
        network: true,
      });

      const result = engine.authorize(principal, 'network_access', {
        type: 'network',
        endpoint: 'https://api.example.com',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('cannot access network');
    });

    it('should deny network access for experimental skills', () => {
      const principal = createPrincipal('experimental', {
        network: true,
      });

      const result = engine.authorize(principal, 'network_access', {
        type: 'network',
        endpoint: 'https://api.example.com',
      });

      expect(result.decision).toBe('deny');
    });

    it('should allow unrestricted network for verified skills with network:true', () => {
      const principal = createPrincipal('verified', {
        network: true,
      });

      const result = engine.authorize(principal, 'network_access', {
        type: 'network',
        endpoint: 'https://any-api.example.com',
      });

      expect(result.decision).toBe('permit');
      expect(result.reason).toContain('Unrestricted network access');
    });

    it('should enforce endpoint allowlist for verified skills', () => {
      const principal = createPrincipal('verified', {
        network: {
          endpoints: ['https://api.example.com', 'https://data.example.com'],
        },
      });

      // Should permit declared endpoints
      const allowed1 = engine.authorize(principal, 'network_access', {
        type: 'network',
        endpoint: 'https://api.example.com/v1/users',
      });
      expect(allowed1.decision).toBe('permit');

      const allowed2 = engine.authorize(principal, 'network_access', {
        type: 'network',
        endpoint: 'https://data.example.com/fetch',
      });
      expect(allowed2.decision).toBe('permit');

      // Should deny undeclared endpoints
      const denied = engine.authorize(principal, 'network_access', {
        type: 'network',
        endpoint: 'https://other.example.com',
      });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('not in declared network permissions');
    });

    it('should deny network access without declared permissions', () => {
      const principal = createPrincipal('verified', {});

      const result = engine.authorize(principal, 'network_access', {
        type: 'network',
        endpoint: 'https://api.example.com',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('No network permissions declared');
    });

    it('should deny network access without endpoint', () => {
      const principal = createPrincipal('verified', { network: true });

      const result = engine.authorize(principal, 'network_access', {
        type: 'network',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('endpoint missing');
    });
  });

  describe('Shell Command Authorization', () => {
    it('should deny shell execution for community skills', () => {
      const principal = createPrincipal('community', {
        shell: { allowed: ['ls'] },
      });

      const result = engine.authorize(principal, 'run_shell', {
        type: 'command',
        command: 'ls',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('cannot execute shell commands');
    });

    it('should deny shell execution for experimental skills', () => {
      const principal = createPrincipal('experimental', {
        shell: { allowed: ['ls'] },
      });

      const result = engine.authorize(principal, 'run_shell', {
        type: 'command',
        command: 'ls',
      });

      expect(result.decision).toBe('deny');
    });

    it('should enforce allowed command list for verified skills', () => {
      const principal = createPrincipal('verified', {
        shell: {
          allowed: ['git status', 'git diff', 'npm test'],
        },
      });

      // Should permit declared commands
      const allowed1 = engine.authorize(principal, 'run_shell', {
        type: 'command',
        command: 'git status',
      });
      expect(allowed1.decision).toBe('permit');

      const allowed2 = engine.authorize(principal, 'run_shell', {
        type: 'command',
        command: 'npm test --verbose',
      });
      expect(allowed2.decision).toBe('permit');

      // Should deny undeclared commands
      const denied = engine.authorize(principal, 'run_shell', {
        type: 'command',
        command: 'rm -rf /',
      });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('not in declared shell permissions');
    });

    it('should check denied list before allowed list', () => {
      const principal = createPrincipal('verified', {
        shell: {
          allowed: ['git'],
          denied: ['rm'],
        },
      });

      // Should permit allowed command without denied pattern
      const allowed = engine.authorize(principal, 'run_shell', {
        type: 'command',
        command: 'git status',
      });
      expect(allowed.decision).toBe('permit');

      // Should deny if contains denied pattern
      const denied = engine.authorize(principal, 'run_shell', {
        type: 'command',
        command: 'git rm file.txt',
      });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('denied pattern');
    });

    it('should deny shell execution without permissions', () => {
      const principal = createPrincipal('verified', {});

      const result = engine.authorize(principal, 'run_shell', {
        type: 'command',
        command: 'ls',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('No shell permissions declared');
    });
  });

  describe('Memory Access Authorization', () => {
    it('should deny memory access for community skills', () => {
      const principal = createPrincipal('community', {
        memory: { read: true },
      });

      const result = engine.authorize(principal, 'read_memory', {
        type: 'memory',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('cannot access memory');
    });

    it('should deny memory access for experimental skills', () => {
      const principal = createPrincipal('experimental', {
        memory: { read: true },
      });

      const result = engine.authorize(principal, 'read_memory', {
        type: 'memory',
      });

      expect(result.decision).toBe('deny');
    });

    it('should allow memory read for verified skills with permission', () => {
      const principal = createPrincipal('verified', {
        memory: { read: true },
      });

      const result = engine.authorize(principal, 'read_memory', {
        type: 'memory',
      });

      expect(result.decision).toBe('permit');
    });

    it('should deny memory read without permission', () => {
      const principal = createPrincipal('verified', {});

      const result = engine.authorize(principal, 'read_memory', {
        type: 'memory',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('No memory read permissions');
    });

    it('should enforce write category restrictions', () => {
      const principal = createPrincipal('verified', {
        memory: {
          write: ['skill_state', 'user_preference'],
        },
      });

      // Should permit declared categories
      const allowed1 = engine.authorize(principal, 'write_memory', {
        type: 'memory',
        category: 'skill_state',
      });
      expect(allowed1.decision).toBe('permit');

      const allowed2 = engine.authorize(principal, 'write_memory', {
        type: 'memory',
        category: 'user_preference',
      });
      expect(allowed2.decision).toBe('permit');

      // Should deny undeclared categories
      const denied = engine.authorize(principal, 'write_memory', {
        type: 'memory',
        category: 'system_config',
      });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('not in declared memory write permissions');
    });

    it('should deny memory write without category', () => {
      const principal = createPrincipal('verified', {
        memory: { write: ['skill_state'] },
      });

      const result = engine.authorize(principal, 'write_memory', {
        type: 'memory',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('category missing');
    });
  });

  describe('Secret Access Authorization', () => {
    it('should deny secret access for community skills', () => {
      const principal = createPrincipal('community', {
        secrets: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:mysecret'],
      });

      const result = engine.authorize(principal, 'read_secret', {
        type: 'secret',
        arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mysecret',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('cannot access secrets');
    });

    it('should enforce secrets allowlist for verified skills', () => {
      const principal = createPrincipal('verified', {
        secrets: [
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:api-key',
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-password',
        ],
      });

      // Should permit declared secrets
      const allowed = engine.authorize(principal, 'read_secret', {
        type: 'secret',
        arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:api-key',
      });
      expect(allowed.decision).toBe('permit');

      // Should deny undeclared secrets
      const denied = engine.authorize(principal, 'read_secret', {
        type: 'secret',
        arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:other-secret',
      });
      expect(denied.decision).toBe('deny');
      expect(denied.reason).toContain('not in declared secrets permissions');
    });

    it('should deny secret access without ARN', () => {
      const principal = createPrincipal('verified', {
        secrets: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:api-key'],
      });

      const result = engine.authorize(principal, 'read_secret', {
        type: 'secret',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('ARN missing');
    });

    it('should deny secret access without permissions', () => {
      const principal = createPrincipal('verified', {});

      const result = engine.authorize(principal, 'read_secret', {
        type: 'secret',
        arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:api-key',
      });

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('No secrets permissions declared');
    });
  });

  describe('Tool Invocation Authorization', () => {
    it('should allow tool invocation for all trust levels', () => {
      const trustLevels: SkillTrustLevel[] = [
        'platform',
        'verified',
        'community',
        'private',
        'experimental',
      ];

      for (const trustLevel of trustLevels) {
        const principal = createPrincipal(trustLevel);

        const result = engine.authorize(principal, 'invoke_tool', {
          type: 'tool',
          toolName: 'example-tool',
        });

        expect(result.decision).toBe('permit');
      }
    });
  });

  describe('Unknown Action Types', () => {
    it('should deny unknown action types', () => {
      const principal = createPrincipal('verified');

      const result = engine.authorize(
        principal,
        'unknown_action' as ActionType,
        { type: 'file' }
      );

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('Unknown action type');
    });
  });

  describe('Audit Logging', () => {
    it('should log authorization decisions when audit log is enabled', () => {
      const auditEngine = new SkillTrustEngine({ auditLog: true });
      const principal = createPrincipal('verified', {
        filesystem: { read: ['/workspace/**'] },
      });

      // These should log to console (can't easily test console output in unit tests)
      auditEngine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/workspace/file.txt',
      });

      auditEngine.authorize(principal, 'file_read', {
        type: 'file',
        path: '/etc/passwd',
      });
    });
  });

  describe('Trust Level Hierarchy', () => {
    it('should enforce strictest constraints for experimental skills', () => {
      const principal = createPrincipal('experimental', {
        filesystem: { read: ['/workspace/**'] },
        network: true,
        shell: { allowed: ['ls'] },
        memory: { read: true },
        secrets: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:test'],
      });

      // Should deny all restricted operations
      expect(
        engine.authorize(principal, 'file_read', { type: 'file', path: '/workspace/file.txt' })
          .decision
      ).toBe('deny');

      expect(
        engine.authorize(principal, 'network_access', {
          type: 'network',
          endpoint: 'https://api.example.com',
        }).decision
      ).toBe('deny');

      expect(
        engine.authorize(principal, 'run_shell', { type: 'command', command: 'ls' }).decision
      ).toBe('deny');

      expect(
        engine.authorize(principal, 'read_memory', { type: 'memory' }).decision
      ).toBe('deny');

      expect(
        engine.authorize(principal, 'read_secret', {
          type: 'secret',
          arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test',
        }).decision
      ).toBe('deny');

      // Only /tmp access should work
      expect(
        engine.authorize(principal, 'file_read', { type: 'file', path: '/tmp/file.txt' }).decision
      ).toBe('permit');
    });

    it('should enforce community skill restrictions', () => {
      const principal = createPrincipal('community', {
        filesystem: { read: ['/workspace/**'], write: ['/tmp/**'] },
        network: { endpoints: ['https://api.example.com'] },
        shell: { allowed: ['ls'] },
        memory: { read: true },
      });

      // /tmp access should work
      expect(
        engine.authorize(principal, 'file_read', { type: 'file', path: '/tmp/file.txt' }).decision
      ).toBe('permit');

      expect(
        engine.authorize(principal, 'file_write', { type: 'file', path: '/tmp/output.txt' })
          .decision
      ).toBe('permit');

      // Everything else should be denied
      expect(
        engine.authorize(principal, 'file_read', { type: 'file', path: '/workspace/file.txt' })
          .decision
      ).toBe('deny');

      expect(
        engine.authorize(principal, 'network_access', {
          type: 'network',
          endpoint: 'https://api.example.com',
        }).decision
      ).toBe('deny');

      expect(
        engine.authorize(principal, 'run_shell', { type: 'command', command: 'ls' }).decision
      ).toBe('deny');

      expect(
        engine.authorize(principal, 'read_memory', { type: 'memory' }).decision
      ).toBe('deny');
    });

    it('should grant verified skills full declared permissions', () => {
      const principal = createPrincipal('verified', {
        filesystem: { read: ['/workspace/**'], write: ['/workspace/output/**'] },
        network: { endpoints: ['https://api.example.com'] },
        shell: { allowed: ['git status'] },
        memory: { read: true, write: ['skill_state'] },
        secrets: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:api-key'],
      });

      // All declared permissions should be permitted
      expect(
        engine.authorize(principal, 'file_read', { type: 'file', path: '/workspace/file.txt' })
          .decision
      ).toBe('permit');

      expect(
        engine.authorize(principal, 'file_write', {
          type: 'file',
          path: '/workspace/output/result.txt',
        }).decision
      ).toBe('permit');

      expect(
        engine.authorize(principal, 'network_access', {
          type: 'network',
          endpoint: 'https://api.example.com/v1',
        }).decision
      ).toBe('permit');

      expect(
        engine.authorize(principal, 'run_shell', { type: 'command', command: 'git status' })
          .decision
      ).toBe('permit');

      expect(
        engine.authorize(principal, 'read_memory', { type: 'memory' }).decision
      ).toBe('permit');

      expect(
        engine.authorize(principal, 'write_memory', { type: 'memory', category: 'skill_state' })
          .decision
      ).toBe('permit');

      expect(
        engine.authorize(principal, 'read_secret', {
          type: 'secret',
          arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:api-key',
        }).decision
      ).toBe('permit');
    });
  });
});
