import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * Configuration for a single cron job on a tenant's agent.
 */
export interface TenantCronJobConfig {
  /** Human-readable job name (used in resource naming) */
  name: string;
  /** EventBridge cron expression, e.g. "cron(0 8 ? * MON-FRI *)" */
  schedule: string;
  /** S3 key for the prompt template */
  promptKey: string;
  /** Skills required for this job */
  skills: string[];
  /** Max budget per invocation in USD */
  maxBudgetUsd: number;
  /** S3 prefix for job output */
  outputPrefix: string;
}

/**
 * Props for the TenantAgent L3 construct.
 */
export interface TenantAgentProps {
  /** Unique tenant identifier (alphanumeric + hyphens) */
  tenantId: string;
  /** Tenant tier controls model access and resource isolation */
  tier: 'basic' | 'pro' | 'enterprise';
  /** Environment name for resource naming */
  envName: string;
  /** Cron jobs to schedule for this tenant */
  cronJobs?: TenantCronJobConfig[];
  /** Monthly budget limit in USD -- triggers alarm at 90% */
  budgetLimitMonthlyUsd?: number;

  // Shared infrastructure references
  tenantsTable: dynamodb.ITable;
  sessionsTable: dynamodb.ITable;
  skillsTable: dynamodb.ITable;
  rateLimitsTable: dynamodb.ITable;
  costTrackingTable: dynamodb.ITable;
  auditTable: dynamodb.ITable;
  tenantBucket: s3.IBucket;
  skillsBucket: s3.IBucket;
  userPool: cognito.IUserPool;
  eventBus: events.IEventBus;
  alarmTopic: sns.ITopic;
}

/**
 * L3 construct that provisions all per-tenant resources:
 * - Scoped IAM role (DynamoDB partition + S3 prefix isolation)
 * - Cognito group for the tenant's users
 * - EventBridge rules for cron jobs (-> Step Functions)
 * - CloudWatch dashboard with tenant-specific metrics
 * - Budget alarm at 90% of monthly limit
 */
