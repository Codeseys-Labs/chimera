/**
 * CDK tests for FrontendStack
 *
 * Validates the React SPA infrastructure:
 * - S3 bucket (private, OAI-accessible)
 * - CloudFront distribution with S3 origin, SPA routing, split cache policies
 * - HTML cache: TTL=0 (always revalidate), Assets cache: TTL=365d (Vite hashes)
 * - SPA error responses (403/404 -> index.html)
 * - Stack outputs for all resources
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { FrontendStack } from '../lib/frontend-stack';

describe('FrontendStack', () => {
  let app: cdk.App;

  beforeEach(() => {
    app = new cdk.App();
  });

  describe('Dev Environment', () => {
    let stack: FrontendStack;
    let template: Template;

    beforeEach(() => {
      stack = new FrontendStack(app, 'TestFrontendStack', {
        envName: 'dev',
        env: { account: '123456789012', region: 'us-east-1' },
      });
      template = Template.fromStack(stack);
    });

    describe('S3 Bucket', () => {
      it('should create a private S3 bucket with all public access blocked', () => {
        template.hasResourceProperties('AWS::S3::Bucket', {
          BucketName: 'chimera-frontend-dev-123456789012',
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
        const bucket = Object.values(buckets).find((b: any) =>
          b.Properties?.BucketName?.includes('chimera-frontend'),
        ) as any;
        expect(bucket?.Properties?.VersioningConfiguration).toBeUndefined();
      });

      it('should set DESTROY removal policy in dev', () => {
        const buckets = template.findResources('AWS::S3::Bucket');
        const bucket = Object.values(buckets).find((b: any) =>
          b.Properties?.BucketName?.includes('chimera-frontend'),
        ) as any;
        expect(bucket?.DeletionPolicy).toBe('Delete');
        expect(bucket?.UpdateReplacePolicy).toBe('Delete');
      });
    });

    describe('OAI', () => {
      it('should create an Origin Access Identity', () => {
        template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 1);
        template.hasResourceProperties('AWS::CloudFront::CloudFrontOriginAccessIdentity', {
          CloudFrontOriginAccessIdentityConfig: {
            Comment: 'OAI for Chimera frontend - dev',
          },
        });
      });
    });

    describe('Cache Policies', () => {
      it('should create HTML cache policy with TTL=0', () => {
        template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
          CachePolicyConfig: {
            Name: 'chimera-frontend-html-dev',
            DefaultTTL: 0,
            MaxTTL: 0,
            MinTTL: 0,
          },
        });
      });

      it('should create assets cache policy with TTL=365d', () => {
        template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
          CachePolicyConfig: {
            Name: 'chimera-frontend-assets-dev',
            DefaultTTL: 31536000,
            MaxTTL: 31536000,
            MinTTL: 31536000,
          },
        });
      });
    });

    describe('CloudFront Distribution', () => {
      it('should create exactly one CloudFront distribution', () => {
        template.resourceCountIs('AWS::CloudFront::Distribution', 1);
      });

      it('should set defaultRootObject to index.html', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
          DistributionConfig: {
            DefaultRootObject: 'index.html',
          },
        });
      });

      it('should redirect HTTP to HTTPS on default behavior', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        const defaultBehavior = dist.Properties.DistributionConfig.DefaultCacheBehavior;
        expect(defaultBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
      });

      it('should have S3 as the default origin (via OAI)', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        const origins = dist.Properties.DistributionConfig.Origins;
        const s3Origin = origins.find((o: any) => o.S3OriginConfig !== undefined);
        expect(s3Origin).toBeDefined();
      });

      it('should have an /assets/* additional behavior', () => {
        const distributions = template.findResources('AWS::CloudFront::Distribution');
        const dist = Object.values(distributions)[0] as any;
        const cacheBehaviors = dist.Properties.DistributionConfig.CacheBehaviors ?? [];
        const assetsBehavior = cacheBehaviors.find((b: any) => b.PathPattern === '/assets/*');
        expect(assetsBehavior).toBeDefined();
      });

      it('should have SPA error response for 403 -> index.html', () => {
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

      it('should have SPA error response for 404 -> index.html', () => {
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

      it('should use PRICE_CLASS_100 in dev', () => {
        template.hasResourceProperties('AWS::CloudFront::Distribution', {
          DistributionConfig: {
            PriceClass: 'PriceClass_100',
          },
        });
      });
    });

    describe('Stack Outputs', () => {
      it('should export FrontendBucketName', () => {
        template.hasOutput('FrontendBucketName', {
          Export: { Name: 'TestFrontendStack-FrontendBucketName' },
        });
      });

      it('should export FrontendBucketArn', () => {
        template.hasOutput('FrontendBucketArn', {
          Export: { Name: 'TestFrontendStack-FrontendBucketArn' },
        });
      });

      it('should export FrontendDistributionId', () => {
        template.hasOutput('FrontendDistributionId', {
          Export: { Name: 'TestFrontendStack-FrontendDistributionId' },
        });
      });

      it('should export FrontendDistributionDomainName', () => {
        template.hasOutput('FrontendDistributionDomainName', {
          Export: { Name: 'TestFrontendStack-FrontendDistributionDomainName' },
        });
      });

      it('should export FrontendUrl', () => {
        template.hasOutput('FrontendUrl', {
          Export: { Name: 'TestFrontendStack-FrontendUrl' },
        });
      });
    });
  });

  describe('Prod Environment', () => {
    let stack: FrontendStack;
    let template: Template;

    beforeEach(() => {
      stack = new FrontendStack(app, 'TestFrontendStackProd', {
        envName: 'prod',
        env: { account: '123456789012', region: 'us-east-1' },
      });
      template = Template.fromStack(stack);
    });

    it('should enable versioning on the bucket in prod', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        VersioningConfiguration: { Status: 'Enabled' },
      });
    });

    it('should set RETAIN removal policy in prod', () => {
      const buckets = template.findResources('AWS::S3::Bucket');
      const bucket = Object.values(buckets).find((b: any) =>
        b.Properties?.BucketName?.includes('chimera-frontend'),
      ) as any;
      expect(bucket?.DeletionPolicy).toBe('Retain');
      expect(bucket?.UpdateReplacePolicy).toBe('Retain');
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
    it('should attach certificate and domain names when provided', () => {
      const certStack = new cdk.Stack(app, 'CertStack');
      const mockCert = acm.Certificate.fromCertificateArn(
        certStack,
        'MockCert',
        'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id',
      );

      const stack = new FrontendStack(app, 'TestFrontendStackHttps', {
        envName: 'dev',
        certificate: mockCert,
        domainNames: ['app.example.com'],
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          Aliases: ['app.example.com'],
          ViewerCertificate: Match.objectLike({
            AcmCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id',
          }),
        },
      });
    });
  });
});
