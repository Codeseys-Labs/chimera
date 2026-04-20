import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import {
  TenantIsolationAspect,
  EncryptionAspect,
  LogRetentionAspect,
  TaggingAspect,
} from '../aspects';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { SecurityStack } from '../lib/security-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { ApiStack } from '../lib/api-stack';
import { SkillPipelineStack } from '../lib/skill-pipeline-stack';
import { ChatStack } from '../lib/chat-stack';
import { TenantOnboardingStack } from '../lib/tenant-onboarding-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { OrchestrationStack } from '../lib/orchestration-stack';
import { EvolutionStack } from '../lib/evolution-stack';
import { EmailStack } from '../lib/email-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { DiscoveryStack } from '../lib/discovery-stack';
import { RegistryStack } from '../lib/registry-stack';
import {
  applyCommonSuppressions,
  applyNetworkStackSuppressions,
  applyDataStackSuppressions,
  applySecurityStackSuppressions,
  applyObservabilityStackSuppressions,
  applyApiStackSuppressions,
  applySkillPipelineStackSuppressions,
  applyChatStackSuppressions,
  applyPipelineStackSuppressions,
  applyOrchestrationStackSuppressions,
  applyEvolutionStackSuppressions,
  applyTenantOnboardingStackSuppressions,
  applyEmailStackSuppressions,
  applyFrontendStackSuppressions,
  applyDiscoveryStackSuppressions,
} from '../cdk-nag-suppressions';

const app = new cdk.App();

// CDK Nag: AwsSolutions compliance scanning (errors block synth, warnings are advisory)
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

const envName = app.node.tryGetContext('environment') ?? 'dev';
const isProd = envName === 'prod';

// Custom Aspects: cross-cutting compliance enforcement
Aspects.of(app).add(new TenantIsolationAspect());
Aspects.of(app).add(new EncryptionAspect());
Aspects.of(app).add(new LogRetentionAspect());
Aspects.of(app).add(new TaggingAspect({ environment: envName }));

const envConfig: cdk.Environment = {
  account: app.node.tryGetContext('account') ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: app.node.tryGetContext('region') ?? 'us-west-2',
};

const prefix = `Chimera-${envName}`;

// Shared tags applied to every resource in every stack
const projectTags: Record<string, string> = {
  Project: 'Chimera',
  Environment: envName,
  ManagedBy: 'CDK',
};

// --- Stack 1: Network ---
// VPC, subnets, NAT gateways, VPC endpoints, security groups.
// Everything else depends on this stack.
const networkStack = new NetworkStack(app, `${prefix}-Network`, {
  env: envConfig,
  description: 'Chimera network layer: VPC, subnets, NAT gateways, VPC endpoints, security groups',
  envName,
});
applyNetworkStackSuppressions(networkStack);

// --- Stack 2: Data ---
// 6 DynamoDB tables, 3 S3 buckets. Depends on NetworkStack for VPC (future ElastiCache).
const dataStack = new DataStack(app, `${prefix}-Data`, {
  env: envConfig,
  description: 'Chimera data layer: 6 DynamoDB tables, 3 S3 buckets',
  envName,
  vpc: networkStack.vpc,
  ecsSecurityGroup: networkStack.ecsSecurityGroup,
});
applyDataStackSuppressions(dataStack);
dataStack.addDependency(networkStack);

// --- Stack 3: Security ---
// Cognito user pool, WAF WebACL, KMS keys. No stack dependencies.
const securityStack = new SecurityStack(app, `${prefix}-Security`, {
  env: envConfig,
  description: 'Chimera security layer: Cognito user pool, WAF WebACL, KMS key',
  envName,
});
applySecurityStackSuppressions(securityStack);

// --- Stack 4: Observability ---
// CloudWatch dashboard, SNS alarm topic, X-Ray config, DDB throttle alarms.
// Depends on DataStack for table metrics and SecurityStack for KMS encryption.
const observabilityStack = new ObservabilityStack(app, `${prefix}-Observability`, {
  env: envConfig,
  description: 'Chimera observability layer: CloudWatch dashboards, SNS alarms, X-Ray config',
  envName,
  platformKey: securityStack.platformKey,
  tenantsTable: dataStack.tenantsTable,
  sessionsTable: dataStack.sessionsTable,
  skillsTable: dataStack.skillsTable,
  rateLimitsTable: dataStack.rateLimitsTable,
  costTrackingTable: dataStack.costTrackingTable,
  auditTable: dataStack.auditTable,
});
applyObservabilityStackSuppressions(observabilityStack);
observabilityStack.addDependency(dataStack);
observabilityStack.addDependency(securityStack);

