import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
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

    // Grant CloudWatch Logs permission to use this key for LogGroup encryption
    // CloudWatch Logs can ONLY access KMS via key policy, not IAM policies
    this.platformKey.addToResourcePolicy(new iam.PolicyStatement({
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
    }));

    // ======================================================================
    // Cognito User Pool
    // Single pool per environment. Tenants are distinguished by the
    // custom:tenant_id claim in the JWT, NOT by separate user pools.
    // This keeps the architecture simple while supporting tenant isolation
    // via the tenant_id claim in API Gateway authorizers and Cedar policies.
    // ======================================================================
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `chimera-users-${props.envName}`,
      selfSignUpEnabled: true, // Users can self-register via web UI
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
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
      `https://chat-${props.envName}.example.com/auth/callback`,
    ];
    const defaultLogoutUrls = [
      'http://localhost:8080/',
      `https://chat-${props.envName}.example.com/`,
    ];

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'chimera-web',
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
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
    // ======================================================================
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
      description: 'Cognito hosted UI domain (e.g., chimera-dev-123456789.auth.us-east-1.amazoncognito.com)',
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
