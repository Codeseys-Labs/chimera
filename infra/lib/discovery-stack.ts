import * as cdk from 'aws-cdk-lib';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';

export interface DiscoveryStackProps extends cdk.StackProps {
  envName: string;
  /** REST API URL from ApiStack */
  restApiUrl: string;
  /** WebSocket API URL from ApiStack */
  webSocketUrl: string;
  /** ALB DNS name from ChatStack */
  albDnsName: string;
  /** ECS cluster name from ChatStack */
  ecsClusterName: string;
  /** ECS service name from ChatStack */
  ecsServiceName: string;
  /** Cognito user pool ID from SecurityStack */
  userPoolId: string;
  /** Cognito user pool client ID from SecurityStack */
  userPoolClientId: string;
  /** DynamoDB table names from DataStack */
  tableNames: {
    tenants: string;
    sessions: string;
    skills: string;
    rateLimits: string;
    costTracking: string;
    audit: string;
  };
  /** S3 bucket names from DataStack */
  bucketNames: {
    tenant: string;
    skills: string;
  };
  /** CodePipeline pipeline name from PipelineStack */
  pipelineName: string;
  /** CloudFront distribution domain from FrontendStack */
  cloudFrontDomain: string;
  /** Frontend S3 bucket name from FrontendStack */
  frontendBucketName: string;
}

/**
 * Cloud Map service discovery namespace for Chimera agent self-awareness.
 *
 * Creates an HTTP namespace (chimera-{env}) and registers all deployed services
 * as non-IP instances with structured attributes. Agents can call the Cloud Map
 * DiscoverInstances API to answer "what infrastructure am I made of?" at runtime.
 *
 * Uses HTTP namespace (not DNS-based) to avoid Route53 and VPC coupling.
 * All service attributes are strings — Cloud Map's only supported attribute type.
 *
 * Paired with CodeCommit (CDK source) for full self-awareness:
 * - Cloud Map: runtime state (what's running, with ARNs/URLs)
 * - CodeCommit: intended state (CDK source, infrastructure-as-code)
 */
export class DiscoveryStack extends cdk.Stack {
  public readonly namespace: servicediscovery.HttpNamespace;
  public readonly namespaceId: string;
  public readonly namespaceArn: string;

  constructor(scope: Construct, id: string, props: DiscoveryStackProps) {
    super(scope, id, props);

    // ======================================================================
    // Cloud Map HTTP Namespace: chimera-{env}
    // HTTP namespaces don't require VPC or Route53 hosted zones.
    // Agents query via servicediscovery:DiscoverInstances API.
    // ======================================================================
    this.namespace = new servicediscovery.HttpNamespace(this, 'Namespace', {
      name: `chimera-${props.envName}`,
      description: `Chimera service discovery namespace for ${props.envName} environment`,
    });

    this.namespaceId = this.namespace.namespaceId;
    this.namespaceArn = this.namespace.namespaceArn;

    // ======================================================================
    // Service: chimera-chat-gateway
    // ECS Fargate service behind ALB — the agent's primary conversation endpoint.
    // ======================================================================
    const chatGatewayService = this.namespace.createService('ChatGatewayService', {
      name: 'chimera-chat-gateway',
    });
    chatGatewayService.registerNonIpInstance('ChatGatewayInstance', {
      instanceId: 'chimera-chat-gateway',
      customAttributes: {
        albDns: props.albDnsName,
        ecsCluster: props.ecsClusterName,
        ecsService: props.ecsServiceName,
        port: '3000',
        stackName: 'ChatStack',
        resourceType: 'ecs-fargate-service',
      },
    });

    // ======================================================================
    // Service: chimera-api
    // REST API Gateway + WebSocket API — management plane and real-time streaming.
    // ======================================================================
    const apiService = this.namespace.createService('ApiService', {
      name: 'chimera-api',
    });
    apiService.registerNonIpInstance('ApiInstance', {
      instanceId: 'chimera-api',
      customAttributes: {
        restApiUrl: props.restApiUrl,
        webSocketUrl: props.webSocketUrl,
        stackName: 'ApiStack',
        resourceType: 'api-gateway',
      },
    });

    // ======================================================================
    // Service: chimera-cognito
    // Cognito user pool — authentication and authorization for tenants + CLI users.
    // ======================================================================
    const cognitoService = this.namespace.createService('CognitoService', {
      name: 'chimera-cognito',
    });
    cognitoService.registerNonIpInstance('CognitoInstance', {
      instanceId: 'chimera-cognito',
      customAttributes: {
        userPoolId: props.userPoolId,
        clientId: props.userPoolClientId,
        stackName: 'SecurityStack',
        resourceType: 'cognito-user-pool',
      },
    });

    // ======================================================================
    // Service: chimera-data
    // 6 DynamoDB tables + 2 S3 buckets — the full persistence layer.
    // ======================================================================
    const dataService = this.namespace.createService('DataService', {
      name: 'chimera-data',
    });
    dataService.registerNonIpInstance('DataInstance', {
      instanceId: 'chimera-data',
      customAttributes: {
        tenantsTable: props.tableNames.tenants,
        sessionsTable: props.tableNames.sessions,
        skillsTable: props.tableNames.skills,
        rateLimitsTable: props.tableNames.rateLimits,
        costTrackingTable: props.tableNames.costTracking,
        auditTable: props.tableNames.audit,
        tenantBucket: props.bucketNames.tenant,
        skillsBucket: props.bucketNames.skills,
        stackName: 'DataStack',
        resourceType: 'data-layer',
      },
    });

    // ======================================================================
    // Service: chimera-pipeline
    // CodePipeline CI/CD — self-aware deployment + the GitOps feedback loop.
    // ======================================================================
    const pipelineService = this.namespace.createService('PipelineService', {
      name: 'chimera-pipeline',
    });
    pipelineService.registerNonIpInstance('PipelineInstance', {
      instanceId: 'chimera-pipeline',
      customAttributes: {
        pipelineName: props.pipelineName,
        stackName: 'PipelineStack',
        resourceType: 'codepipeline',
      },
    });

    // ======================================================================
    // Service: chimera-frontend
    // S3 + CloudFront SPA — the web UI for human operators.
    // ======================================================================
    const frontendService = this.namespace.createService('FrontendService', {
      name: 'chimera-frontend',
    });
    frontendService.registerNonIpInstance('FrontendInstance', {
      instanceId: 'chimera-frontend',
      customAttributes: {
        cloudFrontDomain: props.cloudFrontDomain,
        s3Bucket: props.frontendBucketName,
        stackName: 'FrontendStack',
        resourceType: 'cloudfront-spa',
      },
    });

    // ======================================================================
    // Stack Outputs
    // ======================================================================
    new cdk.CfnOutput(this, 'NamespaceId', {
      value: this.namespace.namespaceId,
      description: 'Cloud Map HTTP namespace ID',
      exportName: `${id}-NamespaceId`,
    });

    new cdk.CfnOutput(this, 'NamespaceArn', {
      value: this.namespace.namespaceArn,
      description: 'Cloud Map HTTP namespace ARN',
      exportName: `${id}-NamespaceArn`,
    });

    new cdk.CfnOutput(this, 'NamespaceName', {
      value: this.namespace.namespaceName,
      description: 'Cloud Map HTTP namespace name',
      exportName: `${id}-NamespaceName`,
    });
  }
}
