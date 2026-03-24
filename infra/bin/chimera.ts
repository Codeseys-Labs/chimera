#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
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

const app = new cdk.App();
const envName = app.node.tryGetContext('environment') ?? 'dev';

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

// --- Stack 2: Data ---
// 6 DynamoDB tables, 3 S3 buckets. Depends on NetworkStack for VPC (future ElastiCache).
const dataStack = new DataStack(app, `${prefix}-Data`, {
  env: envConfig,
  description: 'Chimera data layer: 6 DynamoDB tables, 3 S3 buckets',
  envName,
  vpc: networkStack.vpc,
});
dataStack.addDependency(networkStack);

// --- Stack 3: Security ---
// Cognito user pool, WAF WebACL, KMS keys. No stack dependencies.
const securityStack = new SecurityStack(app, `${prefix}-Security`, {
  env: envConfig,
  description: 'Chimera security layer: Cognito user pool, WAF WebACL, KMS key',
  envName,
});

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
observabilityStack.addDependency(dataStack);
observabilityStack.addDependency(securityStack);

// --- Stack 5: API Gateway ---
// REST API v1 with JWT authorizer, WebSocket API, webhook routes, OpenAI-compatible endpoint.
// Depends on SecurityStack for Cognito user pool and WAF WebACL.
const apiStack = new ApiStack(app, `${prefix}-Api`, {
  env: envConfig,
  description: 'Chimera API Gateway: REST API, WebSocket, webhooks, OpenAI-compatible endpoint',
  envName,
  userPool: securityStack.userPool,
  webAcl: securityStack.webAcl,
});
apiStack.addDependency(securityStack);

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
});

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
skillPipelineStack.addDependency(dataStack);

// --- Stack 8: Chat Gateway ---
// Express/Fastify server on ECS Fargate with ALB, SSE bridge for Vercel AI SDK streaming.
// Depends on NetworkStack for VPC/security groups, DataStack for DynamoDB tables, and PipelineStack for ECR repository.
const chatStack = new ChatStack(app, `${prefix}-Chat`, {
  env: envConfig,
  description: 'Chimera chat gateway: ECS Fargate service with ALB, SSE streaming, platform adapters',
  envName,
  vpc: networkStack.vpc,
  albSecurityGroup: networkStack.albSecurityGroup,
  ecsSecurityGroup: networkStack.ecsSecurityGroup,
  tenantsTable: dataStack.tenantsTable,
  sessionsTable: dataStack.sessionsTable,
  skillsTable: dataStack.skillsTable,
  ecrRepository: pipelineStack.chatGatewayEcrRepository,
});
chatStack.addDependency(networkStack);
chatStack.addDependency(dataStack);
chatStack.addDependency(pipelineStack);

// --- Stack 9: Orchestration ---
// EventBridge event bus, SQS queues for agent task distribution and A2A messaging.
// Supports swarm, workflow, and graph orchestration patterns.
// Depends on SecurityStack for KMS encryption.
const orchestrationStack = new OrchestrationStack(app, `${prefix}-Orchestration`, {
  env: envConfig,
  description: 'Chimera orchestration layer: EventBridge event bus, SQS queues for agent communication',
  envName,
  platformKey: securityStack.platformKey,
});
orchestrationStack.addDependency(securityStack);

// --- Stack 10: Evolution Engine ---
// Self-improvement mechanisms: prompt evolution, auto-skill generation, model routing optimization,
// memory GC, cron self-scheduling. All changes are Cedar-bounded, audited, and reversible.
const evolutionStack = new EvolutionStack(app, `${prefix}-Evolution`, {
  env: envConfig,
  description: 'Chimera evolution engine: prompt A/B testing, auto-skills, model routing, memory GC',
  envName,
  auditTable: dataStack.auditTable,
});
evolutionStack.addDependency(dataStack);

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
tenantOnboardingStack.addDependency(dataStack);
tenantOnboardingStack.addDependency(securityStack);
tenantOnboardingStack.addDependency(observabilityStack);

// Apply tags to all stacks
for (const stack of [networkStack, dataStack, securityStack, observabilityStack, apiStack, skillPipelineStack, chatStack, orchestrationStack, evolutionStack, tenantOnboardingStack, pipelineStack]) {
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

app.synth();
