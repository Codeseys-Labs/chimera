# Chimera Architecture Review: Platform Engineering & IaC

> **Reviewer:** Platform Engineering Agent
> **Date:** 2026-03-19
> **Scope:** IaC separation, CDK stack structure, deployment pipeline, GitOps, self-modifying IaC, environment strategy, infrastructure testing, monitoring, DR, multi-region
> **Source Documents:** [[AWS-Native-OpenClaw-Architecture-Synthesis]], [[AWS Bedrock AgentCore and Strands Agents/08-IaC-Patterns-Agent-Platforms|08-IaC-Patterns-Agent-Platforms]], [[AWS Bedrock AgentCore and Strands Agents/06-AWS-Services-Agent-Infrastructure|06-AWS-Services-Agent-Infrastructure]], [[OpenClaw NemoClaw OpenFang/08-Deployment-Infrastructure-Self-Editing|08-Deployment-Infrastructure-Self-Editing]]

---

## Executive Assessment

The synthesis document proposes a two-layer IaC separation (platform vs. tenant) using AWS CDK. This is directionally correct but significantly underspecified for production readiness. The current proposal has 5 files across 2 CDK apps -- a real deployment needs **12-15 stacks** across a single CDK app with explicit dependency ordering, a CodePipeline with at least 5 stages, and concrete guardrails for the self-modifying IaC pattern.

This review provides the missing specificity: exact stack decomposition, L3 construct designs, pipeline configuration, GitOps workflow, directory layout, and testing strategy.

**Key recommendations:**
1. Use a **single CDK app** with cross-stack references instead of two separate CDK apps
2. Add a dedicated **NetworkStack** and **DataStack** that the synthesis omits entirely
3. The `manage_infrastructure` tool needs a **two-phase commit** (propose + apply) with mandatory drift detection
4. Implement **canary deployments** for agent runtime updates -- agent behavior changes are harder to test than traditional code
5. Add **infrastructure tests at three levels**: CDK assertions, integration tests, and contract tests

---

## 1. CDK Stack Structure

### Stack Decomposition

The synthesis proposes 4 platform stacks and 3 tenant stacks. This is insufficient. Here is the complete stack graph:

```
ChimeraApp
  |
  +-- NetworkStack              (VPC, subnets, NAT, VPC endpoints, security groups)
  |     |
  +-- DataStack                 (DynamoDB tables, S3 buckets, EFS)
  |     |
  +-- SecurityStack             (Cognito, WAF, Cedar policies, KMS keys)
  |     |
  +-- ObservabilityStack        (CloudWatch dashboards, alarms, X-Ray groups, SNS topics)
  |     |
  +-- PlatformRuntimeStack      (AgentCore Runtime, API Gateway, EventBridge bus)
  |     |   depends on: NetworkStack, DataStack, SecurityStack
  |     |
  +-- ChatStack                 (ECS Fargate service, ALB, Chat SDK deployment)
  |     |   depends on: NetworkStack, SecurityStack, PlatformRuntimeStack
  |     |
  +-- PipelineStack             (CodePipeline, CodeBuild projects, ECR repos)
  |     |   depends on: nothing (bootstraps everything else)
  |     |
  +-- TenantStack (per tenant)  (Tenant-specific AgentCore config, cron rules, skills)
        |   depends on: PlatformRuntimeStack, DataStack, SecurityStack
        |
        +-- TenantCronConstruct
        +-- TenantSkillsConstruct
        +-- TenantMemoryConstruct
```

### Why This Decomposition

| Stack | Change Frequency | Blast Radius | Owner |
|-------|-----------------|--------------|-------|
| NetworkStack | Quarterly | Critical (everything depends on it) | Platform team |
| DataStack | Monthly | High (data loss risk) | Platform team |
| SecurityStack | Monthly | High (auth breakage) | Security + Platform |
| ObservabilityStack | Weekly | Low (monitoring only) | Platform team |
| PlatformRuntimeStack | Weekly | Medium (agent runtime) | Platform team |
| ChatStack | Weekly | Medium (chat delivery) | Platform team |
| PipelineStack | Rarely | Low (CI/CD only) | Platform team |
| TenantStack | Daily (per tenant) | Low (isolated to tenant) | Automated / Tenant admin |

### Core Stack Implementations

#### NetworkStack

```typescript
// lib/stacks/network-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly agentSecurityGroup: ec2.ISecurityGroup;
  public readonly vpcEndpoints: { [key: string]: ec2.IInterfaceVpcEndpoint };

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'ChimeraVpc', {
      maxAzs: 3,
      natGateways: 2, // HA but cost-conscious; scale to 3 for prod-critical
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // VPC endpoints reduce NAT costs and improve latency for AWS service calls
    this.vpcEndpoints = {};
    const endpointServices = ['dynamodb', 's3', 'bedrock-runtime', 'bedrock-agent-runtime',
                               'secretsmanager', 'ecr.api', 'ecr.dkr', 'logs', 'monitoring'];

    for (const svc of ['dynamodb', 's3']) {
      this.vpc.addGatewayEndpoint(`${svc}-endpoint`, {
        service: ec2.GatewayVpcEndpointAwsService[svc.toUpperCase().replace('-', '_') as keyof typeof ec2.GatewayVpcEndpointAwsService],
      });
    }

    for (const svc of endpointServices.filter(s => s !== 'dynamodb' && s !== 's3')) {
      this.vpcEndpoints[svc] = this.vpc.addInterfaceEndpoint(`${svc}-endpoint`, {
        service: new ec2.InterfaceVpcEndpointAwsService(svc),
        privateDnsEnabled: true,
      });
    }

    this.agentSecurityGroup = new ec2.SecurityGroup(this, 'AgentSG', {
      vpc: this.vpc,
      description: 'Security group for Chimera agent services',
      allowAllOutbound: true,
    });
  }
}
```

