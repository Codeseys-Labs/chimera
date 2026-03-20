/**
 * Mock MCP Gateway Client for local development
 *
 * Provides in-memory implementation of MCP Gateway registration
 * for local development without requiring AgentCore Gateway infrastructure.
 */

import type {
  MCPGatewayRegistration,
  SkillPermissions,
  SkillTrustLevel,
} from '@chimera/shared';
import type {
  MCPTool,
  MCPRegistrationResponse,
} from '../skills/mcp-gateway-client';

/**
 * Registered MCP target information
 */
interface RegisteredTarget {
  tenantId: string;
  targetName: string;
  targetId: string;
  tools: MCPTool[];
  registration: MCPGatewayRegistration;
  registeredAt: string;
  status: 'active' | 'inactive' | 'error';
  errorMessage?: string;
}

/**
 * Mock MCP Gateway Client
 *
 * In-memory implementation of MCP Gateway for local development.
 * Maintains registry of MCP servers without actual process spawning.
 */
export class MockGatewayClient {
  private targets: Map<string, RegisteredTarget>;
  private targetCounter: number;

  constructor() {
    this.targets = new Map();
    this.targetCounter = 0;
  }

  /**
   * Register a skill as an MCP server
   *
   * @param registration - MCP Gateway registration request
   * @returns Registration response with tool list
   */
  async register(registration: MCPGatewayRegistration): Promise<MCPRegistrationResponse> {
    const { tenant_id, skill_name, mcp_config, permissions, trust_level } = registration;

    const targetName = `skill-${skill_name}`;
    const targetId = this.generateTargetId();

    // Validate tools are declared
    if (!mcp_config.tools || mcp_config.tools.length === 0) {
      return {
        target_id: targetId,
        tools: [],
        status: 'error',
        message: 'No tools declared in MCP config',
      };
    }

    // Create registered target
    const target: RegisteredTarget = {
      tenantId: tenant_id,
      targetName,
      targetId,
      tools: mcp_config.tools.map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      registration,
      registeredAt: new Date().toISOString(),
      status: 'active',
    };

    // Store by composite key: tenantId:targetName
    const key = this.buildTargetKey(tenant_id, targetName);
    this.targets.set(key, target);

    return {
      target_id: targetId,
      tools: target.tools,
      status: 'active',
    };
  }

  /**
   * Unregister a skill from MCP Gateway
   *
   * @param tenantId - Tenant identifier
   * @param skillName - Skill name
   */
  async unregister(tenantId: string, skillName: string): Promise<void> {
    const targetName = `skill-${skillName}`;
    const key = this.buildTargetKey(tenantId, targetName);

    const target = this.targets.get(key);
    if (target) {
      target.status = 'inactive';
      // Remove after grace period
      setTimeout(() => {
        this.targets.delete(key);
      }, 5000);
    }
  }

  /**
   * List registered MCP targets for tenant
   *
   * @param tenantId - Tenant identifier
   * @returns Array of registered targets
   */
  async listTargets(tenantId: string): Promise<Array<{ target_name: string; tools: MCPTool[] }>> {
    const results: Array<{ target_name: string; tools: MCPTool[] }> = [];

    for (const target of this.targets.values()) {
      if (target.tenantId === tenantId && target.status === 'active') {
        results.push({
          target_name: target.targetName,
          tools: target.tools,
        });
      }
    }

    return results;
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
    const key = this.buildTargetKey(tenantId, targetName);
    const target = this.targets.get(key);

    if (!target) {
      return {
        status: 'inactive',
        message: 'Target not registered',
      };
    }

    return {
      status: target.status,
      message: target.errorMessage,
    };
  }

  /**
   * Invoke an MCP tool (mock implementation)
   *
   * In local development, this returns a mock response rather than
   * actually executing the tool.
   *
   * @param tenantId - Tenant identifier
   * @param targetName - Target name
   * @param toolName - Tool name
   * @param input - Tool input parameters
   * @returns Tool execution result
   */
  async invokeTool(
    tenantId: string,
    targetName: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const key = this.buildTargetKey(tenantId, targetName);
    const target = this.targets.get(key);

    if (!target) {
      return {
        success: false,
        error: `Target not found: ${targetName}`,
      };
    }

    if (target.status !== 'active') {
      return {
        success: false,
        error: `Target not active: ${target.status}`,
      };
    }

    const tool = target.tools.find((t) => t.name === toolName);
    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${toolName}`,
      };
    }

    // Return mock successful response
    return {
      success: true,
      result: {
        tool: toolName,
        input,
        output: `Mock response for ${toolName}`,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Get all registered targets (for debugging)
   */
  getAllTargets(): RegisteredTarget[] {
    return Array.from(this.targets.values());
  }

  /**
   * Get target by key
   */
  getTarget(tenantId: string, targetName: string): RegisteredTarget | undefined {
    const key = this.buildTargetKey(tenantId, targetName);
    return this.targets.get(key);
  }

  /**
   * Clear all registered targets (for testing)
   */
  reset(): void {
    this.targets.clear();
    this.targetCounter = 0;
  }

  /**
   * Generate unique target ID
   */
  private generateTargetId(): string {
    this.targetCounter++;
    return `mock-target-${this.targetCounter}-${Date.now()}`;
  }

  /**
   * Build composite key for target storage
   */
  private buildTargetKey(tenantId: string, targetName: string): string {
    return `${tenantId}:${targetName}`;
  }

  /**
   * Get registration statistics (for monitoring)
   */
  getStats(): {
    totalTargets: number;
    activeTargets: number;
    inactiveTargets: number;
    errorTargets: number;
    totalTools: number;
  } {
    const targets = Array.from(this.targets.values());

    const stats = {
      totalTargets: targets.length,
      activeTargets: 0,
      inactiveTargets: 0,
      errorTargets: 0,
      totalTools: 0,
    };

    for (const target of targets) {
      stats.totalTools += target.tools.length;

      switch (target.status) {
        case 'active':
          stats.activeTargets++;
          break;
        case 'inactive':
          stats.inactiveTargets++;
          break;
        case 'error':
          stats.errorTargets++;
          break;
      }
    }

    return stats;
  }

  /**
   * Get targets by trust level
   */
  getTargetsByTrustLevel(trustLevel: SkillTrustLevel): RegisteredTarget[] {
    return Array.from(this.targets.values()).filter(
      (t) => t.registration.trust_level === trustLevel
    );
  }

  /**
   * Simulate tool execution failure (for testing error handling)
   */
  simulateToolError(tenantId: string, targetName: string, errorMessage: string): void {
    const key = this.buildTargetKey(tenantId, targetName);
    const target = this.targets.get(key);

    if (target) {
      target.status = 'error';
      target.errorMessage = errorMessage;
    }
  }

  /**
   * Restore target to active status (for testing recovery)
   */
  restoreTarget(tenantId: string, targetName: string): void {
    const key = this.buildTargetKey(tenantId, targetName);
    const target = this.targets.get(key);

    if (target) {
      target.status = 'active';
      target.errorMessage = undefined;
    }
  }
}
