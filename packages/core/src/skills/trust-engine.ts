/**
 * Skill Trust Engine
 *
 * Cedar-based policy enforcement for skill permissions
 * Implements the 5-tier trust model with runtime permission checking
 */

import { SkillTrustLevel, SkillPermissions } from '@chimera/shared';

/**
 * Action type for Cedar policy evaluation
 */
export type ActionType =
  | 'file_read'
  | 'file_write'
  | 'network_access'
  | 'run_shell'
  | 'read_memory'
  | 'write_memory'
  | 'read_secret'
  | 'invoke_tool';

/**
 * Resource context for Cedar policy evaluation
 */
export interface ResourceContext {
  type: 'file' | 'network' | 'command' | 'memory' | 'secret' | 'tool';
  path?: string; // For file operations
  endpoint?: string; // For network operations
  command?: string; // For shell operations
  category?: string; // For memory operations
  arn?: string; // For secret operations
  toolName?: string; // For tool invocations
}

/**
 * Principal context (who is requesting the action)
 */
export interface PrincipalContext {
  skillName: string;
  trustLevel: SkillTrustLevel;
  tenantId: string;
  sessionId: string;
  permissions: SkillPermissions;
}

/**
 * Authorization result
 */
export interface AuthorizationResult {
  decision: 'permit' | 'deny';
  reason?: string;
  applicable_policies?: string[];
}

/**
 * Trust Engine Configuration
 */
export interface TrustEngineConfig {
  /** Enable strict mode (deny-by-default) */
  strictMode?: boolean;

  /** Log authorization decisions */
  auditLog?: boolean;
}

/**
 * Skill Trust Engine
 *
 * Enforces Cedar-based authorization policies for skill actions
 */
export class SkillTrustEngine {
  private config: TrustEngineConfig;

  constructor(config: TrustEngineConfig = {}) {
    this.config = {
      strictMode: config.strictMode !== false, // Default: true
      auditLog: config.auditLog || false,
    };
  }

  /**
   * Authorize an action
   *
   * Evaluates Cedar policies to determine if principal can perform action on resource
   *
   * @param principal - Principal context (skill + tenant)
   * @param action - Action type
   * @param resource - Resource context
   * @returns Authorization result
   */
  authorize(
    principal: PrincipalContext,
    action: ActionType,
    resource: ResourceContext
  ): AuthorizationResult {
    // Platform skills have unrestricted access
    if (principal.trustLevel === 'platform') {
      return this.permit('Platform skill has unrestricted access');
    }

    // Route to specific authorizer based on action
    switch (action) {
      case 'file_read':
        return this.authorizeFileRead(principal, resource);
      case 'file_write':
        return this.authorizeFileWrite(principal, resource);
      case 'network_access':
        return this.authorizeNetworkAccess(principal, resource);
      case 'run_shell':
        return this.authorizeShellCommand(principal, resource);
      case 'read_memory':
        return this.authorizeMemoryRead(principal, resource);
      case 'write_memory':
        return this.authorizeMemoryWrite(principal, resource);
      case 'read_secret':
        return this.authorizeSecretRead(principal, resource);
      case 'invoke_tool':
        return this.authorizeToolInvocation(principal, resource);
      default:
        return this.deny(`Unknown action type: ${action}`);
    }
  }

  /**
   * Authorize file read operation
   */
  private authorizeFileRead(
    principal: PrincipalContext,
    resource: ResourceContext
  ): AuthorizationResult {
    if (!resource.path) {
      return this.deny('Resource path missing');
    }

    const { trustLevel, permissions } = principal;

    // Community and experimental: only /tmp
    if (trustLevel === 'community' || trustLevel === 'experimental') {
      if (!resource.path.startsWith('/tmp/')) {
        return this.deny(`${trustLevel} skills can only read from /tmp`);
      }
      return this.permit('Allowed: /tmp access');
    }

    // Verified and private: check declared permissions
    if (trustLevel === 'verified' || trustLevel === 'private') {
      if (!permissions.filesystem?.read) {
        return this.deny('No filesystem read permissions declared');
      }

      for (const pattern of permissions.filesystem.read) {
        if (this.matchGlob(resource.path, pattern)) {
          return this.permit(`Matched declared pattern: ${pattern}`);
        }
      }

      return this.deny(
        `Path "${resource.path}" not in declared read permissions`
      );
    }

    return this.deny('Unexpected trust level');
  }

