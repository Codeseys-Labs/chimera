import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  envName: string;
}

/**
 * Network foundation for Chimera.
 *
 * Creates a VPC with 3 subnet tiers across 3 AZs, NAT gateways (1 for dev, 2 for prod),
 * VPC endpoints for AWS services, and security groups for the ALB, ECS, agents, and endpoints.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly albSecurityGroup: ec2.ISecurityGroup;
  public readonly ecsSecurityGroup: ec2.ISecurityGroup;
  public readonly agentSecurityGroup: ec2.ISecurityGroup;
  public readonly endpointSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // VPC: 10.0.0.0/16 = 65,536 IPs. 3 AZs for HA.
    // NAT: 1 gateway in dev (cost savings), 2 in prod (HA across AZs).
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 3,
      natGateways: isProd ? 2 : 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24, // 3 x 254 IPs -- ALB, NAT Gateway
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 22, // 3 x 1,022 IPs -- ECS Fargate, Lambda, AgentCore
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24, // 3 x 254 IPs -- DynamoDB (via endpoint), ElastiCache (future)
        },
      ],
    });

    // VPC Flow Logs for network visibility and security auditing
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'FlowLogGroup', {
          logGroupName: `/chimera/${props.envName}/vpc-flow-logs`,
          retention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
          removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        }),
      ),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // --- Gateway endpoints (free, no hourly charge) ---
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // --- Security group for interface VPC endpoints ---
    this.endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSG', {
      vpc: this.vpc,
      securityGroupName: 'chimera-vpc-endpoint-sg',
      description: 'Allows HTTPS from ECS and Agent security groups to VPC endpoints',
      allowAllOutbound: false,
    });

    // --- Interface endpoints (~$0.01/hr/AZ + $0.01/GB each) ---
    // These keep traffic off the NAT gateway and on the AWS backbone.
    // Break-even vs NAT data-processing ($0.045/GB) is ~36 GB/mo per endpoint
    // across 3 AZs once you include avoided NAT-hour attribution. Every
    // service listed below is referenced by at least one stack in infra/lib,
    // so the NAT-bypass traffic is real — not speculative.
    // (ref: docs/research/cost-optimization-2026-04-23/RECOMMENDATIONS.md §E1)
    const interfaceEndpointServices: Array<{ id: string; service: string }> = [
      { id: 'BedrockRuntime', service: 'bedrock-runtime' },
      { id: 'BedrockAgentRuntime', service: 'bedrock-agent-runtime' },
      { id: 'SecretsManager', service: 'secretsmanager' },
      { id: 'EcrApi', service: 'ecr.api' },
      { id: 'EcrDkr', service: 'ecr.dkr' },
      { id: 'CloudWatchLogs', service: 'logs' },
      { id: 'CloudWatchMonitoring', service: 'monitoring' },
      // Added in Wave-15c cost optimization. Every entry below is used by
      // at least one stack (see RECOMMENDATIONS.md §E1 for evidence).
      { id: 'StepFunctions', service: 'states' }, // orchestration-stack state machines
      { id: 'EventBridge', service: 'events' }, // email/evolution/orchestration event bus
      { id: 'Sqs', service: 'sqs' }, // orchestration + email parser queues
      { id: 'Sns', service: 'sns' }, // pipeline + observability alarm topics
      { id: 'Sts', service: 'sts' }, // every boto3 AssumeRole hop
      { id: 'Kms', service: 'kms' }, // every CMK encrypt/decrypt call
    ];

    for (const ep of interfaceEndpointServices) {
      this.vpc.addInterfaceEndpoint(`${ep.id}Endpoint`, {
        service: new ec2.InterfaceVpcEndpointAwsService(ep.service),
        privateDnsEnabled: true,
        securityGroups: [this.endpointSecurityGroup],
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    // --- ALB security group ---
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: this.vpc,
      securityGroupName: 'chimera-alb-sg',
      description: 'ALB: accepts HTTPS from internet, sends to ECS on 8080',
      allowAllOutbound: false,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS from internet',
    );

    // --- ECS security group ---
    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSG', {
      vpc: this.vpc,
      securityGroupName: 'chimera-ecs-sg',
      description: 'ECS Fargate tasks: accepts 8080 from ALB, outbound to NAT/endpoints',
      allowAllOutbound: true,
    });
    this.ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(8080),
      'ALB to ECS',
    );

    // --- Agent security group ---
    this.agentSecurityGroup = new ec2.SecurityGroup(this, 'AgentSG', {
      vpc: this.vpc,
      securityGroupName: 'chimera-agent-sg',
      description: 'AgentCore MicroVMs: outbound only to NAT/endpoints',
      allowAllOutbound: true,
    });

    // Wire up: ALB -> ECS (outbound), ECS/Agent -> endpoints
    this.albSecurityGroup.addEgressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(8080),
      'ALB to ECS',
    );
    this.endpointSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(443),
      'ECS to VPC endpoints',
    );
    this.endpointSecurityGroup.addIngressRule(
      this.agentSecurityGroup,
      ec2.Port.tcp(443),
      'Agent to VPC endpoints',
    );

    // --- Stack outputs ---
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: `${this.stackName}-VpcId`,
    });
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: this.vpc.privateSubnets.map(s => s.subnetId).join(','),
      exportName: `${this.stackName}-PrivateSubnetIds`,
    });
    new cdk.CfnOutput(this, 'AgentSGId', {
      value: this.agentSecurityGroup.securityGroupId,
      exportName: `${this.stackName}-AgentSGId`,
    });
  }
}
