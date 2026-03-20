/**
 * AWS CloudWatch Tool - Monitoring and logging for agents
 *
 * Operations:
 * - put_metric_data: Publish custom metrics
 * - start_query: Execute CloudWatch Logs Insights queries
 * - get_query_results: Retrieve query results
 * - put_metric_alarm: Create metric-based alarms
 * - describe_alarms: Query alarm status
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import {
  CloudWatchClient,
  PutMetricDataCommand,
  PutMetricAlarmCommand,
  DescribeAlarmsCommand,
  type ComparisonOperator,
  type Statistic,
  type StateValue,
  type StandardUnit,
} from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
  type QueryStatus,
} from '@aws-sdk/client-cloudwatch-logs';
import type { AWSClientFactory } from './client-factory';
import type { AWSToolContext, AWSToolResult } from './types';

/**
 * Metric data point
 */
export interface MetricDataPoint {
  metricName: string;
  value?: number;
  values?: number[];
  counts?: number[];
  timestamp?: Date;
  dimensions?: Array<{ name: string; value: string }>;
  unit?: StandardUnit;
  storageResolution?: number; // 1 or 60 seconds
}

/**
 * Configuration for publishing metrics
 */
export interface PutMetricDataConfig {
  namespace: string;
  metricData: MetricDataPoint[];
}

/**
 * Configuration for starting a logs query
 */
export interface StartQueryConfig {
  logGroupNames: string[];
  startTime: number; // Unix timestamp (seconds)
  endTime: number; // Unix timestamp (seconds)
  queryString: string; // CloudWatch Logs Insights query
  limit?: number;
}

/**
 * Configuration for creating a metric alarm
 */
export interface PutMetricAlarmConfig {
  alarmName: string;
  comparisonOperator: ComparisonOperator;
  evaluationPeriods: number;
  metricName: string;
  namespace: string;
  period: number; // Seconds
  statistic: Statistic;
  threshold: number;
  actionsEnabled?: boolean;
  alarmActions?: string[]; // SNS topic ARNs
  alarmDescription?: string;
  dimensions?: Array<{ name: string; value: string }>;
  treatMissingData?: 'breaching' | 'notBreaching' | 'ignore' | 'missing';
}

/**
 * Configuration for describing alarms
 */
export interface DescribeAlarmsConfig {
  alarmNames?: string[];
  stateValue?: StateValue;
  maxRecords?: number;
  nextToken?: string;
}

/**
 * AWS CloudWatch Tool
 */
export class CloudWatchTool {
  constructor(private clientFactory: AWSClientFactory) {}

