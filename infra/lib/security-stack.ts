import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface SecurityStackProps extends cdk.StackProps {
  envName: string;
  callbackUrls?: string[];
  logoutUrls?: string[];
}

/**
 * Security layer for Chimera.
 *
 * Creates a Cognito user pool with tenant-scoped custom attributes,
 * three user pool groups (admin, tenant-admin, user), a WAF WebACL
 * with rate limiting and managed rule sets, and a KMS key for
 * platform-level encryption.
 */
export class SecurityStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly webAcl: wafv2.CfnWebACL;
  public readonly platformKey: kms.Key;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // KMS: Platform encryption key
    // Used for Secrets Manager secrets, SNS topic encryption, etc.
    // Separate from the audit key in DataStack (different access policies).
    // ======================================================================
    this.platformKey = new kms.Key(this, 'PlatformKey', {
      alias: `chimera-platform-${props.envName}`,
      enableKeyRotation: true,
      description: 'Chimera platform encryption key for secrets and SNS',
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Grant CloudWatch Logs permission to use this key for LogGroup encryption.
    // CloudWatch Logs can ONLY access KMS via key policy, not IAM policies (ref: ADR-022).
    //
    // Race-condition guard: this statement is added BEFORE any cross-stack
    // consumer (ObservabilityStack, etc.) references `platformKey`. Synthesis
    // order is enforced two ways:
    //   1. `addToResourcePolicy` runs synchronously in this constructor, so
    //      the resulting CFN template has the permission baked into the
    //      initial key policy — not an async `AWS::KMS::KeyPolicy` update.
    //   2. `observabilityStack.addDependency(securityStack)` in bin/chimera.ts
    //      (and the implicit `platformKey` prop passthrough) enforces that
    //      SecurityStack reaches CREATE_COMPLETE — key + policy together —
    //      before any KMS-encrypted log group is provisioned.
    // Do not move this block below `new kms.Key(...)`'s consumers; removing
    // either guarantee can produce silently-unencrypted log groups.
    // (ref: docs/reviews/infra-review.md §3)
    this.platformKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:CreateGrant',
          'kms:DescribeKey',
        ],
        resources: ['*'], // Key policy always uses '*' for resources (refers to this key)
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      })
    );

    // ======================================================================
    // Cognito User Pool
    // Single pool per environment. Tenants are distinguished by the
    // custom:tenant_id claim in the JWT, NOT by separate user pools.
    // This keeps the architecture simple while supporting tenant isolation
    // via the tenant_id claim in API Gateway authorizers and Cedar policies.
    // ======================================================================
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `chimera-users-${props.envName}`,
      selfSignUpEnabled: false, // Admin-only user creation for security
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      customAttributes: {
        // Immutable after creation -- tenant assignment is permanent
        tenant_id: new cognito.StringAttribute({ mutable: false }),
        // Mutable -- tier can change on upgrade/downgrade
        tenant_tier: new cognito.StringAttribute({ mutable: true }),
      },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ======================================================================
    // Post-Confirmation Lambda Trigger
    // On first sign-up confirmation, generates a tenant ID, writes it to
    // the user's custom:tenant_id attribute, and starts the tenant onboarding
    // Step Functions workflow. Uses the known state machine naming convention
    // to avoid a circular dependency between SecurityStack and TenantOnboardingStack.
    // ======================================================================
    const postConfirmationFn = new lambda.Function(this, 'PostConfirmationTrigger', {
      functionName: `chimera-post-confirmation-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      code: lambda.Code.fromInline(`
const { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const crypto = require('crypto');

const cognito = new CognitoIdentityProviderClient({});
const sfn = new SFNClient({});

exports.handler = async (event) => {
  // Only trigger on PostConfirmation_ConfirmSignUp (not PostConfirmation_ConfirmForgotPassword)
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event;

  const userId = event.request.userAttributes.sub;
  const email = event.request.userAttributes.email;
  const userPoolId = event.userPoolId;
  const tenantId = 'tenant_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

  console.log(JSON.stringify({ message: 'New user confirmed', userId, email, tenantId }));

  // 1. Set custom:tenant_id on the Cognito user
  await cognito.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: userPoolId,
    Username: userId,
    UserAttributes: [{ Name: 'custom:tenant_id', Value: tenantId }],
  }));

  // 2. Start tenant onboarding Step Functions
  const onboardingArn = process.env.ONBOARDING_STATE_MACHINE_ARN;
  if (onboardingArn) {
    try {
      await sfn.send(new StartExecutionCommand({
        stateMachineArn: onboardingArn,
        name: tenantId + '-' + Date.now(),
        input: JSON.stringify({
          tenantId,
          userId,
          email,
          tier: 'basic',
          adminEmail: email,
          timestamp: new Date().toISOString(),
        }),
      }));
    } catch (err) {
      console.error('Onboarding start failed (non-fatal):', err.message);
      // Don't fail the Cognito flow — tenant record can be created later
    }
  }

  return event;
};
      `),
      environment: {
        // Constructed from the known naming convention to avoid circular cross-stack dependency.
        // TenantOnboardingStack names its state machine: chimera-tenant-onboarding-{envName}
        ONBOARDING_STATE_MACHINE_ARN: `arn:aws:states:${this.region}:${this.account}:stateMachine:chimera-tenant-onboarding-${props.envName}`,
      },
    });

    // Grant Cognito admin permissions to update user attributes.
    // Use account-scoped wildcard to break the CDK circular dependency:
    //   UserPool → PostConfirmationTrigger → ServiceRolePolicy → UserPool
    // The Lambda is ONLY invoked by this User Pool's trigger, and the action
    // is narrowly scoped to AdminUpdateUserAttributes, so the broader
    // resource scope is acceptable.
    postConfirmationFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminUpdateUserAttributes'],
        resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`],
      })
    );

    // Grant Step Functions start execution (scoped to the onboarding state machine)
    postConfirmationFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [
          `arn:aws:states:${this.region}:${this.account}:stateMachine:chimera-tenant-onboarding-${props.envName}`,
        ],
      })
    );

    // Wire as Cognito post-confirmation trigger
    this.userPool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION, postConfirmationFn);

    // --- User pool groups ---
    // admin: platform operators (full access)
    // tenant-admin: tenant administrators (manage their tenant's agents, skills, users)
    // user: regular users (invoke agents, view dashboards)
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'Platform administrators with full access',
      precedence: 0, // Highest priority
    });
    new cognito.CfnUserPoolGroup(this, 'TenantAdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'tenant-admin',
      description: 'Tenant administrators: manage agents, skills, and tenant users',
      precedence: 10,
    });
    new cognito.CfnUserPoolGroup(this, 'UserGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'user',
      description: 'Regular users: invoke agents and view dashboards',
      precedence: 20,
    });

    // --- Cognito Hosted UI Domain ---
    // Custom domain for OAuth flows (login/callback)
    const hostedUIDomain = this.userPool.addDomain('HostedUI', {
      cognitoDomain: {
        domainPrefix: `chimera-${props.envName}-${this.account}`,
      },
    });

    // --- App clients ---
    // Web client: authorization code grant for browser-based apps
    // Dynamic callback URLs: accept API Gateway URLs from ApiStack or use localhost for dev
    const defaultCallbackUrls = [
      'http://localhost:8080/auth/callback',
      'http://localhost:9999/callback',
      `https://chat-${props.envName}.example.com/auth/callback`,
    ];
    const defaultLogoutUrls = [
      'http://localhost:8080/',
      'http://localhost:9999/',
      `https://chat-${props.envName}.example.com/`,
    ];

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'chimera-web',
      authFlows: { userSrp: true, userPassword: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: props.callbackUrls || defaultCallbackUrls,
        logoutUrls: props.logoutUrls || defaultLogoutUrls,
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      generateSecret: false, // PKCE doesn't use client secret
      preventUserExistenceErrors: true,
    });

    // CLI client: SRP auth for the `chimera` CLI tool
    this.userPool.addClient('CliClient', {
      userPoolClientName: 'chimera-cli',
      authFlows: { userSrp: true },
      accessTokenValidity: cdk.Duration.hours(8),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    // ======================================================================
    // WAF WebACL
    // Attached to API Gateway (regional scope). Three rules:
    // 1. AWS Managed Common Rules -- blocks common exploits (XSS, SQLi, etc.)
    // 2. Rate limiting -- 2000 requests per 5-min window per IP
    // 3. AWS Managed Known Bad Inputs -- blocks known malicious payloads
    //
    // Logging: WebACL logs are sent to a dedicated CloudWatch LogGroup
    // (encrypted with platformKey) so blocked requests are auditable. Without
    // this, only aggregate metrics would be visible — no per-request forensics
    // for attack pattern investigation or false-positive review.
    // (ref: docs/reviews/infra-review.md §2)
    // ======================================================================

    // WAFv2 requires log group names to begin with 'aws-waf-logs-'.
    const wafLogGroup = new logs.LogGroup(this, 'WafLogGroup', {
      logGroupName: `aws-waf-logs-chimera-api-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      encryptionKey: this.platformKey,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `chimera-api-waf-${props.envName}`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `chimera-waf-${props.envName}`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'common-rules',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimitPerIP',
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'rate-limit',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'bad-inputs',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Attach the CloudWatch LogGroup to the WebACL for request logging.
    // WAFv2 `LogDestinationConfigs` requires the log-group ARN *without* the
    // trailing ':*' that CloudWatch Logs appends, so we construct it from the
    // log-group name instead of re-parsing `wafLogGroup.logGroupArn`.
    const wafLogGroupArnForWaf = cdk.Stack.of(this).formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: wafLogGroup.logGroupName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
    const wafLoggingConfiguration = new wafv2.CfnLoggingConfiguration(
      this,
      'WebAclLogging',
      {
        logDestinationConfigs: [wafLogGroupArnForWaf],
        resourceArn: this.webAcl.attrArn,
      }
    );
    wafLoggingConfiguration.node.addDependency(this.webAcl);
    wafLoggingConfiguration.node.addDependency(wafLogGroup);

    // --- Stack outputs ---
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `${this.stackName}-UserPoolId`,
    });
    new cdk.CfnOutput(this, 'UserPoolArn', {
      value: this.userPool.userPoolArn,
      exportName: `${this.stackName}-UserPoolArn`,
    });
    new cdk.CfnOutput(this, 'WebClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${this.stackName}-WebClientId`,
    });
    new cdk.CfnOutput(this, 'HostedUIDomain', {
      value: hostedUIDomain.domainName,
      exportName: `${this.stackName}-HostedUIDomain`,
      description:
        'Cognito hosted UI domain (e.g., chimera-dev-123456789.auth.us-east-1.amazoncognito.com)',
    });
    new cdk.CfnOutput(this, 'CognitoOAuthURL', {
      value: `https://${hostedUIDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      exportName: `${this.stackName}-CognitoOAuthURL`,
      description: 'Cognito OAuth base URL for login/token endpoints',
    });
    new cdk.CfnOutput(this, 'WebAclArn', {
      value: this.webAcl.attrArn,
      exportName: `${this.stackName}-WebAclArn`,
    });
    new cdk.CfnOutput(this, 'PlatformKeyArn', {
      value: this.platformKey.keyArn,
      exportName: `${this.stackName}-PlatformKeyArn`,
    });
  }
}
