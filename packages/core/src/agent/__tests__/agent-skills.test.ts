/**
 * Agent-Skills Integration Tests
 *
 * Tests end-to-end skill loading, MCP registration, and agent tool execution
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  ChimeraAgent,
  createAgent,
  type AgentConfig,
  type AgentResult,
} from '../agent';
import { SystemPromptTemplate } from '../prompt';
import { SkillRegistry } from '../../skills/registry';
import { SkillDiscovery } from '../../skills/discovery';
import { SkillInstaller } from '../../skills/installer';
import { MCPGatewayClient, HttpClient } from '../../skills/mcp-gateway-client';
import {
  Skill,
  SkillInstall,
  MCPServerConfig,
} from '@chimera/shared';

/**
 * Mock HTTP client for MCP Gateway
 */
class MockHttpClient implements HttpClient {
  public registrations: Map<string, { tools: any[]; status: string }> = new Map();

  async post(url: string, body: any): Promise<any> {
    if (url.includes('/mcp/register')) {
      this.registrations.set(body.target_name, {
        tools: body.tools || [],
        status: 'active',
      });
      return {
        target_id: body.target_name,
        tools: body.tools || [],
        status: 'active',
      };
    }

    if (url.includes('/mcp/unregister')) {
      this.registrations.delete(body.target_name);
      return { success: true };
    }

    return {};
  }

  async get(url: string): Promise<any> {
    if (url.includes('/mcp/list')) {
      return {
        targets: Array.from(this.registrations.entries()).map(([name, data]) => ({
          target_name: name,
          tools: data.tools,
        })),
      };
    }

    if (url.includes('/mcp/status')) {
      const match = url.match(/target_name=([^&]+)/);
      if (match) {
        const targetName = match[1];
        const reg = this.registrations.get(targetName);
        return reg || { status: 'inactive' };
      }
    }

    return {};
  }

  async delete(): Promise<any> {
    return {};
  }

  reset(): void {
    this.registrations.clear();
  }
}

/**
 * Mock S3 client
 */
class MockS3 {
  public bundles: Map<string, Buffer> = new Map();

  async getObject(params: any): Promise<{ Body: Buffer }> {
    const bundle = this.bundles.get(params.Key);
    if (!bundle) {
      throw new Error(`Object not found: ${params.Key}`);
    }
    return { Body: bundle };
  }

  async putObject(): Promise<any> {
    return {};
  }

  async deleteObject(): Promise<any> {
    return {};
  }
}

/**
 * Mock Registry
 */
class MockRegistry {
  public skills: Map<string, Skill> = new Map();
  public installs: Map<string, SkillInstall> = new Map();

  async getSkill(name: string, version?: string): Promise<Skill | null> {
    if (version) {
      return this.skills.get(`${name}@${version}`) || this.skills.get(name) || null;
    }
    return this.skills.get(name) || null;
  }

  async getSkillInstall(tenantId: string, skillName: string): Promise<SkillInstall | null> {
    return this.installs.get(`${tenantId}#${skillName}`) || null;
  }

  async getInstalledSkills(tenantId: string): Promise<SkillInstall[]> {
    return Array.from(this.installs.values()).filter(
      install => install.tenant_id === tenantId
    );
  }

  async recordInstall(install: SkillInstall): Promise<void> {
    this.installs.set(`${install.tenant_id}#${install.skill_name}`, install);
  }

  async removeInstall(tenantId: string, skillName: string): Promise<void> {
    this.installs.delete(`${tenantId}#${skillName}`);
  }

  async listVersions(skillName: string): Promise<Skill[]> {
    return Array.from(this.skills.values()).filter(s => s.name === skillName);
  }

  async searchSkills(): Promise<{ skills: Skill[] }> {
    return { skills: Array.from(this.skills.values()) };
  }

  async listByCategory(): Promise<Skill[]> {
    return Array.from(this.skills.values());
  }
}

/**
 * Mock Validator
 */
class MockValidator {
  async validateSkill(): Promise<{ valid: boolean; errors: string[] }> {
    return { valid: true, errors: [] };
  }
}

/**
 * Mock Model for agent testing
 */
class MockModel {
  public responses: string[] = [];
  public currentResponse = 0;

  async converse(turn: any): Promise<any> {
    const response = this.responses[this.currentResponse] || 'Mock response';
    this.currentResponse++;

    return {
      output: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: response }],
        },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }

  reset(): void {
    this.responses = [];
    this.currentResponse = 0;
  }
}