// --- Stack 5: API Gateway ---
// REST API v1 with JWT authorizer, WebSocket API, webhook routes, OpenAI-compatible endpoint.
// Depends on SecurityStack for Cognito user pool and WAF WebACL.
// Depends on DataStack for DynamoDB tables used by Lambda management API handlers.
const apiStack = new ApiStack(app, `${prefix}-Api`, {
  env: envConfig,
  description: 'Chimera API Gateway: REST API, WebSocket, webhooks, OpenAI-compatible endpoint',
  envName,
  userPool: securityStack.userPool,
  webAcl: securityStack.webAcl,
  tenantsTable: dataStack.tenantsTable,
  sessionsTable: dataStack.sessionsTable,
  skillsTable: dataStack.skillsTable,
});
applyApiStackSuppressions(apiStack);
apiStack.addDependency(securityStack);
apiStack.addDependency(dataStack);

// --- Stack 6: CI/CD Pipeline ---
// CodePipeline with multi-stage canary deployment: CodeCommit source -> Build/Test -> Canary -> Progressive Rollout.
// Uses CodeCommit (not GitHub) to enable self-editing infrastructure through AWS SDK.
// Created early to provide ECR repository for Chat stack.
const pipelineStack = new PipelineStack(app, `${prefix}-Pipeline`, {
  env: envConfig,
  description: 'Chimera CI/CD pipeline: CodePipeline with canary deployment and auto-rollback',
  envName,
  repositoryName: app.node.tryGetContext('repositoryName') ?? 'chimera',
  branch: app.node.tryGetContext('branch') ?? 'main',
  dockerHubSecretArn: app.node.tryGetContext('dockerHubSecretArn'),
});
applyPipelineStackSuppressions(pipelineStack);

// --- Stack 7: Skill Pipeline ---
// 7-stage security scanning pipeline for marketplace skills using Step Functions.
// Depends on DataStack for skills table and skills bucket.
const skillPipelineStack = new SkillPipelineStack(app, `${prefix}-SkillPipeline`, {
  env: envConfig,
  description: 'Chimera skill security scanning pipeline: 7-stage Step Functions workflow',
  envName,
  skillsTable: dataStack.skillsTable,
  skillsBucket: dataStack.skillsBucket,
});
applySkillPipelineStackSuppressions(skillPipelineStack);
skillPipelineStack.addDependency(dataStack);

// --- Stack 8: Chat Gateway ---
// Express/Fastify server on ECS Fargate with ALB, SSE bridge for Vercel AI SDK streaming.
// Depends on NetworkStack for VPC/security groups, DataStack for DynamoDB tables, and PipelineStack for ECR repository.
const chatStack = new ChatStack(app, `${prefix}-Chat`, {
  env: envConfig,
  description:
    'Chimera chat gateway: ECS Fargate service with ALB, SSE streaming, platform adapters',
  envName,
  vpc: networkStack.vpc,
  albSecurityGroup: networkStack.albSecurityGroup,
  ecsSecurityGroup: networkStack.ecsSecurityGroup,
  // DAX SG narrowing deferred: passing `daxSecurityGroup` here creates a
  // circular dependency (DataStack -> ChatStack SG -> DataStack tables).
  // Resolution requires moving `chatGatewayTaskSecurityGroup` ownership to
  // NetworkStack (which has no ChatStack deps). Tracked as an infra follow-up
  // in docs/reviews/wave4-cdk-audit.md §"DAX SG not wired". DataStack keeps
  // the fallback rule (DAX ingress from broad ECS SG) until that refactor lands.
  tenantsTable: dataStack.tenantsTable,
  sessionsTable: dataStack.sessionsTable,
  skillsTable: dataStack.skillsTable,
  ecrRepository: pipelineStack.chatGatewayEcrRepository,
  cognitoUserPoolId: securityStack.userPool.userPoolId,
  cognitoUserPoolClientId: securityStack.userPoolClient.userPoolClientId,
});
applyChatStackSuppressions(chatStack, isProd);
chatStack.addDependency(networkStack);
chatStack.addDependency(dataStack);
chatStack.addDependency(pipelineStack);
chatStack.addDependency(securityStack);

// --- Stack 9: Orchestration ---
// EventBridge event bus, SQS queues for agent task distribution and A2A messaging.
// Supports swarm, workflow, and graph orchestration patterns.
// Depends on SecurityStack for KMS encryption.
const orchestrationStack = new OrchestrationStack(app, `${prefix}-Orchestration`, {
  env: envConfig,
  description:
    'Chimera orchestration layer: EventBridge event bus, SQS queues for agent communication',
  envName,
  platformKey: securityStack.platformKey,
});
applyOrchestrationStackSuppressions(orchestrationStack);
orchestrationStack.addDependency(securityStack);

