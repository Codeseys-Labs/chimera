#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { SecurityStack } from '../lib/security-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { ApiStack } from '../lib/api-stack';
import { SkillPipelineStack } from '../lib/skill-pipeline-stack';
import { ChatStack } from '../lib/chat-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { OrchestrationStack } from '../lib/orchestration-stack';

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
// Cognito user pool, WAF WebACL, KMS keys. Depends on NetworkStack (WAF for regional resources).
const securityStack = new SecurityStack(app, `${prefix}-Security`, {
  env: envConfig,
  description: 'Chimera security layer: Cognito user pool, WAF WebACL, KMS key',
  envName,
});
securityStack.addDependency(networkStack);

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

// --- Stack 6: Skill Pipeline ---
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

// --- Stack 7: Chat Gateway ---
// Express/Fastify server on ECS Fargate with ALB, SSE bridge for Vercel AI SDK streaming.
// Depends on NetworkStack for VPC/security groups and DataStack for DynamoDB tables.
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
});
chatStack.addDependency(networkStack);
chatStack.addDependency(dataStack);

// --- Stack 8: Orchestration ---
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

// --- Stack 9: CI/CD Pipeline ---
// CodePipeline with multi-stage canary deployment: GitHub source -> Build/Test -> Canary -> Progressive Rollout.
// Independent stack, can be deployed separately from application stacks.
const pipelineStack = new PipelineStack(app, `${prefix}-Pipeline`, {
  env: envConfig,
  description: 'Chimera CI/CD pipeline: CodePipeline with canary deployment and auto-rollback',
  envName,
  repository: app.node.tryGetContext('repository') ?? 'your-org/chimera',
  branch: app.node.tryGetContext('branch') ?? 'main',
  githubTokenSecretName: app.node.tryGetContext('githubTokenSecret'),
});

// Apply tags to all stacks
for (const stack of [networkStack, dataStack, securityStack, observabilityStack, apiStack, skillPipelineStack, chatStack, orchestrationStack, pipelineStack]) {
  for (const [key, value] of Object.entries(projectTags)) {
    cdk.Tags.of(stack).add(key, value);
  }
}

// --- Stack outputs for cross-stack consumption ---
// NetworkStack exports VPC ID, subnet IDs, security group IDs
// DataStack exports table ARNs/names, bucket ARNs/names
// SecurityStack exports user pool ID/ARN, WebACL ARN, KMS key ARN
// ObservabilityStack exports alarm topic ARN, dashboard URL/name
// ApiStack exports REST API ID/URL, authorizer ID, WebSocket API ID/URL
// SkillPipelineStack exports state machine ARN/name
// ChatStack exports ALB DNS/ARN, ECS cluster/service names, task definition ARN
// OrchestrationStack exports event bus name/ARN, task queue URL/ARN, message queue URL/ARN, event publisher role ARN
// PipelineStack exports pipeline ARN/name, artifact bucket name, orchestration state machine ARN, alarm topic ARN

app.synth();
