import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface ChatStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.IVpc;
  albSecurityGroup: ec2.ISecurityGroup;
  ecsSecurityGroup: ec2.ISecurityGroup;
  tenantsTable: dynamodb.ITable;
  sessionsTable: dynamodb.ITable;
  skillsTable: dynamodb.ITable;
  ecrRepository?: ecr.IRepository;
  domainName?: string;
  certificate?: acm.ICertificate;
  cognitoUserPoolId?: string;
  cognitoUserPoolClientId?: string;
  /** Bedrock inference profile ID for the chat gateway (default: us.anthropic.claude-sonnet-4-6-v1:0) */
  bedrockModelId?: string;
  /**
   * DAX cluster security group exposed by DataStack. When provided, ChatStack
   * registers an ingress rule on port 8111 from the chat-gateway task SG so
   * DAX access is strictly scoped to chat tasks only (ref: docs/reviews/infra-review.md §1).
   * If omitted, DataStack falls back to its legacy broad ECS-SG rule.
   */
  daxSecurityGroup?: ec2.ISecurityGroup;
}

/**
 * Chat Gateway layer for Chimera.
 *
 * Deploys an Express/Fastify server on ECS Fargate with Application Load Balancer.
 * The gateway accepts Vercel AI SDK chat requests, routes to tenant agents via
 * AgentCore Runtime, and streams responses through the SSE bridge package
 * (@chimera/sse-bridge).
 *
 * Architecture:
 * - CloudFront -> ALB -> ECS Fargate (API routes: /chat/*, /auth/*, etc.)
 * - Auto-scaling based on CPU and memory
 * - CloudWatch Logs for application and access logs
 * - IAM roles for DynamoDB, Bedrock, and Secrets Manager access
 * - Platform adapter interface for Slack/Web/Teams
 *
 * The chat gateway server streams Strands agent events translated to Vercel DSP
 * format over Server-Sent Events (SSE), enabling real-time UI updates in React,
 * Vue, Svelte, and other AI SDK-powered frontends.
 */
