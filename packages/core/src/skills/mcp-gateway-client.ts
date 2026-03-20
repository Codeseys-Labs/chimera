/**
 * MCP Gateway Client
 *
 * Client for registering skills with AgentCore Gateway as MCP servers
 * Manages skill-provided tools through the MCP protocol
 */

import {
  MCPGatewayRegistration,
  MCPServerConfig,
  SkillPermissions,
  SkillTrustLevel,
} from '@chimera/shared';

/**
 * MCP tool definition (from MCP protocol)
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

/**
 * MCP server registration response
 */
export interface MCPRegistrationResponse {
  target_id: string;
  tools: MCPTool[];
  status: 'active' | 'inactive' | 'error';
  message?: string;
}

/**
 * HTTP client interface (placeholder)
 */
export interface HttpClient {
  post(url: string, body: any, headers?: Record<string, string>): Promise<any>;
  delete(url: string, headers?: Record<string, string>): Promise<any>;
  get(url: string, headers?: Record<string, string>): Promise<any>;
}

/**
 * MCP Gateway configuration
 */
export interface MCPGatewayConfig {
  /** AgentCore Gateway API endpoint */
  gatewayEndpoint: string;

  /** API key for gateway authentication */
  apiKey?: string;

  /** HTTP client */
  httpClient: HttpClient;
}

/**
 * MCP Gateway Client
 *
 * Integrates with AgentCore Gateway to register skills as MCP servers
 */
export class MCPGatewayClient {
  private config: MCPGatewayConfig;

  constructor(config: MCPGatewayConfig) {
    this.config = config;
  }

  /**
   * Register a skill as an MCP server
   *
   * Workflow:
   * 1. Prepare MCP server configuration
   * 2. Generate sandbox config based on trust level
   * 3. Register with AgentCore Gateway
   * 4. Return tool list
   *
   * @param registration - MCP Gateway registration request
   * @returns Registration response with tool list
   */
  async register(
    registration: MCPGatewayRegistration
  ): Promise<MCPRegistrationResponse> {
    const { tenant_id, skill_name, mcp_config, permissions, trust_level } = registration;

    // Prepare registration payload
    const payload = {
      tenant_id,
      target_name: `skill-${skill_name}`,
      transport: mcp_config.transport,
      command: mcp_config.command,
      args: mcp_config.args,
      tools: mcp_config.tools,
      sandbox_config: this.buildSandboxConfig(trust_level, permissions),
      cedar_policies: this.buildCedarPolicies(trust_level, permissions),
    };

    // Call AgentCore Gateway API
    const endpoint = `${this.config.gatewayEndpoint}/mcp/register`;
    const headers = this.buildHeaders();

    try {
      const response = await this.config.httpClient.post(endpoint, payload, headers);

      return {
        target_id: response.target_id,
        tools: response.tools || mcp_config.tools.map((t: { name: string; description: string }) => ({ name: t.name, description: t.description })),
        status: 'active',
      };
    } catch (error: any) {
      return {
        target_id: `skill-${skill_name}`,
        tools: [],
        status: 'error',
        message: `Registration failed: ${error.message}`,
      };
    }
  }

  /**
   * Unregister a skill from MCP Gateway
   *
   * @param tenantId - Tenant identifier
   * @param skillName - Skill name
   */
  async unregister(tenantId: string, skillName: string): Promise<void> {
    const endpoint = `${this.config.gatewayEndpoint}/mcp/unregister`;
    const headers = this.buildHeaders();
    const payload = {
      tenant_id: tenantId,
      target_name: `skill-${skillName}`,
    };

    await this.config.httpClient.post(endpoint, payload, headers);
  }

  /**
   * List registered MCP targets for tenant
   *
   * @param tenantId - Tenant identifier
   * @returns Array of registered targets
   */
  async listTargets(tenantId: string): Promise<Array<{ target_name: string; tools: MCPTool[] }>> {
    const endpoint = `${this.config.gatewayEndpoint}/mcp/list?tenant_id=${tenantId}`;
    const headers = this.buildHeaders();

    const response = await this.config.httpClient.get(endpoint, headers);
    return response.targets || [];
  }

