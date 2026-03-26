/**
 * Cedar Provisioning Policies
 *
 * Cedar policy definitions and helpers for agent infrastructure provisioning.
 * Enforces cost limits, resource type restrictions, and change type authorization.
 */

import type { IaCChangeType } from '../evolution/types';

/**
 * Cedar policy evaluation context
 */
export interface CedarProvisioningContext {
  tenantId: string;
  tier: 'basic' | 'advanced' | 'premium';
  changeType: IaCChangeType;
  targetResourceType: string;
  estimatedMonthlyCostDelta: number;
  currentMonthlyCost: number;
  humanApproved: boolean;
  triggeredByCriticalAlarm?: boolean;
  healthStatus?: string;
}

/**
 * Cedar policy evaluation result
 */
export interface CedarProvisioningResult {
  decision: 'ALLOW' | 'DENY';
  reason?: string;
  requiresApproval: boolean;
  costThresholdExceeded: boolean;
  policyMatches: string[];
}

/**
 * Tenant tier configuration
 */
export interface TenantTierConfig {
  tier: 'basic' | 'advanced' | 'premium';
  maxMonthlyCost: number;
  autoApproveCostThreshold: number;
  maxDeploymentsPerHour: number;
  maxDeploymentsPerDay: number;
  allowedRegions: string[];
}

/**
 * Cedar policy templates for infrastructure provisioning
 */
export class CedarProvisioningPolicies {
  private tierConfigs: Record<string, TenantTierConfig> = {
    basic: {
      tier: 'basic',
      maxMonthlyCost: 500,
      autoApproveCostThreshold: 50,
      maxDeploymentsPerHour: 3,
      maxDeploymentsPerDay: 10,
      allowedRegions: ['us-east-1', 'us-west-2'],
    },
    advanced: {
      tier: 'advanced',
      maxMonthlyCost: 2000,
      autoApproveCostThreshold: 100,
      maxDeploymentsPerHour: 5,
      maxDeploymentsPerDay: 20,
      allowedRegions: ['us-east-1', 'us-west-2', 'eu-west-1'],
    },
    premium: {
      tier: 'premium',
      maxMonthlyCost: 10000,
      autoApproveCostThreshold: 200,
      maxDeploymentsPerHour: 10,
      maxDeploymentsPerDay: 50,
      allowedRegions: ['*'],
    },
  };

  /**
   * Evaluate provisioning request against Cedar policies
   */
  evaluateProvisioning(context: CedarProvisioningContext): CedarProvisioningResult {
    const policyMatches: string[] = [];
    const tierConfig = this.tierConfigs[context.tier];

    // Policy 1: Cost-based evaluation
    const costResult = this.evaluateCostPolicy(context, tierConfig);
    if (costResult.decision === 'DENY') {
      return costResult;
    }
    policyMatches.push(...costResult.policyMatches);

    // Policy 2: Change type evaluation
    const changeTypeResult = this.evaluateChangeTypePolicy(context);
    if (changeTypeResult.decision === 'DENY') {
      return changeTypeResult;
    }
    policyMatches.push(...changeTypeResult.policyMatches);

    // Policy 3: Resource type evaluation
    const resourceTypeResult = this.evaluateResourceTypePolicy(context);
    if (resourceTypeResult.decision === 'DENY') {
      return resourceTypeResult;
    }
    policyMatches.push(...resourceTypeResult.policyMatches);

    // Policy 4: Emergency self-healing (overrides other policies)
    if (context.triggeredByCriticalAlarm) {
      return {
        decision: 'ALLOW',
        reason: 'Emergency self-healing action',
        requiresApproval: false,
        costThresholdExceeded: false,
        policyMatches: ['emergency-self-heal'],
      };
    }

    // Aggregate results
    const costThresholdExceeded =
      context.estimatedMonthlyCostDelta >= tierConfig.autoApproveCostThreshold;

    const requiresApproval =
      costThresholdExceeded ||
      context.humanApproved === false && this.isHighRiskChange(context.changeType);

    return {
      decision: requiresApproval ? 'DENY' : 'ALLOW',
      reason: requiresApproval
        ? 'Change requires human approval'
        : 'Auto-approved within policy bounds',
      requiresApproval,
      costThresholdExceeded,
      policyMatches,
    };
  }