#### DataStack

> **Note**: This section was updated 2026-03-19 to use the canonical **6-table design** from the Final Architecture Plan. The original draft used a single-table design which has been superseded. See [docs/architecture/canonical-data-model.md](../../architecture/canonical-data-model.md) for the authoritative schema definition.

```typescript
// lib/stacks/data-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface DataStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class DataStack extends cdk.Stack {
  public readonly tenantsTable: dynamodb.ITable;
  public readonly sessionsTable: dynamodb.ITable;
  public readonly skillsTable: dynamodb.ITable;
  public readonly rateLimitsTable: dynamodb.ITable;
  public readonly costTrackingTable: dynamodb.ITable;
  public readonly auditTable: dynamodb.ITable;
  public readonly tenantBucket: s3.IBucket;
  public readonly skillsBucket: s3.IBucket;
  public readonly artifactsBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'production';

    // --- Table 1: Tenants ---
    this.tenantsTable = new dynamodb.Table(this, 'TenantsTable', {
      tableName: `chimera-tenants-${props.envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.tenantsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-tier',
      partitionKey: { name: 'tier', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.tenantsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-status',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Table 2: Sessions ---
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: `chimera-sessions-${props.envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-agent-activity',
      partitionKey: { name: 'agentId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'lastActivity', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.sessionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-user-sessions',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'lastActivity', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Tenant data bucket with prefix isolation
    this.tenantBucket = new s3.Bucket(this, 'TenantBucket', {
      bucketName: `chimera-tenants-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        { id: 'intelligent-tiering', transitions: [
          { storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: cdk.Duration.days(30) },
        ]},
        { id: 'glacier-archive', prefix: 'archive/',
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) },
          ]},
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Skills bucket (global + marketplace + tenant skills)
    this.skillsBucket = new s3.Bucket(this, 'SkillsBucket', {
      bucketName: `chimera-skills-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Shared filesystem for agent workspaces
    this.agentWorkspace = new efs.FileSystem(this, 'AgentWorkspace', {
      vpc: props.vpc,
      throughputMode: efs.ThroughputMode.ELASTIC,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
    });
  }
}
```

#### PlatformRuntimeStack

```typescript
// lib/stacks/platform-runtime-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface PlatformRuntimeStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  platformTable: dynamodb.ITable;
  tenantBucket: s3.IBucket;
  skillsBucket: s3.IBucket;
}

export class PlatformRuntimeStack extends cdk.Stack {
  public readonly agentRuntime: agentcore.Runtime;
  public readonly eventBus: events.IEventBus;
  public readonly webSocketApi: apigateway.CfnApi;

  constructor(scope: Construct, id: string, props: PlatformRuntimeStackProps) {
    super(scope, id, props);

    // AgentCore Runtime -- shared pool for standard-tier tenants
    this.agentRuntime = new agentcore.Runtime(this, 'PoolRuntime', {
      runtimeName: 'chimera-pool',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(
        './agent-code'
      ),
    });

    // Production endpoint (pinned version for stability)
    this.agentRuntime.addEndpoint('production', {
      description: 'Stable production endpoint for pooled tenants',
    });

    // Canary endpoint (latest version for progressive rollout)
    this.agentRuntime.addEndpoint('canary', {
      description: 'Canary endpoint -- receives 5% of traffic',
    });

    // Custom event bus for agent platform events
    this.eventBus = new events.EventBus(this, 'ChimeraEventBus', {
      eventBusName: 'chimera-events',
    });

    // WebSocket API for real-time agent streaming
    this.webSocketApi = new apigateway.CfnApi(this, 'AgentWebSocketApi', {
      name: 'chimera-websocket',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });

    // Grant runtime access to data stores
    props.platformTable.grantReadWriteData(this.agentRuntime);
    props.tenantBucket.grantReadWrite(this.agentRuntime);
    props.skillsBucket.grantRead(this.agentRuntime);
  }
}
```

---

## 2. CDK Construct Library (L3 Constructs)

The platform should publish reusable L3 constructs that encapsulate common Chimera patterns. These live in a shared construct library package: `@chimera/cdk-constructs`.

### TenantAgent Construct

```typescript
// packages/cdk-constructs/src/tenant-agent.ts
import * as cdk from 'aws-cdk-lib';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface TenantAgentProps {
  tenantId: string;
  tier: 'basic' | 'pro' | 'enterprise';
  modelId?: string;
  skills?: string[];
  cronJobs?: CronJobConfig[];
  memoryStrategies?: ('SUMMARY' | 'SEMANTIC_MEMORY' | 'USER_PREFERENCE')[];
  platformTable: dynamodb.ITable;
  tenantBucket: s3.IBucket;
  poolRuntime: agentcore.Runtime;
  eventBus: events.IEventBus;
}

export interface CronJobConfig {
  name: string;
  schedule: events.Schedule;
  promptKey: string;  // S3 key for the prompt template
  skills: string[];
  maxBudgetUsd: number;
  outputPrefix: string;
  notifications?: { slackChannel?: string; email?: string };
}

export class TenantAgent extends Construct {
  public readonly tenantRole: iam.IRole;
  public readonly cronStateMachines: sfn.IStateMachine[];

  constructor(scope: Construct, id: string, props: TenantAgentProps) {
    super(scope, id);

    // Scoped IAM role for this tenant
    this.tenantRole = new iam.Role(this, 'TenantRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: `Chimera tenant role for ${props.tenantId}`,
    });

    // DynamoDB access scoped to tenant's partition key prefix
    props.platformTable.grant(this.tenantRole,
      'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
    );
    // Condition: PK must start with TENANT#{tenantId}
    (this.tenantRole as iam.Role).addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['dynamodb:*'],
      resources: [props.platformTable.tableArn],
      conditions: {
        'ForAllValues:StringNotLike': {
          'dynamodb:LeadingKeys': [`TENANT#${props.tenantId}*`],
        },
      },
    }));

    // S3 access scoped to tenant's prefix
    props.tenantBucket.grantReadWrite(this.tenantRole,
      `tenants/${props.tenantId}/*`);

    // Enterprise tier: dedicated AgentCore runtime
    if (props.tier === 'enterprise') {
      const dedicatedRuntime = new agentcore.Runtime(this, 'DedicatedRuntime', {
        runtimeName: `chimera-${props.tenantId}`,
        agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(
          './agent-code'
        ),
      });
      dedicatedRuntime.addEndpoint('production', {
        description: `Dedicated production endpoint for ${props.tenantId}`,
      });
    }

    // Cron jobs as EventBridge + Step Functions
    this.cronStateMachines = [];
    for (const job of props.cronJobs ?? []) {
      const sm = this.createCronJob(props, job);
      this.cronStateMachines.push(sm);
    }
  }

  private createCronJob(props: TenantAgentProps, job: CronJobConfig): sfn.StateMachine {
    // Step Function: load config -> invoke agent -> write output -> notify
    const definition = new sfn.Pass(this, `${job.name}-Start`, {
      comment: `Cron job: ${job.name} for tenant ${props.tenantId}`,
    });
    // (Full definition would chain: LoadConfig -> InvokeAgent -> WriteOutput -> Notify)

    const stateMachine = new sfn.StateMachine(this, `${job.name}-SM`, {
      stateMachineName: `chimera-${props.tenantId}-${job.name}`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(30),
    });

    // EventBridge schedule
    new events.Rule(this, `${job.name}-Schedule`, {
      schedule: job.schedule,
      targets: [new targets.SfnStateMachine(stateMachine)],
      eventBus: props.eventBus,
    });

    return stateMachine;
  }
}
```

### AgentObservability Construct

```typescript
// packages/cdk-constructs/src/agent-observability.ts
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface AgentObservabilityProps {
  tenantId?: string;  // undefined = platform-level
  alarmAction: sns.ITopic;
}