// --- Stack 10: Evolution Engine ---
// Self-improvement mechanisms: prompt evolution, auto-skill generation, model routing optimization,
// memory GC, cron self-scheduling. All changes are Cedar-bounded, audited, and reversible.
const evolutionStack = new EvolutionStack(app, `${prefix}-Evolution`, {
  env: envConfig,
  description:
    'Chimera evolution engine: prompt A/B testing, auto-skills, model routing, memory GC',
  envName,
  auditTable: dataStack.auditTable,
  eventBus: orchestrationStack.eventBus,
});
applyEvolutionStackSuppressions(evolutionStack);
evolutionStack.addDependency(dataStack);
evolutionStack.addDependency(orchestrationStack);

// --- Stack 11: Tenant Onboarding ---
// Cedar policy infrastructure + Step Functions workflow for tenant provisioning.
// Creates DDB records, Cognito groups, IAM roles, S3 prefixes, Cedar policies, cost tracking.
// Depends on DataStack for tables/buckets and SecurityStack for user pool/KMS.
const tenantOnboardingStack = new TenantOnboardingStack(app, `${prefix}-TenantOnboarding`, {
  env: envConfig,
  description: 'Chimera tenant onboarding: Cedar policies + Step Functions provisioning workflow',
  envName,
  tenantsTable: dataStack.tenantsTable,
  sessionsTable: dataStack.sessionsTable,
  skillsTable: dataStack.skillsTable,
  rateLimitsTable: dataStack.rateLimitsTable,
  costTrackingTable: dataStack.costTrackingTable,
  auditTable: dataStack.auditTable,
  tenantBucket: dataStack.tenantBucket,
  skillsBucket: dataStack.skillsBucket,
  userPool: securityStack.userPool,
  platformKey: securityStack.platformKey,
  alarmTopic: observabilityStack.alarmTopic,
});
applyTenantOnboardingStackSuppressions(tenantOnboardingStack);
tenantOnboardingStack.addDependency(dataStack);
tenantOnboardingStack.addDependency(securityStack);
tenantOnboardingStack.addDependency(observabilityStack);

// --- Stack 12: Email ---
// SES receipt rules, S3 inbound bucket, email parser + sender Lambdas,
// SQS queues for backpressure. Agent email communication channel.
// Depends on DataStack for sessions table and OrchestrationStack for event bus.
// Note: uses a stack-local KMS key for SQS encryption (not SecurityStack's platformKey)
// to avoid CDK circular dependency (see email-stack.ts for explanation).
const emailStack = new EmailStack(app, `${prefix}-Email`, {
  env: envConfig,
  description:
    'Chimera email channel: SES inbound, email parser/sender Lambdas, thread context in DDB',
  envName,
  sessionsTable: dataStack.sessionsTable,
  agentEventBus: orchestrationStack.eventBus,
  emailDomain: app.node.tryGetContext('emailDomain'),
  fromAddress: app.node.tryGetContext('fromAddress'),
});
applyEmailStackSuppressions(emailStack);
emailStack.addDependency(dataStack);
emailStack.addDependency(orchestrationStack);

// --- Stack 13: Frontend ---
// S3 + CloudFront for the React SPA. No dependencies on other stacks.
const frontendStack = new FrontendStack(app, `${prefix}-Frontend`, {
  env: envConfig,
  description: 'Chimera frontend: S3 + CloudFront for React SPA',
  envName,
});
applyFrontendStackSuppressions(frontendStack);

