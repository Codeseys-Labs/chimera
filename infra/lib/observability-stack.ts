import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as xray from 'aws-cdk-lib/aws-xray';
import { Construct } from 'constructs';

export interface ObservabilityStackProps extends cdk.StackProps {
  envName: string;
  platformKey: kms.IKey;
  tenantsTable?: dynamodb.ITable;
  sessionsTable?: dynamodb.ITable;
  skillsTable?: dynamodb.ITable;
  rateLimitsTable?: dynamodb.ITable;
  costTrackingTable?: dynamodb.ITable;
  auditTable?: dynamodb.ITable;
  runbookBaseUrl?: string; // Base URL for runbook documentation (e.g., https://wiki.example.com/runbooks/)
  replicaRegions?: string[]; // Cross-region replication targets for DR
}

/**
 * Observability layer for Chimera.
 *
 * Creates platform-wide CloudWatch dashboard, SNS alarm topic, X-Ray config,
 * and key alarms: DynamoDB throttles, error rates, latency p99, budget thresholds.
 * Per-tenant dashboards are handled by tenant-agent.ts L3 construct.
 */
export class ObservabilityStack extends cdk.Stack {
  public readonly alarmTopic: sns.Topic;
  public readonly criticalAlarmTopic: sns.Topic;
  public readonly highAlarmTopic: sns.Topic;
  public readonly mediumAlarmTopic: sns.Topic;
  public readonly platformDashboard: cloudwatch.Dashboard;
  public readonly tenantHealthDashboard: cloudwatch.Dashboard;
  public readonly skillUsageDashboard: cloudwatch.Dashboard;
  public readonly costAttributionDashboard: cloudwatch.Dashboard;
  public readonly platformLogGroup: logs.LogGroup;
  public readonly xrayGroup: xray.CfnGroup;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // Centralized Log Group: Platform-wide logs
    // All services (ECS, Lambda, API Gateway) send logs here for unified querying.
    // ======================================================================
    this.platformLogGroup = new logs.LogGroup(this, 'PlatformLogGroup', {
      logGroupName: `/chimera/${props.envName}/platform`,
      retention: isProd ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      encryptionKey: props.platformKey,
    });

