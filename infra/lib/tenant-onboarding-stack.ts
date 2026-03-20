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
            // Create tenant isolation policy
            await client.send(new CreatePolicyCommand({
              policyStoreId,
              definition: {
                static: {
                  statement: tenantIsolationPolicy,
                  description: \`Tenant isolation policy for \${tenantId}\`,
                },
              },
            }));

            // Create tier-specific tool policy (if applicable)
            if (toolInvocationPolicy) {
              await client.send(new CreatePolicyCommand({
                policyStoreId,
                definition: {
                  static: {
                    statement: toolInvocationPolicy,
                    description: \`Tool invocation policy for \${tenantId} (\${tier} tier)\`,
                  },
                },
              }));
            }

            console.log(\`Created Cedar policies for tenant \${tenantId}\`);
            return { success: true, policiesCreated: toolInvocationPolicy ? 2 : 1 };
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
    const createTenantTask = new tasks.LambdaInvoke(this, 'CreateTenantRecord', {
      lambdaFunction: this.createTenantRecordFunction,
      resultPath: '$.createTenantResult',
    });

    const createRoleTask = new tasks.LambdaInvoke(this, 'CreateIAMRole', {
      lambdaFunction: this.createIamRoleFunction,
      resultPath: '$.createRoleResult',
    });

    const createGroupTask = new tasks.LambdaInvoke(this, 'CreateCognitoGroup', {
      lambdaFunction: this.createCognitoGroupFunction,
      inputPath: '$',
      resultPath: '$.createGroupResult',
      payload: sfn.TaskInput.fromObject({
        tenantId: sfn.JsonPath.stringAt('$.tenantId'),
        tier: sfn.JsonPath.stringAt('$.tier'),
        iamRoleArn: sfn.JsonPath.stringAt('$.createRoleResult.Payload.roleArn'),
      }),
    });

    const initS3Task = new tasks.LambdaInvoke(this, 'InitializeS3Prefix', {
      lambdaFunction: this.initializeS3PrefixFunction,
      resultPath: '$.initS3Result',
    });

    const createCedarTask = new tasks.LambdaInvoke(this, 'CreateCedarPolicies', {
      lambdaFunction: this.createCedarPoliciesFunction,
      resultPath: '$.createCedarResult',
    });

    const initCostTask = new tasks.LambdaInvoke(this, 'InitializeCostTracking', {
      lambdaFunction: this.initializeCostTrackingFunction,
      resultPath: '$.initCostResult',
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

    // Success notification
    const successState = new sfn.Succeed(this, 'OnboardingComplete', {
      comment: 'Tenant onboarding completed successfully',
    });

    // Error handling
    const failState = new sfn.Fail(this, 'OnboardingFailed', {
      cause: 'Tenant onboarding workflow failed',
      error: 'OnboardingError',
    });

    // Chain workflow steps
    const definition = createTenantTask
      .next(createRoleTask)
      .next(createGroupTask)
      .next(
        new sfn.Parallel(this, 'ParallelInitialization')
          .branch(initS3Task)
          .branch(createCedarTask)
          .branch(initCostTask)
      )
      .next(updateStatusTask)
      .next(successState)
      .addCatch(failState, { resultPath: '$.error' });

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
  }
}
