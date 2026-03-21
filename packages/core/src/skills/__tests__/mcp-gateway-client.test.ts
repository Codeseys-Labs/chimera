/**
 * MCP Gateway Client Tests
 *
 * Validates MCP protocol integration with AgentCore Gateway
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  MCPGatewayClient,
  MCPGatewayConfig,
  HttpClient,
  MCPRegistrationResponse,
} from '../mcp-gateway-client';
import {
  MCPGatewayRegistration,
  SkillTrustLevel,
  SkillPermissions,
} from '@chimera/shared';

/**
 * Mock HTTP client for testing
 */
class MockHttpClient implements HttpClient {
  public requests: Array<{ method: string; url: string; body?: any; headers?: Record<string, string> }> = [];
  public responses: Map<string, any> = new Map();
  public shouldFail = false;
  public failureMessage = 'Network error';

  async post(url: string, body: any, headers?: Record<string, string>): Promise<any> {
    this.requests.push({ method: 'POST', url, body, headers });

    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }

    const response = this.responses.get(url);
    if (response) {
      return response;
    }

    // Default successful response
    return {
      target_id: body.target_name,
      tools: body.tools || [],
      status: 'active',
    };
  }

  async delete(url: string, headers?: Record<string, string>): Promise<any> {
    this.requests.push({ method: 'DELETE', url, headers });

    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }

    return { success: true };
  }

  async get(url: string, headers?: Record<string, string>): Promise<any> {
    this.requests.push({ method: 'GET', url, headers });

    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }

    const response = this.responses.get(url);
    if (response) {
      return response;
    }

    return { targets: [] };
  }

  reset(): void {
    this.requests = [];
    this.responses.clear();
    this.shouldFail = false;
  }
}