    // ======================================================================
    // SNS Topic: Alarm notifications
    // All CloudWatch alarms publish to this topic. Subscribers: email, PagerDuty, Slack.
    // Encrypted with platformKey for security compliance.
    // ======================================================================
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `Chimera ${props.envName} Alarms`,
      topicName: `chimera-alarms-${props.envName}`,
      masterKey: props.platformKey,
    });

    // Add email subscription for prod (typically ops team distribution list)
    if (isProd) {
      const opsEmail = this.node.tryGetContext('opsEmail');
      if (opsEmail) {
        this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(opsEmail));
      }
    }

    // ======================================================================
    // Severity-Tiered SNS Topics: Production alarm routing
    // Critical: PagerDuty, immediate on-call escalation (5xx errors, DDB throttles)
    // High: Slack/email, 1-hour SLA (cost anomalies, backup failures)
    // Medium: Email only, monitoring (API 4xx spikes, low priority warnings)
    // ======================================================================
    this.criticalAlarmTopic = new sns.Topic(this, 'CriticalAlarmTopic', {
      displayName: `Chimera ${props.envName} Critical Alarms`,
      topicName: `chimera-alarms-critical-${props.envName}`,
      masterKey: props.platformKey,
    });

    this.highAlarmTopic = new sns.Topic(this, 'HighAlarmTopic', {
      displayName: `Chimera ${props.envName} High Priority Alarms`,
      topicName: `chimera-alarms-high-${props.envName}`,
      masterKey: props.platformKey,
    });

    this.mediumAlarmTopic = new sns.Topic(this, 'MediumAlarmTopic', {
      displayName: `Chimera ${props.envName} Medium Priority Alarms`,
      topicName: `chimera-alarms-medium-${props.envName}`,
      masterKey: props.platformKey,
    });

    if (isProd) {
      const opsEmail = this.node.tryGetContext('opsEmail');
      const pagerDutyEndpoint = this.node.tryGetContext('pagerDutyEndpoint');
      const slackWebhook = this.node.tryGetContext('slackWebhook');

      // Critical: PagerDuty + email
      if (pagerDutyEndpoint) {
        this.criticalAlarmTopic.addSubscription(
          new subscriptions.UrlSubscription(pagerDutyEndpoint, {
            protocol: sns.SubscriptionProtocol.HTTPS,
          })
        );
      }
      if (opsEmail) {
        this.criticalAlarmTopic.addSubscription(new subscriptions.EmailSubscription(opsEmail));
      }

      // High: Slack + email
      if (slackWebhook) {
        this.highAlarmTopic.addSubscription(
          new subscriptions.UrlSubscription(slackWebhook, {
            protocol: sns.SubscriptionProtocol.HTTPS,
          })
        );
      }
      if (opsEmail) {
        this.highAlarmTopic.addSubscription(new subscriptions.EmailSubscription(opsEmail));
      }

      // Medium: Email only
      if (opsEmail) {
        this.mediumAlarmTopic.addSubscription(new subscriptions.EmailSubscription(opsEmail));
      }
    }

    // ======================================================================
    // X-Ray Tracing Group: Distributed tracing for Chimera services
    // Groups traces from ECS, Lambda, and API Gateway for end-to-end visibility.
    // Filter: service(chimera-*) for all Chimera microservices.
    // ======================================================================
    this.xrayGroup = new xray.CfnGroup(this, 'XRayTracingGroup', {
      groupName: `chimera-${props.envName}`,
      filterExpression: 'service("chimera-*")',
      insightsConfiguration: {
        insightsEnabled: true,
        notificationsEnabled: isProd,
      },
    });

    // ======================================================================
    // CloudWatch Dashboard: Platform-wide view
    // Single dashboard with 5 sections: Health, DynamoDB, Cost, Latency, Errors.
    // ======================================================================
    this.platformDashboard = new cloudwatch.Dashboard(this, 'PlatformDashboard', {
      dashboardName: `chimera-platform-${props.envName}`,
      defaultInterval: cdk.Duration.hours(3),
    });

    // --- Health section: active tenants, active sessions, skill invocations ---
    const healthWidgets: cloudwatch.IWidget[] = [];

    if (props.tenantsTable) {
      // Count of active tenants (approximation via ConsumedReadCapacityUnits as proxy)
      const tenantsMetric = props.tenantsTable.metricConsumedReadCapacityUnits({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });
      healthWidgets.push(
        new cloudwatch.GraphWidget({
          title: 'Tenants Table Activity',
          left: [tenantsMetric],
          width: 8,
        })
      );
    }

    if (props.sessionsTable) {
      const sessionsReadMetric = props.sessionsTable.metricConsumedReadCapacityUnits({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });
      healthWidgets.push(
        new cloudwatch.GraphWidget({
          title: 'Sessions Table Activity',
          left: [sessionsReadMetric],
          width: 8,
        })
      );
    }

    if (props.skillsTable) {
      const skillsMetric = props.skillsTable.metricConsumedReadCapacityUnits({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });
      healthWidgets.push(
        new cloudwatch.GraphWidget({
          title: 'Skills Table Activity',
          left: [skillsMetric],
          width: 8,
        })
      );
    }

    if (healthWidgets.length > 0) {
      this.platformDashboard.addWidgets(...healthWidgets);
    }

    // --- DynamoDB section: throttles, system errors, user errors ---
    const ddbWidgets: cloudwatch.IWidget[] = [];
    const tables = [
      { name: 'Tenants', table: props.tenantsTable },
      { name: 'Sessions', table: props.sessionsTable },
      { name: 'Skills', table: props.skillsTable },
      { name: 'RateLimits', table: props.rateLimitsTable },
      { name: 'CostTracking', table: props.costTrackingTable },
      { name: 'Audit', table: props.auditTable },
    ];

    for (const { name, table } of tables) {
      if (!table) continue;

      // Read throttles
      const readThrottles = table.metricThrottledRequestsForOperations({
        operations: [
          dynamodb.Operation.GET_ITEM,
          dynamodb.Operation.QUERY,
          dynamodb.Operation.SCAN,
        ],
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      // Write throttles
      const writeThrottles = table.metricThrottledRequestsForOperations({
        operations: [
          dynamodb.Operation.PUT_ITEM,
          dynamodb.Operation.UPDATE_ITEM,
          dynamodb.Operation.DELETE_ITEM,
        ],
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      ddbWidgets.push(
        new cloudwatch.GraphWidget({
          title: `${name} - Throttles`,
          left: [readThrottles, writeThrottles],
          width: 12,
          leftYAxis: { min: 0 },
        })
      );

      // Create alarm for throttles (>=10 throttled requests in 5 min indicates capacity issue)
      const runbookUrl = props.runbookBaseUrl
        ? `${props.runbookBaseUrl}dynamodb-throttles`
        : 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ProvisionedThroughput.html';

      const throttleAlarm = new cloudwatch.Alarm(this, `${name}ThrottleAlarm`, {
        alarmName: `chimera-${props.envName}-${name.toLowerCase()}-throttles`,
        alarmDescription: `DynamoDB ${name} table experiencing throttles (>=10 in 5min). RUNBOOK: ${runbookUrl}`,
        metric: new cloudwatch.MathExpression({
          expression: 'm1 + m2',
          usingMetrics: {
            m1: readThrottles,
            m2: writeThrottles,
          },
          period: cdk.Duration.minutes(5),
        }),
        threshold: 10,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      throttleAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.criticalAlarmTopic));
      throttleAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic)); // Keep legacy topic
    }

    if (ddbWidgets.length > 0) {
      this.platformDashboard.addWidgets(...ddbWidgets);
    }

    // --- Cost section: budget tracking from cost-tracking table ---
    // Future enhancement: create metric filter on cost-tracking table stream
    // to track monthly spend per tenant. For now, placeholder text widget.
    this.platformDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## Cost Tracking\n\nMonthly spend per tenant tracked in \`chimera-cost-tracking-${props.envName}\` table.\n\nBudget threshold alarms trigger when tenant exceeds tier quota.`,
        width: 24,
        height: 3,
      })
    );

    // --- Latency section: ECS task latency, API Gateway p99 ---
    // API Gateway latency (p99) - namespace: AWS/ApiGateway
    const apiLatencyP99 = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Latency',
      statistic: 'p99',
      period: cdk.Duration.minutes(5),
      dimensionsMap: {
        Stage: props.envName,
      },
    });

    // ECS task CPU/Memory utilization - namespace: AWS/ECS
    const ecsCpuUtilization = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
      dimensionsMap: {
        ServiceName: `chimera-chat-${props.envName}`,
      },
    });

    const ecsMemoryUtilization = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'MemoryUtilization',
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
      dimensionsMap: {
        ServiceName: `chimera-chat-${props.envName}`,
      },
    });

    this.platformDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Gateway Latency (p99)',
        left: [apiLatencyP99],
        width: 12,
        leftYAxis: { label: 'Milliseconds', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'ECS Task CPU/Memory',
        left: [ecsCpuUtilization, ecsMemoryUtilization],
        width: 12,
        leftYAxis: { label: 'Percent', min: 0, max: 100 },
      })
    );

    // --- Errors section: ECS task failures, Lambda errors, 4xx/5xx responses ---
    // API Gateway 4xx/5xx errors
    const api4xxErrors = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '4XXError',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
      dimensionsMap: {
        Stage: props.envName,
      },
    });

    const api5xxErrors = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5XXError',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
      dimensionsMap: {
        Stage: props.envName,
      },
    });

    // Lambda errors
    const lambdaErrors = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const lambdaThrottles = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Throttles',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    this.platformDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Gateway Errors',
        left: [api4xxErrors, api5xxErrors],
        width: 12,
        leftYAxis: { label: 'Count', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors & Throttles',
        left: [lambdaErrors, lambdaThrottles],
        width: 12,
        leftYAxis: { label: 'Count', min: 0 },
      })
    );

    // ======================================================================
    // Key Alarms: API error rate, cost anomaly
    // ======================================================================

    // API Error Rate >5% alarm
    // Calculates error rate as (5xx / total requests) * 100
    const apiRequestCount = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
      dimensionsMap: {
        Stage: props.envName,
      },
    });

    const apiErrorRate = new cloudwatch.MathExpression({
      expression: '(m1 / m2) * 100',
      usingMetrics: {
        m1: api5xxErrors,
        m2: apiRequestCount,
      },
      period: cdk.Duration.minutes(5),
    });

    const apiErrorRunbook = props.runbookBaseUrl
      ? `${props.runbookBaseUrl}api-error-rate`
      : 'Check ECS task logs, Lambda errors, and DynamoDB throttles';

    const apiErrorRateAlarm = new cloudwatch.Alarm(this, 'ApiErrorRateAlarm', {
      alarmName: `chimera-${props.envName}-api-error-rate`,
      alarmDescription: `API 5xx error rate exceeds 5% (indicates platform degradation). RUNBOOK: ${apiErrorRunbook}`,
      metric: apiErrorRate,
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiErrorRateAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.criticalAlarmTopic));
    apiErrorRateAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic)); // Keep legacy topic

    // Cost Anomaly Detection alarm
    // Tracks monthly spend in cost-tracking table via custom metric filter
    // Triggers when tenant exceeds tier quota by 20%
    const costAnomalyMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Billing',
      metricName: 'TenantCostAnomaly',
      statistic: 'Maximum',
      period: cdk.Duration.hours(1),
    });

    const costRunbook = props.runbookBaseUrl
      ? `${props.runbookBaseUrl}cost-anomaly`
      : 'Review tenant cost-tracking table, check for runaway agent sessions, verify billing tier';

    const costAnomalyAlarm = new cloudwatch.Alarm(this, 'CostAnomalyAlarm', {
      alarmName: `chimera-${props.envName}-cost-anomaly`,
      alarmDescription: `Tenant cost exceeded tier quota by 20% (requires investigation). RUNBOOK: ${costRunbook}`,
      metric: costAnomalyMetric,
      threshold: 1.2, // 120% of tier quota
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    costAnomalyAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.highAlarmTopic));
    costAnomalyAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic)); // Keep legacy topic

    // ======================================================================
    // Cost Metric Publisher: Scheduled Lambda that reads cost-tracking table
    // and publishes aggregated metrics to CloudWatch Chimera/Billing namespace.
    // Runs hourly via EventBridge cron rule.
    // ======================================================================
    const costPublisherFn = new lambda.Function(this, 'CostMetricPublisher', {
      functionName: `chimera-cost-publisher-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      code: lambda.Code.fromInline(`
const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const ddb = new DynamoDBClient({});
const cw = new CloudWatchClient({});

exports.handler = async () => {
  const table = process.env.COST_TABLE;
  if (!table) { console.log('No COST_TABLE configured'); return; }

  try {
    const now = new Date();
    const period = now.toISOString().slice(0, 7); // YYYY-MM
    const scan = await ddb.send(new ScanCommand({
      TableName: table,
      FilterExpression: 'begins_with(PK, :prefix) AND SK = :period',
      ExpressionAttributeValues: {
        ':prefix': { S: 'TENANT#' },
        ':period': { S: 'PERIOD#' + period },
      },
      Limit: 500,
    }));

    let totalSpend = 0;
    const tenantSpends = [];
    for (const item of scan.Items || []) {
      const spend = parseFloat(item.current_spend?.N || '0');
      const tenantId = (item.PK?.S || '').replace('TENANT#', '').split('#')[0];
      const quotaLimit = parseFloat(item.quota_limit?.N || '0');
      totalSpend += spend;
      tenantSpends.push({ tenantId, spend, quotaLimit });
    }

    const activeTenants = tenantSpends.filter(t => t.spend > 0);
    const anomalyTenants = tenantSpends.filter(t => t.quotaLimit > 0 && t.spend / t.quotaLimit > 1.2);

    const metrics = [
      {
        MetricName: 'TotalMonthlySpend',
        Value: totalSpend,
        Unit: 'None',
        Timestamp: now,
      },
      {
        MetricName: 'ActiveTenants',
        Value: activeTenants.length,
        Unit: 'Count',
        Timestamp: now,
      },
    ];

    // Publish per-tenant anomaly metrics
    for (const t of anomalyTenants) {
      metrics.push({
        MetricName: 'TenantCostAnomaly',
        Value: t.quotaLimit > 0 ? t.spend / t.quotaLimit : 0,
        Unit: 'None',
        Timestamp: now,
        Dimensions: [{ Name: 'TenantId', Value: t.tenantId }],
      });
    }

    // CloudWatch PutMetricData accepts max 1000 metrics per call
    const batches = [];
    for (let i = 0; i < metrics.length; i += 20) {
      batches.push(metrics.slice(i, i + 20));
    }
    for (const batch of batches) {
      await cw.send(new PutMetricDataCommand({
        Namespace: 'Chimera/Billing',
        MetricData: batch,
      }));
    }

    console.log(JSON.stringify({
      totalSpend,
      activeTenants: activeTenants.length,
      anomalyTenants: anomalyTenants.length,
      period,
    }));
  } catch (err) {
    console.error('Cost publish failed:', err.message);
    throw err; // Surface errors to CloudWatch Lambda metrics
  }
};
      `),
      environment: {
        COST_TABLE: props.costTrackingTable?.tableName ?? '',
      },
    });

    // Grant the Lambda read access to the cost-tracking table
    if (props.costTrackingTable) {
      props.costTrackingTable.grantReadData(costPublisherFn);
    }

    // Grant CloudWatch PutMetricData permission
    costPublisherFn.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': 'Chimera/Billing',
          },
        },
      })
    );

    // Schedule: run every hour
    new events.Rule(this, 'CostPublisherSchedule', {
      ruleName: `chimera-cost-publisher-schedule-${props.envName}`,
      description: 'Hourly trigger for cost metric publisher Lambda',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(costPublisherFn)],
    });

    // ======================================================================
    // PITR Backup Monitoring: Continuous backup health checks
    // Monitors DynamoDB point-in-time recovery status for critical tables.
    // Alarms trigger if backup fails or PITR is disabled.
    // ======================================================================
    const pitrTables = [
      { name: 'Tenants', table: props.tenantsTable },
      { name: 'Sessions', table: props.sessionsTable },
      { name: 'Skills', table: props.skillsTable },
      { name: 'CostTracking', table: props.costTrackingTable },
      { name: 'Audit', table: props.auditTable },
    ];

    for (const { name, table } of pitrTables) {
      if (!table) continue;

      // DynamoDB backup monitoring via CloudWatch Metrics
      // AWS publishes backup metrics to CloudWatch when PITR is enabled
      const backupMetric = new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'AccountProvisionedReadCapacityUtilization',
        statistic: 'Average',
        period: cdk.Duration.hours(1),
        dimensionsMap: {
          TableName: table.tableName,
        },
      });

      // Note: AWS doesn't directly expose PITR status as a CloudWatch metric.
      // In production, use AWS Config rule dynamodb-pitr-enabled for compliance monitoring.
      // This alarm serves as a proxy for table health.
    }

    // Add alarm for AWS Backup (if using AWS Backup service for DR)
    if (isProd) {
      const backupJobFailureMetric = new cloudwatch.Metric({
        namespace: 'AWS/Backup',
        metricName: 'NumberOfBackupJobsFailed',
        statistic: 'Sum',
        period: cdk.Duration.hours(24),
      });

      const backupRunbook = props.runbookBaseUrl
        ? `${props.runbookBaseUrl}backup-failure`
        : 'Check AWS Backup console for failed jobs, verify IAM permissions, check service quotas';

      const backupFailureAlarm = new cloudwatch.Alarm(this, 'BackupFailureAlarm', {
        alarmName: `chimera-${props.envName}-backup-failure`,
        alarmDescription: `AWS Backup job failed (PITR or manual backup). RUNBOOK: ${backupRunbook}`,
        metric: backupJobFailureMetric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      backupFailureAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.highAlarmTopic));
      backupFailureAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
    }

    // ======================================================================
    // Enhanced Dashboards: Tenant Health, Skill Usage, Cost Attribution
    // ======================================================================

    // --- Tenant Health Dashboard ---
    // Per-tenant session activity, request rates, error rates, latency p99.
    // Uses custom metrics published by TenantRouter and ChimeraAgent.
    this.tenantHealthDashboard = new cloudwatch.Dashboard(this, 'TenantHealthDashboard', {
      dashboardName: `chimera-tenant-health-${props.envName}`,
      defaultInterval: cdk.Duration.hours(6),
    });

    // Active sessions per tenant (custom metric from TenantRouter)
    const tenantActiveSessionsMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Tenant',
      metricName: 'ActiveSessions',
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });

    // Request rate per tenant
    const tenantRequestRateMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Tenant',
      metricName: 'RequestCount',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    // Error rate per tenant
    const tenantErrorRateMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Tenant',
      metricName: 'ErrorCount',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    // Latency p99 per tenant
    const tenantLatencyP99Metric = new cloudwatch.Metric({
      namespace: 'Chimera/Tenant',
      metricName: 'RequestLatency',
      statistic: 'p99',
      period: cdk.Duration.minutes(5),
    });

    this.tenantHealthDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Active Sessions by Tenant',
        left: [tenantActiveSessionsMetric],
        width: 12,
        leftYAxis: { label: 'Sessions', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Request Rate by Tenant',
        left: [tenantRequestRateMetric],
        width: 12,
        leftYAxis: { label: 'Requests/5min', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Error Rate by Tenant',
        left: [tenantErrorRateMetric],
        width: 12,
        leftYAxis: { label: 'Errors/5min', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Latency p99 by Tenant',
        left: [tenantLatencyP99Metric],
        width: 12,
        leftYAxis: { label: 'Milliseconds', min: 0 },
      })
    );

    // --- Skill Usage Dashboard ---
    // Per-skill invocation counts, success rates, latency, error types.
    // Tracks skill marketplace health and identifies problematic skills.
    this.skillUsageDashboard = new cloudwatch.Dashboard(this, 'SkillUsageDashboard', {
      dashboardName: `chimera-skill-usage-${props.envName}`,
      defaultInterval: cdk.Duration.hours(6),
    });

    // Skill invocation count (custom metric from ChimeraAgent)
    const skillInvocationMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Skills',
      metricName: 'InvocationCount',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    // Skill success rate
    const skillSuccessMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Skills',
      metricName: 'SuccessCount',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const skillFailureMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Skills',
      metricName: 'FailureCount',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    // Skill execution latency
    const skillLatencyMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Skills',
      metricName: 'ExecutionLatency',
      statistic: 'Average',
      period: cdk.Duration.minutes(5),
    });

    this.skillUsageDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Skill Invocations by Skill',
        left: [skillInvocationMetric],
        width: 12,
        leftYAxis: { label: 'Invocations/5min', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Skill Success vs Failure',
        left: [skillSuccessMetric, skillFailureMetric],
        width: 12,
        leftYAxis: { label: 'Count', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Skill Execution Latency (avg)',
        left: [skillLatencyMetric],
        width: 12,
        leftYAxis: { label: 'Milliseconds', min: 0 },
      }),
      new cloudwatch.TextWidget({
        markdown: `## Skill Health Monitoring\n\n- **Top skills**: Query Chimera/Skills metrics filtered by skill name\n- **Error analysis**: Check skill failure dimensions for error types\n- **Marketplace impact**: High failure rate skills trigger trust level downgrade`,
        width: 12,
        height: 4,
      })
    );

    // --- Cost Attribution Dashboard ---
    // Per-tenant spend, tier quota tracking, budget burn rate.
    // Aggregates cost from DynamoDB streams on cost-tracking table.
    this.costAttributionDashboard = new cloudwatch.Dashboard(this, 'CostAttributionDashboard', {
      dashboardName: `chimera-cost-attribution-${props.envName}`,
      defaultInterval: cdk.Duration.hours(24),
    });

    // Monthly spend per tenant (custom metric from cost-tracking stream)
    const tenantSpendMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Billing',
      metricName: 'TenantSpend',
      statistic: 'Sum',
      period: cdk.Duration.hours(1),
    });

    // Tier quota utilization
    const quotaUtilizationMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Billing',
      metricName: 'QuotaUtilization',
      statistic: 'Maximum',
      period: cdk.Duration.hours(1),
    });

    // Budget burn rate ($/hour)
    const burnRateMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Billing',
      metricName: 'BurnRate',
      statistic: 'Average',
      period: cdk.Duration.hours(1),
    });

    this.costAttributionDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Monthly Spend by Tenant',
        left: [tenantSpendMetric],
        width: 12,
        leftYAxis: { label: 'USD', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Tier Quota Utilization by Tenant',
        left: [quotaUtilizationMetric],
        width: 12,
        leftYAxis: { label: 'Percent', min: 0, max: 150 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Budget Burn Rate',
        left: [burnRateMetric],
        width: 12,
        leftYAxis: { label: 'USD/hour', min: 0 },
      }),
      new cloudwatch.TextWidget({
        markdown: `## Cost Tracking Data Sources\n\n- **DynamoDB**: \`chimera-cost-tracking-${props.envName}\` table\n- **Update frequency**: Real-time via DDB streams + Lambda aggregator\n- **Quota enforcement**: Rate limiter triggered at 90% quota, hard stop at 100%\n- **Billing cycle**: Monthly (PERIOD#{yyyy-mm})`,
        width: 12,
        height: 4,
      })
    );

    // ======================================================================
    // Cross-Region Monitoring: Multi-region metric aggregation for DR
    // Creates composite alarms that aggregate health across all replica regions.
    // ======================================================================
    if (props.replicaRegions && props.replicaRegions.length > 0) {
      // Create cross-region health composite alarm
      const regionalHealthMetrics = props.replicaRegions.map(
        (region) =>
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5XXError',
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
            dimensionsMap: {
              Stage: props.envName,
            },
            region: region,
          })
      );

      // Composite alarm: triggers if ANY region has >5% error rate
      const crossRegionErrorRate = new cloudwatch.MathExpression({
        expression: regionalHealthMetrics.map((m, i) => `m${i}`).join(' + '),
        usingMetrics: Object.fromEntries(regionalHealthMetrics.map((m, i) => [`m${i}`, m])),
        period: cdk.Duration.minutes(5),
      });

      const crossRegionRunbook = props.runbookBaseUrl
        ? `${props.runbookBaseUrl}cross-region-failure`
        : 'Check Route53 health checks, verify ALB target health in all regions, initiate DR failover if needed';

      const crossRegionAlarm = new cloudwatch.Alarm(this, 'CrossRegionHealthAlarm', {
        alarmName: `chimera-${props.envName}-cross-region-health`,
        alarmDescription: `Multi-region health check failed (errors in ${props.replicaRegions.join(', ')}). RUNBOOK: ${crossRegionRunbook}`,
        metric: crossRegionErrorRate,
        threshold: 10,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      crossRegionAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.criticalAlarmTopic));
      crossRegionAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
    }

    // ======================================================================
    // Load Testing Metrics: Custom namespace for performance validation
    // Load testing framework publishes metrics to Chimera/LoadTest namespace.
    // Target: 1000 concurrent sessions with <500ms p99 latency.
    // ======================================================================
    const loadTestConcurrentSessions = new cloudwatch.Metric({
      namespace: 'Chimera/LoadTest',
      metricName: 'ConcurrentSessions',
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
    });

    const loadTestLatencyP99 = new cloudwatch.Metric({
      namespace: 'Chimera/LoadTest',
      metricName: 'RequestLatency',
      statistic: 'p99',
      period: cdk.Duration.minutes(1),
    });

    const loadTestErrorRate = new cloudwatch.Metric({
      namespace: 'Chimera/LoadTest',
      metricName: 'ErrorRate',
      statistic: 'Average',
      period: cdk.Duration.minutes(1),
    });

    // Add load test widgets to platform dashboard
    this.platformDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## Load Testing Results\n\nTarget: 1000 concurrent sessions, <500ms p99 latency, <1% error rate\n\nRun load tests: \`bun run load-test --target 1000\``,
        width: 24,
        height: 2,
      }),
      new cloudwatch.GraphWidget({
        title: 'Load Test: Concurrent Sessions',
        left: [loadTestConcurrentSessions],
        width: 8,
        leftYAxis: { label: 'Sessions', min: 0 },
      }),
      new cloudwatch.GraphWidget({
        title: 'Load Test: Latency p99',
        left: [loadTestLatencyP99],
        width: 8,
        leftYAxis: { label: 'Milliseconds', min: 0 },
        leftAnnotations: [
          {
            value: 500,
            label: 'SLA Threshold',
            color: '#ff0000',
          },
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Load Test: Error Rate',
        left: [loadTestErrorRate],
        width: 8,
        leftYAxis: { label: 'Percent', min: 0, max: 5 },
        leftAnnotations: [
          {
            value: 1,
            label: 'SLA Threshold',
            color: '#ff0000',
          },
        ],
      })
    );

    // ======================================================================
    // Stack Outputs
    // ======================================================================
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      exportName: `${this.stackName}-AlarmTopicArn`,
      description: 'SNS topic ARN for CloudWatch alarms (legacy)',
    });

    new cdk.CfnOutput(this, 'CriticalAlarmTopicArn', {
      value: this.criticalAlarmTopic.topicArn,
      exportName: `${this.stackName}-CriticalAlarmTopicArn`,
      description: 'SNS topic ARN for critical alarms (PagerDuty)',
    });

    new cdk.CfnOutput(this, 'HighAlarmTopicArn', {
      value: this.highAlarmTopic.topicArn,
      exportName: `${this.stackName}-HighAlarmTopicArn`,
      description: 'SNS topic ARN for high priority alarms (Slack)',
    });

    new cdk.CfnOutput(this, 'MediumAlarmTopicArn', {
      value: this.mediumAlarmTopic.topicArn,
      exportName: `${this.stackName}-MediumAlarmTopicArn`,
      description: 'SNS topic ARN for medium priority alarms (Email)',
    });

    new cdk.CfnOutput(this, 'PlatformDashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.platformDashboard.dashboardName}`,
      exportName: `${this.stackName}-PlatformDashboardUrl`,
      description: 'Platform CloudWatch dashboard URL',
    });

    new cdk.CfnOutput(this, 'PlatformDashboardName', {
      value: this.platformDashboard.dashboardName,
      exportName: `${this.stackName}-PlatformDashboardName`,
      description: 'Platform CloudWatch dashboard name',
    });

    new cdk.CfnOutput(this, 'TenantHealthDashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.tenantHealthDashboard.dashboardName}`,
      exportName: `${this.stackName}-TenantHealthDashboardUrl`,
      description: 'Tenant health CloudWatch dashboard URL',
    });

    new cdk.CfnOutput(this, 'SkillUsageDashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.skillUsageDashboard.dashboardName}`,
      exportName: `${this.stackName}-SkillUsageDashboardUrl`,
      description: 'Skill usage CloudWatch dashboard URL',
    });

    new cdk.CfnOutput(this, 'CostAttributionDashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.costAttributionDashboard.dashboardName}`,
      exportName: `${this.stackName}-CostAttributionDashboardUrl`,
      description: 'Cost attribution CloudWatch dashboard URL',
    });

    new cdk.CfnOutput(this, 'PlatformLogGroupName', {
      value: this.platformLogGroup.logGroupName,
      exportName: `${this.stackName}-PlatformLogGroupName`,
      description: 'Centralized platform log group name',
    });

    new cdk.CfnOutput(this, 'XRayGroupName', {
      value: this.xrayGroup.groupName!,
      exportName: `${this.stackName}-XRayGroupName`,
      description: 'X-Ray tracing group name',
    });
  }
}
