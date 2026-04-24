/**
 * CDK tests for ApiStack
 *
 * Validates the API Gateway infrastructure:
 * - REST API (chimera-api-{env}) with Cognito JWT authorizer
 * - WebSocket API (WEBSOCKET protocol) with stage
 * - WAF WebACL association
 * - CloudWatch log groups for REST and WebSocket APIs
 * - Webhook routes for platform integrations
 * - OpenAI-compatible endpoint
 * - Stack outputs for all resources
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { ApiStack } from '../lib/api-stack';

describe('ApiStack', () => {
  let app: cdk.App;
  let userPool: cognito.UserPool;
  let webAcl: wafv2.CfnWebACL;

  beforeEach(() => {
    app = new cdk.App();

    const supportStack = new cdk.Stack(app, 'SupportStack');

    userPool = new cognito.UserPool(supportStack, 'TestUserPool');

    webAcl = new wafv2.CfnWebACL(supportStack, 'TestWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      rules: [],
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'test-waf',
        sampledRequestsEnabled: true,
      },
    });
  });

  describe('Dev Environment', () => {
    let stack: ApiStack;
    let template: Template;

    beforeEach(() => {
      stack = new ApiStack(app, 'TestApiStack', {
        envName: 'dev',
        userPool,
        webAcl,
      });
      template = Template.fromStack(stack);
    });

    describe('REST API', () => {
      it('should create exactly one REST API', () => {
        template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
      });

      it('should create REST API with correct name', () => {
        template.hasResourceProperties('AWS::ApiGateway::RestApi', {
          Name: 'chimera-api-dev',
        });
      });

      it('should create REST API with REGIONAL endpoint', () => {
        template.hasResourceProperties('AWS::ApiGateway::RestApi', {
          EndpointConfiguration: {
            Types: ['REGIONAL'],
          },
        });
      });

      it('should create Cognito JWT authorizer', () => {
        template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
          Name: 'chimera-jwt-dev',
          Type: 'COGNITO_USER_POOLS',
          IdentitySource: 'method.request.header.Authorization',
        });
      });

      it('should create request validator for body and params', () => {
        template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
          ValidateRequestBody: true,
          ValidateRequestParameters: true,
        });
      });
    });

    describe('WebSocket API', () => {
      it('should create WebSocket API with WEBSOCKET protocol', () => {
        template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
          Name: 'chimera-ws-dev',
          ProtocolType: 'WEBSOCKET',
          RouteSelectionExpression: '$request.body.action',
        });
      });

      it('should create WebSocket Stage with auto-deploy', () => {
        template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
          StageName: 'dev',
          AutoDeploy: true,
        });
      });

      it('should configure WebSocket throttle limits for dev', () => {
        template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
          DefaultRouteSettings: Match.objectLike({
            ThrottlingBurstLimit: 100,
            ThrottlingRateLimit: 200,
          }),
        });
      });
    });

    describe('WAF WebACL Association', () => {
      it('should create exactly one WAF WebACL association', () => {
        template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
      });
    });

    describe('Log Groups', () => {
      it('should create access log group for REST API', () => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: '/aws/apigateway/chimera-api-dev',
        });
      });

      it('should create access log group for WebSocket', () => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: '/chimera/dev/api-gateway/websocket',
        });
      });

      it('should create exactly 2 log groups', () => {
        template.resourceCountIs('AWS::Logs::LogGroup', 2);
      });

      it('should use ONE_WEEK retention for dev log groups', () => {
        // ONE_WEEK = 7
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: '/aws/apigateway/chimera-api-dev',
          RetentionInDays: 7,
        });
      });
    });

    describe('API Methods', () => {
      it('should create methods with Cognito authorization', () => {
        template.hasResourceProperties('AWS::ApiGateway::Method', {
          AuthorizationType: 'COGNITO_USER_POOLS',
        });
      });

      it('should create webhook methods with no authorization', () => {
        template.hasResourceProperties('AWS::ApiGateway::Method', {
          AuthorizationType: 'NONE',
        });
      });
    });

    describe('Stack Outputs', () => {
      it('should export ApiId', () => {
        template.hasOutput('ApiId', {
          Export: { Name: 'TestApiStack-ApiId' },
        });
      });

      it('should export ApiUrl', () => {
        template.hasOutput('ApiUrl', {
          Export: { Name: 'TestApiStack-ApiUrl' },
        });
      });

      it('should export ApiRootResourceId', () => {
        template.hasOutput('ApiRootResourceId', {
          Export: { Name: 'TestApiStack-ApiRootResourceId' },
        });
      });

      it('should export AuthorizerId', () => {
        template.hasOutput('AuthorizerId', {
          Export: { Name: 'TestApiStack-AuthorizerId' },
        });
      });

      it('should export WebSocketApiId', () => {
        template.hasOutput('WebSocketApiId', {
          Export: { Name: 'TestApiStack-WebSocketApiId' },
        });
      });

      it('should export WebSocketUrl', () => {
        template.hasOutput('WebSocketUrl', {
          Export: { Name: 'TestApiStack-WebSocketUrl' },
        });
      });
    });
  });

  describe('Prod Environment', () => {
    let stack: ApiStack;
    let template: Template;

    beforeEach(() => {
      stack = new ApiStack(app, 'TestApiStackProd', {
        envName: 'prod',
        userPool,
        webAcl,
      });
      template = Template.fromStack(stack);
    });

    it('should use app-class retention for prod REST API log group (30 days)', () => {
      // Wave-16b: API Gateway access logs harmonized to app class
      // (prod=ONE_MONTH). Long-tail flows to S3 out-of-band.
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/apigateway/chimera-api-prod',
        RetentionInDays: 30,
      });
    });

    it('should retain prod log groups on deletion', () => {
      const logGroups = template.findResources('AWS::Logs::LogGroup', {
        Properties: {
          LogGroupName: '/aws/apigateway/chimera-api-prod',
        },
      });
      const logGroup = Object.values(logGroups)[0] as any;
      expect(logGroup.DeletionPolicy).toBe('Retain');
    });

    it('should configure higher WebSocket throttle limits for prod', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        StageName: 'prod',
        DefaultRouteSettings: Match.objectLike({
          ThrottlingBurstLimit: 500,
          ThrottlingRateLimit: 1000,
        }),
      });
    });

    it('should use app-class retention for prod WebSocket log group (30 days)', () => {
      // Wave-16b: WebSocket access logs harmonized to app class
      // (prod=ONE_MONTH).
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/chimera/prod/api-gateway/websocket',
        RetentionInDays: 30,
      });
    });
  });
});
