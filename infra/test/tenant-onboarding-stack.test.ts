/**
 * CDK tests for TenantOnboardingStack
 *
 * Validates the tenant provisioning workflow:
 * - 7 onboarding Lambda functions + 7 offboarding Lambda functions
 *   + 1 Cedar evaluation Lambda (from CedarPolicyConstruct)
 *   + 1 CDK-managed LogRetentionFunction = 16 total Lambda functions
 * - 2 Step Functions Standard state machines: onboarding saga + offboarding saga
 * - AWS Verified Permissions policy store (STRICT validation mode)
 * - CloudWatch log group for Cedar policy evaluation audit trail
 * - Stack outputs for state machine ARN and Cedar policy store ID
 *
 * Note: beforeAll is used (not beforeEach) because CDK synthesis is expensive
 * and the template is read-only during assertions.
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as kms from 'aws-cdk-lib/aws-kms';
import { TenantOnboardingStack } from '../lib/tenant-onboarding-stack';

function buildDependencies(app: cdk.App) {
  const dep = new cdk.Stack(app, 'DepStack');

  const makeTable = (id: string, name: string) =>
    new dynamodb.Table(dep, id, {
      tableName: name,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    });

  return {
    tenantsTable: makeTable('T1', 'mock-tenants'),
    sessionsTable: makeTable('T2', 'mock-sessions'),
    skillsTable: makeTable('T3', 'mock-skills'),
    rateLimitsTable: makeTable('T4', 'mock-rate-limits'),
    costTrackingTable: makeTable('T5', 'mock-cost-tracking'),
    auditTable: makeTable('T6', 'mock-audit'),
    tenantBucket: new s3.Bucket(dep, 'TenantBucket'),
    skillsBucket: new s3.Bucket(dep, 'SkillsBucket'),
    userPool: new cognito.UserPool(dep, 'UserPool'),
    platformKey: new kms.Key(dep, 'PlatformKey'),
  };
}

describe('TenantOnboardingStack', () => {
  describe('Dev Environment', () => {
    let template: Template;

    // beforeAll avoids re-synthesizing the expensive stack for every test
    beforeAll(() => {
      const app = new cdk.App();
      const deps = buildDependencies(app);
      const stack = new TenantOnboardingStack(app, 'TestTenantOnboardingStack', {
        envName: 'dev',
        ...deps,
      });
      template = Template.fromStack(stack);
    });

    describe('Lambda Functions', () => {
      it('should create 16 Lambda functions (15 app + 1 CDK LogRetentionFunction)', () => {
        // 7 onboarding + 7 offboarding + 1 cedar eval Lambda + 1 CDK LogRetentionFunction singleton
        template.resourceCountIs('AWS::Lambda::Function', 16);
      });

      it('should create app Lambda functions with Node.js 20.x runtime', () => {
        // Check app-defined functions by name — LogRetentionFunction may use a different runtime
        const appFunctionNames = [
          'chimera-onboard-create-tenant-dev',
          'chimera-onboard-create-group-dev',
          'chimera-onboard-create-role-dev',
          'chimera-onboard-init-s3-dev',
          'chimera-onboard-create-cedar-dev',
          'chimera-onboard-init-cost-dev',
          'chimera-onboard-compensate-dev',
          'chimera-cedar-eval-dev',
        ];
        for (const name of appFunctionNames) {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: name,
            Runtime: 'nodejs20.x',
          });
        }
      });

      describe('Create Tenant Record', () => {
        it('should create the function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-create-tenant-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 512,
            Timeout: 30,
          });
        });

        it('should inject TENANTS_TABLE_NAME environment variable', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-create-tenant-dev',
            Environment: {
              Variables: Match.objectLike({
                TENANTS_TABLE_NAME: Match.anyValue(),
              }),
            },
          });
        });
      });

      describe('Create Cognito Group', () => {
        it('should create the function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-create-group-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 256,
            Timeout: 15,
          });
        });

        it('should inject USER_POOL_ID environment variable', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-create-group-dev',
            Environment: {
              Variables: Match.objectLike({
                USER_POOL_ID: Match.anyValue(),
              }),
            },
          });
        });
      });

      describe('Create IAM Role', () => {
        it('should create the function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-create-role-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 256,
            Timeout: 30,
          });
        });

        it('should inject ACCOUNT_ID environment variable', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-create-role-dev',
            Environment: {
              Variables: Match.objectLike({
                ACCOUNT_ID: Match.anyValue(),
              }),
            },
          });
        });
      });

      describe('Initialize S3 Prefix', () => {
        it('should create the function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-init-s3-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 256,
            Timeout: 15,
          });
        });

        it('should inject TENANT_BUCKET_NAME environment variable', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-init-s3-dev',
            Environment: {
              Variables: Match.objectLike({
                TENANT_BUCKET_NAME: Match.anyValue(),
              }),
            },
          });
        });
      });

      describe('Create Cedar Policies', () => {
        it('should create the function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-create-cedar-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 256,
            Timeout: 30,
          });
        });

        it('should inject POLICY_STORE_ID environment variable', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-create-cedar-dev',
            Environment: {
              Variables: Match.objectLike({
                POLICY_STORE_ID: Match.anyValue(),
              }),
            },
          });
        });
      });

      describe('Initialize Cost Tracking', () => {
        it('should create the function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-init-cost-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 256,
            Timeout: 15,
          });
        });

        it('should inject COST_TRACKING_TABLE_NAME environment variable', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-init-cost-dev',
            Environment: {
              Variables: Match.objectLike({
                COST_TRACKING_TABLE_NAME: Match.anyValue(),
              }),
            },
          });
        });
      });

      describe('Compensate Tenant (Rollback)', () => {
        it('should create the function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-compensate-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 512,
            Timeout: 60,
          });
        });

        it('should inject all required environment variables for rollback', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-onboard-compensate-dev',
            Environment: {
              Variables: Match.objectLike({
                TENANTS_TABLE_NAME: Match.anyValue(),
                COST_TRACKING_TABLE_NAME: Match.anyValue(),
                USER_POOL_ID: Match.anyValue(),
                TENANT_BUCKET_NAME: Match.anyValue(),
                POLICY_STORE_ID: Match.anyValue(),
                ENV_NAME: 'dev',
              }),
            },
          });
        });
      });

      describe('Cedar Evaluation Function (from CedarPolicyConstruct)', () => {
        it('should create the Cedar evaluation function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-cedar-eval-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 512,
            Timeout: 10,
          });
        });

        it('should inject POLICY_STORE_ID into Cedar evaluation function', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-cedar-eval-dev',
            Environment: {
              Variables: Match.objectLike({
                POLICY_STORE_ID: Match.anyValue(),
              }),
            },
          });
        });
      });
    });

    describe('Verified Permissions Policy Store', () => {
      it('should create exactly 1 policy store', () => {
        template.resourceCountIs('AWS::VerifiedPermissions::PolicyStore', 1);
      });

      it('should create policy store with STRICT validation mode', () => {
        template.hasResourceProperties('AWS::VerifiedPermissions::PolicyStore', {
          ValidationSettings: {
            Mode: 'STRICT',
          },
        });
      });

      it('should include Cedar schema definition', () => {
        template.hasResourceProperties('AWS::VerifiedPermissions::PolicyStore', {
          Schema: Match.objectLike({
            CedarJson: Match.anyValue(),
          }),
        });
      });
    });

    describe('Step Functions State Machine', () => {
      it('should create exactly 2 state machines (onboarding + offboarding)', () => {
        template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
      });

      it('should create state machine with correct name', () => {
        template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
          StateMachineName: 'chimera-tenant-onboarding-dev',
        });
      });

      it('should enable X-Ray tracing on the state machine', () => {
        template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
          TracingConfiguration: {
            Enabled: true,
          },
        });
      });
    });

    describe('CloudWatch Log Groups', () => {
      it('should create Cedar audit log group for dev', () => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: '/aws/verifiedpermissions/chimera/dev',
        });
      });

      it('should use ONE_MONTH retention for Cedar audit log group in dev', () => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: '/aws/verifiedpermissions/chimera/dev',
          RetentionInDays: 30,
        });
      });
    });

    describe('Stack Outputs', () => {
      it('should export OnboardingStateMachineArn', () => {
        template.hasOutput('OnboardingStateMachineArn', {
          Export: {
            Name: 'Chimera-dev-OnboardingStateMachineArn',
          },
        });
      });

      it('should export CedarPolicyStoreId', () => {
        template.hasOutput('CedarPolicyStoreId', {
          Export: {
            Name: 'Chimera-dev-CedarPolicyStoreId',
          },
        });
      });
    });
  });

  describe('Prod Environment', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const deps = buildDependencies(app);
      const stack = new TenantOnboardingStack(app, 'TestTenantOnboardingStackProd', {
        envName: 'prod',
        ...deps,
      });
      template = Template.fromStack(stack);
    });

    it('should use ONE_YEAR retention for Cedar audit log group in prod', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/verifiedpermissions/chimera/prod',
        RetentionInDays: 365,
      });
    });

    it('should use RETAIN removal policy for Cedar audit log group in prod', () => {
      const logGroups = template.findResources('AWS::Logs::LogGroup', {
        Properties: {
          LogGroupName: '/aws/verifiedpermissions/chimera/prod',
        },
      });
      const logGroup = Object.values(logGroups)[0] as any;
      expect(logGroup.DeletionPolicy).toBe('Retain');
    });

    it('should use prod-named Lambda functions', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-onboard-create-tenant-prod',
      });
    });
  });
});
