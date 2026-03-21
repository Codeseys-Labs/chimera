/**
 * Tools module tests
 *
 * Tests for SkillLoader, SkillRegistry, and skill adapter patterns
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SkillLoader } from '../skill-loader';
import type { SkillDefinition, SkillAdapter } from '../types';

// Mock skill adapter for testing
class MockSkillAdapter implements SkillAdapter {
  sourcePlatform = 'test-platform' as const;

  async validate(source: unknown): Promise<boolean> {
    return typeof source === 'object' && source !== null;
  }

  async importSkill(source: unknown): Promise<SkillDefinition> {
    const mockSource = source as any;
    return {
      id: mockSource.id || 'test-skill',
      name: mockSource.name || 'Test Skill',
      version: '1.0.0',
      description: 'Test skill for unit testing',
      implementation: {
        type: 'instruction',
        instructions: mockSource.instructions || 'Test instructions',
      },
      permissions: mockSource.permissions,
      metadata: {
        platform: this.sourcePlatform,
        imported: new Date().toISOString(),
      },
    };
  }

  async exportSkill(skill: SkillDefinition): Promise<unknown> {
    return {
      id: skill.id,
      name: skill.name,
      instructions: skill.implementation.instructions,
    };
  }
}

describe('SkillLoader', () => {
  let loader: SkillLoader;
  let mockAdapter: MockSkillAdapter;

  beforeEach(() => {
    loader = new SkillLoader();
    mockAdapter = new MockSkillAdapter();
  });

  describe('registerAdapter', () => {
    it('should register an adapter', () => {
      loader.registerAdapter(mockAdapter);

      const adapters = loader.getAdapters();
      expect(adapters).toHaveLength(1);
      expect(adapters[0].sourcePlatform).toBe('test-platform');
    });

    it('should allow multiple adapters', () => {
      const adapter2 = new MockSkillAdapter();
      adapter2.sourcePlatform = 'another-platform' as any;

      loader.registerAdapter(mockAdapter);
      loader.registerAdapter(adapter2);

      const adapters = loader.getAdapters();
      expect(adapters).toHaveLength(2);
    });
  });

  describe('importSkill', () => {
    beforeEach(() => {
      loader.registerAdapter(mockAdapter);
    });

    it('should import skill from registered adapter', async () => {
      const source = {
        id: 'code-review-skill',
        name: 'Code Review Assistant',
        instructions: 'Review code for quality and security',
      };

      const skill = await loader.importSkill(source, 'test-platform' as any);

      expect(skill.id).toBe('code-review-skill');
      expect(skill.name).toBe('Code Review Assistant');
      expect(skill.implementation.type).toBe('instruction');
    });

    it('should throw error for unregistered platform', async () => {
      await expect(
        loader.importSkill({}, 'unregistered' as any)
      ).rejects.toThrow('No adapter registered for platform: unregistered');
    });

    it('should validate source format before importing', async () => {
      // Invalid source (null)
      await expect(
        loader.importSkill(null, 'test-platform' as any)
      ).rejects.toThrow('Invalid skill format for platform: test-platform');
    });
  });

  describe('exportSkill', () => {
    beforeEach(() => {
      loader.registerAdapter(mockAdapter);
    });

    it('should export skill to target format', async () => {
      const skill: SkillDefinition = {
        id: 'test-skill',
        name: 'Test Skill',
        version: '1.0.0',
        description: 'Test',
        implementation: {
          type: 'instruction',
          instructions: 'Do something useful',
        },
        metadata: {},
      };

      const exported = await loader.exportSkill(skill, 'test-platform' as any);

      expect(exported).toEqual({
        id: 'test-skill',
        name: 'Test Skill',
        instructions: 'Do something useful',
      });
    });

    it('should throw error for unregistered platform', async () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'instruction', instructions: 'Test' },
        metadata: {},
      };

      await expect(
        loader.exportSkill(skill, 'unregistered' as any)
      ).rejects.toThrow('No adapter registered for platform: unregistered');
    });
  });

  describe('validateSkillPermissions', () => {
    it('should pass validation for skill without permissions', () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'instruction', instructions: 'Test' },
        metadata: {},
      };

      const result = loader.validateSkillPermissions(skill);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect overly broad filesystem read permissions', () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'instruction', instructions: 'Test' },
        permissions: {
          filesystem: {
            read: ['**'],
          },
        },
        metadata: {},
      };

      const result = loader.validateSkillPermissions(skill);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('wildcards too broad'))).toBe(true);
    });

    it('should reject root filesystem write permissions', () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'instruction', instructions: 'Test' },
        permissions: {
          filesystem: {
            write: ['/'],
          },
        },
        metadata: {},
      };

      const result = loader.validateSkillPermissions(skill);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('root write not allowed'))).toBe(true);
    });

    it('should detect dangerous shell commands', () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'instruction', instructions: 'Test' },
        permissions: {
          shell: {
            allowed: ['rm -rf /'],
          },
        },
        metadata: {},
      };

      const result = loader.validateSkillPermissions(skill);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('dangerous commands'))).toBe(true);
    });

    it('should validate Secrets Manager ARN format', () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'instruction', instructions: 'Test' },
        permissions: {
          secrets: ['invalid-arn-format'],
        },
        metadata: {},
      };

      const result = loader.validateSkillPermissions(skill);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('invalid ARN format'))).toBe(true);
    });

    it('should pass with valid Secrets Manager ARN', () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'instruction', instructions: 'Test' },
        permissions: {
          secrets: ['arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123'],
        },
        metadata: {},
      };

      const result = loader.validateSkillPermissions(skill);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should allow safe filesystem patterns', () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'instruction', instructions: 'Test' },
        permissions: {
          filesystem: {
            read: ['src/**/*.ts', 'docs/**/*.md'],
            write: ['output/*.json'],
          },
        },
        metadata: {},
      };

      const result = loader.validateSkillPermissions(skill);

      expect(result.valid).toBe(true);
    });
  });

  describe('listSkillTools', () => {
    it('should return empty array for instruction-only skills', async () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'instruction', instructions: 'Test' },
        metadata: {},
      };

      const tools = await loader.listSkillTools(skill);

      expect(tools).toHaveLength(0);
    });

    it('should return tools for MCP-backed skills', async () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: {
          type: 'mcp_server',
          instructions: 'Use tools',
          mcpServer: {
            name: 'test-mcp',
            command: 'node',
            args: ['server.js'],
            tools: [
              {
                name: 'search_code',
                description: 'Search codebase',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                  },
                  required: ['query'],
                },
              },
            ],
          },
        },
        metadata: {},
      };

      const tools = await loader.listSkillTools(skill);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('search_code');
    });
  });

  describe('loadSkillProvider', () => {
    it('should throw for unsupported implementation type', async () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'unknown' as any, instructions: 'Test' },
        metadata: {},
      };

      await expect(loader.loadSkillProvider(skill)).rejects.toThrow(
        'Unsupported implementation type'
      );
    });

    it('should throw not implemented for MCP provider', async () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: {
          type: 'mcp_server',
          instructions: 'Test',
          mcpServer: {
            name: 'test-mcp',
            command: 'node',
            args: ['server.js'],
            tools: [],
          },
        },
        metadata: {},
      };

      await expect(loader.loadSkillProvider(skill)).rejects.toThrow(
        'MCP provider creation not yet implemented'
      );
    });

    it('should throw not implemented for instruction provider', async () => {
      const skill: SkillDefinition = {
        id: 'test',
        name: 'Test',
        version: '1.0.0',
        description: 'Test',
        implementation: { type: 'instruction', instructions: 'Test' },
        metadata: {},
      };

      await expect(loader.loadSkillProvider(skill)).rejects.toThrow(
        'Instruction provider creation not yet implemented'
      );
    });
  });

  describe('getAdapters and getProviders', () => {
    it('should return empty arrays initially', () => {
      const newLoader = new SkillLoader();

      expect(newLoader.getAdapters()).toHaveLength(0);
      expect(newLoader.getProviders()).toHaveLength(0);
    });

    it('should return registered adapters', () => {
      loader.registerAdapter(mockAdapter);

      const adapters = loader.getAdapters();
      expect(adapters).toHaveLength(1);
    });
  });
});
