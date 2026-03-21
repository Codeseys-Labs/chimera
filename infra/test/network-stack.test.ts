/**
 * CDK tests for NetworkStack
 *
 * Validates Phase 1 network infrastructure:
 * - VPC with 3 subnet tiers across 3 AZs
 * - NAT gateways (1 for dev, 2 for prod)
 * - VPC Flow Logs
 * - Gateway endpoints (DynamoDB, S3)
 * - Interface endpoints (Bedrock, Secrets Manager, ECR, CloudWatch)
 * - Security groups (ALB, ECS, Agent, Endpoint)
 * - Security group rules and network connectivity
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';

describe('NetworkStack', () => {
  describe('Dev Environment', () => {
    let app: cdk.App;
    let stack: NetworkStack;
    let template: Template;

    beforeEach(() => {
      app = new cdk.App();
      stack = new NetworkStack(app, 'TestNetworkStack', {
        envName: 'dev',
      });
      template = Template.fromStack(stack);
    });

    describe('VPC', () => {
      it('should create VPC with correct CIDR block', () => {
        template.resourceCountIs('AWS::EC2::VPC', 1);

        template.hasResourceProperties('AWS::EC2::VPC', {
          CidrBlock: '10.0.0.0/16',
          EnableDnsHostnames: true,
          EnableDnsSupport: true,
        });
      });

      it('should create 6 subnets (2 AZs × 3 tiers)', () => {
        // CDK creates 2 AZs by default even when maxAzs is 3 (based on region availability)
        // 2 public + 2 private + 2 isolated = 6 subnets
        template.resourceCountIs('AWS::EC2::Subnet', 6);
      });

      it('should create public subnets with /24 CIDR mask', () => {
        template.hasResourceProperties('AWS::EC2::Subnet', {
          CidrBlock: Match.stringLikeRegexp('10\\.0\\.[0-9]+\\.0\\/24'),
          MapPublicIpOnLaunch: true,
        });
      });

      it('should create private subnets with /22 CIDR mask', () => {
        template.hasResourceProperties('AWS::EC2::Subnet', {
          CidrBlock: Match.stringLikeRegexp('10\\.0\\.(4|8|12)\\.0\\/22'),
          MapPublicIpOnLaunch: false,
        });
      });

      it('should create isolated subnets with /24 CIDR mask', () => {
        template.hasResourceProperties('AWS::EC2::Subnet', {
          CidrBlock: Match.stringLikeRegexp('10\\.0\\.(12|13|14)\\.0\\/24'),
          MapPublicIpOnLaunch: false,
        });
      });
    });

    describe('NAT Gateways', () => {
      it('should create 1 NAT gateway in dev environment', () => {
        template.resourceCountIs('AWS::EC2::NatGateway', 1);
      });

      it('should create 1 Elastic IP for NAT gateway', () => {
        template.resourceCountIs('AWS::EC2::EIP', 1);

        template.hasResourceProperties('AWS::EC2::EIP', {
          Domain: 'vpc',
        });
      });
    });

    describe('VPC Flow Logs', () => {
      it('should create VPC Flow Logs', () => {
        template.resourceCountIs('AWS::EC2::FlowLog', 1);

        template.hasResourceProperties('AWS::EC2::FlowLog', {
          ResourceType: 'VPC',
          TrafficType: 'ALL',
        });
      });

      it('should create CloudWatch log group with 1-month retention for dev', () => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: '/chimera/dev/vpc-flow-logs',
          RetentionInDays: 30,
        });
      });
    });

    describe('Gateway Endpoints', () => {
      it('should create DynamoDB gateway endpoint', () => {
        template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
          ServiceName: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('dynamodb$')]),
            ]),
          }),
          VpcEndpointType: 'Gateway',
        });
      });

      it('should create S3 gateway endpoint', () => {
        template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
          ServiceName: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('s3$')]),
            ]),
          }),
          VpcEndpointType: 'Gateway',
        });
      });
    });

    describe('Interface Endpoints', () => {
      it('should create 7 interface VPC endpoints', () => {
        const template = Template.fromStack(stack);
        const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
          Properties: {
            VpcEndpointType: 'Interface',
          },
        });

        expect(Object.keys(endpoints).length).toBe(7);
      });

      it('should enable private DNS for interface endpoints', () => {
        template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
          VpcEndpointType: 'Interface',
          PrivateDnsEnabled: true,
        });
      });

      it('should create Bedrock Runtime endpoint', () => {
        template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
          ServiceName: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('bedrock-runtime$')]),
            ]),
          }),
          VpcEndpointType: 'Interface',
        });
      });

      it('should create Bedrock Agent Runtime endpoint', () => {
        template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
          ServiceName: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('bedrock-agent-runtime$')]),
            ]),
          }),
          VpcEndpointType: 'Interface',
        });
      });

      it('should create Secrets Manager endpoint', () => {
        template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
          ServiceName: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('secretsmanager$')]),
            ]),
          }),
          VpcEndpointType: 'Interface',
        });
      });

      it('should create ECR API endpoint', () => {
        template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
          ServiceName: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('ecr\\.api$')]),
            ]),
          }),
          VpcEndpointType: 'Interface',
        });
      });

      it('should create ECR Docker endpoint', () => {
        template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
          ServiceName: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('ecr\\.dkr$')]),
            ]),
          }),
          VpcEndpointType: 'Interface',
        });
      });

      it('should create CloudWatch Logs endpoint', () => {
        template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
          ServiceName: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('logs$')]),
            ]),
          }),
          VpcEndpointType: 'Interface',
        });
      });

      it('should create CloudWatch Monitoring endpoint', () => {
        template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
          ServiceName: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('monitoring$')]),
            ]),
          }),
          VpcEndpointType: 'Interface',
        });
      });
    });

    describe('Security Groups', () => {
      it('should create 4 security groups', () => {
        // ALB SG, ECS SG, Agent SG, Endpoint SG
        template.resourceCountIs('AWS::EC2::SecurityGroup', 4);
      });

      it('should create ALB security group accepting HTTPS from internet', () => {
        template.hasResourceProperties('AWS::EC2::SecurityGroup', {
          GroupName: 'chimera-alb-sg',
          GroupDescription: 'ALB: accepts HTTPS from internet, sends to ECS on 8080',
          SecurityGroupIngress: Match.arrayWith([
            Match.objectLike({
              CidrIp: '0.0.0.0/0',
              IpProtocol: 'tcp',
              FromPort: 443,
              ToPort: 443,
            }),
          ]),
        });
      });

      it('should create ECS security group accepting port 8080 from ALB', () => {
        template.hasResourceProperties('AWS::EC2::SecurityGroup', {
          GroupName: 'chimera-ecs-sg',
          GroupDescription: 'ECS Fargate tasks: accepts 8080 from ALB, outbound to NAT/endpoints',
        });
      });

      it('should create Agent security group with outbound-only access', () => {
        template.hasResourceProperties('AWS::EC2::SecurityGroup', {
          GroupName: 'chimera-agent-sg',
          GroupDescription: 'AgentCore MicroVMs: outbound only to NAT/endpoints',
        });
      });

      it('should create Endpoint security group', () => {
        template.hasResourceProperties('AWS::EC2::SecurityGroup', {
          GroupName: 'chimera-vpc-endpoint-sg',
          GroupDescription: 'Allows HTTPS from ECS and Agent security groups to VPC endpoints',
        });
      });
    });

    describe('Security Group Rules', () => {
      it('should allow ALB -> ECS egress on port 8080', () => {
        template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
          IpProtocol: 'tcp',
          FromPort: 8080,
          ToPort: 8080,
        });
      });

      it('should allow ECS -> Endpoint ingress on port 443', () => {
        template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          Description: 'ECS to VPC endpoints',
        });
      });

      it('should allow Agent -> Endpoint ingress on port 443', () => {
        template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          Description: 'Agent to VPC endpoints',
        });
      });
    });

    describe('Stack Outputs', () => {
      it('should export VPC ID', () => {
        template.hasOutput('VpcId', {
          Export: {
            Name: 'TestNetworkStack-VpcId',
          },
        });
      });

      it('should export Private Subnet IDs', () => {
        template.hasOutput('PrivateSubnetIds', {
          Export: {
            Name: 'TestNetworkStack-PrivateSubnetIds',
          },
        });
      });

      it('should export Agent Security Group ID', () => {
        template.hasOutput('AgentSGId', {
          Export: {
            Name: 'TestNetworkStack-AgentSGId',
          },
        });
      });
    });
  });

  describe('Prod Environment', () => {
    let app: cdk.App;
    let stack: NetworkStack;
    let template: Template;

    beforeEach(() => {
      app = new cdk.App();
      stack = new NetworkStack(app, 'TestNetworkStackProd', {
        envName: 'prod',
      });
      template = Template.fromStack(stack);
    });

    it('should create 2 NAT gateways in prod for HA', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 2);
    });

    it('should create 2 Elastic IPs for NAT gateways in prod', () => {
      template.resourceCountIs('AWS::EC2::EIP', 2);
    });

    it('should use 1-year log retention for VPC Flow Logs in prod', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/chimera/prod/vpc-flow-logs',
        RetentionInDays: 365,
      });
    });
  });
});
