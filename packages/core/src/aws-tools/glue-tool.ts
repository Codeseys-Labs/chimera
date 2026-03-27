/**
 * AWS Glue Tool - ETL and data catalog management for agents (Strands format)
 *
 * Operations:
 * - glue_get_databases: List Glue Data Catalog databases
 * - glue_get_tables: List tables in a database
 * - glue_get_table: Get table metadata and schema
 * - glue_start_job_run: Start an ETL job run
 * - glue_get_job_run: Get job run status and metrics
 * - glue_get_crawler: Get crawler configuration and status
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  GlueClient,
  GetDatabasesCommand,
  GetTablesCommand,
  GetTableCommand,
  StartJobRunCommand,
  GetJobRunCommand,
  GetCrawlerCommand,
} from '@aws-sdk/client-glue';
import type { AWSClientFactory } from './client-factory';
import { retryWithBackoff, formatToolError, GLUE_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create Glue Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of Glue tools for Strands Agent
 */
export function createGlueTools(clientFactory: AWSClientFactory) {
  const getDatabases = tool({
    name: 'glue_get_databases',
    description: 'List AWS Glue Data Catalog databases',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      catalogId: z.string().optional().describe('Catalog ID (defaults to account ID)'),
      maxResults: z.number().optional().describe('Maximum number of results'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const glue = await clientFactory.getGlueClient(context);

        const command = new GetDatabasesCommand({
          CatalogId: input.catalogId,
          MaxResults: input.maxResults,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => glue.send(command), GLUE_RETRYABLE_ERRORS);

        const databases = (response.DatabaseList ?? []).map((db) => ({
          name: db.Name!,
          description: db.Description,
          locationUri: db.LocationUri,
          createTime: db.CreateTime?.toISOString(),
        }));

        return JSON.stringify({
          success: true,
          data: {
            databases,
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

  const getTables = tool({
    name: 'glue_get_tables',
    description: 'List tables in an AWS Glue Data Catalog database',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      databaseName: z.string().describe('Database name'),
      catalogId: z.string().optional().describe('Catalog ID (defaults to account ID)'),
      expression: z.string().optional().describe('Filter expression for table names'),
      maxResults: z.number().optional().describe('Maximum number of results'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const glue = await clientFactory.getGlueClient(context);

        const command = new GetTablesCommand({
          DatabaseName: input.databaseName,
          CatalogId: input.catalogId,
          Expression: input.expression,
          MaxResults: input.maxResults,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => glue.send(command), GLUE_RETRYABLE_ERRORS);

        const tables = (response.TableList ?? []).map((table) => ({
          name: table.Name!,
          databaseName: table.DatabaseName!,
          description: table.Description,
          storageDescriptor: table.StorageDescriptor ? {
            location: table.StorageDescriptor.Location,
            inputFormat: table.StorageDescriptor.InputFormat,
            outputFormat: table.StorageDescriptor.OutputFormat,
            compressed: table.StorageDescriptor.Compressed,
            numberOfBuckets: table.StorageDescriptor.NumberOfBuckets,
          } : undefined,
          partitionKeys: table.PartitionKeys?.map((key) => ({
            name: key.Name,
            type: key.Type,
          })),
          tableType: table.TableType,
          createTime: table.CreateTime?.toISOString(),
          updateTime: table.UpdateTime?.toISOString(),
        }));

        return JSON.stringify({
          success: true,
          data: {
            tables,
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

  const getTable = tool({
    name: 'glue_get_table',
    description: 'Get detailed table metadata and schema from AWS Glue Data Catalog',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      databaseName: z.string().describe('Database name'),
      tableName: z.string().describe('Table name'),
      catalogId: z.string().optional().describe('Catalog ID (defaults to account ID)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const glue = await clientFactory.getGlueClient(context);

        const command = new GetTableCommand({
          DatabaseName: input.databaseName,
          Name: input.tableName,
          CatalogId: input.catalogId,
        });

        const response = await retryWithBackoff(() => glue.send(command), GLUE_RETRYABLE_ERRORS);

        const table = response.Table;
        return JSON.stringify({
          success: true,
          data: {
            name: table?.Name,
            databaseName: table?.DatabaseName,
            description: table?.Description,
            owner: table?.Owner,
            createTime: table?.CreateTime?.toISOString(),
            updateTime: table?.UpdateTime?.toISOString(),
            tableType: table?.TableType,
            storageDescriptor: table?.StorageDescriptor ? {
              location: table.StorageDescriptor.Location,
              inputFormat: table.StorageDescriptor.InputFormat,
              outputFormat: table.StorageDescriptor.OutputFormat,
              compressed: table.StorageDescriptor.Compressed,
              columns: table.StorageDescriptor.Columns?.map((col) => ({
                name: col.Name,
                type: col.Type,
                comment: col.Comment,
              })),
            } : undefined,
            partitionKeys: table?.PartitionKeys?.map((key) => ({
              name: key.Name,
              type: key.Type,
              comment: key.Comment,
            })),
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

  const startJobRun = tool({
    name: 'glue_start_job_run',
    description: 'Start an AWS Glue ETL job run with optional arguments',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      jobName: z.string().describe('Glue job name'),
      arguments: z.record(z.string()).optional().describe('Job arguments (key-value pairs)'),
      timeout: z.number().optional().describe('Job timeout in minutes'),
      maxCapacity: z.number().optional().describe('Number of DPUs to allocate'),
      numberOfWorkers: z.number().optional().describe('Number of workers (for G.1X/G.2X worker types)'),
      workerType: z.enum(['Standard', 'G.1X', 'G.2X', 'G.025X']).optional().describe('Worker type'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const glue = await clientFactory.getGlueClient(context);

        const command = new StartJobRunCommand({
          JobName: input.jobName,
          Arguments: input.arguments,
          Timeout: input.timeout,
          MaxCapacity: input.maxCapacity,
          NumberOfWorkers: input.numberOfWorkers,
          WorkerType: input.workerType,
        });

        const response = await retryWithBackoff(() => glue.send(command), GLUE_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            jobRunId: response.JobRunId!,
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

  const getJobRun = tool({
    name: 'glue_get_job_run',
    description: 'Get AWS Glue ETL job run status, metrics, and error details',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      jobName: z.string().describe('Glue job name'),
      runId: z.string().describe('Job run ID'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const glue = await clientFactory.getGlueClient(context);

        const command = new GetJobRunCommand({
          JobName: input.jobName,
          RunId: input.runId,
        });

        const response = await retryWithBackoff(() => glue.send(command), GLUE_RETRYABLE_ERRORS);

        const jobRun = response.JobRun;
        return JSON.stringify({
          success: true,
          data: {
            id: jobRun?.Id,
            jobName: jobRun?.JobName,
            jobRunState: jobRun?.JobRunState,
            startedOn: jobRun?.StartedOn?.toISOString(),
            completedOn: jobRun?.CompletedOn?.toISOString(),
            executionTime: jobRun?.ExecutionTime,
            errorMessage: jobRun?.ErrorMessage,
            maxCapacity: jobRun?.MaxCapacity,
            numberOfWorkers: jobRun?.NumberOfWorkers,
            workerType: jobRun?.WorkerType,
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

  const getCrawler = tool({
    name: 'glue_get_crawler',
    description: 'Get AWS Glue crawler configuration and status',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      name: z.string().describe('Crawler name'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const glue = await clientFactory.getGlueClient(context);

        const command = new GetCrawlerCommand({
          Name: input.name,
        });

        const response = await retryWithBackoff(() => glue.send(command), GLUE_RETRYABLE_ERRORS);

        const crawler = response.Crawler;
        return JSON.stringify({
          success: true,
          data: {
            name: crawler?.Name,
            role: crawler?.Role,
            databaseName: crawler?.DatabaseName,
            state: crawler?.State,
            creationTime: crawler?.CreationTime?.toISOString(),
            lastUpdated: crawler?.LastUpdated?.toISOString(),
            lastCrawl: crawler?.LastCrawl ? {
              status: crawler.LastCrawl.Status,
              startTime: crawler.LastCrawl.StartTime?.toISOString(),
              errorMessage: crawler.LastCrawl.ErrorMessage,
            } : undefined,
            schedule: crawler?.Schedule ? {
              scheduleExpression: crawler.Schedule.ScheduleExpression,
              state: crawler.Schedule.State,
            } : undefined,
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

  return [
    getDatabases,
    getTables,
    getTable,
    startJobRun,
    getJobRun,
    getCrawler,
  ];
}
