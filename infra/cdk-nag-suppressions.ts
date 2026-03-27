/**
 * CDK Nag Suppressions for Chimera Infrastructure
 *
 * All suppressions are documented with a reason explaining why the deviation
 * from the AwsSolutions rule pack is acceptable for this project.
 *
 * Applied from bin/chimera.ts after each stack is created.
 * Reference: ADR-025 CDK Nag Compliance Strategy.
 */
import { NagSuppressions } from 'cdk-nag';
import { Stack } from 'aws-cdk-lib';

/**
 * Suppressions common to all stacks (Lambda execution roles, access log buckets,
 * pinned runtimes, IAM wildcard patterns from CDK-generated grants).
 */
export function applyCommonSuppressions(stack: Stack): void {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'AWS managed policies (AWSLambdaBasicExecutionRole, AmazonECSTaskExecutionRolePolicy, ' +
        'AmazonAPIGatewayPushToCloudWatchLogs) are used where they represent the minimal ' +
        'required permissions for the service. Custom inline policies would duplicate ' +
        'AWS-maintained policies without adding security value.',
    },
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'Wildcard permissions in this stack are CDK-generated grants for legitimate ' +
        'access patterns: Lambda function versions (:*), DynamoDB GSI indexes (/index/*), ' +
        'KMS key operations (kms:GenerateDataKey*, kms:ReEncrypt*), S3 object operations ' +
        '(s3:GetObject*, s3:List*, s3:DeleteObject*, s3:Abort*), and CloudWatch Logs groups. ' +
        'All wildcards are scoped to project-specific resources.',
    },
    {
      id: 'AwsSolutions-L1',
      reason:
        'Lambda runtime versions are pinned for reproducibility and stability. ' +
        'Pinning to a specific runtime (e.g. python3.12, nodejs20.x) prevents ' +
        'unexpected behavior from automatic runtime upgrades in production.',
    },
    {
      id: 'AwsSolutions-SQS4',
      reason:
        'Dead-letter queues (DLQs) do not require their own DLQ. ' +
        'DLQs are terminal destinations for failed messages — adding a DLQ-of-DLQ ' +
        'provides no operational benefit and adds unnecessary complexity.',
    },
    {
      id: 'AwsSolutions-S1',
      reason:
        'S3 access logging is enabled on primary buckets. Access logging buckets ' +
        'do not log to themselves (ChimeraBucket enforces this). Some transient ' +
        'buckets (e.g. CDK asset staging) intentionally skip access logging.',
    },
  ]);
}

/**
 * Suppressions for NetworkStack.
 */
export function applyNetworkStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-EC23',
      reason:
        'ALB Security Group intentionally allows inbound 0.0.0.0/0 on ports 80/443. ' +
        'This is required for a public-facing Application Load Balancer. ' +
        'Traffic is restricted to HTTP and HTTPS only — no broad port range open.',
    },
  ]);
}

/**
 * Suppressions for DataStack.
 */
export function applyDataStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);
}

/**
 * Suppressions for SecurityStack.
 */
export function applySecurityStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-COG3',
      reason:
        'Cognito User Pool Advanced Security Mode (ADVANCED) is not enabled. ' +
        'Advanced Security adds significant cost ($0.05/MAU). ' +
        'Chimera implements application-level fraud detection and rate limiting. ' +
        'This will be re-evaluated before GA launch.',
    },
  ]);
}

/**
 * Suppressions for ObservabilityStack.
 */
export function applyObservabilityStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);
}

/**
 * Suppressions for ApiStack.
 */