// --- Stack 14: Discovery ---
// Cloud Map HTTP namespace + service registrations for agent self-awareness.
// Agents call DiscoverInstances to learn the runtime state of the infrastructure.
// Props are resolved CDK tokens — Cloud Map stores them as concrete strings at deploy time.
const discoveryStack = new DiscoveryStack(app, `${prefix}-Discovery`, {
  env: envConfig,
  description:
    'Chimera discovery layer: Cloud Map HTTP namespace + service registrations for agent self-awareness',
  envName,
  restApiUrl: apiStack.api.url,
  webSocketUrl:
    'wss://' +
    apiStack.webSocketApi.ref +
    '.execute-api.' +
    envConfig.region +
    '.amazonaws.com/' +
    envName,
  albDnsName: chatStack.alb.loadBalancerDnsName,
  ecsClusterName: chatStack.ecsCluster.clusterName,
  ecsServiceName: chatStack.ecsService.serviceName,
  userPoolId: securityStack.userPool.userPoolId,
  userPoolClientId: securityStack.userPoolClient.userPoolClientId,
  tableNames: {
    tenants: dataStack.tenantsTable.tableName,
    sessions: dataStack.sessionsTable.tableName,
    skills: dataStack.skillsTable.tableName,
    rateLimits: dataStack.rateLimitsTable.tableName,
    costTracking: dataStack.costTrackingTable.tableName,
    audit: dataStack.auditTable.tableName,
  },
  bucketNames: {
    tenant: dataStack.tenantBucket.bucketName,
    skills: dataStack.skillsBucket.bucketName,
  },
  pipelineName: pipelineStack.pipeline.pipelineName,
  repositoryName: app.node.tryGetContext('repositoryName') ?? 'chimera',
  cloudFrontDomain: frontendStack.distribution.distributionDomainName,
  frontendBucketName: frontendStack.bucket.bucketName,
});
applyDiscoveryStackSuppressions(discoveryStack);
discoveryStack.addDependency(apiStack);
discoveryStack.addDependency(chatStack);
discoveryStack.addDependency(securityStack);
discoveryStack.addDependency(dataStack);
discoveryStack.addDependency(pipelineStack);
discoveryStack.addDependency(frontendStack);

// --- Stack 15 (OPTIONAL): AgentCore Registry ---
// PLACEHOLDER — synthesized ONLY when `deployRegistry` CDK context flag is true:
//   npx cdk synth -c deployRegistry=true
// With the flag unset (default), the stack is not created and synth yields 14 stacks.
// This ends the "no Registry resource exists" blocker for future operators without
// risking accidental provisioning. Accepts both boolean `true` and string `"true"`
// because `-c flag=true` on the CLI is parsed as a string.
// See: docs/designs/agentcore-registry-spike.md, ADR-034.
const deployRegistryCtx = app.node.tryGetContext('deployRegistry');
const deployRegistry = deployRegistryCtx === true || deployRegistryCtx === 'true';

let registryStack: RegistryStack | undefined;
if (deployRegistry) {
  registryStack = new RegistryStack(app, `${prefix}-Registry`, {
    env: envConfig,
    description: 'Chimera AgentCore Registry (spike — not yet production)',
    envName,
  });
  applyCommonSuppressions(registryStack);
}

// Apply tags to all stacks
const stacksToTag: cdk.Stack[] = [
  networkStack,
  dataStack,
  securityStack,
  observabilityStack,
  apiStack,
  skillPipelineStack,
  chatStack,
  orchestrationStack,
  evolutionStack,
  tenantOnboardingStack,
  pipelineStack,
  emailStack,
  frontendStack,
  discoveryStack,
];
if (registryStack) {
  stacksToTag.push(registryStack);
}
for (const stack of stacksToTag) {
  for (const [key, value] of Object.entries(projectTags)) {
    cdk.Tags.of(stack).add(key, value);
  }
}

// --- Stack outputs for cross-stack consumption ---
// Stack 1 (NetworkStack): VPC ID, subnet IDs, security group IDs
// Stack 2 (DataStack): table ARNs/names, bucket ARNs/names
// Stack 3 (SecurityStack): user pool ID/ARN, WebACL ARN, KMS key ARN
// Stack 4 (ObservabilityStack): alarm topic ARN, dashboard URL/name
// Stack 5 (ApiStack): REST API ID/URL, authorizer ID, WebSocket API ID/URL
// Stack 6 (PipelineStack): pipeline ARN/name, artifact bucket name, agent ECR repository ARN/URI, chat-gateway ECR repository ARN/URI, orchestration state machine ARN, alarm topic ARN
// Stack 7 (SkillPipelineStack): state machine ARN/name
// Stack 8 (ChatStack): ALB DNS/ARN, ECS cluster/service names, task definition ARN
// Stack 9 (OrchestrationStack): event bus name/ARN, task queue URL/ARN, message queue URL/ARN, event publisher role ARN
// Stack 10 (EvolutionStack): evolution state table ARN/name, artifacts bucket ARN/name, state machine ARNs
// Stack 11 (TenantOnboardingStack): Cedar policy store ID/ARN, onboarding state machine ARN, evaluation Lambda ARN
// Stack 12 (EmailStack): inbound email bucket name, email KMS key ARN, parser/sender queue URLs, Lambda ARNs, rule set name
// Stack 13 (FrontendStack): S3 bucket name/ARN, CloudFront distribution ID/domain, frontend URL
// Stack 14 (DiscoveryStack): Cloud Map namespace ID/ARN/name

app.synth();
