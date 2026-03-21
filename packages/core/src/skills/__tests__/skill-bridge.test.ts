/**
 * Tests for skill bridge (agent integration)
 */

import {
  skillsToAgentTools,
  injectSkillsIntoAgent,
  buildSkillCatalog,
} from '../skill-bridge';
import type { SkillDefinition } from '../../tools/types';
import type { AgentConfig } from '../../agent/agent';
import { SystemPromptTemplate } from '../../agent/prompt';

describe('skillsToAgentTools', () => {
  it('should convert instruction-based skill to prompt addition', () => {
    const skills: SkillDefinition[] = [
      {
        name: 'git-commit',
        version: '1.0.0',
        description: 'Commit changes',
        author: 'platform',
        trustLevel: 'platform',
        format: 'SKILL.md',
        implementation: {
          type: 'instruction',
          instructions: '# Git Commit\nUse `git commit -m "message"`',
        },
        source: {
          platform: 'openclaw',
          formatVersion: 'v2',
          importedAt: new Date().toISOString(),
        },
      },
    ];

    const result = skillsToAgentTools(skills);

    expect(result.tools).toHaveLength(0); // No MCP tools
    expect(result.promptAdditions).toContain('git-commit Skill');
    expect(result.promptAdditions).toContain('git commit -m');
  });

  it('should convert MCP skill to callable tools', () => {
    const skills: SkillDefinition[] = [
      {
        name: 'api-client',
        version: '1.0.0',
        description: 'API client',
        author: 'platform',
        trustLevel: 'platform',
        format: 'SKILL.md',
        implementation: {
          type: 'mcp_server',
          mcpServer: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            tools: [
              {
                name: 'fetch_data',
                description: 'Fetch data from API',
                parameters: [],
              },
              {
                name: 'post_data',
                description: 'Post data to API',
                parameters: [],
              },
            ],
          },
        },
        source: {
          platform: 'openclaw',
          formatVersion: 'v2',
          importedAt: new Date().toISOString(),
        },
      },
    ];

    const result = skillsToAgentTools(skills);

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe('fetch_data');
    expect(result.tools[0].description).toBe('Fetch data from API');
    expect(result.tools[1].name).toBe('post_data');
    expect(result.promptAdditions).toBe(''); // MCP-only, no prompt additions
  });

  it('should handle hybrid skills (instructions + MCP)', () => {
    const skills: SkillDefinition[] = [
      {
        name: 'hybrid-skill',
        version: '1.0.0',
        description: 'Hybrid skill',
        author: 'platform',
        trustLevel: 'platform',
        format: 'SKILL.md',
        implementation: {
          type: 'hybrid',
          instructions: '# Hybrid Skill\nUse the tools wisely.',
          mcpServer: {
            transport: 'http',
            url: 'http://localhost:8080',
            tools: [
              {
                name: 'helper_tool',
                description: 'Helper tool',
                parameters: [],
              },
            ],
          },
        },
        source: {
          platform: 'openclaw',
          formatVersion: 'v2',
          importedAt: new Date().toISOString(),
        },
      },
    ];

    const result = skillsToAgentTools(skills);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('helper_tool');
    expect(result.promptAdditions).toContain('Hybrid Skill');
    expect(result.promptAdditions).toContain('Use the tools wisely');
  });

  it('should handle empty skills array', () => {
    const result = skillsToAgentTools([]);

    expect(result.tools).toHaveLength(0);
    expect(result.promptAdditions).toBe('');
  });
});

describe('injectSkillsIntoAgent', () => {
  it('should inject skills into agent config', () => {
    const basePrompt = new SystemPromptTemplate('Base system prompt');
    const config: AgentConfig = {
      systemPrompt: basePrompt,
      tenantId: 'tenant-123',
      userId: 'user-456',
    };

    const skills: SkillDefinition[] = [
      {
        name: 'test-skill',
        version: '1.0.0',
        description: 'Test skill',
        author: 'platform',
        trustLevel: 'platform',
        format: 'SKILL.md',
        implementation: {
          type: 'instruction',
          instructions: 'Test instructions',
        },
        source: {
          platform: 'openclaw',
          formatVersion: 'v2',
          importedAt: new Date().toISOString(),
        },
      },
    ];

    const enhancedConfig = injectSkillsIntoAgent(config, skills);

    // Check that system prompt is enhanced
    const renderedPrompt = enhancedConfig.systemPrompt.render({
      tenantId: 'tenant-123',
      userId: 'user-456',
      sessionId: 'session-789',
    });
    expect(renderedPrompt).toContain('Base system prompt');
    expect(renderedPrompt).toContain('test-skill Skill');
    expect(renderedPrompt).toContain('Test instructions');
  });

  it('should preserve existing loadedTools', () => {
    const basePrompt = new SystemPromptTemplate('Base prompt');
    const existingTool = {
      name: 'existing_tool',
      description: 'Existing tool',
      inputSchema: { type: 'object', properties: {} },
      callback: async () => 'result',
    };

    const config: AgentConfig = {
      systemPrompt: basePrompt,
      tenantId: 'tenant-123',
      loadedTools: [existingTool],
    };

    const skills: SkillDefinition[] = [
      {
        name: 'mcp-skill',
        version: '1.0.0',
        description: 'MCP skill',
        author: 'platform',
        trustLevel: 'platform',
        format: 'SKILL.md',
        implementation: {
          type: 'mcp_server',
          mcpServer: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            tools: [
              {
                name: 'new_tool',
                description: 'New tool',
                parameters: [],
              },
            ],
          },
        },
        source: {
          platform: 'openclaw',
          formatVersion: 'v2',
          importedAt: new Date().toISOString(),
        },
      },
    ];

    const enhancedConfig = injectSkillsIntoAgent(config, skills);

    expect(enhancedConfig.loadedTools).toHaveLength(2);
    expect(enhancedConfig.loadedTools?.[0].name).toBe('existing_tool');
    expect(enhancedConfig.loadedTools?.[1].name).toBe('new_tool');
  });
});

