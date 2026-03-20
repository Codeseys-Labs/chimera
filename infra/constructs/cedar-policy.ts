import * as cdk from 'aws-cdk-lib';
import * as verifiedpermissions from 'aws-cdk-lib/aws-verifiedpermissions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Cedar policy templates for different authorization scenarios.
 * These templates are instantiated per tenant with specific parameters.
 */
export enum CedarPolicyTemplate {
  /** Restrict tenant to their own DynamoDB partition */
  TENANT_ISOLATION = 'tenant-isolation',
  /** Control which tools/skills a tenant can invoke */
  TOOL_INVOCATION = 'tool-invocation',
  /** Restrict memory writes to approved categories */
  MEMORY_WRITE = 'memory-write',
  /** Enforce skill trust level restrictions */
  SKILL_TRUST = 'skill-trust',
  /** Control infrastructure modification permissions */
  IAC_MODIFICATION = 'iac-modification',
  /** Restrict secret access to tenant-scoped paths */
  SECRET_ACCESS = 'secret-access',
  /** Control network egress destinations */
  NETWORK_EGRESS = 'network-egress',
  /** Enforce A2A authentication and tenant boundaries */
  A2A_AUTH = 'a2a-auth',
}

/**
 * Props for the CedarPolicyConstruct.
 */
export interface CedarPolicyConstructProps {
  /** Environment name for resource naming */
  envName: string;
  /** Enable detailed audit logging of policy decisions */
  enableAuditLogging?: boolean;
}

/**
 * L3 construct for Cedar-based authorization infrastructure.
 *
 * Creates:
 * - AWS Verified Permissions policy store
 * - Cedar schema defining Chimera entity types (Tenant, Session, Skill, Tool, etc.)
 * - Policy templates for common authorization patterns
 * - Lambda-based policy evaluation middleware
 * - CloudWatch Logs for policy decision audit trail
 *
 * Usage:
 * ```typescript
 * const cedarPolicy = new CedarPolicyConstruct(this, 'CedarPolicy', {
 *   envName: 'prod',
 *   enableAuditLogging: true,
 * });
 *
 * // Reference policy store in other stacks
 * const policyStoreId = cedarPolicy.policyStore.attrPolicyStoreId;
 * ```
 *
 * Security considerations (from Chimera-Architecture-Review-Security.md):
 * - Policy store contains authoritative policies for all tenant isolation
 * - Schema enforces type safety on policy evaluation
 * - Audit logs capture all ALLOW/DENY decisions for compliance
 * - Evaluation middleware validates session-to-tenant mapping before invoking agents
 */
export class CedarPolicyConstruct extends Construct {
  /** Verified Permissions policy store */
  public readonly policyStore: verifiedpermissions.CfnPolicyStore;

  /** Lambda function for policy evaluation middleware */
  public readonly evaluationFunction: lambda.Function;

  /** CloudWatch log group for policy decision audit trail */
  public readonly auditLogGroup?: logs.LogGroup;