  /**
   * Authorize file write operation
   */
  private authorizeFileWrite(
    principal: PrincipalContext,
    resource: ResourceContext
  ): AuthorizationResult {
    if (!resource.path) {
      return this.deny('Resource path missing');
    }

    const { trustLevel, permissions } = principal;

    // Community and experimental: only /tmp
    if (trustLevel === 'community' || trustLevel === 'experimental') {
      if (!resource.path.startsWith('/tmp/')) {
        return this.deny(`${trustLevel} skills can only write to /tmp`);
      }
      return this.permit('Allowed: /tmp access');
    }

    // Verified and private: check declared permissions
    if (trustLevel === 'verified' || trustLevel === 'private') {
      if (!permissions.filesystem?.write) {
        return this.deny('No filesystem write permissions declared');
      }

      for (const pattern of permissions.filesystem.write) {
        if (this.matchGlob(resource.path, pattern)) {
          return this.permit(`Matched declared pattern: ${pattern}`);
        }
      }

      return this.deny(
        `Path "${resource.path}" not in declared write permissions`
      );
    }

    return this.deny('Unexpected trust level');
  }

  /**
   * Authorize network access
   */
  private authorizeNetworkAccess(
    principal: PrincipalContext,
    resource: ResourceContext
  ): AuthorizationResult {
    if (!resource.endpoint) {
      return this.deny('Resource endpoint missing');
    }

    const { trustLevel, permissions } = principal;

    // Community and experimental: no network
    if (trustLevel === 'community' || trustLevel === 'experimental') {
      return this.deny(`${trustLevel} skills cannot access network`);
    }

    // Verified and private: check declared permissions
    if (trustLevel === 'verified' || trustLevel === 'private') {
      if (!permissions.network) {
        return this.deny('No network permissions declared');
      }

      if (permissions.network === true) {
        return this.permit('Unrestricted network access declared');
      }

      if (typeof permissions.network === 'object' && permissions.network.endpoints) {
        for (const allowed of permissions.network.endpoints) {
          if (resource.endpoint.startsWith(allowed)) {
            return this.permit(`Matched declared endpoint: ${allowed}`);
          }
        }
      }

      return this.deny(
        `Endpoint "${resource.endpoint}" not in declared network permissions`
      );
    }

    return this.deny('Unexpected trust level');
  }

  /**
   * Authorize shell command execution
   */
  private authorizeShellCommand(
    principal: PrincipalContext,
    resource: ResourceContext
  ): AuthorizationResult {
    if (!resource.command) {
      return this.deny('Resource command missing');
    }

    const { trustLevel, permissions } = principal;

    // Community and experimental: no shell
    if (trustLevel === 'community' || trustLevel === 'experimental') {
      return this.deny(`${trustLevel} skills cannot execute shell commands`);
    }

    // Verified and private: check declared permissions
    if (trustLevel === 'verified' || trustLevel === 'private') {
      if (!permissions.shell) {
        return this.deny('No shell permissions declared');
      }

      // Check denied list first
      if (permissions.shell.denied) {
        for (const denied of permissions.shell.denied) {
          if (resource.command.includes(denied)) {
            return this.deny(`Command contains denied pattern: ${denied}`);
          }
        }
      }

      // Check allowed list
      if (permissions.shell.allowed) {
        for (const allowed of permissions.shell.allowed) {
          if (resource.command.startsWith(allowed)) {
            return this.permit(`Matched declared command: ${allowed}`);
          }
        }
      }

      return this.deny(
        `Command "${resource.command}" not in declared shell permissions`
      );
    }

    return this.deny('Unexpected trust level');
  }

