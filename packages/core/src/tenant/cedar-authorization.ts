/**
 * Cedar Authorization
 *
 * AWS Cedar policy engine integration for fine-grained access control
 * Implements User-Tenant-Operation (UTO) authorization model
 */

import { TenantContext } from './tenant-router';

/**
 * Cedar policy action
 */
export interface CedarAction {
  type: string; // e.g., "Agent::Invoke", "Session::Create", "Skill::Install"
  id: string; // Action identifier
}

/**
 * Cedar policy resource
 */
export interface CedarResource {
  type: string; // e.g., "Agent", "Session", "Skill"
  id: string; // Resource identifier
  attributes?: Record<string, unknown>; // Additional resource metadata
}

/**
 * Cedar authorization request
 */
export interface AuthorizationRequest {
  principal: {
    type: 'User';
    id: string; // userId
  };
  action: CedarAction;
  resource: CedarResource;
  context: {
    tenantId: string;
    userGroups: string[];
    isAdmin: boolean;
    timestamp: string;
    [key: string]: unknown; // Additional context
  };
}

/**
 * Cedar authorization decision
 */
export type AuthorizationDecision = 'Allow' | 'Deny';

/**
 * Cedar authorization result
 */
export interface AuthorizationResult {
  decision: AuthorizationDecision;
  reasons: string[]; // Policy IDs that contributed to the decision
  errors?: string[]; // Evaluation errors
}

/**
 * Cedar policy statement
 */
export interface CedarPolicy {
  id: string;
  effect: 'permit' | 'forbid';
  principal: string; // Cedar entity pattern (e.g., "User::*")
  action: string; // Cedar action pattern (e.g., "Agent::Invoke")
  resource: string; // Cedar resource pattern (e.g., "Agent::*")
  conditions?: string[]; // Cedar condition expressions
  description?: string;
}

/**
 * Built-in Cedar policies for multi-tenant isolation
 */
export const DEFAULT_POLICIES: CedarPolicy[] = [
  {
    id: 'cross-tenant-isolation',
    effect: 'forbid',
    principal: 'User::*',
    action: '*',
    resource: '*',
    conditions: ['context.tenantId != resource.tenantId'],
    description: 'Forbid cross-tenant access - users can only access resources in their own tenant',
  },
  {
    id: 'admin-full-access',
    effect: 'permit',
    principal: 'User::*',
    action: '*',
    resource: '*',
    conditions: ['context.isAdmin == true', 'context.tenantId == resource.tenantId'],
    description: 'Grant full access to tenant administrators within their tenant',
  },
  {
    id: 'user-read-own-sessions',
    effect: 'permit',
    principal: 'User::*',
    action: 'Session::Read',
    resource: 'Session::*',
    conditions: ['principal.id == resource.userId', 'context.tenantId == resource.tenantId'],
    description: 'Users can read their own sessions',
  },
  {
    id: 'user-create-sessions',
    effect: 'permit',
    principal: 'User::*',
    action: 'Session::Create',
    resource: 'Tenant::*',
    conditions: ['context.tenantId == resource.id'],
    description: 'Users can create sessions in their tenant',
  },
  {
    id: 'user-invoke-agents',
    effect: 'permit',
    principal: 'User::*',
    action: 'Agent::Invoke',
    resource: 'Agent::*',
    conditions: ['context.tenantId == resource.tenantId'],
    description: 'Users can invoke agents in their tenant',
  },
  {
    id: 'suspended-tenant-deny-all',
    effect: 'forbid',
    principal: 'User::*',
    action: '*',
    resource: '*',
    conditions: ['resource.tenantStatus == "SUSPENDED"'],
    description: 'Deny all operations on suspended tenants',
  },
  {
    id: 'trial-tier-skill-restriction',
    effect: 'forbid',
    principal: 'User::*',
    action: 'Skill::Install',
    resource: 'Skill::*',
    conditions: ['resource.tier == "TRIAL"', 'resource.skillType == "premium"'],
    description: 'Trial tenants cannot install premium skills',
  },
];

