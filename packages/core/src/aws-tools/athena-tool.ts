/**
 * AWS Athena Tool - Serverless SQL query engine for agents (Strands format)
 *
 * Operations:
 * - athena_start_query_execution: Execute SQL query on data in S3
 * - athena_get_query_execution: Get query execution status and statistics
 * - athena_get_query_results: Retrieve query result rows
 * - athena_stop_query_execution: Cancel a running query
 * - athena_list_databases: List databases in Athena data catalog
 * - athena_list_table_metadata: List tables in a database
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StopQueryExecutionCommand,
  ListDatabasesCommand,
  ListTableMetadataCommand,
} from '@aws-sdk/client-athena';
import type { AWSClientFactory } from './client-factory';
import { retryWithBackoff, formatToolError, ATHENA_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create Athena Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of Athena tools for Strands Agent
 */
export function createAthenaTools(clientFactory: AWSClientFactory) {
  const startQueryExecution = tool({
    name: 'athena_start_query_execution',
    description: 'Execute SQL query on data in S3 using AWS Athena serverless query engine',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queryString: z.string().describe('SQL query to execute'),
      database: z.string().optional().describe('Database to use for query'),
      catalog: z.string().optional().describe('Data catalog name (default: AwsDataCatalog)'),
      outputLocation: z.string().describe('S3 location for query results (s3://bucket/path/)'),
      workGroup: z.string().optional().describe('Athena workgroup name'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const athena = await clientFactory.getAthenaClient(context);

        const command = new StartQueryExecutionCommand({
          QueryString: input.queryString,
          QueryExecutionContext: {
            Database: input.database,
            Catalog: input.catalog ?? 'AwsDataCatalog',
          },
          ResultConfiguration: {
            OutputLocation: input.outputLocation,
          },
          WorkGroup: input.workGroup,
        });

        const response = await retryWithBackoff(() => athena.send(command), ATHENA_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            queryExecutionId: response.QueryExecutionId!,
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

  const getQueryExecution = tool({
    name: 'athena_get_query_execution',
    description: 'Get AWS Athena query execution status, statistics, and error details',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queryExecutionId: z.string().describe('Query execution ID from start_query_execution'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const athena = await clientFactory.getAthenaClient(context);

        const command = new GetQueryExecutionCommand({
          QueryExecutionId: input.queryExecutionId,
        });

        const response = await retryWithBackoff(() => athena.send(command), ATHENA_RETRYABLE_ERRORS);

        const execution = response.QueryExecution;
        return JSON.stringify({
          success: true,
          data: {
            queryExecutionId: execution?.QueryExecutionId!,
            query: execution?.Query,
            state: execution?.Status?.State,
            stateChangeReason: execution?.Status?.StateChangeReason,
            submissionDateTime: execution?.Status?.SubmissionDateTime?.toISOString(),
            completionDateTime: execution?.Status?.CompletionDateTime?.toISOString(),
            statistics: execution?.Statistics ? {
              engineExecutionTimeInMillis: execution.Statistics.EngineExecutionTimeInMillis,
              dataScannedInBytes: execution.Statistics.DataScannedInBytes,
              totalExecutionTimeInMillis: execution.Statistics.TotalExecutionTimeInMillis,
            } : undefined,
            outputLocation: execution?.ResultConfiguration?.OutputLocation,
            database: execution?.QueryExecutionContext?.Database,
            catalog: execution?.QueryExecutionContext?.Catalog,
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
    name: 'athena_get_query_results',
    description: 'Retrieve result rows from a completed AWS Athena query',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queryExecutionId: z.string().describe('Query execution ID'),
      maxResults: z.number().optional().describe('Maximum number of rows to return'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const athena = await clientFactory.getAthenaClient(context);

        const command = new GetQueryResultsCommand({
          QueryExecutionId: input.queryExecutionId,
          MaxResults: input.maxResults,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => athena.send(command), ATHENA_RETRYABLE_ERRORS);

        // Extract column names from metadata
        const columns = (response.ResultSet?.ResultSetMetadata?.ColumnInfo ?? []).map((col) => ({
          name: col.Name!,
          type: col.Type!,
        }));

        // Extract rows
        const rows = (response.ResultSet?.Rows ?? []).map((row) =>
          (row.Data ?? []).map((cell) => cell.VarCharValue ?? null)
        );

        return JSON.stringify({
          success: true,
          data: {
            columns,
            rows,
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

  const stopQueryExecution = tool({
    name: 'athena_stop_query_execution',
    description: 'Cancel a running AWS Athena query execution',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queryExecutionId: z.string().describe('Query execution ID to cancel'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const athena = await clientFactory.getAthenaClient(context);

        const command = new StopQueryExecutionCommand({
          QueryExecutionId: input.queryExecutionId,
        });

        await retryWithBackoff(() => athena.send(command), ATHENA_RETRYABLE_ERRORS);

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

  const listDatabases = tool({
    name: 'athena_list_databases',
    description: 'List databases in AWS Athena data catalog',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      catalogName: z.string().describe('Data catalog name (e.g., AwsDataCatalog)'),
      maxResults: z.number().optional().describe('Maximum number of results'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const athena = await clientFactory.getAthenaClient(context);

        const command = new ListDatabasesCommand({
          CatalogName: input.catalogName,
          MaxResults: input.maxResults,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => athena.send(command), ATHENA_RETRYABLE_ERRORS);

        const databases = (response.DatabaseList ?? []).map((db) => ({
          name: db.Name!,
          description: db.Description,
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

  const listTableMetadata = tool({
    name: 'athena_list_table_metadata',
    description: 'List tables in an AWS Athena database',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      catalogName: z.string().describe('Data catalog name'),
      databaseName: z.string().describe('Database name'),
      expression: z.string().optional().describe('Filter expression for table names'),
      maxResults: z.number().optional().describe('Maximum number of results'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const athena = await clientFactory.getAthenaClient(context);

        const command = new ListTableMetadataCommand({
          CatalogName: input.catalogName,
          DatabaseName: input.databaseName,
          Expression: input.expression,
          MaxResults: input.maxResults,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => athena.send(command), ATHENA_RETRYABLE_ERRORS);

        const tables = (response.TableMetadataList ?? []).map((table) => ({
          name: table.Name!,
          tableType: table.TableType,
          createTime: table.CreateTime?.toISOString(),
          lastAccessTime: table.LastAccessTime?.toISOString(),
          columns: table.Columns?.map((col) => ({
            name: col.Name,
            type: col.Type,
            comment: col.Comment,
          })),
          partitionKeys: table.PartitionKeys?.map((key) => ({
            name: key.Name,
            type: key.Type,
          })),
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

  return [
    startQueryExecution,
    getQueryExecution,
    getQueryResults,
    stopQueryExecution,
    listDatabases,
    listTableMetadata,
  ];
}
