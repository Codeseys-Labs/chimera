import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { CedarPolicyConstruct } from '../constructs/cedar-policy';

export interface TenantOnboardingStackProps extends cdk.StackProps {
  envName: string;
  // References to shared infrastructure
  tenantsTable: dynamodb.ITable;
  sessionsTable: dynamodb.ITable;
  skillsTable: dynamodb.ITable;
  rateLimitsTable: dynamodb.ITable;
  costTrackingTable: dynamodb.ITable;
  auditTable: dynamodb.ITable;
  tenantBucket: s3.IBucket;
  skillsBucket: s3.IBucket;
  userPool: cognito.IUserPool;
  platformKey: cdk.aws_kms.IKey;
  alarmTopic?: sns.ITopic;
}

/**
 * Tenant Onboarding Stack for AWS Chimera.
 *
 * Orchestrates the complete tenant provisioning workflow:
 * 1. Create DDB tenant records (PROFILE, CONFIG#features, CONFIG#models, BILLING#current, QUOTA#*)
 * 2. Create Cognito group for tenant users
 * 3. Create IAM role with tenant-scoped permissions (DynamoDB partition + S3 prefix isolation)
 * 4. Initialize S3 prefix for tenant data
 * 5. Create Cedar policies for tenant authorization
 * 6. Initialize cost tracking record for current month
 * 7. Send onboarding notification
 *
 * Uses Step Functions to coordinate Lambda-based workflow steps with error handling
 * and retry logic. Cedar policy evaluation enforces multi-tenant isolation at every step.
 *
 * Architecture references:
 * - Canonical data model: docs/architecture/canonical-data-model.md
 * - Security review: docs/research/architecture-reviews/Chimera-Architecture-Review-Security.md
 * - Multi-tenant isolation: docs/research/validation/02-multi-tenant-isolation-ddb.md
 */
export class TenantOnboardingStack extends cdk.Stack {
  /** Cedar policy construct for authorization */
  public readonly cedarPolicy: CedarPolicyConstruct;

  /** Step Functions state machine for onboarding workflow */
  public readonly onboardingStateMachine: sfn.StateMachine;

  /** Lambda functions for each onboarding step */
  public readonly createTenantRecordFunction: lambda.Function;
  public readonly createCognitoGroupFunction: lambda.Function;
  public readonly createIamRoleFunction: lambda.Function;
  public readonly initializeS3PrefixFunction: lambda.Function;
  public readonly createCedarPoliciesFunction: lambda.Function;
  public readonly initializeCostTrackingFunction: lambda.Function;
  /** Compensation Lambda — best-effort rollback on workflow failure */
  public readonly compensateTenantFunction: lambda.Function;

  /** Step Functions state machine for offboarding workflow */
  public readonly offboardingStateMachine: sfn.StateMachine;