export class AgentObservability extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: AgentObservabilityProps) {
    super(scope, id);

    const prefix = props.tenantId ? `Tenant-${props.tenantId}` : 'Platform';

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `Chimera-${prefix}`,
    });

    // Agent invocation metrics
    const invocationDuration = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'InvocationDuration',
      dimensionsMap: props.tenantId ? { TenantId: props.tenantId } : undefined,
      statistic: 'p99',
      period: cdk.Duration.minutes(5),
    });

    const errorRate = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'Errors',
      dimensionsMap: props.tenantId ? { TenantId: props.tenantId } : undefined,
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const tokenUsage = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'TokensUsed',
      dimensionsMap: props.tenantId ? { TenantId: props.tenantId } : undefined,
      statistic: 'Sum',
      period: cdk.Duration.hours(1),
    });

    // Dashboard widgets
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: `${prefix} Agent Latency (p99)`,
        left: [invocationDuration],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: `${prefix} Error Rate`,
        left: [errorRate],
        width: 12,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: `${prefix} Token Usage (hourly)`,
        left: [tokenUsage],
        width: 12,
      }),
      new cloudwatch.SingleValueWidget({
        title: `${prefix} Active Sessions`,
        metrics: [new cloudwatch.Metric({
          namespace: 'AgentPlatform',
          metricName: 'ActiveSessions',
          dimensionsMap: props.tenantId ? { TenantId: props.tenantId } : undefined,
          statistic: 'Maximum',
        })],
        width: 12,
      }),
    );

    // Alarms
    new cloudwatch.Alarm(this, 'HighErrorRate', {
      metric: errorRate,
      threshold: 10,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `${prefix}: Error rate exceeded 10 errors in 5min window`,
      actionsEnabled: true,
    }).addAlarmAction({ bind: () => ({ alarmActionArn: props.alarmAction.topicArn }) });

    new cloudwatch.Alarm(this, 'HighLatency', {
      metric: invocationDuration,
      threshold: 30000, // 30 seconds p99
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      alarmDescription: `${prefix}: p99 latency exceeded 30s`,
      actionsEnabled: true,
    }).addAlarmAction({ bind: () => ({ alarmActionArn: props.alarmAction.topicArn }) });
  }
}
```

---

## 3. Deployment Pipeline

### CodePipeline Design

```
Source (CodeCommit/GitHub)
  |
  v