export function applyApiStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-APIG4',
      reason:
        'Webhook endpoints (/webhooks/slack, /webhooks/discord, /webhooks/github, ' +
        '/webhooks/teams, /webhooks/telegram) intentionally bypass JWT authorization. ' +
        'These endpoints are authenticated via platform-specific HMAC signature verification ' +
        '(e.g. X-Slack-Signature, X-Hub-Signature-256) in the Lambda handlers. ' +
        'JWT auth would break platform webhook delivery flows.',
    },
    {
      id: 'AwsSolutions-COG4',
      reason:
        'Webhook endpoints use HMAC-based platform authentication, not Cognito user pools. ' +
        'Platform webhooks cannot present Cognito tokens — they send HMAC-signed payloads. ' +
        'Handlers validate signatures before processing.',
    },
  ]);
}

/**
 * Suppressions for ChatStack.
 */
export function applyChatStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-ELB2',
      reason:
        'ALB access logs are not enabled for cost reduction in initial deployment. ' +
        'ALB access logging charges $0.023/GB and generates significant volume. ' +
        'Access logs will be enabled before production traffic.',
    },
    {
      id: 'AwsSolutions-ECS2',
      reason:
        'ECS task definition reads secrets via environment variables from Secrets Manager ' +
        'references (not plaintext). The task definition uses EcsSecret.fromSecretsManager() ' +
        'which creates secretOptions entries — these are securely injected by ECS at runtime.',
    },
    {
      id: 'AwsSolutions-CFR3',
      reason:
        'CloudFront distribution enforces HTTPS via viewer protocol policy redirect-to-https. ' +
        'HTTP requests are automatically redirected to HTTPS — no plaintext traffic is allowed.',
    },
    {
      id: 'AwsSolutions-CFR4',
      reason:
        'CloudFront geo restriction is not enabled. Chimera is a global service with no ' +
        'geographic access restrictions required. Geo-blocking would prevent legitimate ' +
        'international customers from accessing the service.',
    },
    {
      id: 'AwsSolutions-CFR5',
      reason:
        'CloudFront distribution is not associated with a WAF WebACL. ' +
        'The ALB origin is protected by a WAF WebACL (SecurityStack) at the network edge. ' +
        'Adding WAF at both CloudFront and ALB would result in double WAF costs without ' +
        'proportional security benefit for this architecture.',
    },
  ]);
}

/**
 * Suppressions for PipelineStack.
 */
export function applyPipelineStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-CB4',
      reason:
        'CodeBuild projects use default AWS-managed encryption (AES-256), not a CMK. ' +
        'CMK encryption for CodeBuild build artifacts adds cost without meaningful ' +
        'security benefit for build logs and intermediate artifacts. ' +
        'Build output artifacts in S3 are encrypted with CMK.',
    },
    {
      id: 'AwsSolutions-S10',
      reason:
        'S3 buckets enforce SSL via bucket policy (aws:SecureTransport condition). ' +
        'ChimeraBucket adds SSL enforcement on all managed buckets. ' +
        'CDK asset buckets created by the pipeline stage use default SSL enforcement.',
    },
    {
      id: 'AwsSolutions-SNS3',
      reason:
        'SNS alarm notification topic uses AWS-managed SSE (not CMK). ' +
        'Alarm notifications contain operational metadata, not sensitive customer data. ' +
        'AWS-managed encryption provides sufficient protection for this use case.',
    },
    {
      id: 'AwsSolutions-SF2',
      reason:
        'Step Functions state machines do not have X-Ray tracing enabled. ' +
        'X-Ray tracing is enabled at the Lambda level for all execution handlers. ' +
        'State machine-level tracing will be enabled after observability baseline is established.',
    },
    {
      id: 'AwsSolutions-SMG4',
      reason:
        'Secrets Manager secret does not have automatic rotation enabled. ' +
        'The DockerHub credentials secret is rotated manually on a quarterly schedule ' +
        'by the platform team. Automatic rotation requires a custom Lambda rotator ' +
        'for DockerHub API credentials which is out of scope for initial deployment.',
    },
  ]);
}

/**
 * Suppressions for SkillPipelineStack.
 */