export class ChatStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly ecsCluster: ecs.Cluster;
  public readonly ecsService: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly distribution: cloudfront.Distribution;
  /**
   * Task-family-scoped security group for the chat-gateway Fargate service.
   * Kept distinct from the shared `ecsSecurityGroup` so DataStack can narrow
   * DAX cluster ingress to chat tasks only, rather than to every workload
   * that shares the broader ECS SG (ref: docs/reviews/infra-review.md §1).
   */
  public readonly chatGatewayTaskSecurityGroup: ec2.SecurityGroup;
  /**
   * S3 bucket for ALB access logs (prod only, undefined in dev). Exposed so
   * operators / Athena integrations can reference it without re-discovering
   * the auto-generated bucket name.
   */
  public readonly albAccessLogsBucket?: s3.Bucket;

  constructor(scope: Construct, id: string, props: ChatStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // Chat-gateway task-scoped security group
    // Placed before the FargateService so we can attach it as an additional
    // SG and hand it to DataStack for DAX ingress scoping.
    // ======================================================================
    this.chatGatewayTaskSecurityGroup = new ec2.SecurityGroup(
      this,
      'ChatGatewayTaskSg',
      {
        vpc: props.vpc,
        securityGroupName: `chimera-chat-gateway-task-${props.envName}`,
        description:
          'Chat-gateway Fargate task SG: scoped peer for DAX ingress (principle of least privilege)',
        allowAllOutbound: true,
      }
    );

    // If DataStack passed in its DAX SG, add the narrow 8111 ingress here so
    // the rule lives in a single place (chat-stack), not buried inside
    // DataStack. This is the active path once bin/chimera.ts wiring supplies
    // `daxSecurityGroup` + `chatGatewayTaskSecurityGroup`.
    if (props.daxSecurityGroup) {
      props.daxSecurityGroup.addIngressRule(
        this.chatGatewayTaskSecurityGroup,
        ec2.Port.tcp(8111),
        'Allow DAX (8111) from chat-gateway tasks only'
      );
    }

    // ======================================================================
    // ECS Cluster
    // Logical grouping for ECS services. Container Insights enabled for
    // observability (CPU, memory, network metrics).
    // ======================================================================
    this.ecsCluster = new ecs.Cluster(this, 'ChatCluster', {
      clusterName: `chimera-chat-${props.envName}`,
      vpc: props.vpc,
      containerInsights: true,
    });

    // ======================================================================
    // CloudWatch Log Group for ECS Task Logs
    // Application stdout/stderr streams here
    // ======================================================================
    const taskLogGroup = new logs.LogGroup(this, 'ChatTaskLogs', {
      logGroupName: `/chimera/${props.envName}/ecs/chat-gateway`,
      retention: isProd ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ======================================================================
    // IAM Task Execution Role
    // Used by ECS agent to pull images, write logs, fetch secrets
    // ======================================================================
    const executionRole = new iam.Role(this, 'ChatTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // ======================================================================
    // IAM Task Role
    // Used by the running application for AWS SDK calls
    // ======================================================================
    const taskRole = new iam.Role(this, 'ChatTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'IAM role for chat gateway ECS tasks - DynamoDB, Bedrock, Secrets Manager, CodeCommit, CodePipeline, CloudFormation, Cloud Map, SSM, Verified Permissions',
    });

    // Grant DynamoDB access
    props.tenantsTable.grantReadData(taskRole);
    props.sessionsTable.grantReadWriteData(taskRole);
    props.skillsTable.grantReadData(taskRole);

    // Grant Bedrock model invocation — scoped to Anthropic Claude foundation models
    // and inference profiles (cross-region system profiles + account application profiles).
    // Foundation model ARNs use an empty account segment (AWS-managed resources).
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:*::inference-profile/*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        ],
      })
    );

    // Grant Bedrock Agent Runtime — scoped to agents and knowledge bases
    // owned by this account/region (agent-runtime resources include account ID).
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agent-runtime:InvokeAgent', 'bedrock-agent-runtime:Retrieve'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:agent/*`,
          `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`,
        ],
      })
    );

    // Grant Secrets Manager access (for platform credentials: Slack tokens, etc.)
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:chimera/${props.envName}/*`,
        ],
      })
    );

    // Grant CodeCommit access for self-evolution (agent commits CDK code)
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'codecommit:CreateCommit',
          'codecommit:GetBranch',
          'codecommit:GetRepository',
          'codecommit:GetFile',
          'codecommit:GetFolder',
          'codecommit:ListRepositories',
        ],
        resources: [`arn:aws:codecommit:${this.region}:${this.account}:chimera*`],
      })
    );

    // Grant CodePipeline access for self-evolution monitoring
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'codepipeline:GetPipelineState',
          'codepipeline:GetPipelineExecution',
          'codepipeline:ListPipelineExecutions',
          'codepipeline:StartPipelineExecution',
        ],
        resources: [`arn:aws:codepipeline:${this.region}:${this.account}:Chimera-*`],
      })
    );

    // Grant CloudFormation read access for deployment verification
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudformation:DescribeStacks', 'cloudformation:ListStacks'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/Chimera-*/*`],
      })
    );

    // Grant Cloud Map discovery for runtime infrastructure lookup
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['servicediscovery:DiscoverInstances', 'servicediscovery:GetNamespace'],
        resources: ['*'], // Cloud Map discovery requires wildcard
      })
    );

    // Grant SSM Parameter Store read for evolution kill switch
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/chimera/*`],
      })
    );

    // Grant Verified Permissions for Cedar policy evaluation
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['verifiedpermissions:IsAuthorized'],
        resources: [`arn:aws:verifiedpermissions:${this.region}:${this.account}:policy-store/*`],
      })
    );

    // Grant AgentCore Code Interpreter access for sandbox execution
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateCodeInterpreterSession',
          'bedrock-agentcore:InvokeCodeInterpreter',
          'bedrock-agentcore:DeleteCodeInterpreterSession',
        ],
        resources: ['*'], // Code Interpreter sessions are account-scoped, no resource ARN pattern
      })
    );

    // Grant AgentCore Browser access for web content extraction
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateBrowserSession',
          'bedrock-agentcore:InvokeBrowser',
          'bedrock-agentcore:DeleteBrowserSession',
        ],
        resources: ['*'],
      })
    );

    // ======================================================================
    // ECS Task Definition
    // Fargate launch type: serverless containers
    // CPU: 1024 = 1 vCPU (0.5 vCPU in dev for cost savings)
    // Memory: 2048 MB = 2 GB (1 GB in dev)
    // ======================================================================
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'ChatTaskDef', {
      family: `chimera-chat-gateway-${props.envName}`,
      cpu: isProd ? 1024 : 512,
      memoryLimitMiB: isProd ? 2048 : 1024,
      executionRole,
      taskRole,
    });

    // ======================================================================
    // Container Definition
    // Image: packages/chat-gateway built via Docker
    // Port: 8080 (Express/Fastify)
    // Environment variables for runtime configuration
    // ======================================================================
    const containerImage = props.ecrRepository
      ? ecs.ContainerImage.fromEcrRepository(props.ecrRepository, 'latest')
      : ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:20-alpine');

    const container = this.taskDefinition.addContainer('ChatGatewayContainer', {
      containerName: 'chat-gateway',
      // Image from ECR repository (built by CI/CD pipeline)
      // Falls back to placeholder if ECR repository not provided
      image: containerImage,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'chat-gateway',
        logGroup: taskLogGroup,
      }),
      environment: {
        NODE_ENV: props.envName === 'prod' ? 'production' : 'development',
        AWS_REGION: this.region,
        AWS_ACCOUNT_ID: this.account,
        TENANTS_TABLE_NAME: props.tenantsTable.tableName,
        SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
        CHIMERA_SESSIONS_TABLE: props.sessionsTable.tableName,
        SKILLS_TABLE_NAME: props.skillsTable.tableName,
        BEDROCK_MODEL_ID: props.bedrockModelId || 'us.anthropic.claude-sonnet-4-6',
        PORT: '8080',
        LOG_LEVEL: isProd ? 'info' : 'debug',
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId ?? '',
        COGNITO_CLIENT_ID: props.cognitoUserPoolClientId ?? '',
        CODE_INTERPRETER_NETWORK_MODE: 'PUBLIC',
        CODE_INTERPRETER_SESSION_TTL: '3600',
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    // ======================================================================
    // Application Load Balancer
    // Exposes the chat gateway to the internet over HTTPS
    // HTTP -> HTTPS redirect (HTTPS certificate will be added in deployment)
    // ======================================================================
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ChatALB', {
      loadBalancerName: `chimera-chat-${props.envName}`,
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      deletionProtection: isProd,
      // SSE streams can be long-lived (agent tool execution, multi-step ReAct loops).
      // Default 60s is too short; gateway sends keepalive pings every 15s.
      idleTimeout: cdk.Duration.seconds(300),
    });

    // ALB access logs: enabled in prod only (dev retains cdk-nag suppression
    // for cost). Logs land in a dedicated S3 bucket with a 30-day lifecycle
    // so storage cost stays bounded while preserving a forensic window for
    // security investigations + PCI-DSS / SOC 2 audit trail.
    //
    // Guarded on a concrete region because `alb.logAccessLogs(...)` throws
    // when the stack is environment-agnostic — it needs to look up the
    // regional ELBv2 log-delivery account. Unit-test stacks without an `env`
    // prop hit this path, so we skip enablement there. Production always
    // synthesises with a concrete region via bin/chimera.ts.
    // (ref: docs/reviews/infra-review.md §5)
    const hasConcreteRegion = !cdk.Token.isUnresolved(this.region);
    if (isProd && hasConcreteRegion) {
      // ALB access logs require either SSE-S3 or SSE-KMS with an AWS-managed
      // key (CMKs are not supported by the ELB log-delivery service). We use
      // KMS_MANAGED so the bucket satisfies EncryptionAspect's `aws:kms`
      // requirement while remaining compatible with the delivery service.
      const albAccessLogsBucket = new s3.Bucket(this, 'AlbAccessLogsBucket', {
        bucketName: `chimera-alb-logs-${this.account}-${this.region}-${props.envName}`,
        encryption: s3.BucketEncryption.KMS_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: false,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          {
            id: 'expire-alb-access-logs-30d',
            enabled: true,
            expiration: cdk.Duration.days(30),
          },
        ],
      });
      // ALB ships logs via ELB service principal; CDK wires the bucket policy
      // automatically inside logAccessLogs().
      this.alb.logAccessLogs(albAccessLogsBucket, 'alb/chat-gateway');
      this.albAccessLogsBucket = albAccessLogsBucket;
    }

    // CloudWatch access logs for ALB
    const albLogGroup = new logs.LogGroup(this, 'AlbAccessLogs', {
      logGroupName: `/chimera/${props.envName}/alb/chat-gateway`,
      retention: isProd ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ALB access logs to CloudWatch (requires resource-based policy)
    albLogGroup.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('elasticloadbalancing.amazonaws.com')],
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [albLogGroup.logGroupArn],
      })
    );

    // ======================================================================
    // ALB Target Group
    // Routes traffic to ECS tasks on port 8080
    // Health check: GET /health (200 OK)
    // Deregistration delay: 30s for graceful shutdown
    // ======================================================================
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'ChatTargetGroup', {
      targetGroupName: `chimera-chat-${props.envName}`,
      vpc: props.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ======================================================================
    // ALB Listeners
    // HTTP (port 80): redirects to HTTPS when certificate is available, else forwards directly
    // HTTPS (port 443): TLS termination + forward to target group (only when certificate provided)
    // ======================================================================
    const httpListener = this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: props.certificate
        ? elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true })
        : elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // HTTPS listener is only created when an ACM certificate is provided.
    // Without a certificate (e.g. dev environments with no custom domain), HTTP-only is used.
    const httpsListener = props.certificate
      ? this.alb.addListener('HttpsListener', {
          port: 443,
          protocol: elbv2.ApplicationProtocol.HTTPS,
          certificates: [props.certificate],
          sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
          defaultAction: elbv2.ListenerAction.forward([this.targetGroup]),
        })
      : undefined;

    // ======================================================================
    // ECS Fargate Service
    // Runs the chat gateway tasks behind the ALB
    // Auto-scaling: 2-10 tasks in prod, 1-3 in dev
    // ======================================================================
    this.ecsService = new ecs.FargateService(this, 'ChatService', {
      serviceName: `chimera-chat-gateway-${props.envName}`,
      cluster: this.ecsCluster,
      taskDefinition: this.taskDefinition,
      desiredCount: isProd ? 2 : 1,
      assignPublicIp: false, // Tasks run in private subnets
      // Attach both the shared ECS SG (ALB -> tasks) and the task-scoped SG
      // (DAX peer). See `chatGatewayTaskSecurityGroup` construction above.
      securityGroups: [props.ecsSecurityGroup, this.chatGatewayTaskSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      enableExecuteCommand: !isProd, // Enable ECS Exec for debugging in dev
    });

    // Attach target group to service
    this.ecsService.attachToApplicationTargetGroup(this.targetGroup);
    this.ecsService.node.addDependency(httpListener);
    if (httpsListener) {
      this.ecsService.node.addDependency(httpsListener);
    }

    // ======================================================================
    // Auto Scaling
    // Scale based on CPU and memory utilization
    // Target: 70% CPU, 80% memory
    // ======================================================================
    const scaling = this.ecsService.autoScaleTaskCount({
      minCapacity: isProd ? 2 : 1,
      maxCapacity: isProd ? 10 : 3,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // ======================================================================
    // CloudFront Distribution
    // Default behavior: ALB origin (API routes — caching disabled)
    // Additional behaviors: ALB for /chat/*, /auth/*, /health, /tenants/*, /slack/*
    // Uses ALL_VIEWER origin request policy to forward all headers including
    // Authorization (which is a restricted header that gets silently stripped
    // when explicitly listed in OriginRequestHeaderBehavior.allowList)
    // Static frontend assets are served by FrontendStack (separate CloudFront distribution).
    // ======================================================================

    // ALB origin created once and reused across all API route behaviors.
    // Uses HTTPS when certificate is available (CloudFront → ALB encrypted), HTTP otherwise.
    const albOrigin = new origins.LoadBalancerV2Origin(this.alb, {
      protocolPolicy: props.certificate
        ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
        : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      httpsPort: 443,
      connectionAttempts: 3,
      connectionTimeout: cdk.Duration.seconds(10),
      // SSE streams may take time before first byte (Bedrock cold start, tool execution).
      // CloudFront max is 60s for standard distributions. The gateway sends an immediate
      // SSE comment on connection open and keepalive pings every 15s to prevent timeouts.
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });

    // CloudFront distribution — API proxy only; static frontend served by FrontendStack
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Chimera Chat Gateway CDN - ${props.envName}`,
      enabled: true,
      priceClass: isProd
        ? cloudfront.PriceClass.PRICE_CLASS_ALL
        : cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      defaultBehavior: {
        origin: albOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      additionalBehaviors: {
        '/chat/*': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
        '/auth/*': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
        '/health': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
        '/tenants/*': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
        '/slack/*': {
          origin: albOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
      },
      errorResponses: [
        {
          httpStatus: 500,
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 502,
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 503,
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 504,
          ttl: cdk.Duration.seconds(0),
        },
      ],
      logBucket: undefined, // CloudFront access logs can be added later
      enableLogging: false, // Disabled to reduce costs in dev
    });

    // ======================================================================
    // Stack Outputs
    // ======================================================================
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      exportName: `${this.stackName}-AlbDnsName`,
      description: 'ALB DNS name for chat gateway',
    });

    new cdk.CfnOutput(this, 'AlbArn', {
      value: this.alb.loadBalancerArn,
      exportName: `${this.stackName}-AlbArn`,
      description: 'ALB ARN for cross-stack references',
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: this.ecsCluster.clusterName,
      exportName: `${this.stackName}-EcsClusterName`,
      description: 'ECS cluster name',
    });

    new cdk.CfnOutput(this, 'EcsServiceName', {
      value: this.ecsService.serviceName,
      exportName: `${this.stackName}-EcsServiceName`,
      description: 'ECS service name for deployments',
    });

    new cdk.CfnOutput(this, 'EcsServiceArn', {
      value: this.ecsService.serviceArn,
      exportName: `${this.stackName}-EcsServiceArn`,
      description: 'ECS service ARN',
    });

    new cdk.CfnOutput(this, 'TaskDefinitionArn', {
      value: this.taskDefinition.taskDefinitionArn,
      exportName: `${this.stackName}-TaskDefinitionArn`,
      description: 'Task definition ARN for CI/CD',
    });

    new cdk.CfnOutput(this, 'TargetGroupArn', {
      value: this.targetGroup.targetGroupArn,
      exportName: `${this.stackName}-TargetGroupArn`,
      description: 'Target group ARN',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: this.distribution.distributionId,
      exportName: `${this.stackName}-CloudFrontDistributionId`,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: this.distribution.distributionDomainName,
      exportName: `${this.stackName}-CloudFrontDomainName`,
      description: 'CloudFront distribution domain name (use this as chat gateway endpoint)',
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      exportName: `${this.stackName}-CloudFrontUrl`,
      description: 'CloudFront HTTPS endpoint URL',
    });
  }
}