  /**
   * Get target status
   *
   * @param tenantId - Tenant identifier
   * @param targetName - Target name (e.g., "skill-code-review")
   * @returns Target status
   */
  async getTargetStatus(
    tenantId: string,
    targetName: string
  ): Promise<{ status: 'active' | 'inactive' | 'error'; message?: string }> {
    const endpoint = `${this.config.gatewayEndpoint}/mcp/status?tenant_id=${tenantId}&target_name=${targetName}`;
    const headers = this.buildHeaders();

    const response = await this.config.httpClient.get(endpoint, headers);
    return response;
  }

  /**
   * Build sandbox configuration based on trust level
   *
   * Maps trust level to isolation constraints:
   * - platform: unrestricted
   * - verified: declared permissions
   * - community: /tmp only, no network
   * - experimental: /tmp only, 10 tool call limit
   *
   * @param trustLevel - Skill trust level
   * @param permissions - Declared permissions
   * @returns Sandbox config object
   */
  private buildSandboxConfig(
    trustLevel: SkillTrustLevel,
    permissions: SkillPermissions
  ): any {
    const baseConfig = {
      memory_mb: 512,
      timeout_seconds: 30,
    };

    switch (trustLevel) {
      case 'platform':
        return {
          ...baseConfig,
          filesystem: { allow: ['**/*'] },
          network: true,
          max_tool_calls: null,
        };

      case 'verified':
        return {
          ...baseConfig,
          filesystem: {
            read: permissions.filesystem?.read || [],
            write: permissions.filesystem?.write || [],
          },
          network: permissions.network || false,
          max_tool_calls: 200,
        };

      case 'community':
        return {
          ...baseConfig,
          filesystem: {
            read: ['/tmp/**'],
            write: ['/tmp/**'],
          },
          network: false,
          max_tool_calls: 50,
        };

      case 'experimental':
        return {
          ...baseConfig,
          filesystem: {
            read: ['/tmp/**'],
            write: ['/tmp/**'],
          },
          network: false,
          max_tool_calls: 10,
        };

      case 'private':
        // Private skills use tenant-specific Cedar policies
        return {
          ...baseConfig,
          filesystem: permissions.filesystem || { read: [], write: [] },
          network: permissions.network || false,
          max_tool_calls: 200,
        };
    }
  }

  /**
   * Build Cedar policy set for skill
   *
   * @param trustLevel - Skill trust level
   * @param permissions - Declared permissions
   * @returns Cedar policy set (as JSON)
   */
  private buildCedarPolicies(
    trustLevel: SkillTrustLevel,
    permissions: SkillPermissions
  ): any {
    // Placeholder: would generate Cedar policy JSON
    // Based on design doc section 5.3 (Cedar Policy Enforcement)
    return {
      policies: [
        {
          effect: 'permit',
          principal: `SkillTrustLevel::${trustLevel}`,
          action: 'invoke_tool',
          resource: '*',
          conditions: this.buildConditions(trustLevel, permissions),
        },
      ],
    };
  }

  /**
   * Build Cedar policy conditions
   */
  private buildConditions(
    trustLevel: SkillTrustLevel,
    permissions: SkillPermissions
  ): any {
    const conditions: any = {};

    // Filesystem conditions
    if (permissions.filesystem) {
      conditions.filesystem = {
        read_allowed: permissions.filesystem.read || [],
        write_allowed: permissions.filesystem.write || [],
      };
    }

    // Network conditions
    if (permissions.network) {
      if (typeof permissions.network === 'object') {
        conditions.network = {
          endpoints_allowed: permissions.network.endpoints || [],
        };
      } else {
        conditions.network = { unrestricted: permissions.network };
      }
    }

    // Shell conditions
    if (permissions.shell) {
      conditions.shell = {
        commands_allowed: permissions.shell.allowed || [],
        commands_denied: permissions.shell.denied || [],
      };
    }

    return conditions;
  }

  /**
   * Build HTTP headers for gateway API
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }
}