export class TenantAgent extends Construct {
  public readonly tenantRole: iam.Role;
  public readonly tenantGroup: cognito.CfnUserPoolGroup;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: TenantAgentProps) {
    super(scope, id);

    const { tenantId, tier, envName } = props;
    const isProd = envName === 'prod';
    const stack = cdk.Stack.of(this);

    // ======================================================================
    // IAM Role: Tenant-scoped agent runtime role
    // Assumed by Bedrock (AgentCore) on behalf of this tenant.
    // DynamoDB: read/write on all 6 tables, but DENY on partitions
    //   that don't match TENANT#{tenantId}.
    // S3: read/write on tenants/{tenantId}/*, read on skills/global/*
    //   and skills/tenant/{tenantId}/*.
    // Bedrock: model access based on tier.
    // Secrets Manager: only chimera/{tenantId}/*.
    // ======================================================================
    this.tenantRole = new iam.Role(this, 'TenantRole', {
      roleName: `chimera-tenant-${tenantId}-${envName}`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: `Chimera tenant role for ${tenantId} (${tier})`,
    });

    // Grant DynamoDB read/write on all 6 tables
    const tables = [
      props.tenantsTable,
      props.sessionsTable,
      props.skillsTable,
      props.rateLimitsTable,
      props.costTrackingTable,
      props.auditTable,
    ];
    for (const table of tables) {
      table.grantReadWriteData(this.tenantRole);
    }

    // DENY access to other tenants' DynamoDB partitions.
    // LeadingKeys condition ensures all accessed items start with this tenant's prefix.
    this.tenantRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['dynamodb:*'],
      resources: [
        ...tables.map(t => t.tableArn),
        ...tables.map(t => `${t.tableArn}/index/*`),
      ],
      conditions: {
        'ForAllValues:StringNotLike': {
          'dynamodb:LeadingKeys': [`TENANT#${tenantId}*`],
        },
      },
    }));

    // S3: tenant data bucket -- scoped to this tenant's prefix
    props.tenantBucket.grantReadWrite(this.tenantRole, `tenants/${tenantId}/*`);

    // S3: skills bucket -- read global skills + this tenant's custom skills
    props.skillsBucket.grantRead(this.tenantRole, 'skills/global/*');
    props.skillsBucket.grantRead(this.tenantRole, `skills/tenant/${tenantId}/*`);

    // Bedrock: model access varies by tier
    const modelPatterns = this.getModelPatternsForTier(tier);
    this.tenantRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: modelPatterns.map(
        p => `arn:aws:bedrock:${stack.region}::foundation-model/${p}`,
      ),
    }));

    // Secrets Manager: tenant-scoped secrets only
    this.tenantRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:chimera/${tenantId}/*`,
      ],
    }));

    // ======================================================================
    // Cognito: Tenant user group
    // Users in this group get the tenant_id claim in their JWT.
    // ======================================================================
    this.tenantGroup = new cognito.CfnUserPoolGroup(this, 'TenantGroup', {
      userPoolId: props.userPool.userPoolId,
      groupName: `tenant-${tenantId}`,
      description: `Users for tenant ${tenantId} (${tier} tier)`,
      roleArn: this.tenantRole.roleArn,
    });

    // ======================================================================
    // Cron Jobs: EventBridge Scheduler -> Step Functions
    // Each cron job creates a minimal Step Functions state machine and
    // an EventBridge rule that triggers it on schedule.
    // ======================================================================
    for (const job of props.cronJobs ?? []) {
      this.createCronJob(props, job);
    }

    // ======================================================================
    // Observability: Per-tenant CloudWatch dashboard
    // Shows errors, latency, token usage, and cost metrics
    // scoped to this tenant via the TenantId dimension.
    // ======================================================================
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `Chimera-Tenant-${tenantId}-${envName}`,
    });

    const tenantDims = { TenantId: tenantId };

    const errorMetric = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'Errors',
      dimensionsMap: tenantDims,
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });
    const latencyMetric = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'InvocationDuration',
      dimensionsMap: tenantDims,
      statistic: 'p99',
      period: cdk.Duration.minutes(5),
    });
    const tokenMetric = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'TokensUsed',
      dimensionsMap: tenantDims,
      statistic: 'Sum',
      period: cdk.Duration.hours(1),
    });
    const costMetric = new cloudwatch.Metric({
      namespace: 'AgentPlatform',
      metricName: 'CostAccumulated',
      dimensionsMap: tenantDims,
      statistic: 'Maximum',
      period: cdk.Duration.hours(1),
    });

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: `${tenantId} - Errors (5min)`,
        left: [errorMetric],
        width: 6,
      }),
      new cloudwatch.GraphWidget({
        title: `${tenantId} - Latency p99 (5min)`,
        left: [latencyMetric],
        width: 6,
      }),
      new cloudwatch.GraphWidget({
        title: `${tenantId} - Tokens/hr`,
        left: [tokenMetric],
        width: 6,
      }),
      new cloudwatch.SingleValueWidget({
        title: `${tenantId} - Monthly Cost ($)`,
        metrics: [costMetric],
        width: 6,
      }),
    );

    // ======================================================================
    // Budget alarm: fires at 90% of the tenant's monthly budget limit
    // ======================================================================
    if (props.budgetLimitMonthlyUsd) {
      const budgetAlarm = new cloudwatch.Alarm(this, 'BudgetAlarm', {
        metric: costMetric,
        threshold: props.budgetLimitMonthlyUsd * 0.9,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription:
          `Tenant ${tenantId} has reached 90% of $${props.budgetLimitMonthlyUsd} monthly budget`,
      });
      budgetAlarm.addAlarmAction({
        bind: () => ({ alarmActionArn: props.alarmTopic.topicArn }),
      });
    }

    // Apply tenant tags to all resources in this construct
    cdk.Tags.of(this).add('TenantId', tenantId);
    cdk.Tags.of(this).add('TenantTier', tier);
  }

  /**
   * Returns Bedrock model ARN patterns allowed for the given tier.
   * basic: Haiku + Nova Lite only (cost control)
   * pro: Sonnet + Haiku + all Nova models
   * enterprise: All Claude + all Nova models
   */
  private getModelPatternsForTier(tier: string): string[] {
    switch (tier) {
      case 'basic':
        return [
          'anthropic.claude-haiku-*',
          'amazon.nova-lite-*',
        ];
      case 'pro':
        return [
          'anthropic.claude-sonnet-*',
          'anthropic.claude-haiku-*',
          'amazon.nova-*',
        ];
      case 'enterprise':
        return [
          'anthropic.claude-*',
          'amazon.nova-*',
        ];
      default:
        return ['anthropic.claude-haiku-*'];
    }
  }

  /**
   * Creates a cron job as an EventBridge rule + Step Functions state machine.
   * The state machine is a placeholder Pass state for Phase 0 -- in later phases
   * it will chain: LoadPrompt -> InvokeAgent -> WriteOutput -> Notify.
   */
  private createCronJob(props: TenantAgentProps, job: TenantCronJobConfig): void {
    const { tenantId, envName } = props;

    // Step Functions state machine -- placeholder for Phase 0.
    // The Pass state captures the job configuration as output.
    const startState = new sfn.Pass(this, `${job.name}-Start`, {
      parameters: {
        tenantId,
        jobName: job.name,
        promptKey: job.promptKey,
        skills: job.skills,
        maxBudgetUsd: job.maxBudgetUsd,
        outputPrefix: job.outputPrefix,
      },
    });

    const stateMachine = new sfn.StateMachine(this, `${job.name}-SM`, {
      stateMachineName: `chimera-${tenantId}-${job.name}-${envName}`,
      definitionBody: sfn.DefinitionBody.fromChainable(startState),
      timeout: cdk.Duration.minutes(30),
    });

    // EventBridge rule on the custom event bus
    new events.Rule(this, `${job.name}-Schedule`, {
      ruleName: `chimera-${tenantId}-${job.name}-${envName}`,
      schedule: events.Schedule.expression(job.schedule),
      targets: [new targets.SfnStateMachine(stateMachine)],
    });
  }
}