export function applySkillPipelineStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-SNS3',
      reason:
        'SNS topic for skill scan notifications uses AWS-managed SSE. ' +
        'Skill scan results are operational metadata without sensitive customer data.',
    },
    {
      id: 'AwsSolutions-SMG4',
      reason:
        'Secrets Manager secrets for skill signing keys are rotated manually. ' +
        'Automatic rotation for asymmetric signing key pairs requires custom rotation logic.',
    },
  ]);
}

/**
 * Suppressions for OrchestrationStack.
 */
export function applyOrchestrationStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-SQS3',
      reason:
        'Workflow Lambda DLQs (ChimeraLambda internal) do not require additional DLQ. ' +
        'These DLQs receive Lambda async invocation failures. Adding another DLQ level ' +
        'provides no operational value — unprocessed DLQ messages trigger CloudWatch alarms.',
    },
    {
      id: 'AwsSolutions-SF2',
      reason:
        'Orchestration state machines do not have X-Ray tracing enabled. ' +
        'X-Ray tracing is enabled at the Lambda level for all step handlers. ' +
        'State machine-level tracing will be added after observability baseline.',
    },
  ]);
}

/**
 * Suppressions for EvolutionStack.
 */
export function applyEvolutionStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-SF1',
      reason:
        'Evolution state machines write logs to CloudWatch via Lambda handlers. ' +
        'State machine execution logging will be enabled after baseline is established.',
    },
    {
      id: 'AwsSolutions-SF2',
      reason:
        'Evolution state machines do not have X-Ray tracing enabled. ' +
        'X-Ray tracing is enabled at the Lambda level for all evolution handlers.',
    },
    {
      id: 'AwsSolutions-SNS3',
      reason:
        'Evolution notification topics use AWS-managed SSE. ' +
        'Evolution events are operational metadata without customer data.',
    },
    {
      id: 'AwsSolutions-S10',
      reason:
        'Evolution artifacts bucket enforces SSL via bucket policy. ' +
        'ChimeraBucket adds ssl-enforcement policy on creation.',
    },
  ]);
}

/**
 * Suppressions for TenantOnboardingStack.
 */
export function applyTenantOnboardingStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-SF1',
      reason:
        'Tenant onboarding state machines write execution history via CloudWatch events. ' +
        'Full execution logging will be enabled after initial deployment validation.',
    },
    {
      id: 'AwsSolutions-S10',
      reason:
        'Tenant data bucket enforces SSL via bucket policy (ChimeraBucket default). ' +
        'The ssl-enforce policy is applied at bucket creation.',
    },
  ]);
}

/**
 * Suppressions for EmailStack.
 */
export function applyEmailStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);
}

/**
 * Suppressions for FrontendStack.
 */
export function applyFrontendStackSuppressions(stack: Stack): void {
  applyCommonSuppressions(stack);

  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-CFR3',
      reason:
        'CloudFront distribution uses redirect-to-https viewer protocol policy. ' +
        'All HTTP requests are redirected to HTTPS — no plaintext traffic served.',
    },
    {
      id: 'AwsSolutions-CFR4',
      reason:
        'No geographic access restrictions. Chimera SPA is available globally ' +
        'with no country-level blocking required.',
    },
    {
      id: 'AwsSolutions-CFR7',
      reason:
        'CloudFront distribution does not use custom error pages for all HTTP error codes. ' +
        'The SPA handles routing and 404s client-side via React Router. ' +
        'A /index.html error redirect is configured for SPA routing support.',
    },
    {
      id: 'AwsSolutions-S10',
      reason:
        'Frontend S3 bucket enforces SSL via bucket policy (ChimeraBucket default). ' +
        'The ssl-enforce policy is applied at bucket creation.',
    },
  ]);
}

/**
 * Suppressions for stacks that use EventBridge event bus without resource policy.
 */
export function applyEventBridgeSuppressions(stack: Stack): void {
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-EB3',
      reason:
        'EventBridge event bus does not require a resource policy for internal use. ' +
        'The bus is accessed only by IAM-authorized resources within the same account.',
    },
  ]);
}