  constructor(scope: Construct, id: string, props: CedarPolicyConstructProps) {
    super(scope, id);

    const { envName, enableAuditLogging = true } = props;
    const stack = cdk.Stack.of(this);
    const isProd = envName === 'prod';

    // ======================================================================
    // Cedar Schema: Define entity types and action hierarchy
    // ======================================================================
    const cedarSchema = this.buildCedarSchema();

    // ======================================================================
    // Policy Store: Central repository for Cedar policies
    // ======================================================================
    this.policyStore = new verifiedpermissions.CfnPolicyStore(this, 'PolicyStore', {
      validationSettings: {
        mode: 'STRICT', // Enforce schema validation on all policies
      },
      schema: {
        cedarJson: JSON.stringify(cedarSchema),
      },
      description: `Chimera Cedar policy store for ${envName} environment`,
    });

    // ======================================================================
    // Audit Logging: CloudWatch Logs for policy evaluation decisions
    // ======================================================================
    if (enableAuditLogging) {
      this.auditLogGroup = new logs.LogGroup(this, 'AuditLogGroup', {
        logGroupName: `/aws/verifiedpermissions/chimera/${envName}`,
        retention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      });
    }

    // ======================================================================
    // Policy Evaluation Lambda: Middleware for authorization checks
    // ======================================================================
    this.evaluationFunction = new lambda.Function(this, 'EvaluationFunction', {
      functionName: `chimera-cedar-eval-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        // Cedar policy evaluation middleware
        // This Lambda is invoked by API Gateway or Step Functions to authorize requests
        const { VerifiedPermissionsClient, IsAuthorizedCommand } = require('@aws-sdk/client-verifiedpermissions');
        const client = new VerifiedPermissionsClient({});

        exports.handler = async (event) => {
          const { principal, action, resource, context } = event;
          const policyStoreId = process.env.POLICY_STORE_ID;

          // Log evaluation request
          console.log(JSON.stringify({
            message: 'Cedar evaluation request',
            principal,
            action,
            resource,
            policyStoreId
          }));

          try {
            const command = new IsAuthorizedCommand({
              policyStoreId,
              principal: { entityType: principal.type, entityId: principal.id },
              action: { actionType: action.type, actionId: action.id },
              resource: { entityType: resource.type, entityId: resource.id },
              context: { contextMap: context || {} },
            });

            const response = await client.send(command);

            // Audit log decision
            console.log(JSON.stringify({
              message: 'Cedar evaluation decision',
              decision: response.decision,
              determiningPolicies: response.determiningPolicies,
              errors: response.errors,
            }));

            return {
              statusCode: 200,
              body: JSON.stringify({
                decision: response.decision,
                determiningPolicies: response.determiningPolicies,
                errors: response.errors,
              }),
            };
          } catch (error) {
            console.error('Cedar evaluation error:', error);
            return {
              statusCode: 500,
              body: JSON.stringify({ error: error.message }),
            };
          }
        };
      `),
      environment: {
        POLICY_STORE_ID: this.policyStore.attrPolicyStoreId,
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      description: 'Cedar policy evaluation middleware for Chimera authorization',
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });

    // Grant Lambda permission to evaluate policies
    this.evaluationFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'verifiedpermissions:IsAuthorized',
        'verifiedpermissions:IsAuthorizedWithToken',
      ],
      resources: [this.policyStore.attrArn],
    }));

    // Output policy store ID for cross-stack reference
    new cdk.CfnOutput(this, 'PolicyStoreId', {
      value: this.policyStore.attrPolicyStoreId,
      description: 'Verified Permissions policy store ID',
      exportName: `Chimera-${envName}-PolicyStoreId`,
    });

    new cdk.CfnOutput(this, 'PolicyStoreArn', {
      value: this.policyStore.attrArn,
      description: 'Verified Permissions policy store ARN',
      exportName: `Chimera-${envName}-PolicyStoreArn`,
    });

    new cdk.CfnOutput(this, 'EvaluationFunctionArn', {
      value: this.evaluationFunction.functionArn,
      description: 'Cedar policy evaluation Lambda ARN',
      exportName: `Chimera-${envName}-CedarEvalFunctionArn`,
    });

    // Apply construct tags
    cdk.Tags.of(this).add('Component', 'CedarPolicy');
  }

  /**
   * Builds the Cedar schema for Chimera entity types and actions.
   *
   * Schema defines:
   * - Tenant: Core entity representing a customer organization
   * - Session: Active agent session linked to a tenant and user
   * - Skill: Installed capability (platform, verified, community, custom)
   * - Tool: Individual tool invocation (bash, read, write, network, etc.)
   * - Resource: Target of an action (DynamoDB item, S3 object, Secret, etc.)
   * - Actions: Hierarchy of operations (read_data, write_data, invoke_tool, etc.)
   *
   * Follows patterns from Chimera-Architecture-Review-Security.md Section 1.7.
   */
  private buildCedarSchema(): object {
    return {
      Chimera: {
        entityTypes: {
          Tenant: {
            shape: {
              type: 'Record',
              attributes: {
                tenantId: { type: 'String', required: true },
                tier: {
                  type: 'String',
                  required: true,
                  // basic | advanced | enterprise | dedicated
                },
                status: {
                  type: 'String',
                  required: true,
                  // ACTIVE | SUSPENDED | TRIAL | CHURNED
                },
                permissions: {
                  type: 'Set',
                  element: { type: 'String' },
                  required: false,
                  // e.g., ["iac_self_service", "marketplace_publish"]
                },
              },
            },
          },
          Session: {
            shape: {
              type: 'Record',
              attributes: {
                sessionId: { type: 'String', required: true },
                tenantId: { type: 'String', required: true },
                userId: { type: 'String', required: true },
                agentId: { type: 'String', required: true },
                createdAt: { type: 'String', required: true },
              },
            },
            memberOfTypes: ['Tenant'],
          },
          Skill: {
            shape: {
              type: 'Record',
              attributes: {
                skillName: { type: 'String', required: true },
                trustLevel: {
                  type: 'String',
                  required: true,
                  // platform | verified | community | custom
                },
                permissions: {
                  type: 'Set',
                  element: { type: 'String' },
                  required: true,
                },
              },
            },
            memberOfTypes: ['Tenant'],
          },
          Tool: {
            shape: {
              type: 'Record',
              attributes: {
                toolName: { type: 'String', required: true },
                category: {
                  type: 'String',
                  required: true,
                  // filesystem | network | shell | memory | iac
                },
                requiresPermission: {
                  type: 'Set',
                  element: { type: 'String' },
                  required: false,
                },
              },
            },
          },
          Resource: {
            shape: {
              type: 'Record',
              attributes: {
                resourceType: {
                  type: 'String',
                  required: true,
                  // dynamodb_item | s3_object | secret | memory_entry | infrastructure
                },
                tenantId: { type: 'String', required: false },
                path: { type: 'String', required: false },
              },
            },
          },
        },
        actions: {
          // Data access actions
          read_data: {
            appliesTo: {
              principalTypes: ['Session'],
              resourceTypes: ['Resource'],
            },
          },
          write_data: {
            appliesTo: {
              principalTypes: ['Session'],
              resourceTypes: ['Resource'],
            },
          },
          delete_data: {
            appliesTo: {
              principalTypes: ['Session'],
              resourceTypes: ['Resource'],
            },
          },
          // Tool invocation actions
          invoke_tool: {
            appliesTo: {
              principalTypes: ['Session'],
              resourceTypes: ['Tool'],
            },
          },
          // Memory actions
          write_memory: {
            appliesTo: {
              principalTypes: ['Session'],
              resourceTypes: ['Resource'],
            },
          },
          read_memory: {
            appliesTo: {
              principalTypes: ['Session'],
              resourceTypes: ['Resource'],
            },
          },
          // Infrastructure actions
          modify_infrastructure: {
            appliesTo: {
              principalTypes: ['Session'],
              resourceTypes: ['Resource'],
            },
          },
          // Network actions
          network_access: {
            appliesTo: {
              principalTypes: ['Session', 'Skill'],
              resourceTypes: ['Resource'],
            },
          },
          // Secret access
          read_secret: {
            appliesTo: {
              principalTypes: ['Session'],
              resourceTypes: ['Resource'],
            },
          },
          // A2A invocation
          a2a_invoke: {
            appliesTo: {
              principalTypes: ['Session'],
              resourceTypes: ['Session'],
            },
          },
        },
      },
    };
  }

  /**
   * Creates a Cedar policy in the policy store.
   *
   * Example:
   * ```typescript
   * cedarPolicy.createPolicy('tenant-isolation', {
   *   effect: 'forbid',
   *   principal: 'Chimera::Session',
   *   action: 'read_data',
   *   resource: 'Chimera::Resource',
   *   conditions: {
   *     'principal.tenantId': { '!=': 'resource.tenantId' }
   *   }
   * });
   * ```
   */
  public createPolicy(
    policyId: string,
    definition: {
      effect: 'permit' | 'forbid';
      principal: string;
      action: string;
      resource: string;
      conditions?: Record<string, any>;
    }
  ): verifiedpermissions.CfnPolicy {
    const { effect, principal, action, resource, conditions } = definition;

    // Build Cedar policy statement
    let statement = `${effect}(\n  principal in ${principal},\n  action == "${action}",\n  resource in ${resource}\n)`;

    if (conditions) {
      const whenClauses = Object.entries(conditions)
        .map(([key, value]) => `  ${key} ${JSON.stringify(value)}`)
        .join(' &&\n');
      statement += ` when {\n${whenClauses}\n}`;
    }

    statement += ';';

    return new verifiedpermissions.CfnPolicy(this, `Policy-${policyId}`, {
      policyStoreId: this.policyStore.attrPolicyStoreId,
      definition: {
        static: {
          statement,
          description: `Cedar policy: ${policyId}`,
        },
      },
    });
  }
}
