#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { SecurityStack } from '../lib/security-stack';
import { ObservabilityStack } from '../lib/observability-stack';

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

// Apply tags to all stacks
for (const stack of [networkStack, dataStack, securityStack, observabilityStack]) {
  for (const [key, value] of Object.entries(projectTags)) {
    cdk.Tags.of(stack).add(key, value);
  }
}

// --- Stack outputs for cross-stack consumption ---
// NetworkStack exports VPC ID, subnet IDs, security group IDs
// DataStack exports table ARNs/names, bucket ARNs/names
// SecurityStack exports user pool ID/ARN, WebACL ARN, KMS key ARN
// ObservabilityStack exports alarm topic ARN, dashboard URL/name

app.synth();
