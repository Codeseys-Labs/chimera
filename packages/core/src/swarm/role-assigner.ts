/**
 * Role Assignment Engine
 *
 * Assigns optimal roles to agents in swarm execution based on task
 * characteristics, agent capabilities, and performance history.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

// Module-level singleton DynamoDB client
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

/**
 * Agent role types
 */
export type AgentRole =
  | 'planner'
  | 'researcher'
  | 'builder'
  | 'validator'
  | 'scout'
  | 'lead'
  | 'merger';

/**
 * Task characteristics that influence role assignment
 */
export interface TaskCharacteristics {
  complexity: 'simple' | 'moderate' | 'complex' | 'very_complex';
  domainKnowledge: 'none' | 'partial' | 'full';
  creativityRequired: 'low' | 'medium' | 'high';
  researchDepth: 'shallow' | 'moderate' | 'deep';
  implementationScope: 'small' | 'medium' | 'large';
  validationCriticality: 'low' | 'medium' | 'high' | 'critical';
  parallelizable: boolean;
  dependencies: string[];
}

/**
 * Agent capability profile
 */
export interface AgentCapabilities {
  agentId: string;
  supportedRoles: AgentRole[];
  specializations: string[];
  experienceLevel: 'novice' | 'intermediate' | 'expert';
  maxConcurrentTasks: number;
  currentLoad: number;
  successRate: number;
  avgTaskDuration: number;
}

/**
 * Role assignment record
 */
export interface RoleAssignment {
  assignmentId: string;
  tenantId: string;
  taskId: string;
  agentId: string;
  role: AgentRole;
  assignedAt: string;
  completedAt?: string;
  status: 'assigned' | 'active' | 'completed' | 'failed' | 'reassigned';
  performanceScore?: number;
  reasoningTrace: string[];
}

/**
 * Role assignment strategy result
 */
export interface RoleAssignmentResult {
  taskId: string;
  assignments: RoleAssignment[];
  strategy: 'single_agent' | 'multi_role' | 'parallel_swarm' | 'hierarchical';
  estimatedDuration: number;
  confidence: number;
}

/**
 * Agent performance metrics by role
 */
export interface RolePerformance {
  agentId: string;
  role: AgentRole;
  tasksCompleted: number;
  successRate: number;
  avgDuration: number;
  avgQualityScore: number;
  lastAssigned: string;
}

/**
 * Role assignment configuration
 */
export interface RoleAssignerConfig {
  /** DynamoDB table for role tracking */
  rolesTable: string;

  /** Enable performance-based reassignment */
  enableReassignment: boolean;

  /** Minimum performance score before reassignment */
  reassignmentThreshold: number;

  /** Enable load balancing across agents */
  enableLoadBalancing: boolean;

  /** Maximum load per agent before overflow */
  maxAgentLoad: number;

  /** Enable performance learning */
  enablePerformanceLearning: boolean;
}

/**
 * Role assignment engine for swarm orchestration
 */
export class RoleAssigner {
  private ddb: DynamoDBDocumentClient;
  private config: RoleAssignerConfig;

  constructor(config: RoleAssignerConfig) {
    this.config = config;
    this.ddb = ddbDocClient;
  }

  /**
   * Assign roles for a task based on characteristics
   */
  async assignRoles(params: {
    tenantId: string;
    taskId: string;
    characteristics: TaskCharacteristics;
    availableAgents: AgentCapabilities[];
  }): Promise<RoleAssignmentResult> {
    const { tenantId, taskId, characteristics, availableAgents } = params;

    // Determine required roles based on task characteristics
    const requiredRoles = this.determineRequiredRoles(characteristics);

    // Select assignment strategy
    const strategy = this.selectStrategy(characteristics, requiredRoles);

    // Assign agents to roles
    const assignments: RoleAssignment[] = [];
    const reasoningTrace: string[] = [];

    for (const role of requiredRoles) {
      const agent = await this.selectAgentForRole(
        role,
        availableAgents,
        tenantId,
        reasoningTrace
      );

      if (!agent) {
        reasoningTrace.push(`No suitable agent found for role: ${role}`);
        continue;
      }

      const assignment: RoleAssignment = {
        assignmentId: this.generateAssignmentId(),
        tenantId,
        taskId,
        agentId: agent.agentId,
        role,
        assignedAt: new Date().toISOString(),
        status: 'assigned',
        reasoningTrace: [...reasoningTrace],
      };

      // Store assignment
      await this.storeAssignment(assignment);

      // Update agent load
      await this.updateAgentLoad(agent.agentId, 1);

      assignments.push(assignment);
      reasoningTrace.push(`Assigned ${agent.agentId} to role ${role}`);
    }

    // Estimate completion time
    const estimatedDuration = this.estimateTaskDuration(characteristics, assignments);

    // Calculate confidence score
    const confidence = this.calculateAssignmentConfidence(assignments, availableAgents);

    return {
      taskId,
      assignments,
      strategy,
      estimatedDuration,
      confidence,
    };
  }

