/**
 * AWS CloudWatch Tool - Monitoring and logging for agents (Strands format)
 *
 * Operations:
 * - cloudwatch_put_metric_data: Publish custom metrics
 * - cloudwatch_start_query: Execute CloudWatch Logs Insights queries
 * - cloudwatch_get_query_results: Retrieve query results
 * - cloudwatch_put_metric_alarm: Create metric-based alarms
 * - cloudwatch_describe_alarms: Query alarm status
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
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
import { retryWithBackoff, formatToolError, CLOUDWATCH_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create CloudWatch Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of CloudWatch tools for Strands Agent
 */
export function createCloudWatchTools(clientFactory: AWSClientFactory) {
  const putMetricData = tool({
    name: 'cloudwatch_put_metric_data',
    description: 'Publish custom metric data to CloudWatch for monitoring and alarming',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      namespace: z.string().describe('Custom namespace for metrics (e.g., MyApp/Production)'),
      metricData: z.array(
        z.object({
          metricName: z.string().describe('Metric name'),
          value: z.number().optional().describe('Single metric value'),
          values: z.array(z.number()).optional().describe('Array of values for statistical set'),
          counts: z.array(z.number()).optional().describe('Array of counts for statistical set'),
          timestamp: z.string().optional().describe('Metric timestamp (ISO 8601)'),
          dimensions: z
            .array(
              z.object({
                name: z.string(),
                value: z.string(),
              })
            )
            .optional()
            .describe('Metric dimensions for filtering'),
          unit: z.string().optional().describe('Unit of measurement (e.g., Count, Seconds, Bytes)'),
          storageResolution: z.number().optional().describe('Storage resolution: 1 (high-res) or 60 (standard)'),
        })
      ).describe('Array of metric data points'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const cloudwatch = await clientFactory.getCloudWatchClient(context);

        // Transform metric data
        const metricData = input.metricData.map((metric) => ({
          MetricName: metric.metricName,
          Value: metric.value,
          Values: metric.values,
          Counts: metric.counts,
          Timestamp: metric.timestamp ? new Date(metric.timestamp) : undefined,
          Dimensions: metric.dimensions?.map((dim) => ({
            Name: dim.name,
            Value: dim.value,
          })),
          Unit: metric.unit as StandardUnit | undefined,
          StorageResolution: metric.storageResolution,
        }));

        const command = new PutMetricDataCommand({
          Namespace: input.namespace,
          MetricData: metricData,
        });

        await retryWithBackoff(() => cloudwatch.send(command), CLOUDWATCH_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          metadata: {
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const startQuery = tool({
    name: 'cloudwatch_start_query',
    description: 'Start a CloudWatch Logs Insights query to analyze log data',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      logGroupNames: z.array(z.string()).describe('Log group names to query'),
      startTime: z.number().describe('Query start time (Unix timestamp in seconds)'),
      endTime: z.number().describe('Query end time (Unix timestamp in seconds)'),
      queryString: z.string().describe('CloudWatch Logs Insights query (e.g., "fields @timestamp, @message | limit 20")'),
      limit: z.number().optional().describe('Maximum number of log events to return'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const logs = await clientFactory.getCloudWatchLogsClient(context);

        const command = new StartQueryCommand({
          logGroupNames: input.logGroupNames,
          startTime: input.startTime,
          endTime: input.endTime,
          queryString: input.queryString,
          limit: input.limit,
        });

        const response = await retryWithBackoff(() => logs.send(command), CLOUDWATCH_RETRYABLE_ERRORS);

        if (!response.queryId) {
          throw new Error('No queryId returned from StartQuery');
        }

        return JSON.stringify({
          success: true,
          data: {
            queryId: response.queryId,
          },
          metadata: {
            requestId: response.$metadata.requestId,
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const getQueryResults = tool({
    name: 'cloudwatch_get_query_results',
    description: 'Retrieve results from a CloudWatch Logs Insights query (poll until status is Complete)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queryId: z.string().describe('Query ID from cloudwatch_start_query'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const logs = await clientFactory.getCloudWatchLogsClient(context);

        const command = new GetQueryResultsCommand({
          queryId: input.queryId,
        });

        const response = await retryWithBackoff(() => logs.send(command), CLOUDWATCH_RETRYABLE_ERRORS);

        // Transform results
        const results = response.results?.map((result) =>
          result.map((field) => ({
            field: field.field ?? '',
            value: field.value ?? '',
          }))
        );

        return JSON.stringify({
          success: true,
          data: {
            status: response.status as QueryStatus,
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
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const putMetricAlarm = tool({
    name: 'cloudwatch_put_metric_alarm',
    description: 'Create or update a CloudWatch metric alarm to trigger actions based on thresholds',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      alarmName: z.string().describe('Alarm name (unique within account)'),
      comparisonOperator: z
        .enum([
          'GreaterThanOrEqualToThreshold',
          'GreaterThanThreshold',
          'LessThanThreshold',
          'LessThanOrEqualToThreshold',
        ])
        .describe('Comparison operator for threshold'),
      evaluationPeriods: z.number().describe('Number of periods to evaluate'),
      metricName: z.string().describe('Metric name to monitor'),
      namespace: z.string().describe('Metric namespace'),
      period: z.number().describe('Period in seconds over which statistic is applied'),
      statistic: z.enum(['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount']).describe('Statistic to apply'),
      threshold: z.number().describe('Threshold value for comparison'),
      actionsEnabled: z.boolean().optional().describe('Enable alarm actions (default: true)'),
      alarmActions: z.array(z.string()).optional().describe('SNS topic ARNs to notify on alarm state'),
      alarmDescription: z.string().optional().describe('Alarm description'),
      dimensions: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
          })
        )
        .optional()
        .describe('Metric dimensions'),
      treatMissingData: z
        .enum(['breaching', 'notBreaching', 'ignore', 'missing'])
        .optional()
        .describe('How to treat missing data points'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const cloudwatch = await clientFactory.getCloudWatchClient(context);

        const command = new PutMetricAlarmCommand({
          AlarmName: input.alarmName,
          ComparisonOperator: input.comparisonOperator as ComparisonOperator,
          EvaluationPeriods: input.evaluationPeriods,
          MetricName: input.metricName,
          Namespace: input.namespace,
          Period: input.period,
          Statistic: input.statistic as Statistic,
          Threshold: input.threshold,
          ActionsEnabled: input.actionsEnabled,
          AlarmActions: input.alarmActions,
          AlarmDescription: input.alarmDescription,
          Dimensions: input.dimensions?.map((dim) => ({
            Name: dim.name,
            Value: dim.value,
          })),
          TreatMissingData: input.treatMissingData,
        });

        await retryWithBackoff(() => cloudwatch.send(command), CLOUDWATCH_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          metadata: {
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const describeAlarms = tool({
    name: 'cloudwatch_describe_alarms',
    description: 'List and query CloudWatch alarms with optional filtering by name or state',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      alarmNames: z.array(z.string()).optional().describe('Specific alarm names to query'),
      stateValue: z.enum(['OK', 'ALARM', 'INSUFFICIENT_DATA']).optional().describe('Filter by alarm state'),
      maxRecords: z.number().optional().describe('Maximum number of alarms to return'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const cloudwatch = await clientFactory.getCloudWatchClient(context);

        const command = new DescribeAlarmsCommand({
          AlarmNames: input.alarmNames,
          StateValue: input.stateValue as StateValue | undefined,
          MaxRecords: input.maxRecords,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => cloudwatch.send(command), CLOUDWATCH_RETRYABLE_ERRORS);

        const metricAlarms = (response.MetricAlarms ?? []).map((alarm: any) => ({
          alarmName: alarm.AlarmName,
          stateValue: alarm.StateValue,
          stateReason: alarm.StateReason ?? '',
          alarmArn: alarm.AlarmArn,
          actionsEnabled: alarm.ActionsEnabled ?? false,
        }));

        return JSON.stringify({
          success: true,
          data: {
            metricAlarms,
            nextToken: response.NextToken,
          },
          metadata: {
            requestId: response.$metadata.requestId,
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  return [putMetricData, startQuery, getQueryResults, putMetricAlarm, describeAlarms];
}

// Legacy config types removed - now defined inline with Zod schemas