  /**
   * Evaluate cost-based policies
   */
  private evaluateCostPolicy(
    context: CedarProvisioningContext,
    tierConfig: TenantTierConfig
  ): CedarProvisioningResult {
    const policyMatches: string[] = [];

    // Policy 1.1: Auto-approve small changes
    if (context.estimatedMonthlyCostDelta < tierConfig.autoApproveCostThreshold) {
      policyMatches.push('cost-small-change-auto-approve');
    }

    // Policy 1.2: Tier-based cost limits
    const projectedCost = context.currentMonthlyCost + context.estimatedMonthlyCostDelta;
    if (projectedCost > tierConfig.maxMonthlyCost) {
      return {
        decision: 'DENY',
        reason: `Would exceed ${context.tier} tier cost quota ($${tierConfig.maxMonthlyCost}/month)`,
        requiresApproval: true,
        costThresholdExceeded: true,
        policyMatches: ['cost-quota-exceeded'],
      };
    }
    policyMatches.push('cost-within-quota');

    // Policy 1.3: Cost reduction always allowed
    if (context.estimatedMonthlyCostDelta <= 0) {
      return {
        decision: 'ALLOW',
        reason: 'Cost-saving change always permitted',
        requiresApproval: false,
        costThresholdExceeded: false,
        policyMatches: ['cost-reduction'],
      };
    }

    return {
      decision: 'ALLOW',
      requiresApproval: false,
      costThresholdExceeded: false,
      policyMatches,
    };
  }

  /**
   * Evaluate change type policies
   */
  private evaluateChangeTypePolicy(
    context: CedarProvisioningContext
  ): CedarProvisioningResult {
    const policyMatches: string[] = [];

    // Policy 2.1: Safe operations (auto-approve)
    const safeOperations: IaCChangeType[] = [
      'update_env_var',
      'rotate_secret',
      'update_config',
    ];

    if (safeOperations.includes(context.changeType)) {
      return {
        decision: 'ALLOW',
        reason: 'Safe operation type',
        requiresApproval: false,
        costThresholdExceeded: false,
        policyMatches: ['change-type-safe'],
      };
    }

    // Policy 2.2: Conditional approval for scaling
    if (context.changeType === 'scale_horizontal' || context.changeType === 'scale_vertical') {
      policyMatches.push('change-type-scaling');
      if (context.estimatedMonthlyCostDelta < 200) {
        return {
          decision: 'ALLOW',
          reason: 'Scaling within cost limits',
          requiresApproval: false,
          costThresholdExceeded: false,
          policyMatches,
        };
      }
    }

    // Policy 2.3: New resource provisioning (restricted)
    if (context.changeType === 'add_tool') {
      if (context.humanApproved) {
        return {
          decision: 'ALLOW',
          reason: 'Human-approved resource creation',
          requiresApproval: false,
          costThresholdExceeded: false,
          policyMatches: ['change-type-add-tool-approved'],
        };
      } else {
        return {
          decision: 'DENY',
          reason: 'New resource creation requires approval',
          requiresApproval: true,
          costThresholdExceeded: false,
          policyMatches: ['change-type-add-tool-unapproved'],
        };
      }
    }

    return {
      decision: 'ALLOW',
      requiresApproval: false,
      costThresholdExceeded: false,
      policyMatches,
    };
  }