  /**
   * Publish custom metric data
   */
  async putMetricData(
    context: AWSToolContext,
    config: PutMetricDataConfig
  ): Promise<AWSToolResult<void>> {
    const startTime = Date.now();

    try {
      const cloudwatch = await this.clientFactory.getCloudWatchClient(context);

      // Transform metric data
      const metricData = config.metricData.map((metric) => ({
        MetricName: metric.metricName,
        Value: metric.value,
        Values: metric.values,
        Counts: metric.counts,
        Timestamp: metric.timestamp,
        Dimensions: metric.dimensions?.map((dim) => ({
          Name: dim.name,
          Value: dim.value,
        })),
        Unit: metric.unit,
        StorageResolution: metric.storageResolution,
      }));

      const command = new PutMetricDataCommand({
        Namespace: config.namespace,
        MetricData: metricData,
      });

      await this.retryWithBackoff(() => cloudwatch.send(command));

      return {
        success: true,
        metadata: {
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * Start a CloudWatch Logs Insights query
   */
  async startQuery(
    context: AWSToolContext,
    config: StartQueryConfig
  ): Promise<
    AWSToolResult<{
      queryId: string;
    }>
  > {
    const startTime = Date.now();

    try {
      const logs = await this.clientFactory.getCloudWatchLogsClient(context);

      const command = new StartQueryCommand({
        logGroupNames: config.logGroupNames,
        startTime: config.startTime,
        endTime: config.endTime,
        queryString: config.queryString,
        limit: config.limit,
      });

      const response = await this.retryWithBackoff(() => logs.send(command));

      if (!response.queryId) {
        throw new Error('No queryId returned from StartQuery');
      }

      return {
        success: true,
        data: {
          queryId: response.queryId,
        },
        metadata: {
          requestId: response.$metadata.requestId,
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * Get CloudWatch Logs Insights query results
   */
  async getQueryResults(
    context: AWSToolContext,
    queryId: string
  ): Promise<
    AWSToolResult<{
      status: QueryStatus;
      results?: Array<Array<{ field: string; value: string }>>;
      statistics?: {
        recordsMatched: number;
        recordsScanned: number;
        bytesScanned: number;
      };
    }>
  > {
    const startTime = Date.now();

    try {
      const logs = await this.clientFactory.getCloudWatchLogsClient(context);

      const command = new GetQueryResultsCommand({
        queryId,
      });

      const response = await this.retryWithBackoff(() => logs.send(command));

      // Transform results
      const results = response.results?.map((result) =>
        result.map((field) => ({
          field: field.field ?? '',
          value: field.value ?? '',
        }))
      );

      return {
        success: true,
        data: {
          status: response.status!,
          results,
          statistics: response.statistics
            ? {
                recordsMatched: response.statistics.recordsMatched ?? 0,
                recordsScanned: response.statistics.recordsScanned ?? 0,
                bytesScanned: response.statistics.bytesScanned ?? 0,
              }
            : undefined,
        },
        metadata: {
          requestId: response.$metadata.requestId,
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * Create a metric alarm
   */
  async putMetricAlarm(
    context: AWSToolContext,
    config: PutMetricAlarmConfig
  ): Promise<AWSToolResult<void>> {
    const startTime = Date.now();

    try {
      const cloudwatch = await this.clientFactory.getCloudWatchClient(context);

      const command = new PutMetricAlarmCommand({
        AlarmName: config.alarmName,
        ComparisonOperator: config.comparisonOperator,
        EvaluationPeriods: config.evaluationPeriods,
        MetricName: config.metricName,
        Namespace: config.namespace,
        Period: config.period,
        Statistic: config.statistic,
        Threshold: config.threshold,
        ActionsEnabled: config.actionsEnabled,
        AlarmActions: config.alarmActions,
        AlarmDescription: config.alarmDescription,
        Dimensions: config.dimensions?.map((dim) => ({
          Name: dim.name,
          Value: dim.value,
        })),
        TreatMissingData: config.treatMissingData,
      });

      await this.retryWithBackoff(() => cloudwatch.send(command));

      return {
        success: true,
        metadata: {
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * Describe CloudWatch alarms
   */
  async describeAlarms(
    context: AWSToolContext,
    config?: DescribeAlarmsConfig
  ): Promise<
    AWSToolResult<{
      metricAlarms: Array<{
        alarmName: string;
        stateValue: string;
        stateReason: string;
        alarmArn: string;
        actionsEnabled: boolean;
      }>;
      nextToken?: string;
    }>
  > {
    const startTime = Date.now();

    try {
      const cloudwatch = await this.clientFactory.getCloudWatchClient(context);

      const command = new DescribeAlarmsCommand({
        AlarmNames: config?.alarmNames,
        StateValue: config?.stateValue,
        MaxRecords: config?.maxRecords,
        NextToken: config?.nextToken,
      });

      const response = await this.retryWithBackoff(() =>
        cloudwatch.send(command)
      );

      const metricAlarms = (response.MetricAlarms ?? []).map((alarm: any) => ({
        alarmName: alarm.AlarmName!,
        stateValue: alarm.StateValue!,
        stateReason: alarm.StateReason ?? '',
        alarmArn: alarm.AlarmArn!,
        actionsEnabled: alarm.ActionsEnabled ?? false,
      }));

      return {
        success: true,
        data: {
          metricAlarms,
          nextToken: response.NextToken,
        },
        metadata: {
          requestId: response.$metadata.requestId,
          region: context.region ?? 'us-east-1',
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error: any) {
      return this.handleError(error, context, startTime);
    }
  }

  /**
   * Retry with exponential backoff and jitter
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        const errorName = error.name;
        const retryableErrors = [
          'ThrottlingException',
          'ServiceUnavailableException',
          'InternalServiceException',
          'TimeoutError',
        ];

        if (retryableErrors.includes(errorName) && attempt < maxRetries) {
          // Exponential backoff with jitter
          const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
          await this.sleep(delay);
        } else {
          throw error;
        }
      }
    }

    throw new Error('Unexpected: all retries exhausted');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Error handler with retryability detection
   */
  private handleError(
    error: any,
    context: AWSToolContext,
    startTime: number
  ): AWSToolResult<any> {
    const retryableErrors = [
      'ThrottlingException',
      'ServiceUnavailableException',
      'InternalServiceException',
      'TimeoutError',
    ];

    return {
      success: false,
      error: {
        message: error.message ?? 'Unknown error',
        code: error.name ?? 'UnknownError',
        retryable: retryableErrors.includes(error.name),
      },
      metadata: {
        region: context.region ?? 'us-east-1',
        durationMs: Date.now() - startTime,
      },
    };
  }
}