[Stage 1: Build]
  - CDK synth
  - Docker build + push to ECR
  - Run CDK assertions (unit tests)
  - Run linting + security scanning (cfn_nag, cdk-nag)
  |
  v
[Stage 2: Deploy to Dev]
  - Deploy all stacks to dev account
  - Run integration tests (API calls, agent invocations)
  - Auto-approve if tests pass
  |
  v
[Stage 3: Deploy to Staging]
  - Deploy all stacks to staging account
  - Run end-to-end tests (multi-tenant scenarios)
  - Canary agent deployment (5% traffic)
  - 30-minute bake time with alarm monitoring
  |
  v
[Stage 4: Manual Approval]
  - SNS notification to platform team
  - Approval gate with link to staging test results
  - Required for production deployment
  |
  v
[Stage 5: Deploy to Prod]
  - Deploy platform stacks (NetworkStack -> DataStack -> SecurityStack -> etc.)
  - Progressive tenant stack deployment (10% -> 50% -> 100%)
  - Automatic rollback on CloudWatch alarm
  |
  v
[Stage 6: Post-Deploy Validation]
  - Smoke tests against production
  - Drift detection scan
  - Cost comparison report
```

### Pipeline CDK Implementation

```typescript
// lib/stacks/pipeline-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { Construct } from 'constructs';

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pipeline = new pipelines.CodePipeline(this, 'ChimeraPipeline', {
      pipelineName: 'chimera-deploy',
      synth: new pipelines.ShellStep('Synth', {
        input: pipelines.CodePipelineSource.connection('org/chimera', 'main', {
          connectionArn: 'arn:aws:codestar-connections:...',
        }),
        commands: [
          'npm ci',
          'npm run build',
          'npm run test:unit',      // CDK assertion tests
          'npm run test:security',  // cdk-nag checks
          'npx cdk synth',
        ],
      }),
      dockerEnabledForSynth: true,
      dockerEnabledForSelfMutation: true,
    });

    // Dev stage
    const devStage = pipeline.addStage(new ChimeraStage(this, 'Dev', {
      env: { account: '111111111111', region: 'us-west-2' },
      stageName: 'dev',
    }));
    devStage.addPost(new pipelines.ShellStep('IntegrationTests', {
      commands: [
        'npm run test:integration -- --env dev',
      ],
    }));

    // Staging stage
    const stagingStage = pipeline.addStage(new ChimeraStage(this, 'Staging', {
      env: { account: '222222222222', region: 'us-west-2' },
      stageName: 'staging',
    }));
    stagingStage.addPost(
      new pipelines.ShellStep('E2ETests', {
        commands: ['npm run test:e2e -- --env staging'],
      }),
      new pipelines.ShellStep('CanaryBake', {
        commands: [
          'echo "Waiting 30 minutes for canary bake..."',
          'sleep 1800',
          'npm run check:canary-health -- --env staging',
        ],
      }),
    );

    // Manual approval before prod
    const prodStage = pipeline.addStage(new ChimeraStage(this, 'Prod', {
      env: { account: '333333333333', region: 'us-west-2' },
      stageName: 'prod',
    }), {
      pre: [new pipelines.ManualApprovalStep('PromoteToProd', {
        comment: 'Review staging test results and canary metrics before deploying to production.',
      })],
    });
    prodStage.addPost(new pipelines.ShellStep('SmokeTests', {
      commands: ['npm run test:smoke -- --env prod'],
    }));
  }
}
```

### Rollback Strategy

| Failure Type | Detection | Rollback Method |
|-------------|-----------|-----------------|
| CDK deploy failure | CloudFormation stack event | Automatic CloudFormation rollback |
| Agent behavior regression | CloudWatch alarm (error rate spike) | CodePipeline alarm-based rollback |
| Canary failure | Canary health check script | Abort pipeline, revert AgentCore endpoint version |
| Data corruption | DynamoDB point-in-time recovery | Manual restore from PITR snapshot |
| Tenant-specific failure | Per-tenant error rate alarm | Roll back individual TenantStack |

---

## 4. GitOps Workflow for Tenant Infrastructure

### Tenant Configuration as Code

Tenant infrastructure changes follow a GitOps workflow. Tenant configurations are YAML files in the repository:

```yaml
# tenants/acme.yaml
tenantId: acme
tier: pro
models:
  default: us.anthropic.claude-sonnet-4-6-v1:0
  complex: us.anthropic.claude-opus-4-6-v1:0
  fast: us.amazon.nova-lite-v1:0
skills:
  - code-review
  - email-reader
  - summarizer
cronJobs:
  - name: daily-digest
    schedule: "cron(0 8 ? * MON-FRI *)"
    promptKey: prompts/digest.md
    skills: [email-reader, summarizer]
    maxBudgetUsd: 2.0
    outputPrefix: outputs/digests/
    notifications:
      slackChannel: "#daily-digest"
  - name: weekly-report
    schedule: "cron(0 9 ? * MON *)"
    promptKey: prompts/weekly-report.md
    skills: [email-reader, summarizer, data-analyst]
    maxBudgetUsd: 5.0
    outputPrefix: outputs/reports/
memoryStrategies:
  - SUMMARY
  - SEMANTIC_MEMORY
  - USER_PREFERENCE