describe('buildSkillCatalog', () => {
  it('should build catalog for empty skills array', () => {
    const catalog = buildSkillCatalog([]);

    expect(catalog).toContain('No skills are currently installed');
  });

  it('should build catalog for instruction-based skill', () => {
    const skills: SkillDefinition[] = [
      {
        name: 'git-commit',
        version: '1.0.0',
        description: 'Commit changes to git',
        author: 'platform',
        trustLevel: 'platform',
        format: 'SKILL.md',
        permissions: {
          shell: {
            allowed: ['git'],
          },
        },
        implementation: {
          type: 'instruction',
          instructions: 'Use git commit',
        },
        source: {
          platform: 'openclaw',
          formatVersion: 'v2',
          importedAt: new Date().toISOString(),
        },
      },
    ];

    const catalog = buildSkillCatalog(skills);

    expect(catalog).toContain('git-commit (v1.0.0)');
    expect(catalog).toContain('Commit changes to git');
    expect(catalog).toContain('Shell access: enabled');
  });

  it('should build catalog for MCP skill with tools', () => {
    const skills: SkillDefinition[] = [
      {
        name: 'api-client',
        version: '2.0.0',
        description: 'API client skill',
        author: 'community',
        trustLevel: 'community',
        format: 'SKILL.md',
        implementation: {
          type: 'mcp_server',
          mcpServer: {
            transport: 'http',
            url: 'http://localhost:8080',
            tools: [
              {
                name: 'fetch_data',
                description: 'Fetch data',
                parameters: [],
              },
              {
                name: 'post_data',
                description: 'Post data',
                parameters: [],
              },
            ],
          },
        },
        source: {
          platform: 'openclaw',
          formatVersion: 'v2',
          importedAt: new Date().toISOString(),
        },
      },
    ];

    const catalog = buildSkillCatalog(skills);

    expect(catalog).toContain('api-client (v2.0.0)');
    expect(catalog).toContain('API client skill');
    expect(catalog).toContain('**Tools:**');
    expect(catalog).toContain('`fetch_data`: Fetch data');
    expect(catalog).toContain('`post_data`: Post data');
  });

  it('should show dependencies in catalog', () => {
    const skills: SkillDefinition[] = [
      {
        name: 'advanced-skill',
        version: '1.0.0',
        description: 'Advanced skill',
        author: 'platform',
        trustLevel: 'platform',
        format: 'SKILL.md',
        dependencies: {
          skills: ['basic-skill', 'helper-skill'],
        },
        implementation: {
          type: 'instruction',
          instructions: 'Advanced instructions',
        },
        source: {
          platform: 'openclaw',
          formatVersion: 'v2',
          importedAt: new Date().toISOString(),
        },
      },
    ];

    const catalog = buildSkillCatalog(skills);

    expect(catalog).toContain('**Dependencies:** basic-skill, helper-skill');
  });

  it('should show filesystem permissions in catalog', () => {
    const skills: SkillDefinition[] = [
      {
        name: 'file-processor',
        version: '1.0.0',
        description: 'Process files',
        author: 'platform',
        trustLevel: 'platform',
        format: 'SKILL.md',
        permissions: {
          filesystem: {
            read: ['*.txt', '*.md'],
            write: ['output/*.json'],
          },
        },
        implementation: {
          type: 'instruction',
          instructions: 'Process files',
        },
        source: {
          platform: 'openclaw',
          formatVersion: 'v2',
          importedAt: new Date().toISOString(),
        },
      },
    ];

    const catalog = buildSkillCatalog(skills);

    expect(catalog).toContain('**Permissions:**');
    expect(catalog).toContain('Filesystem read: *.txt, *.md');
    expect(catalog).toContain('Filesystem write: output/*.json');
  });
});