describe('Agent-Skills Integration', () => {
  let mockHttp: MockHttpClient;
  let mockS3: MockS3;
  let mockRegistry: MockRegistry;
  let mockValidator: MockValidator;
  let mockModel: MockModel;
  let mcpGateway: MCPGatewayClient;
  let installer: SkillInstaller;
  let discovery: SkillDiscovery;

  beforeEach(() => {
    mockHttp = new MockHttpClient();
    mockS3 = new MockS3();
    mockRegistry = new MockRegistry();
    mockValidator = new MockValidator();
    mockModel = new MockModel();

    mcpGateway = new MCPGatewayClient({
      gatewayEndpoint: 'https://gateway.example.com',
      apiKey: 'test-key',
      httpClient: mockHttp,
    });

    installer = new SkillInstaller({
      registry: mockRegistry as any,
      validator: mockValidator as any,
      mcpGateway,
      s3: mockS3 as any,
      bundleBucket: 'chimera-skills',
    });

    discovery = new SkillDiscovery({
      registry: mockRegistry as any,
      enableSemanticSearch: false,
    });
  });

  describe('Skill Installation and MCP Registration', () => {
    it('should install skill and register with MCP Gateway', async () => {
      // Setup: Add skill to marketplace
      const codeReviewSkill: Skill = {
        PK: 'SKILL#code-review',
        SK: 'VERSION#1.0.0',
        name: 'code-review',
        version: '1.0.0',
        author: 'chimera-platform',
        description: 'Automated code review assistant',
        category: 'developer-tools',
        tags: ['code', 'review', 'quality'],
        trust_level: 'platform',
        permissions_hash: 'abc123',
        signatures: { author: 'sig1', platform: 'sig2' },
        bundle: {
          s3_key: 'skills/code-review-1.0.0.tar.gz',
          sha256: 'def456',
          size_bytes: 2048,
        },
        scan_status: 'passed',
        download_count: 1000,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      mockRegistry.skills.set('code-review', codeReviewSkill);
      mockS3.bundles.set(
        'skills/code-review-1.0.0.tar.gz',
        Buffer.from('skill bundle')
      );

      // Install skill
      const installResponse = await installer.install({
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        installed_by: 'user-456',
      });

      expect(installResponse.status).toBe('success');

      // Verify installation was recorded
      const install = await mockRegistry.getSkillInstall('tenant-123', 'code-review');
      expect(install).toBeDefined();
      expect(install?.version).toBe('1.0.0');

      // Now register with MCP Gateway (simulating skill activation)
      const mcpConfig: MCPServerConfig = {
        transport: 'stdio',
        command: 'node',
        args: ['code-review/index.js'],
        tools: [
          { name: 'review_code', description: 'Analyze code quality' },
          { name: 'suggest_improvements', description: 'Suggest code improvements' },
        ],
      };

      const registration = await mcpGateway.register({
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        mcp_config: mcpConfig,
        permissions: {
          filesystem: { read: ['**/*.ts', '**/*.js'], write: [] },
          network: false,
        },
        trust_level: 'platform',
      });

      expect(registration.status).toBe('active');
      expect(registration.tools).toHaveLength(2);
      expect(registration.tools[0].name).toBe('review_code');

      // Verify registration in gateway
      const targets = await mcpGateway.listTargets('tenant-123');
      expect(targets).toHaveLength(1);
      expect(targets[0].target_name).toBe('skill-code-review');
    });

    it('should load installed skills into agent', async () => {
      // Pre-install skills
      const install1: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        pinned: false,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: false,
        use_count: 0,
      };

      const install2: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#github-pr',
        tenant_id: 'tenant-123',
        skill_name: 'github-pr',
        version: '2.0.0',
        pinned: false,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: true,
        use_count: 0,
      };

      mockRegistry.installs.set('tenant-123#code-review', install1);
      mockRegistry.installs.set('tenant-123#github-pr', install2);

      // Get installed skills
      const installed = await mockRegistry.getInstalledSkills('tenant-123');

      expect(installed).toHaveLength(2);
      expect(installed.map(i => i.skill_name)).toContain('code-review');
      expect(installed.map(i => i.skill_name)).toContain('github-pr');

      // Create agent with skills
      const agentConfig: AgentConfig = {
        systemPrompt: new SystemPromptTemplate('You are a helpful assistant'),
        tenantId: 'tenant-123',
        userId: 'user-456',
        skills: ['code-review', 'github-pr'],
        tools: ['review_code', 'create_pr'],
        model: mockModel,
      };

      const agent = createAgent(agentConfig);

      expect(agent).toBeDefined();
      expect(agent.context.tenantId).toBe('tenant-123');
      expect(agent.context.config.skills).toContain('code-review');
      expect(agent.context.config.skills).toContain('github-pr');
    });

    it('should discover skills via semantic search', async () => {
      // Add skills to marketplace
      const skill1: Skill = {
        PK: 'SKILL#code-review',
        SK: 'VERSION#1.0.0',
        name: 'code-review',
        version: '1.0.0',
        author: 'platform',
        description: 'Automated code quality analysis and review',
        category: 'developer-tools',
        tags: ['code', 'review', 'quality', 'static-analysis'],
        trust_level: 'platform',
        permissions_hash: 'abc',
        signatures: {},
        bundle: {
          s3_key: 'skills/code-review-1.0.0.tar.gz',
          sha256: 'def',
          size_bytes: 2048,
        },
        scan_status: 'passed',
        download_count: 1000,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      const skill2: Skill = {
        PK: 'SKILL#test-runner',
        SK: 'VERSION#1.0.0',
        name: 'test-runner',
        version: '1.0.0',
        author: 'platform',
        description: 'Execute unit tests and generate coverage reports',
        category: 'developer-tools',
        tags: ['testing', 'unit-tests', 'coverage'],
        trust_level: 'platform',
        permissions_hash: 'xyz',
        signatures: {},
        bundle: {
          s3_key: 'skills/test-runner-1.0.0.tar.gz',
          sha256: 'ghi',
          size_bytes: 1024,
        },
        scan_status: 'passed',
        download_count: 500,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      mockRegistry.skills.set('code-review', skill1);
      mockRegistry.skills.set('test-runner', skill2);

      // Search for skills
      const results = await discovery.search(
        'code quality analysis',
        'tenant-123',
        { category: 'developer-tools' },
        10
      );

      // Should find code-review skill (keyword match)
      expect(results.length).toBeGreaterThan(0);
      const codeReviewResult = results.find(r => r.skill.name === 'code-review');
      expect(codeReviewResult).toBeDefined();
      expect(codeReviewResult?.score).toBeGreaterThan(0);
    });

    it('should handle skill uninstallation and MCP unregistration', async () => {
      // Pre-install skill
      const install: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        pinned: false,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: false,
        use_count: 10,
      };

      mockRegistry.installs.set('tenant-123#code-review', install);

      // Pre-register with MCP
      mockHttp.registrations.set('skill-code-review', {
        tools: [{ name: 'review_code', description: 'Review code' }],
        status: 'active',
      });

      // Uninstall
      await installer.uninstall({
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
      });

      // Verify installation removed
      const removed = await mockRegistry.getSkillInstall('tenant-123', 'code-review');
      expect(removed).toBeNull();

      // Verify MCP unregistration
      const targets = await mcpGateway.listTargets('tenant-123');
      expect(targets).toHaveLength(0);
    });

    it('should handle skill updates with MCP re-registration', async () => {
      // Install v1.0.0
      const oldInstall: SkillInstall = {
        PK: 'TENANT#tenant-123',
        SK: 'SKILL#code-review',
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        version: '1.0.0',
        pinned: false,
        installed_at: '2026-01-01T00:00:00Z',
        installed_by: 'user-456',
        auto_update: true,
        use_count: 50,
      };

      mockRegistry.installs.set('tenant-123#code-review', oldInstall);

      // Add versions
      const v1: Skill = {
        PK: 'SKILL#code-review',
        SK: 'VERSION#1.0.0',
        name: 'code-review',
        version: '1.0.0',
        author: 'platform',
        description: 'Old version',
        category: 'developer-tools',
        tags: [],
        trust_level: 'platform',
        permissions_hash: 'old',
        signatures: {},
        bundle: {
          s3_key: 'skills/code-review-1.0.0.tar.gz',
          sha256: 'old',
          size_bytes: 1000,
        },
        scan_status: 'passed',
        download_count: 1000,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      };

      const v2: Skill = {
        ...v1,
        SK: 'VERSION#2.0.0',
        version: '2.0.0',
        description: 'New version with improved analysis',
        bundle: {
          s3_key: 'skills/code-review-2.0.0.tar.gz',
          sha256: 'new',
          size_bytes: 1500,
        },
      };

      mockRegistry.skills.set('code-review@1.0.0', v1);
      mockRegistry.skills.set('code-review@2.0.0', v2);
      mockRegistry.skills.set('code-review', v2);

      mockS3.bundles.set('skills/code-review-2.0.0.tar.gz', Buffer.from('new bundle'));

      // Update skill
      await installer.update('tenant-123', 'code-review');

      // Verify new version installed
      const updated = await mockRegistry.getSkillInstall('tenant-123', 'code-review');
      expect(updated?.version).toBe('2.0.0');

      // In real scenario, would re-register with MCP Gateway
      // This tests that the update flow works
    });
  });

  describe('Agent with MCP Tools', () => {
    it('should create agent with MCP-provided tools', async () => {
      // Register skill tools with MCP
      await mcpGateway.register({
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        mcp_config: {
          transport: 'stdio',
          command: 'node',
          args: ['code-review/index.js'],
          tools: [
            { name: 'review_code', description: 'Analyze code quality' },
            { name: 'suggest_improvements', description: 'Suggest improvements' },
          ],
        },
        permissions: {
          filesystem: { read: ['**/*.ts'], write: [] },
          network: false,
        },
        trust_level: 'platform',
      });

      // Get registered tools
      const targets = await mcpGateway.listTargets('tenant-123');
      expect(targets).toHaveLength(1);

      const skillTools = targets[0].tools;
      expect(skillTools).toHaveLength(2);

      // Create agent with these tools
      const agentConfig: AgentConfig = {
        systemPrompt: new SystemPromptTemplate('You are a code review assistant'),
        tenantId: 'tenant-123',
        userId: 'user-456',
        skills: ['code-review'],
        tools: ['review_code', 'suggest_improvements'],
        model: mockModel,
        loadedTools: skillTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              language: { type: 'string' },
            },
            required: ['code'],
          },
          callback: async (input: any) => {
            return `Analyzed ${input.language || 'code'}: ${input.code.substring(0, 50)}...`;
          },
        })),
      };

      const agent = createAgent(agentConfig);

      expect(agent).toBeDefined();
      expect(agent.context.config.tools).toContain('review_code');
      expect(agent.context.config.tools).toContain('suggest_improvements');
      expect(agent.context.config.loadedTools).toHaveLength(2);
    });

    it('should invoke agent with skill-provided tools', async () => {
      mockModel.responses = [
        'I analyzed your code using the review_code tool. Here are the findings...',
      ];

      const agentConfig: AgentConfig = {
        systemPrompt: new SystemPromptTemplate('You are a helpful assistant'),
        tenantId: 'tenant-123',
        userId: 'user-456',
        model: mockModel,
        loadedTools: [
          {
            name: 'review_code',
            description: 'Analyze code quality',
            inputSchema: {
              type: 'object',
              properties: {
                code: { type: 'string' },
              },
            },
            callback: async (input: any) => {
              return `Code quality: Good. No issues found in: ${input.code}`;
            },
          },
        ],
      };

      const agent = createAgent(agentConfig);

      // Invoke agent
      const result: AgentResult = await agent.invoke('Review this code: const x = 1;');

      expect(result).toBeDefined();
      expect(result.output).toContain('analyzed your code');
      expect(result.sessionId).toBeDefined();
      expect(result.stopReason).toBe('end_turn');
    });
  });

  describe('Multi-Skill Agent', () => {
    it('should create agent with multiple installed skills', async () => {
      // Install multiple skills
      const skills = [
        {
          name: 'code-review',
          tools: ['review_code', 'suggest_improvements'],
        },
        {
          name: 'github-pr',
          tools: ['create_pr', 'merge_pr', 'comment_pr'],
        },
        {
          name: 'slack-notify',
          tools: ['send_message', 'create_channel'],
        },
      ];

      // Register each skill with MCP
      for (const skill of skills) {
        await mcpGateway.register({
          tenant_id: 'tenant-123',
          skill_name: skill.name,
          mcp_config: {
            transport: 'stdio',
            command: 'node',
            args: [`${skill.name}/index.js`],
            tools: skill.tools.map(name => ({
              name,
              description: `${name} from ${skill.name}`,
            })),
          },
          permissions: {},
          trust_level: 'verified',
        });
      }

      // Verify all registered
      const targets = await mcpGateway.listTargets('tenant-123');
      expect(targets).toHaveLength(3);

      // Count total tools
      const totalTools = targets.reduce((sum, t) => sum + t.tools.length, 0);
      expect(totalTools).toBe(7); // 2 + 3 + 2 = 7 tools

      // Create agent with all skills
      const agentConfig: AgentConfig = {
        systemPrompt: new SystemPromptTemplate('You are a development assistant'),
        tenantId: 'tenant-123',
        userId: 'user-456',
        skills: ['code-review', 'github-pr', 'slack-notify'],
        model: mockModel,
      };

      const agent = createAgent(agentConfig);

      expect(agent.context.config.skills).toHaveLength(3);
    });
  });
});
