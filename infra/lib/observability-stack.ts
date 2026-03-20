import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
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
  public readonly platformDashboard: cloudwatch.Dashboard;
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
        }),
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
        }),
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
        }),
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
        operations: [dynamodb.Operation.GET_ITEM, dynamodb.Operation.QUERY, dynamodb.Operation.SCAN],
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      // Write throttles
      const writeThrottles = table.metricThrottledRequestsForOperations({
        operations: [dynamodb.Operation.PUT_ITEM, dynamodb.Operation.UPDATE_ITEM, dynamodb.Operation.DELETE_ITEM],
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      ddbWidgets.push(
        new cloudwatch.GraphWidget({
          title: `${name} - Throttles`,
          left: [readThrottles, writeThrottles],
          width: 12,
          leftYAxis: { min: 0 },
        }),
      );

      // Create alarm for throttles (>=10 throttled requests in 5 min indicates capacity issue)
      const throttleAlarm = new cloudwatch.Alarm(this, `${name}ThrottleAlarm`, {
        alarmName: `chimera-${props.envName}-${name.toLowerCase()}-throttles`,
        alarmDescription: `DynamoDB ${name} table experiencing throttles (>=10 in 5min)`,
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
      throttleAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));
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
      }),
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
      }),
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
      }),
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

    const apiErrorRateAlarm = new cloudwatch.Alarm(this, 'ApiErrorRateAlarm', {
      alarmName: `chimera-${props.envName}-api-error-rate`,
      alarmDescription: 'API 5xx error rate exceeds 5% (indicates platform degradation)',
      metric: apiErrorRate,
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    apiErrorRateAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));

    // Cost Anomaly Detection alarm
    // Tracks monthly spend in cost-tracking table via custom metric filter
    // Triggers when tenant exceeds tier quota by 20%
    const costAnomalyMetric = new cloudwatch.Metric({
      namespace: 'Chimera/Billing',
      metricName: 'TenantCostAnomaly',
      statistic: 'Maximum',
      period: cdk.Duration.hours(1),
    });

    const costAnomalyAlarm = new cloudwatch.Alarm(this, 'CostAnomalyAlarm', {
      alarmName: `chimera-${props.envName}-cost-anomaly`,
      alarmDescription: 'Tenant cost exceeded tier quota by 20% (requires investigation)',
      metric: costAnomalyMetric,
      threshold: 1.2, // 120% of tier quota
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    costAnomalyAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(this.alarmTopic));

    // ======================================================================
    // Stack Outputs
    // ======================================================================
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      exportName: `${this.stackName}-AlarmTopicArn`,
      description: 'SNS topic ARN for CloudWatch alarms',
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.platformDashboard.dashboardName}`,
      exportName: `${this.stackName}-DashboardUrl`,
      description: 'CloudWatch dashboard URL',
    });

    new cdk.CfnOutput(this, 'DashboardName', {
      value: this.platformDashboard.dashboardName,
      exportName: `${this.stackName}-DashboardName`,
      description: 'CloudWatch dashboard name',
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