/**
 * Cedar Authorization Engine
 *
 * Evaluates Cedar policies for fine-grained access control:
 * - Cross-tenant isolation (CRITICAL: users can only access their tenant's resources)
 * - Role-based access control (admin, user, viewer)
 * - Resource-specific permissions (sessions, agents, skills)
 * - Tier-based feature gating (trial, basic, advanced, enterprise)
 */
export class CedarAuthorization {
  private policies: Map<string, CedarPolicy>;

  constructor(customPolicies: CedarPolicy[] = []) {
    this.policies = new Map();

    // Load default policies
    for (const policy of DEFAULT_POLICIES) {
      this.policies.set(policy.id, policy);
    }

    // Load custom policies (override defaults with same ID)
    for (const policy of customPolicies) {
      this.policies.set(policy.id, policy);
    }
  }

  /**
   * Authorize an action
   *
   * Evaluates all policies and returns authorization decision:
   * - If any 'forbid' policy matches → Deny
   * - If any 'permit' policy matches and no forbids → Allow
   * - Otherwise → Deny (default deny)
   *
   * @param request - Authorization request
   * @returns Authorization result
   */
  authorize(request: AuthorizationRequest): AuthorizationResult {
    const matchingPermits: string[] = [];
    const matchingForbids: string[] = [];
    const errors: string[] = [];

    // Evaluate all policies
    for (const [policyId, policy] of this.policies) {
      try {
        const matches = this.evaluatePolicy(policy, request);
        if (matches) {
          if (policy.effect === 'permit') {
            matchingPermits.push(policyId);
          } else if (policy.effect === 'forbid') {
            matchingForbids.push(policyId);
          }
        }
      } catch (error: any) {
        errors.push(`Policy ${policyId}: ${error.message}`);
      }
    }

    // Decision logic: forbids take precedence over permits
    if (matchingForbids.length > 0) {
      return {
        decision: 'Deny',
        reasons: matchingForbids,
        errors: errors.length > 0 ? errors : undefined,
      };
    }

    if (matchingPermits.length > 0) {
      return {
        decision: 'Allow',
        reasons: matchingPermits,
        errors: errors.length > 0 ? errors : undefined,
      };
    }

    // Default deny (no matching policies)
    return {
      decision: 'Deny',
      reasons: ['default-deny'],
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Evaluate a single policy against a request
   *
   * Checks if principal, action, resource patterns match,
   * then evaluates condition expressions
   *
   * @param policy - Cedar policy
   * @param request - Authorization request
   * @returns True if policy matches
   */
  private evaluatePolicy(policy: CedarPolicy, request: AuthorizationRequest): boolean {
    // Check principal pattern
    if (!this.matchesPattern(policy.principal, `${request.principal.type}::${request.principal.id}`)) {
      return false;
    }

    // Check action pattern
    if (!this.matchesPattern(policy.action, `${request.action.type}::${request.action.id}`)) {
      return false;
    }

    // Check resource pattern
    if (!this.matchesPattern(policy.resource, `${request.resource.type}::${request.resource.id}`)) {
      return false;
    }

    // Evaluate conditions
    if (policy.conditions) {
      for (const condition of policy.conditions) {
        if (!this.evaluateCondition(condition, request)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Match entity/action/resource pattern
   *
   * Supports wildcards:
   * - "*" matches everything
   * - "User::*" matches all users
   * - "Agent::Invoke" matches exact action
   *
   * @param pattern - Cedar pattern
   * @param value - Actual value
   * @returns True if matches
   */
  private matchesPattern(pattern: string, value: string): boolean {
    if (pattern === '*') {
      return true;
    }

    if (pattern.endsWith('::*')) {
      const prefix = pattern.slice(0, -3);
      return value.startsWith(prefix);
    }

    return pattern === value;
  }

  /**
   * Evaluate Cedar condition expression
   *
   * Simplified condition evaluator supporting:
   * - Equality: "context.tenantId == resource.tenantId"
   * - Inequality: "context.tenantId != resource.tenantId"
   * - Boolean: "context.isAdmin == true"
   * - String comparison: "resource.tier == 'TRIAL'"
   *
   * @param condition - Condition expression
   * @param request - Authorization request
   * @returns True if condition evaluates to true
   */
  private evaluateCondition(condition: string, request: AuthorizationRequest): boolean {
    // Parse condition (simplified - real Cedar has full expression parser)
    const operators = ['==', '!='];
    let operator: string | null = null;
    let left: string | null = null;
    let right: string | null = null;

    for (const op of operators) {
      const parts = condition.split(op).map((s) => s.trim());
      if (parts.length === 2) {
        operator = op;
        left = parts[0];
        right = parts[1];
        break;
      }
    }

    if (!operator || !left || !right) {
      throw new Error(`Invalid condition syntax: ${condition}`);
    }

    // Resolve left-hand side
    const leftValue = this.resolveValue(left, request);

    // Resolve right-hand side
    const rightValue = this.resolveValue(right, request);

    // Compare
    switch (operator) {
      case '==':
        return leftValue === rightValue;
      case '!=':
        return leftValue !== rightValue;
      default:
        throw new Error(`Unsupported operator: ${operator}`);
    }
  }

  /**
   * Resolve value from Cedar expression
   *
   * Supports:
   * - context.{field}
   * - principal.{field}
   * - resource.{field}
   * - Literal values: "string", true, false, numbers
   *
   * @param expr - Expression
   * @param request - Authorization request
   * @returns Resolved value
   */
  private resolveValue(expr: string, request: AuthorizationRequest): unknown {
    // Handle literals
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr.startsWith('"') && expr.endsWith('"')) {
      return expr.slice(1, -1); // Remove quotes
    }
    if (/^\d+$/.test(expr)) return parseInt(expr, 10);

    // Handle path expressions
    const parts = expr.split('.');
    if (parts.length < 2) {
      throw new Error(`Invalid expression: ${expr}`);
    }

    const [root, ...path] = parts;

    let obj: any;
    switch (root) {
      case 'context':
        obj = request.context;
        break;
      case 'principal':
        obj = request.principal;
        break;
      case 'resource':
        obj = { ...request.resource, ...request.resource.attributes };
        break;
      case 'action':
        obj = request.action;
        break;
      default:
        throw new Error(`Unknown root: ${root}`);
    }

    // Navigate path
    for (const key of path) {
      if (obj === null || obj === undefined) {
        return undefined;
      }
      obj = obj[key];
    }

    return obj;
  }

  /**
   * Build authorization request from tenant context
   *
   * Helper to construct request from router output
   *
   * @param context - Tenant context
   * @param action - Action to authorize
   * @param resource - Resource to access
   * @returns Authorization request
   */
  static buildRequest(
    context: TenantContext,
    action: CedarAction,
    resource: CedarResource
  ): AuthorizationRequest {
    return {
      principal: {
        type: 'User',
        id: context.userId,
      },
      action,
      resource,
      context: {
        tenantId: context.tenantId,
        userGroups: context.userGroups,
        isAdmin: context.isAdmin,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Add or update a policy
   *
   * @param policy - Cedar policy
   */
  addPolicy(policy: CedarPolicy): void {
    this.policies.set(policy.id, policy);
  }

  /**
   * Remove a policy
   *
   * @param policyId - Policy ID
   */
  removePolicy(policyId: string): void {
    this.policies.delete(policyId);
  }

  /**
   * Get all policies
   *
   * @returns Array of policies
   */
  getPolicies(): CedarPolicy[] {
    return Array.from(this.policies.values());
  }
}