  /**
   * Get current role assignments for a task
   */
  async getTaskAssignments(params: {
    tenantId: string;
    taskId: string;
  }): Promise<RoleAssignment[]> {
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.config.rolesTable,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `TENANT#${params.tenantId}`,
          ':prefix': `TASK#${params.taskId}#ASSIGNMENT#`,
        },
      })
    );

    return (result.Items || []) as RoleAssignment[];
  }

  /**
   * Get agent performance history for a role
   */
  async getAgentRolePerformance(params: {
    agentId: string;
    role: AgentRole;
  }): Promise<RolePerformance | null> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.config.rolesTable,
        Key: {
          PK: `AGENT#${params.agentId}`,
          SK: `ROLE#${params.role}`,
        },
      })
    );

    return result.Item ? (result.Item as RolePerformance) : null;
  }

  /**
   * Complete a role assignment and update performance
   */
  async completeAssignment(params: {
    assignmentId: string;
    tenantId: string;
    taskId: string;
    agentId: string;
    succeeded: boolean;
    duration: number;
    qualityScore?: number;
  }): Promise<void> {
    const { assignmentId, tenantId, taskId, agentId, succeeded, duration, qualityScore } = params;

    // Update assignment status
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.config.rolesTable,
        Key: {
          PK: `TENANT#${tenantId}`,
          SK: `TASK#${taskId}#ASSIGNMENT#${assignmentId}`,
        },
        UpdateExpression:
          'SET #status = :status, completedAt = :ts, performanceScore = :score',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': succeeded ? 'completed' : 'failed',
          ':ts': new Date().toISOString(),
          ':score': qualityScore || (succeeded ? 1.0 : 0.0),
        },
      })
    );

    // Update agent load
    await this.updateAgentLoad(agentId, -1);

    // Update performance metrics if learning is enabled
    if (this.config.enablePerformanceLearning) {
      const assignment = await this.getAssignment(tenantId, taskId, assignmentId);
      if (assignment) {
        await this.updateRolePerformance(agentId, assignment.role, succeeded, duration, qualityScore);
      }
    }
  }

  /**
   * Reassign role if performance is below threshold
   */
  async reassignIfNeeded(params: {
    tenantId: string;
    taskId: string;
    assignmentId: string;
    currentPerformance: number;
    availableAgents: AgentCapabilities[];
  }): Promise<RoleAssignment | null> {
    if (!this.config.enableReassignment) {
      return null;
    }

    if (params.currentPerformance >= this.config.reassignmentThreshold) {
      return null;
    }

    // Get current assignment
    const current = await this.getAssignment(params.tenantId, params.taskId, params.assignmentId);
    if (!current) {
      return null;
    }

    // Mark current as reassigned
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.config.rolesTable,
        Key: {
          PK: `TENANT#${params.tenantId}`,
          SK: `TASK#${params.taskId}#ASSIGNMENT#${params.assignmentId}`,
        },
        UpdateExpression: 'SET #status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': 'reassigned',
        },
      })
    );

    // Update agent load for old agent
    await this.updateAgentLoad(current.agentId, -1);

    // Select new agent
    const reasoningTrace: string[] = [
      `Reassigning from ${current.agentId} due to low performance: ${params.currentPerformance}`,
    ];

    const newAgent = await this.selectAgentForRole(
      current.role,
      params.availableAgents.filter((a) => a.agentId !== current.agentId),
      params.tenantId,
      reasoningTrace
    );

    if (!newAgent) {
      return null;
    }

    // Create new assignment
    const newAssignment: RoleAssignment = {
      assignmentId: this.generateAssignmentId(),
      tenantId: params.tenantId,
      taskId: params.taskId,
      agentId: newAgent.agentId,
      role: current.role,
      assignedAt: new Date().toISOString(),
      status: 'assigned',
      reasoningTrace,
    };

    await this.storeAssignment(newAssignment);
    await this.updateAgentLoad(newAgent.agentId, 1);

    return newAssignment;
  }

  // Private helper methods

  /**
   * Determine required roles based on task characteristics
   */
  private determineRequiredRoles(characteristics: TaskCharacteristics): AgentRole[] {
    const roles: AgentRole[] = [];

    // Complex tasks need planning
    if (characteristics.complexity !== 'simple') {
      roles.push('planner');
    }

    // Deep research needs researcher
    if (characteristics.researchDepth === 'deep' || characteristics.domainKnowledge === 'none') {
      roles.push('researcher');
    }

    // Scout for quick exploration
    if (characteristics.domainKnowledge === 'partial') {
      roles.push('scout');
    }

    // Builder for implementation
    if (characteristics.implementationScope !== 'small' || !roles.includes('scout')) {
      roles.push('builder');
    }

    // Validator for critical tasks
    if (characteristics.validationCriticality !== 'low') {
      roles.push('validator');
    }

    // Lead for coordination on complex multi-role tasks
    if (roles.length > 2) {
      roles.unshift('lead');
    }

    return roles;
  }

  /**
   * Select assignment strategy
   */
  private selectStrategy(
    characteristics: TaskCharacteristics,
    requiredRoles: AgentRole[]
  ): 'single_agent' | 'multi_role' | 'parallel_swarm' | 'hierarchical' {
    // Single agent for simple tasks
    if (characteristics.complexity === 'simple' && requiredRoles.length === 1) {
      return 'single_agent';
    }

    // Hierarchical for very complex tasks with lead
    if (requiredRoles.includes('lead')) {
      return 'hierarchical';
    }

    // Parallel swarm for parallelizable tasks
    if (characteristics.parallelizable && requiredRoles.length > 2) {
      return 'parallel_swarm';
    }

    // Multi-role for everything else
    return 'multi_role';
  }

  /**
   * Select best agent for a role
   */
  private async selectAgentForRole(
    role: AgentRole,
    availableAgents: AgentCapabilities[],
    tenantId: string,
    reasoningTrace: string[]
  ): Promise<AgentCapabilities | null> {
    // Filter agents that support this role
    const capable = availableAgents.filter((a) => a.supportedRoles.includes(role));

    if (capable.length === 0) {
      reasoningTrace.push(`No agents support role: ${role}`);
      return null;
    }

    // Filter by load if load balancing is enabled
    let candidates = capable;
    if (this.config.enableLoadBalancing) {
      candidates = capable.filter((a) => a.currentLoad < this.config.maxAgentLoad);
      if (candidates.length === 0) {
        reasoningTrace.push(`All agents at max load for role: ${role}`);
        candidates = capable; // Fall back to all capable agents
      }
    }

    // Get performance history for each candidate
    const candidatesWithPerf = await Promise.all(
      candidates.map(async (agent) => {
        const perf = await this.getAgentRolePerformance({ agentId: agent.agentId, role });
        return { agent, perf };
      })
    );

    // Score candidates
    const scored = candidatesWithPerf.map(({ agent, perf }) => {
      let score = 0;

      // Base score from agent success rate
      score += agent.successRate * 40;

      // Role-specific performance
      if (perf) {
        score += perf.successRate * 30;
        score += Math.max(0, 20 - perf.avgDuration / 1000) * 20; // Faster is better
        score += (perf.avgQualityScore || 0.5) * 10;
      } else {
        score += 15; // Give new role assignments a moderate score
      }

      // Load balancing bonus (prefer less loaded agents)
      const loadFactor = 1 - agent.currentLoad / this.config.maxAgentLoad;
      score += loadFactor * 10;

      return { agent, score };
    });

    // Sort by score
    scored.sort((a, b) => b.score - a.score);

    const selected = scored[0].agent;
    reasoningTrace.push(
      `Selected ${selected.agentId} for ${role} (score: ${scored[0].score.toFixed(1)}, load: ${selected.currentLoad})`
    );

    return selected;
  }

  /**
   * Estimate task duration based on assignments
   */
  private estimateTaskDuration(
    characteristics: TaskCharacteristics,
    assignments: RoleAssignment[]
  ): number {
    // Base duration by complexity
    const baseDurations = {
      simple: 300, // 5 minutes
      moderate: 900, // 15 minutes
      complex: 1800, // 30 minutes
      very_complex: 3600, // 60 minutes
    };

    let duration = baseDurations[characteristics.complexity];

    // Adjust for scope
    const scopeMultipliers = { small: 0.5, medium: 1.0, large: 2.0 };
    duration *= scopeMultipliers[characteristics.implementationScope];

    // Adjust for research depth
    if (characteristics.researchDepth === 'deep') {
      duration *= 1.5;
    }

    // Parallel execution reduces duration
    if (characteristics.parallelizable && assignments.length > 1) {
      duration /= Math.min(assignments.length, 3); // Max 3x speedup
    }

    return Math.round(duration);
  }

  /**
   * Calculate confidence in assignment quality
   */
  private calculateAssignmentConfidence(
    assignments: RoleAssignment[],
    availableAgents: AgentCapabilities[]
  ): number {
    if (assignments.length === 0) {
      return 0;
    }

    let totalConfidence = 0;

    for (const assignment of assignments) {
      const agent = availableAgents.find((a) => a.agentId === assignment.agentId);
      if (!agent) continue;

      // Base confidence from agent success rate
      let confidence = agent.successRate;

      // Reduce confidence if agent is heavily loaded
      if (agent.currentLoad >= this.config.maxAgentLoad * 0.8) {
        confidence *= 0.8;
      }

      totalConfidence += confidence;
    }

    return totalConfidence / assignments.length;
  }

  /**
   * Store role assignment
   */
  private async storeAssignment(assignment: RoleAssignment): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.config.rolesTable,
        Item: {
          PK: `TENANT#${assignment.tenantId}`,
          SK: `TASK#${assignment.taskId}#ASSIGNMENT#${assignment.assignmentId}`,
          ...assignment,
          GSI1PK: `AGENT#${assignment.agentId}`,
          GSI1SK: assignment.assignedAt,
        },
      })
    );
  }

  /**
   * Get assignment details
   */
  private async getAssignment(
    tenantId: string,
    taskId: string,
    assignmentId: string
  ): Promise<RoleAssignment | null> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.config.rolesTable,
        Key: {
          PK: `TENANT#${tenantId}`,
          SK: `TASK#${taskId}#ASSIGNMENT#${assignmentId}`,
        },
      })
    );

    return result.Item ? (result.Item as RoleAssignment) : null;
  }

  /**
   * Update agent current load
   */
  private async updateAgentLoad(agentId: string, delta: number): Promise<void> {
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.config.rolesTable,
        Key: {
          PK: `AGENT#${agentId}`,
          SK: 'PROFILE',
        },
        UpdateExpression: 'SET currentLoad = currentLoad + :delta',
        ExpressionAttributeValues: {
          ':delta': delta,
        },
      })
    );
  }

  /**
   * Update role performance metrics
   */
  private async updateRolePerformance(
    agentId: string,
    role: AgentRole,
    succeeded: boolean,
    duration: number,
    qualityScore?: number
  ): Promise<void> {
    const existing = await this.getAgentRolePerformance({ agentId, role });

    const performance: RolePerformance = existing
      ? {
          ...existing,
          tasksCompleted: existing.tasksCompleted + 1,
          successRate:
            (existing.successRate * existing.tasksCompleted + (succeeded ? 1 : 0)) /
            (existing.tasksCompleted + 1),
          avgDuration:
            (existing.avgDuration * existing.tasksCompleted + duration) /
            (existing.tasksCompleted + 1),
          avgQualityScore:
            (existing.avgQualityScore * existing.tasksCompleted + (qualityScore || 0.5)) /
            (existing.tasksCompleted + 1),
          lastAssigned: new Date().toISOString(),
        }
      : {
          agentId,
          role,
          tasksCompleted: 1,
          successRate: succeeded ? 1 : 0,
          avgDuration: duration,
          avgQualityScore: qualityScore || 0.5,
          lastAssigned: new Date().toISOString(),
        };

    await this.ddb.send(
      new PutCommand({
        TableName: this.config.rolesTable,
        Item: {
          PK: `AGENT#${agentId}`,
          SK: `ROLE#${role}`,
          ...performance,
        },
      })
    );
  }

  /**
   * Generate unique assignment ID
   */
  private generateAssignmentId(): string {
    return `asg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Create a role assigner instance
 */
export function createRoleAssigner(config: RoleAssignerConfig): RoleAssigner {
  return new RoleAssigner(config);
}
