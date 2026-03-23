import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface ChatStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.IVpc;
  albSecurityGroup: ec2.ISecurityGroup;
  ecsSecurityGroup: ec2.ISecurityGroup;
  tenantsTable: dynamodb.ITable;
  sessionsTable: dynamodb.ITable;
  skillsTable: dynamodb.ITable;
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
 * - ALB (public subnets) -> ECS Fargate (private subnets)
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

  constructor(scope: Construct, id: string, props: ChatStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

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
      description: 'IAM role for chat gateway ECS tasks to access DynamoDB, Bedrock, and Secrets Manager',
    });

    // Grant DynamoDB access
    props.tenantsTable.grantReadData(taskRole);
    props.sessionsTable.grantReadWriteData(taskRole);
    props.skillsTable.grantReadData(taskRole);

    // Grant Bedrock access (for AgentCore Runtime invocations)
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock-agent-runtime:InvokeAgent',
          'bedrock-agent-runtime:Retrieve',
        ],
        resources: ['*'], // Bedrock models don't support resource-level permissions
      }),
    );

    // Grant Secrets Manager access (for platform credentials: Slack tokens, etc.)
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:chimera/${props.envName}/*`],
      }),
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
    const container = this.taskDefinition.addContainer('ChatGatewayContainer', {
      containerName: 'chat-gateway',
      // Image will be built and pushed by CI/CD pipeline
      // Placeholder: public.ecr.aws/docker/library/node:20-alpine (replace in deployment)
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:20-alpine'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'chat-gateway',
        logGroup: taskLogGroup,
      }),
      environment: {
        NODE_ENV: props.envName === 'prod' ? 'production' : 'development',
        AWS_REGION: this.region,
        TENANTS_TABLE_NAME: props.tenantsTable.tableName,
        SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
        SKILLS_TABLE_NAME: props.skillsTable.tableName,
        PORT: '8080',
        LOG_LEVEL: isProd ? 'info' : 'debug',
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
    });

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
      }),
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
    // HTTP (port 80): placeholder for HTTPS redirect (will be configured in deployment)
    // HTTPS (port 443): routes to target group (certificate added in deployment)
    // ======================================================================
    const httpListener = this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // Placeholder HTTPS listener (certificate will be added via ACM in deployment)
    // For now, this is a placeholder that returns 503
    const httpsListener = this.alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTP, // Will be changed to HTTPS with certificate
      defaultAction: elbv2.ListenerAction.fixedResponse(503, {
        contentType: 'application/json',
        messageBody: JSON.stringify({
          message: 'HTTPS not configured yet. Add ACM certificate in deployment.',
        }),
      }),
    });

    // In production, replace the placeholder with actual target group
    // httpsListener.addAction('ForwardToChat', {
    //   action: elbv2.ListenerAction.forward([this.targetGroup]),
    // });

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
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      enableExecuteCommand: !isProd, // Enable ECS Exec for debugging in dev
    });

    // Attach target group to service
    this.ecsService.attachToApplicationTargetGroup(this.targetGroup);
    this.ecsService.node.addDependency(httpListener);

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
  }
}
