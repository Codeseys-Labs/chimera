/**
 * CDK tests for SecurityStack
 *
 * Validates Phase 3 security infrastructure:
 * - Cognito User Pool with tenant-scoped custom attributes
 * - Password policy enforcement (12+ chars, all types)
 * - User pool groups (admin, tenant-admin, user)
 * - App clients (web, CLI)
 * - WAF WebACL with managed rules and rate limiting
 * - KMS platform encryption key with rotation
 * - Stack outputs for all security resources
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SecurityStack } from '../lib/security-stack';

describe('SecurityStack', () => {
  describe('Dev Environment', () => {
    let app: cdk.App;
    let stack: SecurityStack;
    let template: Template;

    beforeEach(() => {
      app = new cdk.App();
      stack = new SecurityStack(app, 'TestSecurityStack', {
        envName: 'dev',
      });
      template = Template.fromStack(stack);
    });

    describe('KMS Platform Key', () => {
      it('should create platform encryption key with rotation enabled', () => {
        template.resourceCountIs('AWS::KMS::Key', 1);

        template.hasResourceProperties('AWS::KMS::Key', {
          Description: 'Chimera platform encryption key for secrets and SNS',
          EnableKeyRotation: true,
        });
      });

      it('should create KMS alias for platform key', () => {
        template.resourceCountIs('AWS::KMS::Alias', 1);

        template.hasResourceProperties('AWS::KMS::Alias', {
          AliasName: 'alias/chimera-platform-dev',
        });
      });
    });

    describe('Cognito User Pool', () => {
      it('should create user pool with correct configuration', () => {
        template.resourceCountIs('AWS::Cognito::UserPool', 1);

        template.hasResourceProperties('AWS::Cognito::UserPool', {
          UserPoolName: 'chimera-users-dev',
          AutoVerifiedAttributes: ['email'],
          UsernameAttributes: ['email'],
          Policies: {
            PasswordPolicy: {
              MinimumLength: 12,
              RequireLowercase: true,
              RequireUppercase: true,
              RequireNumbers: true,
              RequireSymbols: true,
            },
          },
        });
      });

      it('should disable self sign-up', () => {
        template.hasResourceProperties('AWS::Cognito::UserPool', {
          AdminCreateUserConfig: {
            AllowAdminCreateUserOnly: true,
          },
        });
      });

      it('should configure MFA as optional with TOTP', () => {
        template.hasResourceProperties('AWS::Cognito::UserPool', {
          MfaConfiguration: 'OPTIONAL',
          EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
        });
      });

      it('should have email-only account recovery', () => {
        template.hasResourceProperties('AWS::Cognito::UserPool', {
          AccountRecoverySetting: {
            RecoveryMechanisms: [
              {
                Name: 'verified_email',
                Priority: 1,
              },
            ],
          },
        });
      });

      it('should define custom tenant_id attribute (immutable)', () => {
        template.hasResourceProperties('AWS::Cognito::UserPool', {
          Schema: Match.arrayWith([
            Match.objectLike({
              Name: 'tenant_id',
              Mutable: false,
              AttributeDataType: 'String',
            }),
          ]),
        });
      });

      it('should define custom tenant_tier attribute (mutable)', () => {
        template.hasResourceProperties('AWS::Cognito::UserPool', {
          Schema: Match.arrayWith([
            Match.objectLike({
              Name: 'tenant_tier',
              Mutable: true,
              AttributeDataType: 'String',
            }),
          ]),
        });
      });
    });

    describe('User Pool Groups', () => {
      it('should create 3 user pool groups', () => {
        template.resourceCountIs('AWS::Cognito::UserPoolGroup', 3);
      });

      it('should create admin group with highest precedence', () => {
        template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
          GroupName: 'admin',
          Description: 'Platform administrators with full access',
          Precedence: 0,
        });
      });

      it('should create tenant-admin group', () => {
        template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
          GroupName: 'tenant-admin',
          Description: 'Tenant administrators: manage agents, skills, and tenant users',
          Precedence: 10,
        });
      });

      it('should create user group with lowest precedence', () => {
        template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
          GroupName: 'user',
          Description: 'Regular users: invoke agents and view dashboards',
          Precedence: 20,
        });
      });
    });

    describe('User Pool Clients', () => {
      it('should create 2 user pool clients', () => {
        template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
      });

      it('should create web client with OAuth flows + 7-day refresh + revocation (Wave-15 H3/M1)', () => {
        template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
          ClientName: 'chimera-web',
          AllowedOAuthFlows: ['code'],
          AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'profile']),
          AllowedOAuthFlowsUserPoolClient: true,
          ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
          // CDK converts hours/days to minutes internally
          AccessTokenValidity: 60, // 1 hour = 60 minutes
          IdTokenValidity: 60, // 1 hour = 60 minutes
          RefreshTokenValidity: 10080, // 7 days = 10080 minutes (Wave-15 M1)
          EnableTokenRevocation: true,
        });
      });

      it('should create CLI client with SRP auth + 1-day refresh + revocation (Wave-15 H3/M1)', () => {
        template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
          ClientName: 'chimera-cli',
          ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_SRP_AUTH']),
          // CDK converts hours/days to minutes internally
          AccessTokenValidity: 480, // 8 hours = 480 minutes
          RefreshTokenValidity: 1440, // 1 day = 1440 minutes (Wave-15 M1)
          EnableTokenRevocation: true,
        });
      });
    });

    describe('WAF WebACL', () => {
      it('should create WAF WebACL for regional scope', () => {
        template.resourceCountIs('AWS::WAFv2::WebACL', 1);

        template.hasResourceProperties('AWS::WAFv2::WebACL', {
          Name: 'chimera-api-waf-dev',
          Scope: 'REGIONAL',
          DefaultAction: {
            Allow: {},
          },
          VisibilityConfig: {
            CloudWatchMetricsEnabled: true,
            MetricName: 'chimera-waf-dev',
            SampledRequestsEnabled: true,
          },
        });
      });

      it('should have 3 WAF rules', () => {
        const webAcl = template.findResources('AWS::WAFv2::WebACL');
        const webAclResource = Object.values(webAcl)[0] as any;
        const rules = webAclResource.Properties.Rules;

        expect(rules).toHaveLength(3);
      });

      it('should include AWS Managed Common Rules (priority 1)', () => {
        template.hasResourceProperties('AWS::WAFv2::WebACL', {
          Rules: Match.arrayWith([
            Match.objectLike({
              Name: 'AWSManagedRulesCommonRuleSet',
              Priority: 1,
              OverrideAction: { None: {} },
              Statement: {
                ManagedRuleGroupStatement: {
                  VendorName: 'AWS',
                  Name: 'AWSManagedRulesCommonRuleSet',
                },
              },
              VisibilityConfig: {
                CloudWatchMetricsEnabled: true,
                MetricName: 'common-rules',
                SampledRequestsEnabled: true,
              },
            }),
          ]),
        });
      });

      it('should include rate limiting rule (priority 2, Wave-15 M2 bot/DDoS backstop at 10k)', () => {
        template.hasResourceProperties('AWS::WAFv2::WebACL', {
          Rules: Match.arrayWith([
            Match.objectLike({
              Name: 'RateLimitPerIP',
              Priority: 2,
              Action: { Block: {} },
              Statement: {
                RateBasedStatement: {
                  Limit: 10000,
                  AggregateKeyType: 'IP',
                },
              },
              VisibilityConfig: {
                CloudWatchMetricsEnabled: true,
                MetricName: 'rate-limit',
                SampledRequestsEnabled: true,
              },
            }),
          ]),
        });
      });

      it('should include AWS Managed Known Bad Inputs (priority 3)', () => {
        template.hasResourceProperties('AWS::WAFv2::WebACL', {
          Rules: Match.arrayWith([
            Match.objectLike({
              Name: 'AWSManagedRulesKnownBadInputsRuleSet',
              Priority: 3,
              OverrideAction: { None: {} },
              Statement: {
                ManagedRuleGroupStatement: {
                  VendorName: 'AWS',
                  Name: 'AWSManagedRulesKnownBadInputsRuleSet',
                },
              },
              VisibilityConfig: {
                CloudWatchMetricsEnabled: true,
                MetricName: 'bad-inputs',
                SampledRequestsEnabled: true,
              },
            }),
          ]),
        });
      });
    });

    describe('Stack Outputs', () => {
      it('should export User Pool ID', () => {
        template.hasOutput('UserPoolId', {
          Export: {
            Name: 'TestSecurityStack-UserPoolId',
          },
        });
      });

      it('should export User Pool ARN', () => {
        template.hasOutput('UserPoolArn', {
          Export: {
            Name: 'TestSecurityStack-UserPoolArn',
          },
        });
      });

      it('should export Web Client ID', () => {
        template.hasOutput('WebClientId', {
          Export: {
            Name: 'TestSecurityStack-WebClientId',
          },
        });
      });

      it('should export Web ACL ARN', () => {
        template.hasOutput('WebAclArn', {
          Export: {
            Name: 'TestSecurityStack-WebAclArn',
          },
        });
      });

      it('should export Platform Key ARN', () => {
        template.hasOutput('PlatformKeyArn', {
          Export: {
            Name: 'TestSecurityStack-PlatformKeyArn',
          },
        });
      });
    });
  });

  describe('Prod Environment', () => {
    let app: cdk.App;
    let stack: SecurityStack;
    let template: Template;

    beforeEach(() => {
      app = new cdk.App();
      stack = new SecurityStack(app, 'TestSecurityStackProd', {
        envName: 'prod',
      });
      template = Template.fromStack(stack);
    });

    it('should use RETAIN removal policy for User Pool in prod', () => {
      const userPools = template.findResources('AWS::Cognito::UserPool');
      expect(Object.keys(userPools).length).toBe(1);

      const userPool = Object.values(userPools)[0] as any;
      expect(userPool.DeletionPolicy).toBe('Retain');
    });

    it('should use RETAIN removal policy for KMS key in prod', () => {
      const keys = template.findResources('AWS::KMS::Key');
      expect(Object.keys(keys).length).toBe(1);

      const key = Object.values(keys)[0] as any;
      expect(key.DeletionPolicy).toBe('Retain');
    });
  });
});
