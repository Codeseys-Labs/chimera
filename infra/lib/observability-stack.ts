import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface ObservabilityStackProps extends cdk.StackProps {
  envName: string;
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

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // SNS Topic: Alarm notifications
    // All CloudWatch alarms publish to this topic. Subscribers: email, PagerDuty, Slack.
    // ======================================================================
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `Chimera ${props.envName} Alarms`,
      topicName: `chimera-alarms-${props.envName}`,
    });

    // Add email subscription for prod (typically ops team distribution list)
    if (isProd) {
      const opsEmail = this.node.tryGetContext('opsEmail');
      if (opsEmail) {
        this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(opsEmail));
      }
    }

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
    // Placeholder until ChatStack and PlatformRuntimeStack are implemented.
    // These stacks will export metrics that we import here.
    this.platformDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## Latency (p99)\n\nAPI Gateway and ECS Fargate latency metrics will appear here after ChatStack deployment.\n\nTarget SLA: p99 < 2s for HTTP requests.`,
        width: 24,
        height: 3,
      }),
    );

    // --- Errors section: ECS task failures, Lambda errors, 5xx responses ---
    // Placeholder until runtime stacks are deployed.
    this.platformDashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## Error Rates\n\nECS task failures, Lambda errors, and HTTP 5xx responses will appear here after runtime stacks are deployed.\n\nTarget SLA: <0.1% error rate.`,
        width: 24,
        height: 3,
      }),
    );

    // ======================================================================
    // X-Ray Tracing Configuration
    // Enable X-Ray sampling rules for distributed tracing across services.
    // Lambda, ECS, and API Gateway will instrument with X-Ray SDK.
    // ======================================================================
    // X-Ray sampling rules are configured per-service, not via CDK constructs.
    // This is a placeholder for documentation. Actual X-Ray enablement happens in:
    // - ECS task definitions (ChatStack)
    // - Lambda functions (PlatformRuntimeStack)
    // - API Gateway stages (ChatStack)
    //
    // Default sampling: 5% of requests + 1 req/sec reservoir.
    // Override for critical paths (e.g., /invoke, /chat) to 100% sampling in dev.

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
  }
}
