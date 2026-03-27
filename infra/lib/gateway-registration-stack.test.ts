/**
 * CDK tests for GatewayRegistrationStack
 *
 * Validates gateway tool registration infrastructure:
 * - 4 Lambda functions for tool tier targets (tier1, tier2, tier3, discovery)
 * - 1 CDK LogRetentionFunction singleton (from ChimeraLambda logRetention)
 * - 4 SQS DLQ queues (one per ChimeraLambda)
 * - 4 SSM parameters for runtime ARN discovery
 * - 1 IAM role for AgentCore Gateway invocation
 * - 4 stack outputs for cross-stack consumption
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { GatewayRegistrationStack } from './gateway-registration-stack';

const ENV = { account: '123456789012', region: 'us-east-1' };

describe('GatewayRegistrationStack', () => {
  let stack: GatewayRegistrationStack;
  let template: Template;

  // Synthesize once — CDK synthesis is expensive
  beforeAll(() => {
    const app = new cdk.App();
    stack = new GatewayRegistrationStack(app, 'TestGatewayRegistrationStack', {
      env: ENV,
      envName: 'dev',
    });
    template = Template.fromStack(stack);
  });

  describe('Lambda Functions', () => {
    it('should create 5 Lambda functions (4 tool targets + 1 CDK LogRetentionFunction)', () => {
      // 4 ChimeraLambda tool targets + 1 CDK LogRetentionFunction singleton
      template.resourceCountIs('AWS::Lambda::Function', 5);
    });

    it('should create Tier 1 Lambda with correct name and Python 3.12 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-gateway-tools-tier1-dev',
        Runtime: 'python3.12',
        Handler: 'index.handler',
      });
    });

    it('should create Tier 2 Lambda with correct name and Python 3.12 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-gateway-tools-tier2-dev',
        Runtime: 'python3.12',
        Handler: 'index.handler',
      });
    });

    it('should create Tier 3 Lambda with correct name and Python 3.12 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-gateway-tools-tier3-dev',
        Runtime: 'python3.12',
        Handler: 'index.handler',
      });
    });

    it('should create Discovery Lambda with correct name and Python 3.12 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-gateway-tools-discovery-dev',
        Runtime: 'python3.12',
        Handler: 'index.handler',
      });
    });

    it('should enable X-Ray active tracing on all tool target Lambdas', () => {
      // Each tool target Lambda must have active X-Ray tracing (ChimeraLambda invariant)
      const fns = template.findResources('AWS::Lambda::Function', {
        Properties: { TracingConfig: { Mode: 'Active' } },
      });
      // 4 tool target Lambdas should have active tracing
      // (LogRetentionFunction may not — it's CDK-managed)
      expect(Object.keys(fns).length).toBeGreaterThanOrEqual(4);
    });

    it('should set TOOL_TIER environment variable on each Lambda', () => {
      // Tier 1
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-gateway-tools-tier1-dev',
        Environment: {
          Variables: Match.objectLike({ TOOL_TIER: '1', ENV_NAME: 'dev' }),
        },
      });
      // Discovery
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-gateway-tools-discovery-dev',
        Environment: {
          Variables: Match.objectLike({ TOOL_TIER: 'discovery', ENV_NAME: 'dev' }),
        },
      });
    });

    it('should configure DLQ on each tool target Lambda (ChimeraLambda invariant)', () => {
      // ChimeraLambda always creates a DLQ — verify DeadLetterConfig is set
      const tier1Fns = template.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: 'chimera-gateway-tools-tier1-dev' },
      });
      const tier1 = Object.values(tier1Fns)[0] as { Properties: { DeadLetterConfig?: unknown } };
      expect(tier1.Properties.DeadLetterConfig).toBeDefined();
    });
  });

  describe('SQS DLQ Queues', () => {
    it('should create 4 DLQ queues (one per ChimeraLambda)', () => {
      // Each ChimeraLambda creates one DLQ
      template.resourceCountIs('AWS::SQS::Queue', 4);
    });

    it('should create tier1 DLQ with correct name suffix', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'chimera-gateway-tools-tier1-dev-dlq',
      });
    });

    it('should create discovery DLQ with KMS encryption', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'chimera-gateway-tools-discovery-dev-dlq',
        KmsMasterKeyId: Match.anyValue(),
      });
    });
  });

  describe('SSM Parameters', () => {
    it('should create 4 SSM parameters for runtime tool target discovery', () => {
      template.resourceCountIs('AWS::SSM::Parameter', 4);
    });

    it('should create tier1 SSM parameter at correct path', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/chimera/gateway/tool-targets/dev/tier1',
        Type: 'String',
      });
    });

    it('should create tier2 SSM parameter at correct path', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/chimera/gateway/tool-targets/dev/tier2',
        Type: 'String',
      });
    });

    it('should create tier3 SSM parameter at correct path', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/chimera/gateway/tool-targets/dev/tier3',
        Type: 'String',
      });
    });

    it('should create discovery SSM parameter at correct path', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/chimera/gateway/tool-targets/dev/discovery',
        Type: 'String',
      });
    });
  });

  describe('IAM Role', () => {
    it('should create AgentCore Gateway invoke role', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'chimera-agentcore-invoke-dev',
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'bedrock.amazonaws.com' },
              Action: 'sts:AssumeRole',
            }),
          ]),
        },
      });
    });
  });

  describe('Stack Outputs', () => {
    it('should export Tier 1 Lambda ARN', () => {
      template.hasOutput('Tier1ToolsArn', {
        Export: { Name: 'chimera-gateway-tier1-tools-arn-dev' },
      });
    });

    it('should export Tier 2 Lambda ARN', () => {
      template.hasOutput('Tier2ToolsArn', {
        Export: { Name: 'chimera-gateway-tier2-tools-arn-dev' },
      });
    });

    it('should export Tier 3 Lambda ARN', () => {
      template.hasOutput('Tier3ToolsArn', {
        Export: { Name: 'chimera-gateway-tier3-tools-arn-dev' },
      });
    });

    it('should export Discovery Lambda ARN', () => {
      template.hasOutput('DiscoveryToolsArn', {
        Export: { Name: 'chimera-gateway-discovery-tools-arn-dev' },
      });
    });
  });

  describe('toolTargetParamNames', () => {
    it('should expose SSM param paths for runtime discovery', () => {
      expect(stack.toolTargetParamNames.tier1).toBe('/chimera/gateway/tool-targets/dev/tier1');
      expect(stack.toolTargetParamNames.tier2).toBe('/chimera/gateway/tool-targets/dev/tier2');
      expect(stack.toolTargetParamNames.tier3).toBe('/chimera/gateway/tool-targets/dev/tier3');
      expect(stack.toolTargetParamNames.discovery).toBe('/chimera/gateway/tool-targets/dev/discovery');
    });
  });
});