  /**
   * Evaluate resource type policies
   */
  private evaluateResourceTypePolicy(
    context: CedarProvisioningContext
  ): CedarProvisioningResult {
    // Policy 3.1: Allowed resource types
    const allowedTypes = [
      'AWS::Lambda::Function',
      'AWS::ECS::TaskDefinition',
      'AWS::ECS::Service',
      'AWS::S3::Bucket',
      'AWS::DynamoDB::Table',
      'AWS::SQS::Queue',
      'AWS::SNS::Topic',
      'AWS::SecretsManager::Secret',
      'AWS::SSM::Parameter',
    ];

    // Policy 3.2: Forbidden resource types
    const forbiddenTypes = [
      'AWS::IAM::Role',
      'AWS::IAM::Policy',
      'AWS::EC2::VPC',
      'AWS::EC2::SecurityGroup',
      'AWS::EC2::InternetGateway',
      'AWS::KMS::Key',
    ];

    if (forbiddenTypes.includes(context.targetResourceType)) {
      return {
        decision: 'DENY',
        reason: `Forbidden resource type: ${context.targetResourceType}`,
        requiresApproval: true,
        costThresholdExceeded: false,
        policyMatches: ['resource-type-forbidden'],
      };
    }

    if (!allowedTypes.includes(context.targetResourceType)) {
      return {
        decision: 'DENY',
        reason: `Unknown or restricted resource type: ${context.targetResourceType}`,
        requiresApproval: true,
        costThresholdExceeded: false,
        policyMatches: ['resource-type-unknown'],
      };
    }

    return {
      decision: 'ALLOW',
      requiresApproval: false,
      costThresholdExceeded: false,
      policyMatches: ['resource-type-allowed'],
    };
  }

  /**
   * Check if change type is high-risk
   */
  private isHighRiskChange(changeType: IaCChangeType): boolean {
    const highRiskTypes: IaCChangeType[] = ['add_tool'];
    return highRiskTypes.includes(changeType);
  }

  /**
   * Generate Cedar policy document
   */
  generateCedarPolicy(): string {
    return `
// Cedar Policies for Agent Infrastructure Provisioning

// Policy 1.1: Auto-approve small changes
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.estimatedMonthlyCostDelta < 100.0
};

// Policy 1.2: Tier-based cost limits
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  (principal.tenantId.tier == "basic" &&
   context.currentMonthlyCost + context.estimatedMonthlyCostDelta < 500.0)
  ||
  (principal.tenantId.tier == "advanced" &&
   context.currentMonthlyCost + context.estimatedMonthlyCostDelta < 2000.0)
  ||
  (principal.tenantId.tier == "premium" &&
   context.currentMonthlyCost + context.estimatedMonthlyCostDelta < 10000.0)
};

// Policy 1.3: Cost reduction always allowed
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.estimatedMonthlyCostDelta <= 0.0
};

// Policy 2.1: Safe operations
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.changeType in [
    "update_env_var",
    "rotate_secret",
    "update_config",
    "scale_horizontal"
  ]
};

// Policy 3.2: Forbidden resource types
forbid(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.targetResourceType in [
    "AWS::IAM::Role",
    "AWS::IAM::Policy",
    "AWS::EC2::VPC",
    "AWS::EC2::SecurityGroup",
    "AWS::KMS::Key"
  ]
};

// Policy 5.1: Critical alert response
permit(
  principal is Agent,
  action == Chimera::Action::"provision_infrastructure",
  resource is InfrastructureChange
)
when {
  context.triggeredByCriticalAlarm &&
  context.changeType in [
    "scale_horizontal",
    "scale_vertical",
    "restart_runtime",
    "clear_cache"
  ]
};
`.trim();
  }

  /**
   * Get tier configuration
   */
  getTierConfig(tier: 'basic' | 'advanced' | 'premium'): TenantTierConfig {
    return this.tierConfigs[tier];
  }
}

/**
 * Create a Cedar provisioning policies instance
 */
export function createCedarProvisioningPolicies(): CedarProvisioningPolicies {
  return new CedarProvisioningPolicies();
}