  /** Lambda functions for offboarding workflow */
  public readonly offboardTenantFunction: lambda.Function;
  public readonly cleanupIamRoleFunction: lambda.Function;
  public readonly cleanupCognitoGroupFunction: lambda.Function;
  public readonly cleanupS3PrefixFunction: lambda.Function;
  public readonly cleanupCedarPoliciesFunction: lambda.Function;
  public readonly cleanupDdbItemsFunction: lambda.Function;
  public readonly finalizeTenantOffboardingFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: TenantOnboardingStackProps) {
    super(scope, id, props);

    const { envName } = props;
    const isProd = envName === 'prod';

    // ======================================================================
    // Cedar Policy Infrastructure
    // ======================================================================
    this.cedarPolicy = new CedarPolicyConstruct(this, 'CedarPolicy', {
      envName,
      enableAuditLogging: true,
    });

    // ======================================================================
    // Lambda: Create Tenant DDB Records
    // Creates multi-item tenant config using canonical pattern:
    // - SK=PROFILE (required): tenantId, name, tier, status, adminEmail, region
    // - SK=CONFIG#features (required): feature flags per tier
    // - SK=CONFIG#models (required): allowedModels, defaultModel, routing
    // - SK=BILLING#current (required): payment info, Stripe customer ID
    // - SK=QUOTA#* (multiple): resource quotas (api-requests, agent-sessions)
    // ======================================================================
    this.createTenantRecordFunction = new lambda.Function(this, 'CreateTenantRecord', {
      functionName: `chimera-onboard-create-tenant-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
        const client = new DynamoDBClient({});

        exports.handler = async (event) => {
          const { tenantId, name, tier, adminEmail, region } = event;
          const tableName = process.env.TENANTS_TABLE_NAME;
          const now = new Date().toISOString();

          // Multi-item tenant config (canonical pattern from docs/architecture/canonical-data-model.md)
          const items = [
            // PROFILE item (required)
            {
              PutRequest: {
                Item: {
                  PK: { S: \`TENANT#\${tenantId}\` },
                  SK: { S: 'PROFILE' },
                  tenantId: { S: tenantId },
                  name: { S: name },
                  tier: { S: tier },
                  status: { S: 'PROVISIONING' },
                  adminEmail: { S: adminEmail },
                  dataRegion: { S: region },
                  createdAt: { S: now },
                  updatedAt: { S: now },
                },
              },
            },
            // CONFIG#features item (required)
            {
              PutRequest: {
                Item: {
                  PK: { S: \`TENANT#\${tenantId}\` },
                  SK: { S: 'CONFIG#features' },
                  codeInterpreter: { BOOL: tier === 'enterprise' },
                  browser: { BOOL: tier !== 'basic' },
                  cronJobs: { BOOL: tier !== 'basic' },
                  selfEditingIac: { BOOL: tier === 'enterprise' },
                  maxSubagents: { N: tier === 'basic' ? '1' : tier === 'advanced' ? '5' : '20' },
                  allowedModelProviders: { SS: ['bedrock'] },
                  mcpToolsEnabled: { BOOL: true },
                },
              },
            },
            // CONFIG#models item (required)
            {
              PutRequest: {
                Item: {
                  PK: { S: \`TENANT#\${tenantId}\` },
                  SK: { S: 'CONFIG#models' },
                  allowedModels: {
                    SS: tier === 'basic'
                      ? ['anthropic.claude-haiku-*', 'amazon.nova-lite-*']
                      : tier === 'advanced'
                      ? ['anthropic.claude-sonnet-*', 'anthropic.claude-haiku-*', 'amazon.nova-*']
                      : ['anthropic.claude-*', 'amazon.nova-*'],
                  },
                  defaultModel: { S: tier === 'basic'
                    ? 'anthropic.claude-haiku-*'
                    : 'anthropic.claude-sonnet-*'
                  },
                  monthlyBudgetUsd: { N: tier === 'basic' ? '100' : tier === 'advanced' ? '1000' : '10000' },
                  costAlertThreshold: { N: '0.8' },
                },
              },
            },
            // BILLING#current item (required)
            {
              PutRequest: {
                Item: {
                  PK: { S: \`TENANT#\${tenantId}\` },
                  SK: { S: 'BILLING#current' },
                  monthlySpendUsd: { N: '0' },
                  billingCycle: { S: 'monthly' },
                  paymentMethod: { S: 'credit_card' },
                  stripeCustomerId: { S: '' }, // Set by Stripe integration
                },
              },
            },
            // QUOTA#api-requests item
            {
              PutRequest: {
                Item: {
                  PK: { S: \`TENANT#\${tenantId}\` },
                  SK: { S: 'QUOTA#api-requests' },
                  resource: { S: 'api-requests' },
                  limit: { N: tier === 'basic' ? '10000' : tier === 'advanced' ? '100000' : '1000000' },
                  current: { N: '0' },
                  period: { S: 'monthly' },
                  resetAt: { S: new Date(new Date().setMonth(new Date().getMonth() + 1, 1)).toISOString() },
                },
              },
            },
            // QUOTA#agent-sessions item
            {
              PutRequest: {
                Item: {
                  PK: { S: \`TENANT#\${tenantId}\` },
                  SK: { S: 'QUOTA#agent-sessions' },
                  resource: { S: 'agent-sessions' },
                  limit: { N: tier === 'basic' ? '5' : tier === 'advanced' ? '50' : '500' },
                  current: { N: '0' },
                  period: { S: 'concurrent' },
                },
              },
            },
          ];

          try {
            await client.send(new BatchWriteItemCommand({
              RequestItems: {
                [tableName]: items,
              },
            }));

            console.log(\`Created tenant records for \${tenantId}\`);
            return { success: true, tenantId, status: 'PROVISIONING' };
          } catch (error) {
            console.error('Failed to create tenant records:', error);
            throw error;
          }
        };
      `),
      environment: {
        TENANTS_TABLE_NAME: props.tenantsTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    props.tenantsTable.grantWriteData(this.createTenantRecordFunction);

    // ======================================================================
    // Lambda: Create Cognito Group
    // Creates a Cognito group for the tenant with the tenant IAM role.
    // Users added to this group get custom:tenant_id claim in their JWT.
    // ======================================================================
    this.createCognitoGroupFunction = new lambda.Function(this, 'CreateCognitoGroup', {
      functionName: `chimera-onboard-create-group-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { CognitoIdentityProviderClient, CreateGroupCommand } = require('@aws-sdk/client-cognito-identity-provider');
        const client = new CognitoIdentityProviderClient({});

        exports.handler = async (event) => {
          const { tenantId, tier, iamRoleArn } = event;
          const userPoolId = process.env.USER_POOL_ID;

          try {
            await client.send(new CreateGroupCommand({
              GroupName: \`tenant-\${tenantId}\`,
              UserPoolId: userPoolId,
              Description: \`Users for tenant \${tenantId} (\${tier} tier)\`,
              RoleArn: iamRoleArn,
            }));

            console.log(\`Created Cognito group for tenant \${tenantId}\`);
            return { success: true, groupName: \`tenant-\${tenantId}\` };
          } catch (error) {
            if (error.name === 'GroupExistsException') {
              console.log(\`Group already exists for tenant \${tenantId}\`);
              return { success: true, groupName: \`tenant-\${tenantId}\`, alreadyExists: true };
            }
            console.error('Failed to create Cognito group:', error);
            throw error;
          }
        };
      `),
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
      },
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    this.createCognitoGroupFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:CreateGroup'],
      resources: [props.userPool.userPoolArn],
    }));

    // ======================================================================
    // Lambda: Create IAM Role
    // Creates tenant-scoped IAM role with DynamoDB partition isolation
    // and S3 prefix isolation. Role is assumed by Bedrock AgentCore Runtime.
    // ======================================================================
    this.createIamRoleFunction = new lambda.Function(this, 'CreateIamRole', {
      functionName: `chimera-onboard-create-role-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { IAMClient, CreateRoleCommand, PutRolePolicyCommand } = require('@aws-sdk/client-iam');
        const client = new IAMClient({});

        exports.handler = async (event) => {
          const { tenantId, tier } = event;
          const roleName = \`chimera-tenant-\${tenantId}-${envName}\`;
          const region = process.env.AWS_REGION;
          const account = process.env.ACCOUNT_ID;

          // Trust policy: Bedrock can assume this role
          const trustPolicy = {
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { Service: 'bedrock.amazonaws.com' },
              Action: 'sts:AssumeRole',
            }],
          };

          // Tenant-scoped permissions policy
          const permissionsPolicy = {
            Version: '2012-10-17',
            Statement: [
              // DynamoDB: Access only this tenant's partition
              {
                Effect: 'Allow',
                Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
                Resource: [
                  \`arn:aws:dynamodb:\${region}:\${account}:table/chimera-*-${envName}\`,
                  \`arn:aws:dynamodb:\${region}:\${account}:table/chimera-*-${envName}/index/*\`,
                ],
              },
              {
                Effect: 'Deny',
                Action: ['dynamodb:*'],
                Resource: [
                  \`arn:aws:dynamodb:\${region}:\${account}:table/chimera-*-${envName}\`,
                  \`arn:aws:dynamodb:\${region}:\${account}:table/chimera-*-${envName}/index/*\`,
                ],
                Condition: {
                  'ForAllValues:StringNotLike': {
                    'dynamodb:LeadingKeys': [\`TENANT#\${tenantId}*\`],
                  },
                },
              },
              // S3: Tenant prefix isolation
              {
                Effect: 'Allow',
                Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                Resource: [\`arn:aws:s3:::chimera-tenants-${envName}/tenants/\${tenantId}/*\`],
              },
              {
                Effect: 'Allow',
                Action: ['s3:GetObject'],
                Resource: [
                  \`arn:aws:s3:::chimera-skills-${envName}/skills/global/*\`,
                  \`arn:aws:s3:::chimera-skills-${envName}/skills/tenant/\${tenantId}/*\`,
                ],
              },
              // Bedrock: Tier-based model access
              {
                Effect: 'Allow',
                Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                Resource: tier === 'basic'
                  ? [\`arn:aws:bedrock:\${region}::foundation-model/anthropic.claude-haiku-*\`,
                     \`arn:aws:bedrock:\${region}::foundation-model/amazon.nova-lite-*\`]
                  : tier === 'advanced'
                  ? [\`arn:aws:bedrock:\${region}::foundation-model/anthropic.claude-sonnet-*\`,
                     \`arn:aws:bedrock:\${region}::foundation-model/anthropic.claude-haiku-*\`,
                     \`arn:aws:bedrock:\${region}::foundation-model/amazon.nova-*\`]
                  : [\`arn:aws:bedrock:\${region}::foundation-model/anthropic.claude-*\`,
                     \`arn:aws:bedrock:\${region}::foundation-model/amazon.nova-*\`],
              },
              // Secrets Manager: Tenant-scoped secrets
              {
                Effect: 'Allow',
                Action: ['secretsmanager:GetSecretValue'],
                Resource: [\`arn:aws:secretsmanager:\${region}:\${account}:secret:chimera/\${tenantId}/*\`],
              },
            ],
          };

          try {
            // Create role
            const roleResponse = await client.send(new CreateRoleCommand({
              RoleName: roleName,
              AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
              Description: \`Chimera tenant role for \${tenantId} (\${tier})\`,
              Tags: [
                { Key: 'TenantId', Value: tenantId },
                { Key: 'TenantTier', Value: tier },
                { Key: 'Environment', Value: '${envName}' },
              ],
            }));

            // Attach inline policy
            await client.send(new PutRolePolicyCommand({
              RoleName: roleName,
              PolicyName: 'TenantScopedPolicy',
              PolicyDocument: JSON.stringify(permissionsPolicy),
            }));

            console.log(\`Created IAM role for tenant \${tenantId}\`);
            return { success: true, roleArn: roleResponse.Role.Arn };
          } catch (error) {
            if (error.name === 'EntityAlreadyExistsException') {
              const roleArn = \`arn:aws:iam::\${account}:role/\${roleName}\`;
              console.log(\`Role already exists for tenant \${tenantId}\`);
              return { success: true, roleArn, alreadyExists: true };
            }
            console.error('Failed to create IAM role:', error);
            throw error;
          }
        };
      `),
      environment: {
        ACCOUNT_ID: this.account,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    this.createIamRoleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:TagRole'],
      resources: [`arn:aws:iam::${this.account}:role/chimera-tenant-*-${envName}`],
    }));

    // ======================================================================
    // Lambda: Initialize S3 Prefix
    // Creates .tenant-metadata marker object in tenant's S3 prefix.
    // ======================================================================
    this.initializeS3PrefixFunction = new lambda.Function(this, 'InitializeS3Prefix', {
      functionName: `chimera-onboard-init-s3-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
        const client = new S3Client({});

        exports.handler = async (event) => {
          const { tenantId, tier } = event;
          const bucketName = process.env.TENANT_BUCKET_NAME;

          const metadata = {
            tenantId,
            tier,
            createdAt: new Date().toISOString(),
            version: '1.0.0',
          };

          try {
            await client.send(new PutObjectCommand({
              Bucket: bucketName,
              Key: \`tenants/\${tenantId}/.tenant-metadata\`,
              Body: JSON.stringify(metadata, null, 2),
              ContentType: 'application/json',
            }));

            console.log(\`Initialized S3 prefix for tenant \${tenantId}\`);
            return { success: true, prefix: \`tenants/\${tenantId}/\` };
          } catch (error) {
            console.error('Failed to initialize S3 prefix:', error);
            throw error;
          }
        };
      `),
      environment: {
        TENANT_BUCKET_NAME: props.tenantBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    props.tenantBucket.grantPut(this.initializeS3PrefixFunction, 'tenants/*/.tenant-metadata');

    // ======================================================================
    // Lambda: Create Cedar Policies
    // Creates tenant-specific Cedar authorization policies in the policy store.
    // ======================================================================
    this.createCedarPoliciesFunction = new lambda.Function(this, 'CreateCedarPolicies', {
      functionName: `chimera-onboard-create-cedar-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { VerifiedPermissionsClient, CreatePolicyCommand } = require('@aws-sdk/client-verifiedpermissions');
        const client = new VerifiedPermissionsClient({});

        exports.handler = async (event) => {
          const { tenantId, tier } = event;
          const policyStoreId = process.env.POLICY_STORE_ID;

          // Tenant isolation policy: DENY cross-tenant data access
          const tenantIsolationPolicy = \`
forbid(
  principal,
  action in [Chimera::Action::"read_data", Chimera::Action::"write_data"],
  resource
) when {
  principal.tenantId != resource.tenantId
};
          \`;

          // Tool invocation policy: Restrict tools based on tier
          const toolInvocationPolicy = tier === 'basic' ? \`
forbid(
  principal,
  action == Chimera::Action::"invoke_tool",
  resource
) when {
  resource.toolName in ["manage_infrastructure", "browser", "code_interpreter"]
};
          \` : '';

          try {
            const policyIds = [];

            // Create tenant isolation policy
            const isolationResponse = await client.send(new CreatePolicyCommand({
              policyStoreId,
              definition: {
                static: {
                  statement: tenantIsolationPolicy,
                  description: \`Tenant isolation policy for \${tenantId}\`,
                },
              },
            }));
            policyIds.push(isolationResponse.policy.policyId);

            // Create tier-specific tool policy (if applicable)
            if (toolInvocationPolicy) {
              const toolResponse = await client.send(new CreatePolicyCommand({
                policyStoreId,
                definition: {
                  static: {
                    statement: toolInvocationPolicy,
                    description: \`Tool invocation policy for \${tenantId} (\${tier} tier)\`,
                  },
                },
              }));
              policyIds.push(toolResponse.policy.policyId);
            }

            console.log(\`Created Cedar policies for tenant \${tenantId}\`);
            return { success: true, policiesCreated: policyIds.length, policyIds };
          } catch (error) {
            console.error('Failed to create Cedar policies:', error);
            throw error;
          }
        };
      `),
      environment: {
        POLICY_STORE_ID: this.cedarPolicy.policyStore.attrPolicyStoreId,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    this.createCedarPoliciesFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['verifiedpermissions:CreatePolicy'],
      resources: [this.cedarPolicy.policyStore.attrArn],
    }));

    // ======================================================================
    // Lambda: Initialize Cost Tracking
    // Creates the current month's cost tracking record in DynamoDB.
    // ======================================================================
    this.initializeCostTrackingFunction = new lambda.Function(this, 'InitializeCostTracking', {
      functionName: `chimera-onboard-init-cost-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
        const client = new DynamoDBClient({});

        exports.handler = async (event) => {
          const { tenantId } = event;
          const tableName = process.env.COST_TRACKING_TABLE_NAME;
          const now = new Date();
          const period = \`\${now.getFullYear()}-\${String(now.getMonth() + 1).padStart(2, '0')}\`;
          const ttl = Math.floor(new Date(now.getFullYear() + 2, now.getMonth(), 1).getTime() / 1000); // 2 years

          try {
            await client.send(new PutItemCommand({
              TableName: tableName,
              Item: {
                PK: { S: \`TENANT#\${tenantId}\` },
                SK: { S: \`PERIOD#\${period}\` },
                period: { S: period },
                totalCostUsd: { N: '0' },
                requestCount: { N: '0' },
                sessionCount: { N: '0' },
                lastUpdated: { S: now.toISOString() },
                ttl: { N: String(ttl) },
              },
            }));

            console.log(\`Initialized cost tracking for tenant \${tenantId}\`);
            return { success: true, period };
          } catch (error) {
            console.error('Failed to initialize cost tracking:', error);
            throw error;
          }
        };
      `),
      environment: {
        COST_TRACKING_TABLE_NAME: props.costTrackingTable.tableName,
      },
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    props.costTrackingTable.grantWriteData(this.initializeCostTrackingFunction);

    // ======================================================================
    // Step Functions: Onboarding Workflow
    // Orchestrates all Lambda functions with error handling and retries.
    // ======================================================================
    const createTenantTask = new tasks.LambdaInvoke(this, 'CreateTenantRecordTask', {
      lambdaFunction: this.createTenantRecordFunction,
      resultPath: '$.createTenantResult',
    });
    createTenantTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const createRoleTask = new tasks.LambdaInvoke(this, 'CreateIAMRoleTask', {
      lambdaFunction: this.createIamRoleFunction,
      resultPath: '$.createRoleResult',
    });
    createRoleTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const createGroupTask = new tasks.LambdaInvoke(this, 'CreateCognitoGroupTask', {
      lambdaFunction: this.createCognitoGroupFunction,
      inputPath: '$',
      resultPath: '$.createGroupResult',
      payload: sfn.TaskInput.fromObject({
        tenantId: sfn.JsonPath.stringAt('$.tenantId'),
        tier: sfn.JsonPath.stringAt('$.tier'),
        iamRoleArn: sfn.JsonPath.stringAt('$.createRoleResult.Payload.roleArn'),
      }),
    });
    createGroupTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const initS3Task = new tasks.LambdaInvoke(this, 'InitializeS3PrefixTask', {
      lambdaFunction: this.initializeS3PrefixFunction,
      resultPath: '$.initS3Result',
    });
    initS3Task.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const createCedarTask = new tasks.LambdaInvoke(this, 'CreateCedarPoliciesTask', {
      lambdaFunction: this.createCedarPoliciesFunction,
      resultPath: '$.createCedarResult',
    });
    createCedarTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const initCostTask = new tasks.LambdaInvoke(this, 'InitializeCostTrackingTask', {
      lambdaFunction: this.initializeCostTrackingFunction,
      resultPath: '$.initCostResult',
    });
    initCostTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    // Update tenant status to ACTIVE
    const updateStatusTask = new tasks.DynamoUpdateItem(this, 'UpdateTenantStatus', {
      table: props.tenantsTable,
      key: {
        PK: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.format('TENANT#{}', sfn.JsonPath.stringAt('$.tenantId'))),
        SK: tasks.DynamoAttributeValue.fromString('PROFILE'),
      },
      updateExpression: 'SET #status = :status, updatedAt = :now',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('ACTIVE'),
        ':now': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });
    updateStatusTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    // ======================================================================
    // Lambda: Compensate Tenant (Rollback)
    // Best-effort cleanup of all resources created during a failed onboarding.
    // Receives the full SFN execution state so it can inspect each step result
    // to determine which resources exist and need to be removed.
    // ======================================================================
    this.compensateTenantFunction = new lambda.Function(this, 'CompensateTenant', {
      functionName: `chimera-onboard-compensate-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, BatchWriteItemCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
        const { IAMClient, DeleteRolePolicyCommand, DeleteRoleCommand } = require('@aws-sdk/client-iam');
        const { CognitoIdentityProviderClient, DeleteGroupCommand } = require('@aws-sdk/client-cognito-identity-provider');
        const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
        const { VerifiedPermissionsClient, DeletePolicyCommand } = require('@aws-sdk/client-verifiedpermissions');

        const ddbClient = new DynamoDBClient({});
        const iamClient = new IAMClient({});
        const cognitoClient = new CognitoIdentityProviderClient({});
        const s3Client = new S3Client({});
        const vpClient = new VerifiedPermissionsClient({});

        exports.handler = async (event) => {
          const { tenantId } = event;
          // LambdaInvoke wraps responses under Payload
          const roleResult = event.createRoleResult?.Payload;
          const groupResult = event.createGroupResult?.Payload;
          const cedarResult = event.createCedarResult?.Payload;
          const errors = [];

          // 1. Delete DDB tenant records — DeleteRequest is a no-op for missing items
          try {
            const skList = [
              'PROFILE', 'CONFIG#features', 'CONFIG#models',
              'BILLING#current', 'QUOTA#api-requests', 'QUOTA#agent-sessions',
            ];
            await ddbClient.send(new BatchWriteItemCommand({
              RequestItems: {
                [process.env.TENANTS_TABLE_NAME]: skList.map(sk => ({
                  DeleteRequest: { Key: { PK: { S: \`TENANT#\${tenantId}\` }, SK: { S: sk } } },
                })),
              },
            }));
            console.log(\`Deleted DDB tenant records for \${tenantId}\`);
          } catch (err) {
            console.error('Failed to delete DDB tenant records:', err);
            errors.push({ step: 'ddb_records', error: err.message });
          }

          // 2. Delete cost tracking record (best-effort; missing item is silent)
          try {
            const now = new Date();
            const period = \`\${now.getFullYear()}-\${String(now.getMonth() + 1).padStart(2, '0')}\`;
            await ddbClient.send(new DeleteItemCommand({
              TableName: process.env.COST_TRACKING_TABLE_NAME,
              Key: { PK: { S: \`TENANT#\${tenantId}\` }, SK: { S: \`PERIOD#\${period}\` } },
            }));
            console.log(\`Deleted cost tracking record for \${tenantId}\`);
          } catch (err) {
            console.error('Failed to delete cost tracking record:', err);
            errors.push({ step: 'cost_tracking', error: err.message });
          }

          // 3. Delete IAM role — skip if role pre-existed before this workflow
          if (roleResult?.roleArn && !roleResult?.alreadyExists) {
            const roleName = \`chimera-tenant-\${tenantId}-\${process.env.ENV_NAME}\`;
            try {
              await iamClient.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: 'TenantScopedPolicy' }));
            } catch (err) {
              if (!err.name?.includes('NoSuchEntity')) {
                errors.push({ step: 'iam_policy', error: err.message });
              }
            }
            try {
              await iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
              console.log(\`Deleted IAM role \${roleName}\`);
            } catch (err) {
              if (!err.name?.includes('NoSuchEntity')) {
                console.error('Failed to delete IAM role:', err);
                errors.push({ step: 'iam_role', error: err.message });
              }
            }
          }

          // 4. Delete Cognito group — skip if group pre-existed
          if (groupResult?.groupName && !groupResult?.alreadyExists) {
            try {
              await cognitoClient.send(new DeleteGroupCommand({
                GroupName: groupResult.groupName,
                UserPoolId: process.env.USER_POOL_ID,
              }));
              console.log(\`Deleted Cognito group \${groupResult.groupName}\`);
            } catch (err) {
              if (!err.name?.includes('ResourceNotFound')) {
                console.error('Failed to delete Cognito group:', err);
                errors.push({ step: 'cognito_group', error: err.message });
              }
            }
          }

          // 5. Delete S3 tenant metadata object (present only if initS3Task ran)
          if (event.initS3Result) {
            try {
              await s3Client.send(new DeleteObjectCommand({
                Bucket: process.env.TENANT_BUCKET_NAME,
                Key: \`tenants/\${tenantId}/.tenant-metadata\`,
              }));
              console.log(\`Deleted S3 metadata for \${tenantId}\`);
            } catch (err) {
              console.error('Failed to delete S3 object:', err);
              errors.push({ step: 's3_metadata', error: err.message });
            }
          }

          // 6. Delete Cedar policies by ID (IDs returned by createCedarPoliciesFunction)
          if (cedarResult?.policyIds?.length > 0) {
            for (const policyId of cedarResult.policyIds) {
              try {
                await vpClient.send(new DeletePolicyCommand({
                  policyStoreId: process.env.POLICY_STORE_ID,
                  policyId,
                }));
                console.log(\`Deleted Cedar policy \${policyId}\`);
              } catch (err) {
                if (!err.name?.includes('ResourceNotFound')) {
                  console.error(\`Failed to delete Cedar policy \${policyId}:\`, err);
                  errors.push({ step: 'cedar_policy', policyId, error: err.message });
                }
              }
            }
          }

          console.log(\`Compensation complete for \${tenantId}. Errors: \${errors.length}\`);
          return { compensated: true, tenantId, errors };
        };
      `),
      environment: {
        TENANTS_TABLE_NAME: props.tenantsTable.tableName,
        COST_TRACKING_TABLE_NAME: props.costTrackingTable.tableName,
        USER_POOL_ID: props.userPool.userPoolId,
        TENANT_BUCKET_NAME: props.tenantBucket.bucketName,
        POLICY_STORE_ID: this.cedarPolicy.policyStore.attrPolicyStoreId,
        ENV_NAME: envName,
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    props.tenantsTable.grantWriteData(this.compensateTenantFunction);
    props.costTrackingTable.grantWriteData(this.compensateTenantFunction);
    props.tenantBucket.grantDelete(this.compensateTenantFunction, 'tenants/*/.tenant-metadata');
    this.compensateTenantFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:DeleteRolePolicy', 'iam:DeleteRole'],
      resources: [`arn:aws:iam::${this.account}:role/chimera-tenant-*-${envName}`],
    }));
    this.compensateTenantFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:DeleteGroup'],
      resources: [props.userPool.userPoolArn],
    }));
    this.compensateTenantFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['verifiedpermissions:DeletePolicy'],
      resources: [this.cedarPolicy.policyStore.attrArn],
    }));

    // ======================================================================
    // Step Functions: Onboarding Workflow
    // Orchestrates all Lambda functions with error handling, retries, and
    // compensation (saga pattern) — any failure triggers best-effort rollback.
    // ======================================================================

    // Compensation task — routes to failState after attempting rollback
    const compensateTask = new tasks.LambdaInvoke(this, 'CompensateTenantTask', {
      lambdaFunction: this.compensateTenantFunction,
      resultPath: '$.compensateResult',
    });
    compensateTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      backoffRate: 2,
      interval: cdk.Duration.seconds(2),
    });

    // Success state
    const successState = new sfn.Succeed(this, 'OnboardingComplete', {
      comment: 'Tenant onboarding completed successfully',
    });

    // Fail state — terminal; always reached via compensateTask
    const failState = new sfn.Fail(this, 'OnboardingFailed', {
      cause: 'Tenant onboarding workflow failed',
      error: 'OnboardingError',
    });

    // compensateTask always ends in failState (compensation is best-effort)
    compensateTask.addCatch(failState, { resultPath: '$.compensationError' });
    compensateTask.next(failState);

    // Wire catch handlers: every main-chain task routes failures to compensation
    createTenantTask.addCatch(compensateTask, { resultPath: '$.error' });
    createRoleTask.addCatch(compensateTask, { resultPath: '$.error' });
    createGroupTask.addCatch(compensateTask, { resultPath: '$.error' });
    updateStatusTask.addCatch(compensateTask, { resultPath: '$.error' });

    // Extract parallel state so addCatch can be attached to it
    const parallelInit = new sfn.Parallel(this, 'ParallelInitialization')
      .branch(initS3Task)
      .branch(createCedarTask)
      .branch(initCostTask);
    parallelInit.addCatch(compensateTask, { resultPath: '$.error' });

    // Chain workflow steps
    const definition = createTenantTask
      .next(createRoleTask)
      .next(createGroupTask)
      .next(parallelInit)
      .next(updateStatusTask)
      .next(successState);

    this.onboardingStateMachine = new sfn.StateMachine(this, 'OnboardingStateMachine', {
      stateMachineName: `chimera-tenant-onboarding-${envName}`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(10),
      tracingEnabled: true,
    });

    // Outputs
    new cdk.CfnOutput(this, 'OnboardingStateMachineArn', {
      value: this.onboardingStateMachine.stateMachineArn,
      description: 'Step Functions state machine ARN for tenant onboarding',
      exportName: `Chimera-${envName}-OnboardingStateMachineArn`,
    });

    new cdk.CfnOutput(this, 'CedarPolicyStoreId', {
      value: this.cedarPolicy.policyStore.attrPolicyStoreId,
      description: 'Cedar policy store ID',
      exportName: `Chimera-${envName}-CedarPolicyStoreId`,
    });

    // ======================================================================
    // Lambda: Offboard Tenant (Start)
    // Validates tenant is in an offboardable state and sets status to
    // OFFBOARDING. Returns current tenant config for downstream cleanup steps.
    // ======================================================================
    this.offboardTenantFunction = new lambda.Function(this, 'OffboardTenant', {
      functionName: `chimera-offboard-start-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
        const client = new DynamoDBClient({});

        exports.handler = async (event) => {
          const { tenantId } = event;
          const tableName = process.env.TENANTS_TABLE_NAME;

          const getResult = await client.send(new GetItemCommand({
            TableName: tableName,
            Key: {
              PK: { S: \`TENANT#\${tenantId}\` },
              SK: { S: 'PROFILE' },
            },
          }));

          if (!getResult.Item) {
            throw new Error(\`Tenant \${tenantId} not found\`);
          }

          const status = getResult.Item.status?.S;
          const tier = getResult.Item.tier?.S;
          const name = getResult.Item.name?.S;

          if (status === 'PROVISIONING' || status === 'CHURNED') {
            throw new Error(\`Cannot offboard tenant \${tenantId} with status \${status}\`);
          }

          await client.send(new UpdateItemCommand({
            TableName: tableName,
            Key: {
              PK: { S: \`TENANT#\${tenantId}\` },
              SK: { S: 'PROFILE' },
            },
            UpdateExpression: 'SET #status = :status, updatedAt = :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': { S: 'OFFBOARDING' },
              ':now': { S: new Date().toISOString() },
            },
          }));

          console.log(\`Set tenant \${tenantId} status to OFFBOARDING\`);
          return { tenantId, tier, name, previousStatus: status };
        };
      `),
      environment: {
        TENANTS_TABLE_NAME: props.tenantsTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    props.tenantsTable.grantReadWriteData(this.offboardTenantFunction);

    // ======================================================================
    // Lambda: Cleanup IAM Role
    // Lists all inline policies, deletes them, then deletes the tenant IAM
    // role. Handles NoSuchEntity gracefully (idempotent).
    // ======================================================================
    this.cleanupIamRoleFunction = new lambda.Function(this, 'CleanupIamRole', {
      functionName: `chimera-offboard-iam-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { IAMClient, ListRolePoliciesCommand, DeleteRolePolicyCommand, DeleteRoleCommand } = require('@aws-sdk/client-iam');
        const client = new IAMClient({});

        exports.handler = async (event) => {
          const { tenantId } = event;
          const roleName = \`chimera-tenant-\${tenantId}-\${process.env.ENV_NAME}\`;

          try {
            const policiesResult = await client.send(new ListRolePoliciesCommand({ RoleName: roleName }));
            for (const policyName of (policiesResult.PolicyNames || [])) {
              await client.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
              console.log(\`Deleted inline policy \${policyName} from \${roleName}\`);
            }
          } catch (err) {
            if (!err.name?.includes('NoSuchEntity')) throw err;
            console.log(\`Role \${roleName} not found, skipping inline policy deletion\`);
            return { success: true, roleName, alreadyDeleted: true };
          }

          try {
            await client.send(new DeleteRoleCommand({ RoleName: roleName }));
            console.log(\`Deleted IAM role \${roleName}\`);
          } catch (err) {
            if (!err.name?.includes('NoSuchEntity')) throw err;
            console.log(\`Role \${roleName} not found, skipping deletion\`);
          }

          return { success: true, roleName };
        };
      `),
      environment: {
        ENV_NAME: envName,
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    this.cleanupIamRoleFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:ListRolePolicies', 'iam:DeleteRolePolicy', 'iam:DeleteRole'],
      resources: [`arn:aws:iam::${this.account}:role/chimera-tenant-*-${envName}`],
    }));

    // ======================================================================
    // Lambda: Cleanup Cognito Group
    // Removes all users from the tenant's Cognito group, then deletes it.
    // Handles ResourceNotFoundException gracefully (idempotent).
    // ======================================================================
    this.cleanupCognitoGroupFunction = new lambda.Function(this, 'CleanupCognitoGroup', {
      functionName: `chimera-offboard-cognito-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { CognitoIdentityProviderClient, ListUsersInGroupCommand, AdminRemoveUserFromGroupCommand, DeleteGroupCommand } = require('@aws-sdk/client-cognito-identity-provider');
        const client = new CognitoIdentityProviderClient({});

        exports.handler = async (event) => {
          const { tenantId } = event;
          const groupName = \`tenant-\${tenantId}\`;
          const userPoolId = process.env.USER_POOL_ID;

          try {
            let nextToken;
            let removedCount = 0;
            do {
              const listResult = await client.send(new ListUsersInGroupCommand({
                GroupName: groupName,
                UserPoolId: userPoolId,
                NextToken: nextToken,
              }));
              for (const user of (listResult.Users || [])) {
                await client.send(new AdminRemoveUserFromGroupCommand({
                  UserPoolId: userPoolId,
                  Username: user.Username,
                  GroupName: groupName,
                }));
                removedCount++;
              }
              nextToken = listResult.NextToken;
            } while (nextToken);

            console.log(\`Removed \${removedCount} users from group \${groupName}\`);

            await client.send(new DeleteGroupCommand({
              GroupName: groupName,
              UserPoolId: userPoolId,
            }));
            console.log(\`Deleted Cognito group \${groupName}\`);
          } catch (err) {
            if (err.name?.includes('ResourceNotFoundException')) {
              console.log(\`Cognito group \${groupName} not found, skipping\`);
              return { success: true, groupName, alreadyDeleted: true };
            }
            throw err;
          }

          return { success: true, groupName };
        };
      `),
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    this.cleanupCognitoGroupFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsersInGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:DeleteGroup'],
      resources: [props.userPool.userPoolArn],
    }));

    // ======================================================================
    // Lambda: Cleanup S3 Prefix
    // Paginates through tenants/{tenantId}/ and batch-deletes all objects.
    // ======================================================================
    this.cleanupS3PrefixFunction = new lambda.Function(this, 'CleanupS3Prefix', {
      functionName: `chimera-offboard-s3-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
        const client = new S3Client({});

        exports.handler = async (event) => {
          const { tenantId } = event;
          const bucketName = process.env.TENANT_BUCKET_NAME;
          const prefix = \`tenants/\${tenantId}/\`;
          let deletedCount = 0;
          let continuationToken;

          do {
            const listResult = await client.send(new ListObjectsV2Command({
              Bucket: bucketName,
              Prefix: prefix,
              ContinuationToken: continuationToken,
            }));

            const objects = listResult.Contents || [];
            if (objects.length > 0) {
              await client.send(new DeleteObjectsCommand({
                Bucket: bucketName,
                Delete: {
                  Objects: objects.map(o => ({ Key: o.Key })),
                  Quiet: true,
                },
              }));
              deletedCount += objects.length;
              console.log(\`Deleted \${objects.length} objects from \${prefix}\`);
            }

            continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
          } while (continuationToken);

          console.log(\`S3 cleanup complete for \${tenantId}: \${deletedCount} objects deleted\`);
          return { success: true, prefix, deletedCount };
        };
      `),
      environment: {
        TENANT_BUCKET_NAME: props.tenantBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    props.tenantBucket.grantReadWrite(this.cleanupS3PrefixFunction, 'tenants/*');

    // ======================================================================
    // Lambda: Cleanup Cedar Policies
    // Paginates through the policy store, finds policies matching the tenant
    // by description, and deletes them. Handles ResourceNotFound gracefully.
    // ======================================================================
    this.cleanupCedarPoliciesFunction = new lambda.Function(this, 'CleanupCedarPolicies', {
      functionName: `chimera-offboard-cedar-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { VerifiedPermissionsClient, ListPoliciesCommand, DeletePolicyCommand } = require('@aws-sdk/client-verifiedpermissions');
        const client = new VerifiedPermissionsClient({});

        exports.handler = async (event) => {
          const { tenantId } = event;
          const policyStoreId = process.env.POLICY_STORE_ID;
          const deletedPolicies = [];
          let nextToken;

          do {
            const listResult = await client.send(new ListPoliciesCommand({
              policyStoreId,
              nextToken,
            }));

            for (const policy of (listResult.policies || [])) {
              const desc = policy.definition?.static?.description || '';
              if (desc.includes(tenantId)) {
                try {
                  await client.send(new DeletePolicyCommand({
                    policyStoreId,
                    policyId: policy.policyId,
                  }));
                  deletedPolicies.push(policy.policyId);
                  console.log(\`Deleted Cedar policy \${policy.policyId} for tenant \${tenantId}\`);
                } catch (err) {
                  if (!err.name?.includes('ResourceNotFoundException')) throw err;
                  console.log(\`Cedar policy \${policy.policyId} already deleted, skipping\`);
                }
              }
            }

            nextToken = listResult.nextToken;
          } while (nextToken);

          console.log(\`Deleted \${deletedPolicies.length} Cedar policies for tenant \${tenantId}\`);
          return { success: true, deletedCount: deletedPolicies.length, policyIds: deletedPolicies };
        };
      `),
      environment: {
        POLICY_STORE_ID: this.cedarPolicy.policyStore.attrPolicyStoreId,
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    this.cleanupCedarPoliciesFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['verifiedpermissions:ListPolicies', 'verifiedpermissions:DeletePolicy'],
      resources: [this.cedarPolicy.policyStore.attrArn],
    }));

    // ======================================================================
    // Lambda: Cleanup DDB Items
    // Queries PK=TENANT#{tenantId} on all 6 tables and batch-deletes all
    // matching items. Handles pagination for large result sets.
    // ======================================================================
    this.cleanupDdbItemsFunction = new lambda.Function(this, 'CleanupDdbItems', {
      functionName: `chimera-offboard-ddb-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, QueryCommand, BatchWriteItemCommand } = require('@aws-sdk/client-dynamodb');
        const client = new DynamoDBClient({});

        async function deleteAllItemsForTenant(tableName, tenantId) {
          let lastEvaluatedKey;
          let deletedCount = 0;
          do {
            const queryResult = await client.send(new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: 'PK = :pk',
              ExpressionAttributeValues: { ':pk': { S: \`TENANT#\${tenantId}\` } },
              ExclusiveStartKey: lastEvaluatedKey,
            }));

            const items = queryResult.Items || [];
            // BatchWriteItem limit: 25 items per request
            for (let i = 0; i < items.length; i += 25) {
              const chunk = items.slice(i, i + 25);
              await client.send(new BatchWriteItemCommand({
                RequestItems: {
                  [tableName]: chunk.map(item => ({
                    DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
                  })),
                },
              }));
              deletedCount += chunk.length;
            }

            lastEvaluatedKey = queryResult.LastEvaluatedKey;
          } while (lastEvaluatedKey);
          return deletedCount;
        }

        exports.handler = async (event) => {
          const { tenantId } = event;
          const tables = [
            process.env.TENANTS_TABLE_NAME,
            process.env.SESSIONS_TABLE_NAME,
            process.env.SKILLS_TABLE_NAME,
            process.env.RATE_LIMITS_TABLE_NAME,
            process.env.COST_TRACKING_TABLE_NAME,
            process.env.AUDIT_TABLE_NAME,
          ].filter(Boolean);

          const deletedByTable = {};
          for (const tableName of tables) {
            deletedByTable[tableName] = await deleteAllItemsForTenant(tableName, tenantId);
            console.log(\`Deleted \${deletedByTable[tableName]} items from \${tableName} for \${tenantId}\`);
          }

          return { success: true, tenantId, deletedByTable };
        };
      `),
      environment: {
        TENANTS_TABLE_NAME: props.tenantsTable.tableName,
        SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
        SKILLS_TABLE_NAME: props.skillsTable.tableName,
        RATE_LIMITS_TABLE_NAME: props.rateLimitsTable.tableName,
        COST_TRACKING_TABLE_NAME: props.costTrackingTable.tableName,
        AUDIT_TABLE_NAME: props.auditTable.tableName,
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    props.tenantsTable.grantReadWriteData(this.cleanupDdbItemsFunction);
    props.sessionsTable.grantReadWriteData(this.cleanupDdbItemsFunction);
    props.skillsTable.grantReadWriteData(this.cleanupDdbItemsFunction);
    props.rateLimitsTable.grantReadWriteData(this.cleanupDdbItemsFunction);
    props.costTrackingTable.grantReadWriteData(this.cleanupDdbItemsFunction);
    props.auditTable.grantReadWriteData(this.cleanupDdbItemsFunction);

    // ======================================================================
    // Lambda: Finalize Tenant Offboarding
    // Writes a CHURNED tombstone PROFILE record (PutItem: upsert) to preserve
    // the audit trail. All other items were deleted by cleanupDdbItems.
    // ======================================================================
    this.finalizeTenantOffboardingFunction = new lambda.Function(this, 'FinalizeTenantOffboarding', {
      functionName: `chimera-offboard-finalize-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
        const client = new DynamoDBClient({});

        exports.handler = async (event) => {
          const { tenantId } = event;
          const offboardResult = event.offboardResult?.Payload || {};
          const tableName = process.env.TENANTS_TABLE_NAME;
          const now = new Date().toISOString();

          // Write a sparse CHURNED tombstone so audit trail is preserved
          await client.send(new PutItemCommand({
            TableName: tableName,
            Item: {
              PK: { S: \`TENANT#\${tenantId}\` },
              SK: { S: 'PROFILE' },
              tenantId: { S: tenantId },
              status: { S: 'CHURNED' },
              ...(offboardResult.tier ? { tier: { S: offboardResult.tier } } : {}),
              ...(offboardResult.name ? { name: { S: offboardResult.name } } : {}),
              offboardedAt: { S: now },
              updatedAt: { S: now },
            },
          }));

          console.log(\`Tenant \${tenantId} offboarding finalized, status CHURNED\`);
          return { success: true, tenantId, status: 'CHURNED', offboardedAt: now };
        };
      `),
      environment: {
        TENANTS_TABLE_NAME: props.tenantsTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
    });
    props.tenantsTable.grantWriteData(this.finalizeTenantOffboardingFunction);

    // ======================================================================
    // Step Functions: Offboarding Workflow
    // offboardTenant
    //   -> parallel(cleanupIamRole | cleanupCognitoGroup | cleanupS3Prefix | cleanupCedarPolicies)
    //   -> cleanupDdbItems
    //   -> finalizeTenantOffboarding
    //   -> Success
    //
    // Errors route to a Fail state (no auto-compensation — offboarding is
    // intentional and each step is idempotent; re-run is the recovery path).
    // ======================================================================

    const offboardingFailState = new sfn.Fail(this, 'OffboardingFailed', {
      cause: 'Tenant offboarding workflow failed',
      error: 'OffboardingError',
    });

    // Step 1: Validate tenant and mark OFFBOARDING
    const offboardTenantTask = new tasks.LambdaInvoke(this, 'OffboardTenantTask', {
      lambdaFunction: this.offboardTenantFunction,
      resultPath: '$.offboardResult',
    });
    offboardTenantTask.addRetry({ errors: ['States.ALL'], maxAttempts: 3, backoffRate: 2, interval: cdk.Duration.seconds(1) });
    offboardTenantTask.addCatch(offboardingFailState, { resultPath: '$.error' });

    // Step 2 (parallel branches): IAM, Cognito, S3, Cedar cleanup
    const cleanupIamRoleTask = new tasks.LambdaInvoke(this, 'CleanupIamRoleTask', {
      lambdaFunction: this.cleanupIamRoleFunction,
      resultPath: '$.cleanupIamResult',
    });
    cleanupIamRoleTask.addRetry({ errors: ['States.ALL'], maxAttempts: 3, backoffRate: 2, interval: cdk.Duration.seconds(1) });

    const cleanupCognitoGroupTask = new tasks.LambdaInvoke(this, 'CleanupCognitoGroupTask', {
      lambdaFunction: this.cleanupCognitoGroupFunction,
      resultPath: '$.cleanupCognitoResult',
    });
    cleanupCognitoGroupTask.addRetry({ errors: ['States.ALL'], maxAttempts: 3, backoffRate: 2, interval: cdk.Duration.seconds(1) });

    const cleanupS3PrefixTask = new tasks.LambdaInvoke(this, 'CleanupS3PrefixTask', {
      lambdaFunction: this.cleanupS3PrefixFunction,
      resultPath: '$.cleanupS3Result',
    });
    cleanupS3PrefixTask.addRetry({ errors: ['States.ALL'], maxAttempts: 3, backoffRate: 2, interval: cdk.Duration.seconds(1) });

    const cleanupCedarPoliciesTask = new tasks.LambdaInvoke(this, 'CleanupCedarPoliciesTask', {
      lambdaFunction: this.cleanupCedarPoliciesFunction,
      resultPath: '$.cleanupCedarResult',
    });
    cleanupCedarPoliciesTask.addRetry({ errors: ['States.ALL'], maxAttempts: 3, backoffRate: 2, interval: cdk.Duration.seconds(1) });

    // resultPath preserves $.tenantId / $.offboardResult for downstream steps
    const parallelCleanup = new sfn.Parallel(this, 'ParallelCleanup', {
      resultPath: '$.parallelCleanupResult',
    })
      .branch(cleanupIamRoleTask)
      .branch(cleanupCognitoGroupTask)
      .branch(cleanupS3PrefixTask)
      .branch(cleanupCedarPoliciesTask);
    parallelCleanup.addCatch(offboardingFailState, { resultPath: '$.error' });

    // Step 3: Delete all DDB items across all 6 tables
    const cleanupDdbItemsTask = new tasks.LambdaInvoke(this, 'CleanupDdbItemsTask', {
      lambdaFunction: this.cleanupDdbItemsFunction,
      resultPath: '$.cleanupDdbResult',
    });
    cleanupDdbItemsTask.addRetry({ errors: ['States.ALL'], maxAttempts: 3, backoffRate: 2, interval: cdk.Duration.seconds(1) });
    cleanupDdbItemsTask.addCatch(offboardingFailState, { resultPath: '$.error' });

    // Step 4: Write CHURNED tombstone record
    const finalizeTenantOffboardingTask = new tasks.LambdaInvoke(this, 'FinalizeTenantOffboardingTask', {
      lambdaFunction: this.finalizeTenantOffboardingFunction,
      resultPath: '$.finalizeResult',
    });
    finalizeTenantOffboardingTask.addRetry({ errors: ['States.ALL'], maxAttempts: 3, backoffRate: 2, interval: cdk.Duration.seconds(1) });
    finalizeTenantOffboardingTask.addCatch(offboardingFailState, { resultPath: '$.error' });

    const offboardingSuccessState = new sfn.Succeed(this, 'OffboardingComplete', {
      comment: 'Tenant offboarding completed successfully',
    });

    const offboardingDefinition = offboardTenantTask
      .next(parallelCleanup)
      .next(cleanupDdbItemsTask)
      .next(finalizeTenantOffboardingTask)
      .next(offboardingSuccessState);

    this.offboardingStateMachine = new sfn.StateMachine(this, 'OffboardingStateMachine', {
      stateMachineName: `chimera-tenant-offboarding-${envName}`,
      definitionBody: sfn.DefinitionBody.fromChainable(offboardingDefinition),
      timeout: cdk.Duration.minutes(15),
      tracingEnabled: true,
    });

    new cdk.CfnOutput(this, 'OffboardingStateMachineArn', {
      value: this.offboardingStateMachine.stateMachineArn,
      description: 'Step Functions state machine ARN for tenant offboarding',
      exportName: `Chimera-${envName}-OffboardingStateMachineArn`,
    });
  }
}
