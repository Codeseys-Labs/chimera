import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { logRetentionFor } from '../constructs/log-retention';

export interface ApiStackProps extends cdk.StackProps {
  envName: string;
  userPool: cognito.IUserPool;
  webAcl: wafv2.CfnWebACL;
  /**
   * DynamoDB tables for Lambda integrations.
   * When provided, management API endpoints are backed by real Lambda handlers.
   * When omitted (e.g. unit tests), endpoints return 501 MockIntegration.
   */
  tenantsTable?: dynamodb.TableV2;
  sessionsTable?: dynamodb.TableV2;
  skillsTable?: dynamodb.TableV2;
}

/**
 * API Gateway layer for Chimera.
 *
 * Creates a REST API v1 (required for WAF WebACL association) with JWT
 * authorization using Cognito. Provides management endpoints for tenants,
 * skills, agents, and synchronous chat operations.
 *
 * Also includes a WebSocket API for real-time bidirectional streaming chat,
 * webhook routes for platform integrations (Slack, Discord, Teams, etc.),
 * and an OpenAI-compatible endpoint for drop-in client compatibility.
 *
 * Note: Streaming chat can use either WebSocket API or ALB->ECS with SSE.
 * This stack provides both options for different client needs.
 */
export class ApiStack extends cdk.Stack {
  public readonly api: apigw.RestApi;
  public readonly authorizer: apigw.CognitoUserPoolsAuthorizer;
  public readonly webSocketApi: apigwv2.CfnApi;
  public readonly webSocketStage: apigwv2.CfnStage;
  public readonly tenantResource: apigw.Resource;
  public readonly chatResource: apigw.Resource;
  public readonly skillsResource: apigw.Resource;
  public readonly agentsResource: apigw.Resource;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // CloudWatch Log Group for API Gateway access logs
    // ======================================================================
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: `/aws/apigateway/chimera-api-${props.envName}`,
      retention: logRetentionFor('app', isProd),
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ======================================================================
    // REST API v1
    // Using REST API (not HTTP API) because WAF WebACL association requires
    // REST API for regional resources. HTTP API v2 does not support WAF.
    // ======================================================================
    this.api = new apigw.RestApi(this, 'Api', {
      restApiName: `chimera-api-${props.envName}`,
      description: 'Chimera API Gateway for tenant management, skills, agents, and synchronous chat',
      deployOptions: {
        stageName: props.envName,
        cachingEnabled: isProd,
        cacheClusterEnabled: isProd,
        cacheClusterSize: isProd ? '0.5' : undefined,
        cacheTtl: cdk.Duration.minutes(5),
        cacheDataEncrypted: true,
        throttlingRateLimit: isProd ? 10000 : 1000,
        throttlingBurstLimit: isProd ? 5000 : 500,
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        dataTraceEnabled: !isProd, // Detailed logs only in non-prod
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        // Enable response caching for GET requests
        // 40-60% cost reduction for read-heavy workloads
        cachingEnabled: true,
        cacheClusterEnabled: true,
        cacheClusterSize: isProd ? '1.6' : '0.5', // 0.5 GB cache in dev, 1.6 GB in prod
        cacheTtl: cdk.Duration.minutes(5), // Default TTL for cached responses
        cacheDataEncrypted: true,
      },
      defaultCorsPreflightOptions: {
        // Enumerate dev/staging origins instead of ALL_ORIGINS. Browsers
        // reject `Access-Control-Allow-Origin: *` paired with
        // `Access-Control-Allow-Credentials: true` (CORS spec), so the
        // previous `ALL_ORIGINS` combination silently failed in every
        // credentialed request from the web frontend. Wave-16 M2.
        allowOrigins: isProd
          ? ['https://app.chimera.aws'] // Production domain
          : [
              'https://staging.chimera.aws',
              'http://localhost:5173', // Vite dev server
              'http://localhost:8080', // alt dev server
              'http://localhost:9999', // alt dev server
            ],
        allowMethods: apigw.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Platform-User-Id',
          'X-Platform-Type',
          'X-Thread-Id',
        ],
        allowCredentials: true,
        maxAge: cdk.Duration.hours(1),
      },
      endpointConfiguration: {
        types: [apigw.EndpointType.REGIONAL],
      },
      cloudWatchRole: true, // Enable CloudWatch Logs role
    });

    // ======================================================================
    // JWT Authorizer
    // Validates Cognito JWT tokens. Extracts tenant_id from custom:tenant_id
    // claim for multi-tenant isolation. Authorization scope: tenant_id must
    // match the {tenantId} path parameter in API requests.
    // ======================================================================
    this.authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [props.userPool],
      authorizerName: `chimera-jwt-${props.envName}`,
      identitySource: 'method.request.header.Authorization',
      resultsCacheTtl: cdk.Duration.minutes(5),
    });

    // ======================================================================
    // Request Validators
    // Validate request body and parameters before invoking Lambda integrations
    // ======================================================================
    const requestValidator = this.api.addRequestValidator('RequestValidator', {
      requestValidatorName: 'validate-body-and-params',
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    // ======================================================================
    // Lambda Handlers for Management API
    // Only created when DynamoDB tables are provided as props.
    // Without tables (e.g. unit tests), endpoints fall back to 501 MockIntegration.
    // ======================================================================
    let tenantsHandler: lambda.Function | undefined;
    let sessionsHandler: lambda.Function | undefined;
    let skillsHandler: lambda.Function | undefined;
    let agentsHandler: lambda.Function | undefined;
    let chatHandler: lambda.Function | undefined;

    if (props.tenantsTable && props.sessionsTable && props.skillsTable) {
      const handlerDefaults: Partial<lambda.FunctionProps> = {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        memorySize: 256,
        timeout: cdk.Duration.seconds(29), // Under API GW 29s limit
        tracing: lambda.Tracing.ACTIVE,
        logRetention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
        environment: {
          NODE_OPTIONS: '--enable-source-maps',
          LOG_LEVEL: 'INFO',
        },
      };

      tenantsHandler = new lambda.Function(this, 'TenantsHandler', {
        ...handlerDefaults,
        functionName: `chimera-api-tenants-${props.envName}`,
        code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/api-handlers/tenants')),
        environment: {
          ...handlerDefaults.environment,
          TENANTS_TABLE: props.tenantsTable.tableName,
        },
      });
      props.tenantsTable.grantReadWriteData(tenantsHandler);

      sessionsHandler = new lambda.Function(this, 'SessionsHandler', {
        ...handlerDefaults,
        functionName: `chimera-api-sessions-${props.envName}`,
        code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/api-handlers/sessions')),
        environment: {
          ...handlerDefaults.environment,
          SESSIONS_TABLE: props.sessionsTable.tableName,
        },
      });
      props.sessionsTable.grantReadWriteData(sessionsHandler);

      skillsHandler = new lambda.Function(this, 'SkillsHandler', {
        ...handlerDefaults,
        functionName: `chimera-api-skills-${props.envName}`,
        code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/api-handlers/skills')),
        environment: {
          ...handlerDefaults.environment,
          SKILLS_TABLE: props.skillsTable.tableName,
        },
      });
      props.skillsTable.grantReadWriteData(skillsHandler);

      // TODO(spike): narrow resources once RegistryStack emits a concrete registry ARN.
      // Conditions currently limit blast radius to the deploy region only.
      // These permissions are additive and inert: skillsHandler only invokes
      // bedrock-agentcore (data plane) when the Registry feature flag is flipped
      // per-tenant. With the flag off (default), the handler serves results from
      // the existing DynamoDB skills table and these API calls are never made.
      // Note: bedrock-agentcore:InvokeRegistryMcp is intentionally withheld until
      // the skills-api wires through to the MCP endpoint (see spike design doc).
      // See ADR-034 and docs/designs/agentcore-registry-spike.md.
      skillsHandler.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:SearchRegistryRecords',
          // 'bedrock-agentcore:InvokeRegistryMcp', // withheld: grant only when skills-api wires MCP
        ],
        resources: ['*'], // Registry-specific ARNs not yet known (spike output)
        conditions: {
          // Prevent any accidental cross-region / cross-account blast radius
          StringEquals: {
            'aws:RequestedRegion': cdk.Stack.of(this).region,
          },
        },
      }));

      // Agents are stored in the tenants table (SK prefix AGENT#)
      agentsHandler = new lambda.Function(this, 'AgentsHandler', {
        ...handlerDefaults,
        functionName: `chimera-api-agents-${props.envName}`,
        code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/api-handlers/agents')),
        environment: {
          ...handlerDefaults.environment,
          TENANTS_TABLE: props.tenantsTable.tableName,
        },
      });
      props.tenantsTable.grantReadWriteData(agentsHandler);

      chatHandler = new lambda.Function(this, 'ChatHandler', {
        ...handlerDefaults,
        functionName: `chimera-api-chat-${props.envName}`,
        code: lambda.Code.fromAsset(path.join(__dirname, '../lambdas/api-handlers/chat')),
        environment: {
          ...handlerDefaults.environment,
          TENANTS_TABLE: props.tenantsTable.tableName,
          BEDROCK_MODEL_ID: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
        },
      });
      // Grant Bedrock InvokeModel for synchronous chat
      chatHandler.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['arn:aws:bedrock:*::foundation-model/*', 'arn:aws:bedrock:*:*:inference-profile/*'],
      }));
    }

    // ======================================================================
    // API Resources and Methods
    // ======================================================================

    // --- /api/v1 root ---
    const apiV1 = this.api.root.addResource('api').addResource('v1');

    // --- /api/v1/tenants/{tenantId} ---
    const tenantsResource = apiV1.addResource('tenants');
    this.tenantResource = tenantsResource.addResource('{tenantId}');

    // GET /api/v1/tenants/{tenantId} - Get tenant configuration
    // POST /api/v1/tenants/{tenantId} - Update tenant configuration
    this.addApiMethod(this.tenantResource, 'GET', this.authorizer, requestValidator, tenantsHandler);
    this.addApiMethod(this.tenantResource, 'POST', this.authorizer, requestValidator, tenantsHandler);

    // --- /api/v1/tenants/{tenantId}/chat ---
    this.chatResource = this.tenantResource.addResource('chat');

    // POST /api/v1/tenants/{tenantId}/chat - Synchronous chat (non-streaming)
    // For streaming chat, clients use ALB->ECS endpoint with SSE or WebSocket API
    this.addApiMethod(this.chatResource, 'POST', this.authorizer, requestValidator, chatHandler);

    // GET /api/v1/tenants/{tenantId}/sessions - List sessions
    // GET /api/v1/tenants/{tenantId}/sessions/{sessionId} - Get session details
    // DELETE /api/v1/tenants/{tenantId}/sessions/{sessionId} - Delete session
    const sessionsResource = this.tenantResource.addResource('sessions');
    this.addApiMethod(sessionsResource, 'GET', this.authorizer, requestValidator, sessionsHandler);
    const sessionResource = sessionsResource.addResource('{sessionId}');
    this.addApiMethod(sessionResource, 'GET', this.authorizer, requestValidator, sessionsHandler);
    this.addApiMethod(sessionResource, 'DELETE', this.authorizer, requestValidator, sessionsHandler);

    // --- /api/v1/tenants/{tenantId}/skills ---
    this.skillsResource = this.tenantResource.addResource('skills');

    // GET /api/v1/tenants/{tenantId}/skills - List installed skills
    // POST /api/v1/tenants/{tenantId}/skills - Install skill
    this.addApiMethod(this.skillsResource, 'GET', this.authorizer, requestValidator, skillsHandler);
    this.addApiMethod(this.skillsResource, 'POST', this.authorizer, requestValidator, skillsHandler);

    // GET /api/v1/tenants/{tenantId}/skills/{skillId} - Get skill details
    // DELETE /api/v1/tenants/{tenantId}/skills/{skillId} - Uninstall skill
    const skillResource = this.skillsResource.addResource('{skillId}');
    this.addApiMethod(skillResource, 'GET', this.authorizer, requestValidator, skillsHandler);
    this.addApiMethod(skillResource, 'DELETE', this.authorizer, requestValidator, skillsHandler);

    // --- /api/v1/tenants/{tenantId}/agents ---
    this.agentsResource = this.tenantResource.addResource('agents');

    // GET /api/v1/tenants/{tenantId}/agents - List tenant agents
    // POST /api/v1/tenants/{tenantId}/agents - Create agent configuration
    this.addApiMethod(this.agentsResource, 'GET', this.authorizer, requestValidator, agentsHandler);
    this.addApiMethod(this.agentsResource, 'POST', this.authorizer, requestValidator, agentsHandler);

    // GET /api/v1/tenants/{tenantId}/agents/{agentId} - Get agent configuration
    // PUT /api/v1/tenants/{tenantId}/agents/{agentId} - Update agent configuration
    // DELETE /api/v1/tenants/{tenantId}/agents/{agentId} - Delete agent
    const agentResource = this.agentsResource.addResource('{agentId}');
    this.addApiMethod(agentResource, 'GET', this.authorizer, requestValidator, agentsHandler);
    this.addApiMethod(agentResource, 'PUT', this.authorizer, requestValidator, agentsHandler);
    this.addApiMethod(agentResource, 'DELETE', this.authorizer, requestValidator, agentsHandler);

    // --- /api/v1/tenants/{tenantId}/tools ---
    const toolsResource = this.tenantResource.addResource('tools');

    // GET /api/v1/tenants/{tenantId}/tools - List registered MCP tools
    // POST /api/v1/tenants/{tenantId}/tools - Register MCP tool
    this.addApiMethod(toolsResource, 'GET', this.authorizer, requestValidator);
    this.addApiMethod(toolsResource, 'POST', this.authorizer, requestValidator);

    // DELETE /api/v1/tenants/{tenantId}/tools/{toolId} - Unregister tool
    const toolResource = toolsResource.addResource('{toolId}');
    this.addApiMethod(toolResource, 'DELETE', this.authorizer, requestValidator);

    // --- /api/v1/tenants/{tenantId}/identities ---
    const identitiesResource = this.tenantResource.addResource('identities');

    // GET /api/v1/tenants/{tenantId}/identities - List linked identities
    // POST /api/v1/tenants/{tenantId}/identities - Link identity
    this.addApiMethod(identitiesResource, 'GET', this.authorizer, requestValidator);
    this.addApiMethod(identitiesResource, 'POST', this.authorizer, requestValidator);

    // DELETE /api/v1/tenants/{tenantId}/identities/{identityId} - Unlink identity
    const identityResource = identitiesResource.addResource('{identityId}');
    this.addApiMethod(identityResource, 'DELETE', this.authorizer, requestValidator);

    // ======================================================================
    // Webhook Routes (Unauthenticated)
    // Platform-specific webhook endpoints for Slack, Discord, Teams, etc.
    // These routes are unauthenticated at the API Gateway level because they
    // rely on platform-specific signing secret verification in Lambda handlers.
    // ======================================================================
    const webhooks = this.api.root.addResource('webhooks');
    for (const platform of ['slack', 'discord', 'teams', 'telegram', 'github']) {
      // INTENTIONAL: This endpoint uses MockIntegration until PlatformRuntimeStack
      // wires real Lambda handlers. The chat-gateway (Hono on ECS Fargate) handles
      // all real webhook traffic via its mounted routes (/slack, /discord, /teams,
      // /telegram). API Gateway webhook routes are lower priority. See ADR-024.
      webhooks.addResource(platform).addMethod('POST',
        new apigw.MockIntegration({
          integrationResponses: [{
            statusCode: '501',
            responseTemplates: {
              'application/json': '{"message":"Not yet implemented"}'
            }
          }],
          requestTemplates: {
            'application/json': '{"statusCode": 501}'
          },
        }),
        {
          authorizationType: apigw.AuthorizationType.NONE,
          methodResponses: [
            { statusCode: '200' },
            { statusCode: '501' }
          ]
        }
      );
    }

    // ======================================================================
    // OpenAI-Compatible Endpoint
    // Provides drop-in compatibility for OpenAI clients and libraries.
    // Enables migration from OpenClaw or other OpenAI-compatible systems.
    // ======================================================================
    // INTENTIONAL: This endpoint uses MockIntegration until PlatformRuntimeStack
    // wires real Lambda handlers. The chat-gateway (Hono on ECS Fargate) handles
    // all real traffic. API Gateway REST endpoints are the management API and
    // are lower priority. See ADR-024.
    const openaiV1 = this.api.root.addResource('v1');
    openaiV1.addResource('chat').addResource('completions').addMethod('POST',
      new apigw.MockIntegration({
        integrationResponses: [{
          statusCode: '501',
          responseTemplates: {
            'application/json': '{"message":"Not yet implemented"}'
          }
        }],
        requestTemplates: {
          'application/json': '{"statusCode": 501}'
        },
      }),
      {
        authorizer: this.authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '501' }
        ]
      }
    );

    // ======================================================================
    // WAF WebACL Association
    // Associate the WAF WebACL from SecurityStack with this API Gateway.
    // This provides protection against common web exploits (XSS, SQLi) and
    // rate limiting at the edge before requests reach Lambda integrations.
    // ======================================================================
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: props.webAcl.attrArn,
    });

    // ======================================================================
    // WebSocket API
    // Used by web clients for persistent bidirectional streaming chat.
    // Route selection: $request.body.action maps to route keys.
    // Routes ($connect, $disconnect, sendmessage) will be wired to Lambda
    // handlers when the ChatStack is built.
    // ======================================================================
    const wsAccessLog = new logs.LogGroup(this, 'WsAccessLog', {
      logGroupName: '/chimera/' + props.envName + '/api-gateway/websocket',
      retention: logRetentionFor('app', isProd),
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.webSocketApi = new apigwv2.CfnApi(this, 'WebSocketApi', {
      name: 'chimera-ws-' + props.envName,
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
      description: 'Chimera real-time chat WebSocket API',
    });

    this.webSocketStage = new apigwv2.CfnStage(this, 'WebSocketStage', {
      apiId: this.webSocketApi.ref,
      stageName: props.envName,
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingBurstLimit: isProd ? 500 : 100,
        throttlingRateLimit: isProd ? 1000 : 200,
        loggingLevel: 'INFO',
        dataTraceEnabled: !isProd,
      },
      accessLogSettings: {
        destinationArn: wsAccessLog.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          requestTime: '$context.requestTime',
          eventType: '$context.eventType',
          routeKey: '$context.routeKey',
          status: '$context.status',
          connectionId: '$context.connectionId',
        }),
      },
    });

    // ======================================================================
    // Stack Outputs
    // ======================================================================
    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.restApiId,
      exportName: `${this.stackName}-ApiId`,
      description: 'REST API ID for cross-stack references',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      exportName: `${this.stackName}-ApiUrl`,
      description: 'API Gateway endpoint URL',
    });

    new cdk.CfnOutput(this, 'ApiRootResourceId', {
      value: this.api.root.resourceId,
      exportName: `${this.stackName}-ApiRootResourceId`,
      description: 'Root resource ID for adding resources in other stacks',
    });

    new cdk.CfnOutput(this, 'AuthorizerId', {
      value: this.authorizer.authorizerId,
      exportName: `${this.stackName}-AuthorizerId`,
      description: 'Cognito JWT authorizer ID',
    });

    new cdk.CfnOutput(this, 'WebSocketApiId', {
      value: this.webSocketApi.ref,
      exportName: this.stackName + '-WebSocketApiId',
      description: 'WebSocket API ID',
    });

    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: 'wss://' + this.webSocketApi.ref + '.execute-api.' + this.region + '.amazonaws.com/' + props.envName,
      exportName: this.stackName + '-WebSocketUrl',
      description: 'WebSocket endpoint URL for real-time chat',
    });
  }

  /**
   * Add a management API method.
   *
   * When `lambdaFn` is provided: wires a real LambdaIntegration (proxy mode).
   * When omitted: falls back to a 501 MockIntegration (e.g. during unit tests
   * where DynamoDB tables are not passed as props).
   *
   * GET methods: caching enabled (5 min TTL, keyed on tenantId path param)
   * POST/PUT/DELETE: caching disabled
   */
  private addApiMethod(
    resource: apigw.IResource,
    httpMethod: string,
    authorizer: apigw.IAuthorizer,
    requestValidator: apigw.IRequestValidator,
    lambdaFn?: lambda.Function,
  ): apigw.Method {
    const cacheConfig = httpMethod === 'GET' ? {
      cacheKeyParameters: ['method.request.path.tenantId'],
      cachingEnabled: true,
    } : {
      cachingEnabled: false,
    };

    const integration = lambdaFn
      ? new apigw.LambdaIntegration(lambdaFn, { proxy: true })
      : new apigw.MockIntegration({
          integrationResponses: [
            {
              statusCode: '501',
              responseTemplates: {
                'application/json': JSON.stringify({
                  message: 'Not Implemented',
                  detail: 'Lambda integration not yet wired (tenantsTable/sessionsTable/skillsTable props required)',
                }),
              },
            },
          ],
          requestTemplates: {
            'application/json': '{"statusCode": 501}',
          },
        });

    return resource.addMethod(
      httpMethod,
      integration,
      {
        authorizer,
        authorizationType: apigw.AuthorizationType.COGNITO,
        requestValidator,
        requestParameters: httpMethod === 'GET' ? {
          'method.request.path.tenantId': true,
        } : undefined,
        methodResponses: [
          { statusCode: '200', responseModels: { 'application/json': apigw.Model.EMPTY_MODEL } },
          { statusCode: '201', responseModels: { 'application/json': apigw.Model.EMPTY_MODEL } },
          { statusCode: '400', responseModels: { 'application/json': apigw.Model.ERROR_MODEL } },
          { statusCode: '401', responseModels: { 'application/json': apigw.Model.ERROR_MODEL } },
          { statusCode: '403', responseModels: { 'application/json': apigw.Model.ERROR_MODEL } },
          { statusCode: '404', responseModels: { 'application/json': apigw.Model.ERROR_MODEL } },
          { statusCode: '409', responseModels: { 'application/json': apigw.Model.ERROR_MODEL } },
          { statusCode: '501', responseModels: { 'application/json': apigw.Model.ERROR_MODEL } },
          { statusCode: '502', responseModels: { 'application/json': apigw.Model.ERROR_MODEL } },
        ],
        ...cacheConfig,
      },
    );
  }
}
