import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { ChimeraBucket } from '../constructs/chimera-bucket';

export interface FrontendStackProps extends cdk.StackProps {
  envName: string;
  certificate?: acm.ICertificate;
  domainNames?: string[];
}

/**
 * Frontend layer for Chimera.
 *
 * Deploys the React SPA (Vite build) to S3 + CloudFront.
 * Static assets (JS/CSS with content hashes) are cached for 1 year.
 * HTML entry points always revalidate (TTL=0) to pick up new deploys.
 * SPA routing: CloudFront 403/404 -> index.html.
 *
 * This stack is independent of all other stacks — no dependencies.
 */
export class FrontendStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // S3 Bucket for React SPA Assets — customer-managed KMS via ChimeraBucket
    // OAC is required for SSE-KMS encrypted buckets (OAI does not support SSE-KMS).
    // CloudFront is granted kms:Decrypt on the CMK after the distribution is created.
    // ======================================================================
    const frontendChimera = new ChimeraBucket(this, 'FrontendBucket', {
      bucketName: `chimera-frontend-${props.envName}-${this.account}`,
      versioned: isProd,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });
    this.bucket = frontendChimera.bucket;

    // ======================================================================
    // Cache Policies
    // HTML: TTL=0 so browsers always revalidate (new deploys picked up immediately)
    // Assets: TTL=365d because Vite hashes all asset filenames (immutable)
    // ======================================================================
    const htmlCachePolicy = new cloudfront.CachePolicy(this, 'HtmlCachePolicy', {
      cachePolicyName: `chimera-frontend-html-${props.envName}`,
      comment: 'No caching for HTML — always revalidate on new deploys',
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      // enableAcceptEncodingGzip/Brotli are invalid when caching is disabled (all TTLs=0)
      enableAcceptEncodingGzip: false,
      enableAcceptEncodingBrotli: false,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    const assetsCachePolicy = new cloudfront.CachePolicy(this, 'AssetsCachePolicy', {
      cachePolicyName: `chimera-frontend-assets-${props.envName}`,
      comment: 'Long-term caching for Vite-hashed assets (immutable filenames)',
      defaultTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });

    // ======================================================================
    // CloudFront Distribution
    // Default behavior: S3 via OAC (HTML with revalidation)
    // /assets/*: S3 via OAC (Vite-hashed assets, long cache)
    // SPA fallback: 403/404 -> index.html for client-side routing
    // OAC is required for SSE-KMS encrypted buckets (OAI does not support SSE-KMS).
    // ======================================================================
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Chimera Frontend CDN - ${props.envName}`,
      enabled: true,
      priceClass: isProd
        ? cloudfront.PriceClass.PRICE_CLASS_ALL
        : cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: htmlCachePolicy,
      },
      additionalBehaviors: {
        '/assets/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy: assetsCachePolicy,
        },
      },
      ...(props.certificate
        ? {
            certificate: props.certificate,
            domainNames: props.domainNames,
          }
        : {}),
      errorResponses: [
        {
          // SPA fallback: S3 returns 403 for missing objects -> serve index.html
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          // SPA fallback: deep links return 404 from S3 -> serve index.html
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // ======================================================================
    // CloudFront OAC → KMS grant
    // CloudFront requires kms:Decrypt on the bucket's CMK to serve SSE-KMS
    // encrypted objects. OAI (the older mechanism) cannot access KMS-encrypted
    // buckets at all — OAC is mandatory here.
    //
    // NOTE: We scope to all distributions in the account rather than to the
    // specific distribution ARN. Using `this.distribution.distributionArn`
    // would create a CDK circular dependency:
    //   KMS Key (key policy) → Distribution → Bucket → KMS Key
    // The account-level wildcard is still safe: the key only encrypts this
    // bucket, so only the CloudFront distribution targeting this bucket can
    // meaningfully use it, and cross-account access is blocked.
    // ======================================================================
    frontendChimera.encryptionKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudFrontDecrypt',
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/*`,
        },
      },
    }));

    // ======================================================================
    // Stack Outputs
    // ======================================================================
    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.bucket.bucketName,
      exportName: `${this.stackName}-FrontendBucketName`,
      description: 'S3 bucket name for React SPA assets',
    });

    new cdk.CfnOutput(this, 'FrontendBucketArn', {
      value: this.bucket.bucketArn,
      exportName: `${this.stackName}-FrontendBucketArn`,
      description: 'S3 bucket ARN for React SPA assets',
    });

    new cdk.CfnOutput(this, 'FrontendDistributionId', {
      value: this.distribution.distributionId,
      exportName: `${this.stackName}-FrontendDistributionId`,
      description: 'CloudFront distribution ID for cache invalidation',
    });

    new cdk.CfnOutput(this, 'FrontendDistributionDomainName', {
      value: this.distribution.distributionDomainName,
      exportName: `${this.stackName}-FrontendDistributionDomainName`,
      description: 'CloudFront distribution domain name',
    });

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      exportName: `${this.stackName}-FrontendUrl`,
      description: 'Frontend HTTPS URL',
    });
  }
}
