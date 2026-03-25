/**
 * CDK tests for ChatStack
 *
 * Validates the chat gateway infrastructure:
 * - S3 bucket for static UI assets (private, OAI-accessible)
 * - CloudFront distribution with S3 default origin and ALB API behaviors
 * - OAI (Origin Access Identity) for S3 access
 * - SPA error responses (403/404 -> index.html)
 * - Stack outputs for all resources
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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

    describe('S3 Static Assets Bucket', () => {
      it('should create an S3 bucket with all public access blocked', () => {
        template.hasResourceProperties('AWS::S3::Bucket', {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        });
      });

      it('should not enable versioning in dev', () => {
        const buckets = template.findResources('AWS::S3::Bucket');
        // The static assets bucket in dev should not have versioning
        const staticBucket = Object.values(buckets).find((b: any) =>
          b.Properties?.PublicAccessBlockConfiguration?.BlockPublicAcls === true &&
          b.Properties?.VersioningConfiguration === undefined
        );
        expect(staticBucket).toBeDefined();
      });
    });

    describe('CloudFront OAI', () => {
      it('should create an Origin Access Identity', () => {
        template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 1);

        template.hasResourceProperties('AWS::CloudFront::CloudFrontOriginAccessIdentity', {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: 'OAI for Chimera static assets - dev',
          },
        });
      });
    });

    describe('CloudFront Distribution', () => {
      it('should create a CloudFront distribution', () => {
        template.resourceCountIs('AWS::CloudFront::Distribution', 1);
      });

      it('should have S3 as the default origin', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        const origins = dist.Properties.DistributionConfig.Origins;

        // At least one origin should be an S3 bucket (has S3OriginConfig)
        const s3Origin = origins.find((o: any) => o.S3OriginConfig !== undefined);
        expect(s3Origin).toBeDefined();
      });

      it('should have ALB as an additional origin', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        const origins = dist.Properties.DistributionConfig.Origins;

        // At least one origin should be an ALB (has CustomOriginConfig)
        const albOrigin = origins.find((o: any) => o.CustomOriginConfig !== undefined);
        expect(albOrigin).toBeDefined();
      });

      it('should set defaultRootObject to index.html', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
          DistributionConfig: {
            DefaultRootObject: 'index.html',
          },
        });
      });

      it('should have custom error response for 403 -> index.html', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
          DistributionConfig: {
            CustomErrorResponses: Match.arrayWith([
              Match.objectLike({
                ErrorCode: 403,
                ResponseCode: 200,
                ResponsePagePath: '/index.html',
              }),
            ]),
          },
        });
      });

      it('should have custom error response for 404 -> index.html', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
          DistributionConfig: {
            CustomErrorResponses: Match.arrayWith([
              Match.objectLike({
                ErrorCode: 404,
                ResponseCode: 200,
                ResponsePagePath: '/index.html',
              }),
            ]),
          },
        });
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

      it('should redirect HTTP to HTTPS', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        const defaultBehavior = dist.Properties.DistributionConfig.DefaultCacheBehavior;

        expect(defaultBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
      });
    });

    describe('Stack Outputs', () => {
      it('should export static assets bucket name', () => {
        template.hasOutput('StaticAssetsBucketName', {
          Export: {
            Name: 'TestChatStack-StaticAssetsBucketName',
          },
        });
      });

      it('should export static assets bucket ARN', () => {
        template.hasOutput('StaticAssetsBucketArn', {
          Export: {
            Name: 'TestChatStack-StaticAssetsBucketArn',
          },
        });
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

    it('should enable versioning on static assets bucket in prod', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: {
          Status: 'Enabled',
        },
      });
    });

    it('should use RETAIN removal policy for static bucket in prod', () => {
      const buckets = template.findResources('AWS::S3::Bucket');
      // Find the static assets bucket (has PublicAccessBlockConfiguration)
      const staticBucket = Object.values(buckets).find((b: any) =>
        b.Properties?.PublicAccessBlockConfiguration?.BlockPublicAcls === true
      ) as any;

      expect(staticBucket).toBeDefined();
      expect(staticBucket.DeletionPolicy).toBe('Retain');
      expect(staticBucket.UpdateReplacePolicy).toBe('Retain');
    });

    it('should use PRICE_CLASS_ALL in prod', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          PriceClass: 'PriceClass_All',
        },
      });
    });
  });
});