budgetLimitMonthlyUsd: 500
```

### GitOps Flow

```
1. Tenant admin (or agent via manage_infrastructure) edits tenants/acme.yaml
2. Opens PR against main branch
3. CI runs:
   a. YAML schema validation
   b. CDK diff for affected TenantStack
   c. Cost estimate (Infracost or CDK cost analysis)
   d. Cedar policy validation (is the change within tenant's allowed scope?)
4. Platform team reviews (or auto-approves if within policy bounds)
5. PR merges to main
6. CodePipeline detects change, deploys affected TenantStack only
7. Post-deploy: smoke test against tenant's agent endpoint
```

### CDK Reads Tenant YAML

```typescript
// bin/app.ts
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

const app = new cdk.App();
const env = app.node.tryGetContext('environment') ?? 'dev';

// Load all tenant configs
const tenantsDir = path.join(__dirname, '..', 'tenants');
const tenantFiles = fs.readdirSync(tenantsDir).filter(f => f.endsWith('.yaml'));

// Deploy platform stacks first
const networkStack = new NetworkStack(app, `Chimera-${env}-Network`, { env: envConfig });
const dataStack = new DataStack(app, `Chimera-${env}-Data`, { vpc: networkStack.vpc, env: envConfig });
const securityStack = new SecurityStack(app, `Chimera-${env}-Security`, { env: envConfig });
const runtimeStack = new PlatformRuntimeStack(app, `Chimera-${env}-Runtime`, {
  vpc: networkStack.vpc,
  platformTable: dataStack.platformTable,
  tenantBucket: dataStack.tenantBucket,
  skillsBucket: dataStack.skillsBucket,
  env: envConfig,
});

// Deploy tenant stacks from YAML configs
for (const file of tenantFiles) {
  const config = yaml.parse(fs.readFileSync(path.join(tenantsDir, file), 'utf8'));
  new TenantStack(app, `Chimera-${env}-Tenant-${config.tenantId}`, {
    tenantConfig: config,
    platformTable: dataStack.platformTable,
    tenantBucket: dataStack.tenantBucket,
    poolRuntime: runtimeStack.agentRuntime,
    eventBus: runtimeStack.eventBus,
    env: envConfig,
  });
}
```

---

## 5. Self-Modifying IaC: `manage_infrastructure` Tool

### Critique of Current Design

The synthesis proposes a `manage_infrastructure` tool that commits CDK diffs directly to a GitOps repo. This is **dangerous without additional safety layers**:

1. **No validation of generated CDK code** -- the agent produces arbitrary TypeScript
2. **No cost estimation** before proposing changes
3. **No idempotency guarantee** -- concurrent agents could create conflicting PRs
4. **No tenant scope enforcement** at the IaC level (only Cedar at runtime)

### Recommended Implementation: Two-Phase Commit

```python
@tool
def manage_infrastructure(
    action: str,
    config: dict,
    dry_run: bool = True,
) -> str:
    """
    Modify tenant infrastructure via GitOps. Two phases:
    Phase 1 (dry_run=True): Generate change, validate, estimate cost. Returns PR preview.
    Phase 2 (dry_run=False): Create actual PR with the validated change.

    Allowed actions: add_skill, remove_skill, update_cron, update_model,
                     adjust_budget, enable_channel, disable_channel.
    Forbidden actions: modify_iam, modify_network, modify_platform, delete_tenant.
    """
    # 1. Validate action is allowed for this tenant
    if action in FORBIDDEN_ACTIONS:
        return f"Action '{action}' is forbidden for tenant-initiated changes."

    if not cedar_authorize(tenant_id, action, config):
        return f"Action denied by Cedar policy for tenant {tenant_id}."

    # 2. Load current tenant YAML from repo
    current_yaml = load_tenant_yaml(tenant_id)

    # 3. Apply the change to YAML (safe merge, not arbitrary edit)
    proposed_yaml = apply_change(current_yaml, action, config)

    # 4. Validate the proposed YAML against schema
    validation_errors = validate_tenant_schema(proposed_yaml)
    if validation_errors:
        return f"Validation failed: {validation_errors}"

    # 5. Estimate cost impact
    cost_delta = estimate_cost_delta(current_yaml, proposed_yaml)

    if dry_run:
        return json.dumps({
            "status": "preview",
            "changes": diff_yaml(current_yaml, proposed_yaml),
            "estimated_monthly_cost_delta_usd": cost_delta,
            "message": "Call with dry_run=False to create PR.",
        })

    # 6. Check for concurrent PRs from this tenant (prevent conflicts)
    existing_prs = find_open_prs(tenant_id)
    if existing_prs:
        return f"Tenant {tenant_id} already has open PR(s): {existing_prs}. Merge or close first."

    # 7. Create branch, commit YAML, open PR
    branch = f"tenant/{tenant_id}/{action}/{int(time.time())}"
    pr_url = create_pr(
        branch=branch,
        file_path=f"tenants/{tenant_id}.yaml",
        content=yaml.dump(proposed_yaml),
        title=f"[{tenant_id}] {action}: {config.get('name', '')}",
        body=f"Automated change via manage_infrastructure.\n\nCost delta: ${cost_delta}/month",
    )

    return json.dumps({
        "status": "pr_created",
        "pr_url": pr_url,
        "cost_delta_usd": cost_delta,
    })
```

### Safety Guardrails

| Guardrail | Implementation |
|-----------|---------------|
| Action allowlist | Hard-coded in tool -- agent cannot bypass |
| Cedar policy check | Runtime authorization before any change |
| Schema validation | JSON Schema for tenant YAML -- rejects malformed configs |
| Cost estimation | Infracost or CDK cost API before PR creation |
| Concurrency control | One open PR per tenant at a time |
| Budget ceiling | Monthly budget in tenant config -- changes cannot exceed it |
| Audit trail | All PRs tagged with agent session ID, tenant ID, action |
| Rollback | Revert PR if post-deploy health check fails |
| Rate limiting | Max 5 infrastructure changes per tenant per day |

---

## 6. Environment Strategy

### Account Structure

```
AWS Organization
  |
  +-- Management Account (billing, organization policies)
  |
  +-- Shared Services OU
  |     +-- Pipeline Account (CodePipeline, ECR, artifact buckets)
  |     +-- Security Account (GuardDuty, CloudTrail aggregation, audit)
  |
  +-- Workloads OU
        +-- Dev Account       (all stacks deployed, no real tenant data)
        +-- Staging Account   (all stacks deployed, synthetic tenant data)
        +-- Prod Account      (all stacks deployed, real tenants)
```

### Tenant Sandbox Pattern

Enterprise tenants who need isolated development environments get a **tenant sandbox** within the dev account:

```typescript
// Sandbox is a lightweight TenantStack in dev with:
// - Isolated S3 prefix
// - Isolated DynamoDB partition
// - Own cron schedules (disabled by default)
// - Connected to dev AgentCore runtime
new TenantStack(app, `Chimera-dev-Sandbox-${tenantId}`, {
  tenantConfig: { ...tenantConfig, tier: 'basic' }, // Always basic tier in sandbox
  isSandbox: true,
  // Auto-cleanup after 7 days of inactivity
  autoCleanupDays: 7,
});
```

### Environment Parity

| Aspect | Dev | Staging | Prod |
|--------|-----|---------|------|
| VPC | 2 AZ, 1 NAT | 3 AZ, 2 NAT | 3 AZ, 3 NAT |
| AgentCore Runtime | Shared pool only | Shared + 1 dedicated | Shared + N dedicated |
| DynamoDB | On-demand | On-demand | On-demand (reserved for base) |
| Tenants | Synthetic only | Synthetic + staging copies | Real tenants |
| Model access | Sonnet only (cost) | Sonnet + Haiku | All models |
| Alarms | Slack only | Slack + email | Slack + email + PagerDuty |
| Data retention | 7 days | 30 days | Per tenant policy |

---

## 7. Infrastructure Testing

### Three-Level Testing Strategy

#### Level 1: CDK Assertions (Unit Tests)

Run in seconds during CI. Validate stack structure without deploying.

```typescript
// test/stacks/data-stack.test.ts
import { Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../../lib/stacks/data-stack';
import { NetworkStack } from '../../lib/stacks/network-stack';

describe('DataStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const network = new NetworkStack(app, 'TestNetwork');
    const stack = new DataStack(app, 'TestData', { vpc: network.vpc });
    template = Template.fromStack(stack);
  });

  test('DynamoDB table has PITR enabled', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test('S3 buckets block public access', () => {
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('EFS filesystem is encrypted', () => {
    template.hasResourceProperties('AWS::EFS::FileSystem', {
      Encrypted: true,
    });
  });

  test('DynamoDB table has TTL enabled', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });
});
```

#### Level 2: cdk-nag Security Checks

```typescript
// test/security/nag-checks.test.ts
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

test('Platform stacks pass AWS Solutions checks', () => {
  const app = new cdk.App();
  // ... instantiate all stacks ...
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  // Synth will throw if any nag rules fail
  const assembly = app.synth();
  // Check for error-level annotations
  for (const stack of assembly.stacks) {
    const errors = stack.messages.filter(m => m.level === 'error');
    expect(errors).toHaveLength(0);
  }
});
```

#### Level 3: Integration Tests (Post-Deploy)

```typescript
// test/integration/tenant-lifecycle.test.ts
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

describe('Tenant lifecycle integration', () => {
  const ddb = new DynamoDBClient({});
  const s3 = new S3Client({});

  test('New tenant has config in DynamoDB', async () => {
    const result = await ddb.send(new GetItemCommand({
      TableName: 'chimera-platform',
      Key: {
        PK: { S: 'TENANT#test-tenant' },
        SK: { S: 'CONFIG' },
      },
    }));
    expect(result.Item).toBeDefined();
    expect(result.Item!.model_id.S).toContain('claude');
  });

  test('Tenant S3 prefix exists with default skills', async () => {
    const result = await s3.send(new HeadObjectCommand({
      Bucket: `chimera-tenants-${process.env.ACCOUNT_ID}-${process.env.REGION}`,
      Key: 'tenants/test-tenant/system-prompt.md',
    }));
    expect(result.$metadata.httpStatusCode).toBe(200);
  });

  test('Agent endpoint responds to health check', async () => {
    const response = await fetch(`${process.env.AGENT_ENDPOINT}/health`);
    expect(response.status).toBe(200);
  });
});
```

---

## 8. Monitoring & Alerting Infrastructure

### CloudWatch Dashboard Hierarchy

```
Platform Dashboard (platform team)
  +-- Agent Runtime: invocations, latency p50/p95/p99, errors, throttles
  +-- Infrastructure: ECS CPU/memory, DynamoDB consumed capacity, S3 request rates
  +-- Cost: daily spend by service, projected monthly cost
  +-- Security: WAF blocked requests, failed auth attempts, Cedar policy denials

Per-Tenant Dashboard (tenant admin + platform team)
  +-- Agent Metrics: invocations, latency, token usage, tool call counts
  +-- Cron Jobs: execution status, duration, last success time
  +-- Budget: current month spend vs. limit, projected overage
  +-- Errors: agent errors, tool failures, model timeouts
```

### Alarm Hierarchy

| Alarm | Threshold | Action |
|-------|-----------|--------|
| Platform Error Rate | > 1% of invocations for 5 min | PagerDuty + Slack #platform-alerts |
| Platform Latency (p99) | > 60s for 10 min | Slack #platform-alerts |
| DynamoDB Throttles | > 0 for 5 min | Slack + auto-switch to on-demand if provisioned |
| Tenant Budget Exceeded | > 90% of monthly limit | Slack DM to tenant admin |
| Tenant Budget Critical | > 100% of monthly limit | Disable non-essential cron jobs |
| Cron Job Failure | 3 consecutive failures | Slack notification to tenant |
| AgentCore Runtime Health | Unhealthy for 3 min | PagerDuty (prod), Slack (staging) |
| NAT Gateway ErrorPort | > 0 for 5 min | Slack #platform-alerts |

---

## 9. Disaster Recovery & Backup

### RPO/RTO Targets

| Component | RPO | RTO | Backup Method |
|-----------|-----|-----|---------------|
| DynamoDB (tenant config, sessions) | 0 (continuous) | < 5 min | PITR + on-demand backups |
| S3 (skills, memory, artifacts) | 0 (versioned) | < 15 min | Cross-region replication |
| AgentCore Runtime config | 0 (in Git) | < 30 min | Redeploy from pipeline |
| EFS (workspaces) | 1 hour | < 1 hour | AWS Backup |
| Cognito (user pool) | N/A (managed) | < 15 min | Export/import user pool |

### Backup Automation

```typescript
// lib/constructs/backup.ts
import * as backup from 'aws-cdk-lib/aws-backup';

const plan = new backup.BackupPlan(this, 'ChimeraBackup', {
  backupPlanName: 'chimera-daily',
});

plan.addRule(backup.BackupPlanRule.daily());
plan.addRule(new backup.BackupPlanRule({
  ruleName: 'weekly-retention',
  scheduleExpression: events.Schedule.cron({ weekDay: 'SUN', hour: '3', minute: '0' }),
  deleteAfter: cdk.Duration.days(90),
  moveToColdStorageAfter: cdk.Duration.days(30),
}));

// Protect DynamoDB and EFS
plan.addSelection('DataResources', {
  resources: [
    backup.BackupResource.fromDynamoDbTable(platformTable),
    backup.BackupResource.fromEfsFileSystem(agentWorkspace),
  ],
});
```

### Cross-Region S3 Replication

```typescript
// In DataStack, add replication to DR region
const drBucket = new s3.Bucket(this, 'TenantBucketDR', {
  bucketName: `chimera-tenants-${this.account}-${drRegion}`,
  // ... same config as primary
});

// Replication rule on primary bucket (L1 construct for fine control)
const cfnBucket = this.tenantBucket.node.defaultChild as s3.CfnBucket;
cfnBucket.replicationConfiguration = {
  role: replicationRole.roleArn,
  rules: [{
    status: 'Enabled',
    destination: { bucket: drBucket.bucketArn },
    filter: { prefix: 'tenants/' },
  }],
};
```

---

## 10. Multi-Region Deployment

### Active-Passive Pattern (Recommended for v1)

```
Primary: us-west-2
  - All stacks deployed
  - All tenants active
  - Full monitoring

Secondary: us-east-1 (warm standby)
  - NetworkStack deployed (VPC ready)
  - DataStack deployed (DynamoDB global tables, S3 replication)
  - SecurityStack deployed (Cognito replicated)
  - PlatformRuntimeStack NOT deployed (deploy on failover)
  - TenantStacks NOT deployed (deploy on failover)
```

### DynamoDB Global Tables for Multi-Region

```typescript
// DataStack modification for multi-region
const platformTable = new dynamodb.Table(this, 'PlatformTable', {
  tableName: 'chimera-platform',
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  replicationRegions: ['us-east-1'],  // Global tables for DR
  pointInTimeRecovery: true,
});
```

### Failover Procedure

1. Route 53 health check detects primary region failure
2. DNS failover to secondary region ALB
3. Pipeline deploys PlatformRuntimeStack and TenantStacks to secondary (pre-synthesized, stored in S3)
4. AgentCore Runtime starts in secondary region
5. DynamoDB global tables already have tenant data
6. S3 cross-region replication provides skills and artifacts

Estimated failover time: **15-30 minutes** (dominated by AgentCore Runtime startup).

---

## 11. Monorepo Directory Structure

```
chimera/
  |
  +-- bin/
  |     app.ts                    # CDK app entry point
  |
  +-- lib/
  |     +-- stacks/
  |     |     network-stack.ts
  |     |     data-stack.ts
  |     |     security-stack.ts
  |     |     observability-stack.ts
  |     |     platform-runtime-stack.ts
  |     |     chat-stack.ts
  |     |     pipeline-stack.ts
  |     |     tenant-stack.ts
  |     |
  |     +-- constructs/           # L3 constructs used within stacks
  |     |     tenant-agent.ts
  |     |     agent-observability.ts
  |     |     tenant-cron.ts
  |     |     tenant-memory.ts
  |     |     backup.ts
  |     |
  |     +-- config/
  |           environments.ts     # Per-environment config (account IDs, regions, feature flags)
  |
  +-- agent-code/                 # Strands agent source (deployed to AgentCore Runtime)
  |     main.py
  |     requirements.txt
  |     Dockerfile
  |     tools/
  |       manage_infrastructure.py
  |       manage_schedule.py
  |     tests/
  |       test_agent.py
  |
  +-- tenants/                    # Tenant YAML configs (GitOps source of truth)
  |     acme.yaml
  |     globex.yaml
  |     initech.yaml
  |
  +-- skills/                     # Global platform skills (SKILL.md format)
  |     code-review/
  |       SKILL.md
  |       mcp-server/
  |     email-reader/
  |       SKILL.md
  |
  +-- policies/                   # Cedar policies
  |     tenant-defaults.cedar
  |     skill-access.cedar
  |     infra-modification.cedar
  |
  +-- test/
  |     +-- unit/                 # CDK assertion tests
  |     |     stacks/
  |     |       data-stack.test.ts
  |     |       network-stack.test.ts
  |     |       tenant-stack.test.ts
  |     +-- security/             # cdk-nag + policy tests
  |     |     nag-checks.test.ts
  |     |     cedar-policy.test.ts
  |     +-- integration/          # Post-deploy integration tests
  |     |     tenant-lifecycle.test.ts
  |     |     agent-invocation.test.ts
  |     |     cron-execution.test.ts
  |     +-- e2e/                  # End-to-end multi-tenant tests
  |           multi-tenant-isolation.test.ts
  |           chat-delivery.test.ts
  |
  +-- packages/
  |     +-- cdk-constructs/       # Published L3 construct library (@chimera/cdk-constructs)
  |           src/
  |             tenant-agent.ts
  |             agent-observability.ts
  |             index.ts
  |           package.json
  |           tsconfig.json
  |
  +-- docs/
  |     architecture.md
  |     runbook.md
  |     tenant-onboarding.md
  |
  +-- cdk.json
  +-- package.json
  +-- tsconfig.json
  +-- jest.config.ts
  +-- .eslintrc.js
```

---

## 12. Critical Gaps and Recommendations

### Gap 1: No Network Layer in Synthesis

The synthesis document jumps straight to AgentCore and DynamoDB without defining VPC topology, subnets, or VPC endpoints. **Every other stack depends on networking.** The NetworkStack must be the first thing deployed.

**Recommendation:** Deploy NetworkStack as shown above. Use VPC endpoints for DynamoDB, S3, Bedrock, ECR, and CloudWatch to reduce NAT costs and latency.

### Gap 2: No Canary Deployment for Agent Runtime

Agent behavior changes are non-deterministic. A code change in the Strands agent or a model version update can cause subtle regressions that unit tests won't catch. The synthesis mentions no progressive deployment strategy.

**Recommendation:** Use AgentCore's versioned endpoints. Deploy new versions to a `canary` endpoint receiving 5% of traffic. Monitor error rate and latency for 30 minutes. Promote to `production` endpoint only after bake period passes.

### Gap 3: Self-Modifying IaC Lacks Concurrency Control

The synthesis's `manage_infrastructure` tool can be invoked by multiple agents (or the same agent multiple times) creating conflicting Git branches and PRs.

**Recommendation:** Implement the two-phase commit pattern above with per-tenant PR locking (one open infra PR per tenant at a time).

### Gap 4: No Cost Controls in IaC

The synthesis mentions per-tenant budget limits but doesn't enforce them in infrastructure. A tenant could configure 10 cron jobs running Opus 4.6 every hour and burn through budget.

**Recommendation:** Enforce budget ceilings at three levels:
1. **IaC validation:** Reject tenant YAML changes that would exceed budget (estimated via cost model)
2. **Runtime:** AgentCore session budget limit (`max_budget_usd` per invocation)
3. **Monthly:** CloudWatch alarm triggers Lambda to disable cron jobs when 90% budget is consumed

### Gap 5: No Drift Detection

The synthesis mentions drift detection in passing but provides no implementation.

**Recommendation:** Schedule a daily CodeBuild job that runs `cdk diff` against each deployed stack and alerts on unexpected drift:

```yaml
# buildspec-drift-detection.yml
version: 0.2
phases:
  build:
    commands:
      - npx cdk diff --all 2>&1 | tee drift-report.txt
      - |
        if grep -q "Resources$" drift-report.txt; then
          aws sns publish --topic-arn $ALERT_TOPIC \
            --subject "Chimera Drift Detected" \
            --message file://drift-report.txt
        fi
```

---

## Summary

The synthesis provides a strong conceptual foundation but needs the concrete stack decomposition, pipeline design, and safety guardrails outlined in this review to be production-ready. The most critical next steps are:

1. **Implement the 8-stack CDK structure** with explicit cross-stack dependencies
2. **Build the deployment pipeline** with canary bake and manual approval gates
3. **Harden `manage_infrastructure`** with two-phase commit and concurrency control
4. **Add infrastructure tests** at all three levels from day one
5. **Deploy NetworkStack first** -- everything else depends on it

---

*Review completed 2026-03-19 by Platform Engineering agent.*
