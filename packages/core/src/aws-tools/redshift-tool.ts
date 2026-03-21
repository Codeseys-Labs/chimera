/**
 * AWS Redshift Tool - Data warehouse management for agents (Strands format)
 *
 * Operations:
 * - redshift_describe_clusters: Query Redshift cluster metadata
 * - redshift_create_cluster: Launch a new Redshift data warehouse cluster
 * - redshift_delete_cluster: Delete a Redshift cluster
 * - redshift_pause_cluster: Pause a running cluster to save costs
 * - redshift_resume_cluster: Resume a paused cluster
 * - redshift_modify_cluster: Modify cluster configuration
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  RedshiftClient,
  DescribeClustersCommand,
  CreateClusterCommand,
  DeleteClusterCommand,
  PauseClusterCommand,
  ResumeClusterCommand,
  ModifyClusterCommand,
} from '@aws-sdk/client-redshift';
import type { AWSClientFactory } from './client-factory';
import { createResourceTags } from './client-factory';
import { retryWithBackoff, formatToolError, REDSHIFT_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create Redshift Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of Redshift tools for Strands Agent
 */
export function createRedshiftTools(clientFactory: AWSClientFactory) {
  const describeClusters = tool({
    name: 'redshift_describe_clusters',
    description: 'Query Redshift data warehouse cluster metadata, configuration, and status',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      clusterIdentifier: z.string().optional().describe('Specific cluster identifier'),
      maxRecords: z.number().optional().describe('Maximum number of results'),
      marker: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const redshift = await clientFactory.getRedshiftClient(context);

        const command = new DescribeClustersCommand({
          ClusterIdentifier: input.clusterIdentifier,
          MaxRecords: input.maxRecords,
          Marker: input.marker,
        });

        const response = await retryWithBackoff(() => redshift.send(command), REDSHIFT_RETRYABLE_ERRORS);

        const clusters = (response.Clusters ?? []).map((cluster) => ({
          clusterIdentifier: cluster.ClusterIdentifier!,
          nodeType: cluster.NodeType!,
          clusterStatus: cluster.ClusterStatus,
          numberOfNodes: cluster.NumberOfNodes,
          endpoint: cluster.Endpoint ? {
            address: cluster.Endpoint.Address,
            port: cluster.Endpoint.Port,
          } : undefined,
          dbName: cluster.DBName,
          masterUsername: cluster.MasterUsername,
          vpcId: cluster.VpcId,
          availabilityZone: cluster.AvailabilityZone,
          encrypted: cluster.Encrypted,
          clusterCreateTime: cluster.ClusterCreateTime?.toISOString(),
        }));

        return JSON.stringify({
          success: true,
          data: {
            clusters,
            marker: response.Marker,
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

  const createCluster = tool({
    name: 'redshift_create_cluster',
    description: 'Create a new Redshift data warehouse cluster with specified node type and configuration',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      clusterIdentifier: z.string().describe('Unique identifier for the cluster'),
      nodeType: z.string().describe('Node type (e.g., dc2.large, ra3.xlplus)'),
      numberOfNodes: z.number().optional().describe('Number of nodes (default: 1 for single-node)'),
      masterUsername: z.string().describe('Master username for database'),
      masterUserPassword: z.string().describe('Master password (8-64 characters)'),
      dbName: z.string().optional().describe('Database name to create'),
      clusterType: z.enum(['single-node', 'multi-node']).optional().describe('Cluster type'),
      vpcSecurityGroupIds: z.array(z.string()).optional().describe('VPC security group IDs'),
      clusterSubnetGroupName: z.string().optional().describe('Cluster subnet group name'),
      publiclyAccessible: z.boolean().optional().describe('Allow public internet access'),
      encrypted: z.boolean().optional().describe('Enable encryption at rest'),
      additionalTags: z.record(z.string()).optional().describe('Additional resource tags'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const redshift = await clientFactory.getRedshiftClient(context);

        const tags = createResourceTags(input.tenantId, input.agentId, input.additionalTags ?? {});

        const command = new CreateClusterCommand({
          ClusterIdentifier: input.clusterIdentifier,
          NodeType: input.nodeType,
          NumberOfNodes: input.numberOfNodes ?? 1,
          MasterUsername: input.masterUsername,
          MasterUserPassword: input.masterUserPassword,
          DBName: input.dbName,
          ClusterType: input.clusterType ?? (input.numberOfNodes === 1 ? 'single-node' : 'multi-node'),
          VpcSecurityGroupIds: input.vpcSecurityGroupIds,
          ClusterSubnetGroupName: input.clusterSubnetGroupName,
          PubliclyAccessible: input.publiclyAccessible ?? false,
          Encrypted: input.encrypted ?? true,
          Tags: tags,
        });

        const response = await retryWithBackoff(() => redshift.send(command), REDSHIFT_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            clusterIdentifier: response.Cluster?.ClusterIdentifier!,
            clusterStatus: response.Cluster?.ClusterStatus,
            endpoint: response.Cluster?.Endpoint?.Address,
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

  const deleteCluster = tool({
    name: 'redshift_delete_cluster',
    description: 'Delete a Redshift data warehouse cluster (permanent operation)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      clusterIdentifier: z.string().describe('Cluster identifier to delete'),
      skipFinalClusterSnapshot: z.boolean().optional().describe('Skip final snapshot (default: false)'),
      finalClusterSnapshotIdentifier: z.string().optional().describe('Final snapshot name (required if skipFinalClusterSnapshot=false)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const redshift = await clientFactory.getRedshiftClient(context);

        const command = new DeleteClusterCommand({
          ClusterIdentifier: input.clusterIdentifier,
          SkipFinalClusterSnapshot: input.skipFinalClusterSnapshot ?? false,
          FinalClusterSnapshotIdentifier: input.finalClusterSnapshotIdentifier,
        });

        const response = await retryWithBackoff(() => redshift.send(command), REDSHIFT_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            clusterIdentifier: response.Cluster?.ClusterIdentifier!,
            clusterStatus: response.Cluster?.ClusterStatus,
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

  const pauseCluster = tool({
    name: 'redshift_pause_cluster',
    description: 'Pause a running Redshift cluster to save costs (compute charges stop)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      clusterIdentifier: z.string().describe('Cluster identifier to pause'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const redshift = await clientFactory.getRedshiftClient(context);

        const command = new PauseClusterCommand({
          ClusterIdentifier: input.clusterIdentifier,
        });

        const response = await retryWithBackoff(() => redshift.send(command), REDSHIFT_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            clusterIdentifier: response.Cluster?.ClusterIdentifier!,
            clusterStatus: response.Cluster?.ClusterStatus,
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

  const resumeCluster = tool({
    name: 'redshift_resume_cluster',
    description: 'Resume a paused Redshift cluster (compute charges resume)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      clusterIdentifier: z.string().describe('Cluster identifier to resume'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const redshift = await clientFactory.getRedshiftClient(context);

        const command = new ResumeClusterCommand({
          ClusterIdentifier: input.clusterIdentifier,
        });

        const response = await retryWithBackoff(() => redshift.send(command), REDSHIFT_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            clusterIdentifier: response.Cluster?.ClusterIdentifier!,
            clusterStatus: response.Cluster?.ClusterStatus,
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

  const modifyCluster = tool({
    name: 'redshift_modify_cluster',
    description: 'Modify Redshift cluster configuration (node type, number of nodes, etc.)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      clusterIdentifier: z.string().describe('Cluster identifier to modify'),
      nodeType: z.string().optional().describe('New node type'),
      numberOfNodes: z.number().optional().describe('New number of nodes'),
      masterUserPassword: z.string().optional().describe('New master password'),
      publiclyAccessible: z.boolean().optional().describe('Change public accessibility'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const redshift = await clientFactory.getRedshiftClient(context);

        const command = new ModifyClusterCommand({
          ClusterIdentifier: input.clusterIdentifier,
          NodeType: input.nodeType,
          NumberOfNodes: input.numberOfNodes,
          MasterUserPassword: input.masterUserPassword,
          PubliclyAccessible: input.publiclyAccessible,
        });

        const response = await retryWithBackoff(() => redshift.send(command), REDSHIFT_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            clusterIdentifier: response.Cluster?.ClusterIdentifier!,
            clusterStatus: response.Cluster?.ClusterStatus,
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
    describeClusters,
    createCluster,
    deleteCluster,
    pauseCluster,
    resumeCluster,
    modifyCluster,
  ];
}
