/**
 * CDK tests for ChatStack
 *
 * Validates the chat gateway infrastructure:
 * - CloudFront distribution with ALB as default origin (no S3 static assets)
 * - ALB listeners and target groups
 * - SPA error responses removed (handled by FrontendStack)
 * - Stack outputs for all resources
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { ChatStack } from '../lib/chat-stack';

describe('ChatStack', () => {
  let app: cdk.App;
  let vpc: ec2.Vpc;
  let albSecurityGroup: ec2.SecurityGroup;
  let ecsSecurityGroup: ec2.SecurityGroup;
  let tenantsTable: dynamodb.Table;
  let sessionsTable: dynamodb.Table;
  let skillsTable: dynamodb.Table;

  beforeEach(() => {
    app = new cdk.App();

    const vpcStack = new cdk.Stack(app, 'VpcStack');
    vpc = new ec2.Vpc(vpcStack, 'TestVpc');
    albSecurityGroup = new ec2.SecurityGroup(vpcStack, 'MockAlbSg', {
      vpc,
      description: 'Mock ALB security group for testing',
    });
    ecsSecurityGroup = new ec2.SecurityGroup(vpcStack, 'MockEcsSg', {
      vpc,
      description: 'Mock ECS security group for testing',
    });

    const dataStack = new cdk.Stack(app, 'DataStack');
    tenantsTable = new dynamodb.Table(dataStack, 'TenantsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    });
    sessionsTable = new dynamodb.Table(dataStack, 'SessionsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    });
    skillsTable = new dynamodb.Table(dataStack, 'SkillsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    });
  });

  describe('Dev Environment', () => {
    let stack: ChatStack;
    let template: Template;

    beforeEach(() => {
      stack = new ChatStack(app, 'TestChatStack', {
        envName: 'dev',
        vpc,
        albSecurityGroup,
        ecsSecurityGroup,
        tenantsTable,
        sessionsTable,
        skillsTable,
      });
      template = Template.fromStack(stack);
    });

    describe('CloudFront Distribution', () => {
      it('should create a CloudFront distribution', () => {
        template.resourceCountIs('AWS::CloudFront::Distribution', 1);
      });

      it('should NOT create an S3 bucket (static assets moved to FrontendStack)', () => {
        // ChatStack no longer owns any S3 buckets
        template.resourceCountIs('AWS::S3::Bucket', 0);
      });

      it('should NOT create an OAI (no S3 origin)', () => {
        template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
      });

      it('should have ALB as the default origin', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        const defaultBehavior = dist.Properties.DistributionConfig.DefaultCacheBehavior;

        // Default behavior must NOT point to an S3 origin (no S3OriginConfig on default)
        // The origin should be an ALB (CustomOriginConfig)
        const origins = dist.Properties.DistributionConfig.Origins;
        const defaultOriginId = defaultBehavior.TargetOriginId;
        const defaultOrigin = origins.find((o: any) => o.Id === defaultOriginId);
        expect(defaultOrigin.CustomOriginConfig).toBeDefined();
        expect(defaultOrigin.S3OriginConfig).toBeUndefined();
      });

      it('should have caching disabled on the default (ALB) behavior', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        const defaultBehavior = dist.Properties.DistributionConfig.DefaultCacheBehavior;

        // CACHING_DISABLED managed policy ID
        expect(defaultBehavior.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
      });

      it('should redirect HTTP to HTTPS', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        const defaultBehavior = dist.Properties.DistributionConfig.DefaultCacheBehavior;

        expect(defaultBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
      });

      it('should NOT have SPA error responses (403/404 -> index.html)', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        const errorResponses = dist.Properties.DistributionConfig.CustomErrorResponses ?? [];

        const spaErrors = errorResponses.filter(
          (e: any) => (e.ErrorCode === 403 || e.ErrorCode === 404) && e.ResponsePagePath === '/index.html',
        );
        expect(spaErrors).toHaveLength(0);
      });

      it('should have custom error responses for 500, 502, 503, 504', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
          DistributionConfig: {
            CustomErrorResponses: Match.arrayWith([
              Match.objectLike({ ErrorCode: 500 }),
              Match.objectLike({ ErrorCode: 502 }),
              Match.objectLike({ ErrorCode: 503 }),
              Match.objectLike({ ErrorCode: 504 }),
            ]),
          },
        });
      });

      it('should NOT set defaultRootObject', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        expect(dist.Properties.DistributionConfig.DefaultRootObject).toBeUndefined();
      });
    });

    describe('ALB Listeners (no certificate)', () => {
      it('should have HTTP listener forwarding to target group', () => {
        template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
          Port: 80,
          Protocol: 'HTTP',
          DefaultActions: [Match.objectLike({ Type: 'forward' })],
        });
      });

      it('should not create an HTTPS listener when no certificate is provided', () => {
        const listeners = template.findResources('AWS::ElasticLoadBalancingV2::Listener');
        const httpsListeners = Object.values(listeners).filter(
          (l: any) => l.Properties?.Port === 443,
        );
        expect(httpsListeners).toHaveLength(0);
      });
    });

    describe('Stack Outputs', () => {
      it('should NOT export static assets bucket outputs', () => {
        const outputs = template.findOutputs('*');
        expect(outputs['StaticAssetsBucketName']).toBeUndefined();
        expect(outputs['StaticAssetsBucketArn']).toBeUndefined();
      });

      it('should export CloudFront distribution ID', () => {
        template.hasOutput('CloudFrontDistributionId', {
          Export: {
            Name: 'TestChatStack-CloudFrontDistributionId',
          },
        });
      });

      it('should export CloudFront domain name', () => {
        template.hasOutput('CloudFrontDomainName', {
          Export: {
            Name: 'TestChatStack-CloudFrontDomainName',
          },
        });
      });
    });
  });

  describe('Prod Environment', () => {
    let stack: ChatStack;
    let template: Template;

    beforeEach(() => {
      stack = new ChatStack(app, 'TestChatStackProd', {
        envName: 'prod',
        vpc,
        albSecurityGroup,
        ecsSecurityGroup,
        tenantsTable,
        sessionsTable,
        skillsTable,
      });
      template = Template.fromStack(stack);
    });

    it('should use PRICE_CLASS_ALL in prod', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          PriceClass: 'PriceClass_All',
        },
      });
    });
  });

  describe('HTTPS Configured (with certificate)', () => {
    let httpsStack: ChatStack;
    let httpsTemplate: Template;

    beforeEach(() => {
      const mockCert = acm.Certificate.fromCertificateArn(
        new cdk.Stack(app, 'CertStack'),
        'MockCert',
        'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id',
      );

      httpsStack = new ChatStack(app, 'TestChatStackHttps', {
        envName: 'dev',
        vpc,
        albSecurityGroup,
        ecsSecurityGroup,
        tenantsTable,
        sessionsTable,
        skillsTable,
        domainName: 'chat.example.com',
        certificate: mockCert,
      });
      httpsTemplate = Template.fromStack(httpsStack);
    });

    it('should redirect HTTP to HTTPS (301) when certificate is provided', () => {
      httpsTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: [
          Match.objectLike({
            Type: 'redirect',
            RedirectConfig: Match.objectLike({
              Protocol: 'HTTPS',
              Port: '443',
              StatusCode: 'HTTP_301',
            }),
          }),
        ],
      });
    });

    it('should create HTTPS listener forwarding to target group', () => {
      httpsTemplate.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
        Port: 443,
        Protocol: 'HTTPS',
        DefaultActions: [Match.objectLike({ Type: 'forward' })],
      });
    });

    it('should use HTTPS_ONLY CloudFront origin when certificate is provided', () => {
      const distributions = httpsTemplate.findResources('AWS::CloudFront::Distribution');
      const dist = Object.values(distributions)[0] as any;
      const cfOrigins = dist.Properties.DistributionConfig.Origins;
      const albOrigin = cfOrigins.find((o: any) => o.CustomOriginConfig !== undefined);
      expect(albOrigin.CustomOriginConfig.OriginProtocolPolicy).toBe('https-only');
    });
  });
});