  /**
   * Authorize memory read
   */
  private authorizeMemoryRead(
    principal: PrincipalContext,
    resource: ResourceContext
  ): AuthorizationResult {
    const { trustLevel, permissions } = principal;

    // Community and experimental: no memory
    if (trustLevel === 'community' || trustLevel === 'experimental') {
      return this.deny(`${trustLevel} skills cannot access memory`);
    }

    // Verified and private: check declared permissions
    if (trustLevel === 'verified' || trustLevel === 'private') {
      if (!permissions.memory?.read) {
        return this.deny('No memory read permissions declared');
      }

      return this.permit('Memory read allowed');
    }

    return this.deny('Unexpected trust level');
  }

  /**
   * Authorize memory write
   */
  private authorizeMemoryWrite(
    principal: PrincipalContext,
    resource: ResourceContext
  ): AuthorizationResult {
    if (!resource.category) {
      return this.deny('Resource category missing');
    }

    const { trustLevel, permissions } = principal;

    // Community and experimental: no memory
    if (trustLevel === 'community' || trustLevel === 'experimental') {
      return this.deny(`${trustLevel} skills cannot access memory`);
    }

    // Verified and private: check declared permissions
    if (trustLevel === 'verified' || trustLevel === 'private') {
      if (!permissions.memory?.write) {
        return this.deny('No memory write permissions declared');
      }

      if (permissions.memory.write.includes(resource.category)) {
        return this.permit(`Matched declared category: ${resource.category}`);
      }

      return this.deny(
        `Category "${resource.category}" not in declared memory write permissions`
      );
    }

    return this.deny('Unexpected trust level');
  }

  /**
   * Authorize secret read
   */
  private authorizeSecretRead(
    principal: PrincipalContext,
    resource: ResourceContext
  ): AuthorizationResult {
    if (!resource.arn) {
      return this.deny('Resource ARN missing');
    }

    const { trustLevel, permissions } = principal;

    // Community and experimental: no secrets
    if (trustLevel === 'community' || trustLevel === 'experimental') {
      return this.deny(`${trustLevel} skills cannot access secrets`);
    }

    // Verified and private: check declared permissions
    if (trustLevel === 'verified' || trustLevel === 'private') {
      if (!permissions.secrets) {
        return this.deny('No secrets permissions declared');
      }

      if (permissions.secrets.includes(resource.arn)) {
        return this.permit(`Matched declared ARN: ${resource.arn}`);
      }

      return this.deny(`ARN "${resource.arn}" not in declared secrets permissions`);
    }

    return this.deny('Unexpected trust level');
  }

  /**
   * Authorize tool invocation
   */
  private authorizeToolInvocation(
    principal: PrincipalContext,
    resource: ResourceContext
  ): AuthorizationResult {
    // All trust levels can invoke their own tools
    // Tool call limits are enforced by sandbox config
    return this.permit('Tool invocation allowed');
  }

  /**
   * Create permit result
   */
  private permit(reason: string): AuthorizationResult {
    if (this.config.auditLog) {
      console.log(`[Trust Engine] PERMIT: ${reason}`);
    }

    return {
      decision: 'permit',
      reason,
    };
  }

  /**
   * Create deny result
   */
  private deny(reason: string): AuthorizationResult {
    if (this.config.auditLog) {
      console.log(`[Trust Engine] DENY: ${reason}`);
    }

    return {
      decision: 'deny',
      reason,
    };
  }

  /**
   * Match glob pattern (simplified implementation)
   *
   * Real implementation would use a proper glob library like minimatch
   */
  private matchGlob(path: string, pattern: string): boolean {
    // Replace glob patterns with placeholders first
    let regexPattern = pattern
      .replace(/\*\*/g, '<!DOUBLESTAR!>') // ** → temporary placeholder
      .replace(/\*/g, '<!STAR!>') // * → temporary placeholder
      .replace(/\?/g, '<!QUESTION!>'); // ? → temporary placeholder

    // Escape special regex characters
    regexPattern = regexPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

    // Replace placeholders with regex equivalents
    regexPattern = regexPattern
      .replace(/<!DOUBLESTAR!>/g, '.*') // ** matches anything including /
      .replace(/<!STAR!>/g, '[^/]*') // * matches anything except /
      .replace(/<!QUESTION!>/g, '[^/]'); // ? matches single char except /

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(path);
  }
}