describe('MCPGatewayClient', () => {
  let client: MCPGatewayClient;
  let mockHttp: MockHttpClient;
  let config: MCPGatewayConfig;

  beforeEach(() => {
    mockHttp = new MockHttpClient();
    config = {
      gatewayEndpoint: 'https://gateway.example.com',
      apiKey: 'test-api-key',
      httpClient: mockHttp,
    };
    client = new MCPGatewayClient(config);
  });

  describe('register', () => {
    it('should register a skill with platform trust level', async () => {
      const registration: MCPGatewayRegistration = {
        tenant_id: 'tenant-123',
        skill_name: 'code-review',
        mcp_config: {
          transport: 'stdio',
          command: 'node',
          args: ['skill-code-review/index.js'],
          tools: [
            { name: 'review_code', description: 'Review code for quality' },
            { name: 'suggest_improvements', description: 'Suggest code improvements' },
          ],
        },
        permissions: {
          filesystem: {
            read: ['**/*.ts', '**/*.js'],
            write: [],
          },
          network: true,
        },
        trust_level: 'platform',
      };

      const response = await client.register(registration);

      expect(response.status).toBe('active');
      expect(response.target_id).toBe('skill-code-review');
      expect(response.tools).toHaveLength(2);
      expect(response.tools[0].name).toBe('review_code');

      // Verify HTTP request
      expect(mockHttp.requests).toHaveLength(1);
      const request = mockHttp.requests[0];
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://gateway.example.com/mcp/register');
      expect(request.headers?.['Authorization']).toBe('Bearer test-api-key');
      expect(request.body.tenant_id).toBe('tenant-123');
      expect(request.body.target_name).toBe('skill-code-review');
      expect(request.body.sandbox_config.filesystem.allow).toEqual(['**/*']); // Platform = unrestricted
      expect(request.body.sandbox_config.network).toBe(true);
    });

    it('should register a verified skill with declared permissions', async () => {
      const registration: MCPGatewayRegistration = {
        tenant_id: 'tenant-456',
        skill_name: 'github-pr',
        mcp_config: {
          transport: 'stdio',
          command: 'node',
          args: ['skill-github/index.js'],
          tools: [
            { name: 'create_pr', description: 'Create GitHub PR' },
          ],
        },
        permissions: {
          filesystem: {
            read: ['src/**/*.ts'],
            write: ['docs/**/*.md'],
          },
          network: { endpoints: ['https://api.github.com'] },
        },
        trust_level: 'verified',
      };

      const response = await client.register(registration);

      expect(response.status).toBe('active');

      // Verify sandbox config respects declared permissions
      const request = mockHttp.requests[0];
      expect(request.body.sandbox_config.filesystem.read).toEqual(['src/**/*.ts']);
      expect(request.body.sandbox_config.filesystem.write).toEqual(['docs/**/*.md']);
      expect(request.body.sandbox_config.network).toEqual({ endpoints: ['https://api.github.com'] }); // Network config passed through
      expect(request.body.sandbox_config.max_tool_calls).toBe(200);
    });

    it('should register a community skill with restrictive sandbox', async () => {
      const registration: MCPGatewayRegistration = {
        tenant_id: 'tenant-789',
        skill_name: 'test-utils',
        mcp_config: {
          transport: 'stdio',
          command: 'python3',
          args: ['skill-test/main.py'],
          tools: [
            { name: 'run_test', description: 'Run tests' },
          ],
        },
        permissions: {},
        trust_level: 'community',
      };

      const response = await client.register(registration);

      expect(response.status).toBe('active');

      // Verify community restrictions
      const request = mockHttp.requests[0];
      expect(request.body.sandbox_config.filesystem.read).toEqual(['/tmp/**']);
      expect(request.body.sandbox_config.filesystem.write).toEqual(['/tmp/**']);
      expect(request.body.sandbox_config.network).toBe(false);
      expect(request.body.sandbox_config.max_tool_calls).toBe(50);
    });

    it('should register an experimental skill with strict limits', async () => {
      const registration: MCPGatewayRegistration = {
        tenant_id: 'tenant-exp',
        skill_name: 'experimental-tool',
        mcp_config: {
          transport: 'stdio',
          command: 'node',
          args: ['tool.js'],
          tools: [{ name: 'test_tool', description: 'Experimental tool' }],
        },
        permissions: {},
        trust_level: 'experimental',
      };

      const response = await client.register(registration);

      expect(response.status).toBe('active');

      // Verify experimental restrictions
      const request = mockHttp.requests[0];
      expect(request.body.sandbox_config.filesystem.read).toEqual(['/tmp/**']);
      expect(request.body.sandbox_config.filesystem.write).toEqual(['/tmp/**']);
      expect(request.body.sandbox_config.network).toBe(false);
      expect(request.body.sandbox_config.max_tool_calls).toBe(10); // Very restricted
    });

    it('should handle registration failures gracefully', async () => {
      mockHttp.shouldFail = true;
      mockHttp.failureMessage = 'Gateway unreachable';

      const registration: MCPGatewayRegistration = {
        tenant_id: 'tenant-123',
        skill_name: 'failing-skill',
        mcp_config: {
          transport: 'stdio',
          command: 'node',
          args: ['skill.js'],
          tools: [],
        },
        permissions: {},
        trust_level: 'community',
      };

      const response = await client.register(registration);

      expect(response.status).toBe('error');
      expect(response.message).toContain('Gateway unreachable');
      expect(response.tools).toEqual([]);
    });

    it('should build Cedar policies for skill permissions', async () => {
      const registration: MCPGatewayRegistration = {
        tenant_id: 'tenant-123',
        skill_name: 'secure-skill',
        mcp_config: {
          transport: 'stdio',
          command: 'node',
          args: ['skill.js'],
          tools: [],
        },
        permissions: {
          filesystem: {
            read: ['config/*.json'],
            write: ['logs/*.log'],
          },
          network: { endpoints: ['https://api.example.com'] },
          shell: {
            allowed: ['git', 'npm'],
            denied: ['rm', 'sudo'],
          },
        },
        trust_level: 'verified',
      };

      await client.register(registration);

      const request = mockHttp.requests[0];
      const cedarPolicies = request.body.cedar_policies;

      expect(cedarPolicies.policies).toHaveLength(1);
      expect(cedarPolicies.policies[0].effect).toBe('permit');
      expect(cedarPolicies.policies[0].principal).toBe('SkillTrustLevel::verified');
      expect(cedarPolicies.policies[0].action).toBe('invoke_tool');

      // Verify conditions include permission constraints
      const conditions = cedarPolicies.policies[0].conditions;
      expect(conditions.filesystem.read_allowed).toEqual(['config/*.json']);
      expect(conditions.filesystem.write_allowed).toEqual(['logs/*.log']);
      expect(conditions.network.endpoints_allowed).toEqual(['https://api.example.com']);
      expect(conditions.shell.commands_allowed).toEqual(['git', 'npm']);
      expect(conditions.shell.commands_denied).toEqual(['rm', 'sudo']);
    });
  });

  describe('unregister', () => {
    it('should unregister a skill from gateway', async () => {
      await client.unregister('tenant-123', 'code-review');

      expect(mockHttp.requests).toHaveLength(1);
      const request = mockHttp.requests[0];
      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://gateway.example.com/mcp/unregister');
      expect(request.body.tenant_id).toBe('tenant-123');
      expect(request.body.target_name).toBe('skill-code-review');
    });

    it('should handle unregister failures', async () => {
      mockHttp.shouldFail = true;

      await expect(
        client.unregister('tenant-123', 'code-review')
      ).rejects.toThrow('Network error');
    });
  });

  describe('listTargets', () => {
    it('should list registered MCP targets for tenant', async () => {
      mockHttp.responses.set(
        'https://gateway.example.com/mcp/list?tenant_id=tenant-123',
        {
          targets: [
            {
              target_name: 'skill-code-review',
              tools: [
                { name: 'review_code', description: 'Review code' },
              ],
            },
            {
              target_name: 'skill-github-pr',
              tools: [
                { name: 'create_pr', description: 'Create PR' },
              ],
            },
          ],
        }
      );

      const targets = await client.listTargets('tenant-123');

      expect(targets).toHaveLength(2);
      expect(targets[0].target_name).toBe('skill-code-review');
      expect(targets[1].target_name).toBe('skill-github-pr');

      const request = mockHttp.requests[0];
      expect(request.method).toBe('GET');
      expect(request.url).toContain('tenant_id=tenant-123');
    });

    it('should return empty array when no targets registered', async () => {
      const targets = await client.listTargets('tenant-empty');

      expect(targets).toEqual([]);
    });
  });

  describe('getTargetStatus', () => {
    it('should get status of registered target', async () => {
      mockHttp.responses.set(
        'https://gateway.example.com/mcp/status?tenant_id=tenant-123&target_name=skill-code-review',
        {
          status: 'active',
        }
      );

      const status = await client.getTargetStatus('tenant-123', 'skill-code-review');

      expect(status.status).toBe('active');

      const request = mockHttp.requests[0];
      expect(request.method).toBe('GET');
      expect(request.url).toContain('tenant_id=tenant-123');
      expect(request.url).toContain('target_name=skill-code-review');
    });

    it('should return error status for failed targets', async () => {
      mockHttp.responses.set(
        'https://gateway.example.com/mcp/status?tenant_id=tenant-123&target_name=skill-broken',
        {
          status: 'error',
          message: 'MCP server crashed',
        }
      );

      const status = await client.getTargetStatus('tenant-123', 'skill-broken');

      expect(status.status).toBe('error');
      expect(status.message).toBe('MCP server crashed');
    });
  });

  describe('authentication', () => {
    it('should include Authorization header when API key provided', async () => {
      const registration: MCPGatewayRegistration = {
        tenant_id: 'tenant-123',
        skill_name: 'test-skill',
        mcp_config: {
          transport: 'stdio',
          command: 'node',
          args: ['skill.js'],
          tools: [],
        },
        permissions: {},
        trust_level: 'community',
      };

      await client.register(registration);

      const request = mockHttp.requests[0];
      expect(request.headers?.['Authorization']).toBe('Bearer test-api-key');
    });

    it('should work without API key', async () => {
      const noAuthClient = new MCPGatewayClient({
        gatewayEndpoint: 'https://gateway.example.com',
        httpClient: mockHttp,
      });

      const registration: MCPGatewayRegistration = {
        tenant_id: 'tenant-123',
        skill_name: 'test-skill',
        mcp_config: {
          transport: 'stdio',
          command: 'node',
          args: ['skill.js'],
          tools: [],
        },
        permissions: {},
        trust_level: 'community',
      };

      await noAuthClient.register(registration);

      const request = mockHttp.requests[0];
      expect(request.headers?.['Authorization']).toBeUndefined();
      expect(request.headers?.['Content-Type']).toBe('application/json');
    });
  });
});
