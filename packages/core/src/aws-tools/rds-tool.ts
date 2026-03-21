/**
 * AWS RDS Tool - Relational database management for agents (Strands format)
 *
 * Operations:
 * - rds_describe_db_instances: Query RDS database instance metadata
 * - rds_create_db_instance: Launch a new RDS database instance
 * - rds_delete_db_instance: Delete an RDS database instance
 * - rds_start_db_instance: Start a stopped RDS instance
 * - rds_stop_db_instance: Stop a running RDS instance
 * - rds_modify_db_instance: Modify database instance configuration
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  RDSClient,
  DescribeDBInstancesCommand,
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  StartDBInstanceCommand,
  StopDBInstanceCommand,
  ModifyDBInstanceCommand,
} from '@aws-sdk/client-rds';
import type { AWSClientFactory } from './client-factory';
import { createResourceTags } from './client-factory';
import { retryWithBackoff, formatToolError, RDS_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create RDS Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of RDS tools for Strands Agent
 */
export function createRDSTools(clientFactory: AWSClientFactory) {
  const describeDBInstances = tool({
    name: 'rds_describe_db_instances',
    description: 'Query RDS database instance metadata, configuration, and status',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      dbInstanceIdentifier: z.string().optional().describe('Specific DB instance identifier'),
      filters: z.array(z.object({
        name: z.string(),
        values: z.array(z.string()),
      })).optional().describe('RDS filters (e.g., engine, db-instance-class)'),
      maxRecords: z.number().optional().describe('Maximum number of results'),
      marker: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rds = await clientFactory.getRDSClient(context);

        const command = new DescribeDBInstancesCommand({
          DBInstanceIdentifier: input.dbInstanceIdentifier,
          Filters: input.filters?.map((f) => ({
            Name: f.name,
            Values: f.values,
          })),
          MaxRecords: input.maxRecords,
          Marker: input.marker,
        });

        const response = await retryWithBackoff(() => rds.send(command), RDS_RETRYABLE_ERRORS);

        const instances = (response.DBInstances ?? []).map((db) => ({
          dbInstanceIdentifier: db.DBInstanceIdentifier!,
          dbInstanceClass: db.DBInstanceClass!,
          engine: db.Engine!,
          engineVersion: db.EngineVersion,
          status: db.DBInstanceStatus,
          endpoint: db.Endpoint ? {
            address: db.Endpoint.Address,
            port: db.Endpoint.Port,
          } : undefined,
          allocatedStorage: db.AllocatedStorage,
          storageType: db.StorageType,
          multiAZ: db.MultiAZ,
          publiclyAccessible: db.PubliclyAccessible,
          vpcSecurityGroups: db.VpcSecurityGroups?.map((sg) => sg.VpcSecurityGroupId),
          availabilityZone: db.AvailabilityZone,
        }));

        return JSON.stringify({
          success: true,
          data: {
            instances,
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

  const createDBInstance = tool({
    name: 'rds_create_db_instance',
    description: 'Create a new RDS database instance with specified engine and configuration',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      dbInstanceIdentifier: z.string().describe('Unique identifier for the DB instance'),
      dbInstanceClass: z.string().describe('Instance class (e.g., db.t3.micro, db.r5.large)'),
      engine: z.enum(['mysql', 'postgres', 'mariadb', 'oracle-ee', 'oracle-se2', 'sqlserver-ex', 'sqlserver-web', 'sqlserver-se', 'sqlserver-ee']).describe('Database engine'),
      masterUsername: z.string().describe('Master username for database'),
      masterUserPassword: z.string().describe('Master password (8-41 characters)'),
      allocatedStorage: z.number().describe('Storage size in GB'),
      storageType: z.enum(['gp2', 'gp3', 'io1', 'io2']).optional().describe('Storage type'),
      vpcSecurityGroupIds: z.array(z.string()).optional().describe('VPC security group IDs'),
      dbSubnetGroupName: z.string().optional().describe('DB subnet group for VPC'),
      publiclyAccessible: z.boolean().optional().describe('Allow public internet access'),
      multiAZ: z.boolean().optional().describe('Enable Multi-AZ deployment'),
      backupRetentionPeriod: z.number().optional().describe('Backup retention in days (0-35)'),
      additionalTags: z.record(z.string()).optional().describe('Additional resource tags'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rds = await clientFactory.getRDSClient(context);

        const tags = createResourceTags(input.tenantId, input.agentId, input.additionalTags ?? {});

        const command = new CreateDBInstanceCommand({
          DBInstanceIdentifier: input.dbInstanceIdentifier,
          DBInstanceClass: input.dbInstanceClass,
          Engine: input.engine,
          MasterUsername: input.masterUsername,
          MasterUserPassword: input.masterUserPassword,
          AllocatedStorage: input.allocatedStorage,
          StorageType: input.storageType ?? 'gp3',
          VpcSecurityGroupIds: input.vpcSecurityGroupIds,
          DBSubnetGroupName: input.dbSubnetGroupName,
          PubliclyAccessible: input.publiclyAccessible ?? false,
          MultiAZ: input.multiAZ ?? false,
          BackupRetentionPeriod: input.backupRetentionPeriod ?? 7,
          Tags: tags,
        });

        const response = await retryWithBackoff(() => rds.send(command), RDS_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            dbInstanceIdentifier: response.DBInstance?.DBInstanceIdentifier!,
            status: response.DBInstance?.DBInstanceStatus,
            endpoint: response.DBInstance?.Endpoint?.Address,
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

  const deleteDBInstance = tool({
    name: 'rds_delete_db_instance',
    description: 'Delete an RDS database instance (permanent operation)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      dbInstanceIdentifier: z.string().describe('DB instance identifier to delete'),
      skipFinalSnapshot: z.boolean().optional().describe('Skip final snapshot (default: false)'),
      finalDBSnapshotIdentifier: z.string().optional().describe('Final snapshot name (required if skipFinalSnapshot=false)'),
      deleteAutomatedBackups: z.boolean().optional().describe('Delete automated backups (default: true)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rds = await clientFactory.getRDSClient(context);

        const command = new DeleteDBInstanceCommand({
          DBInstanceIdentifier: input.dbInstanceIdentifier,
          SkipFinalSnapshot: input.skipFinalSnapshot ?? false,
          FinalDBSnapshotIdentifier: input.finalDBSnapshotIdentifier,
          DeleteAutomatedBackups: input.deleteAutomatedBackups ?? true,
        });

        const response = await retryWithBackoff(() => rds.send(command), RDS_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            dbInstanceIdentifier: response.DBInstance?.DBInstanceIdentifier!,
            status: response.DBInstance?.DBInstanceStatus,
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

  const startDBInstance = tool({
    name: 'rds_start_db_instance',
    description: 'Start a stopped RDS database instance',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      dbInstanceIdentifier: z.string().describe('DB instance identifier to start'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rds = await clientFactory.getRDSClient(context);

        const command = new StartDBInstanceCommand({
          DBInstanceIdentifier: input.dbInstanceIdentifier,
        });

        const response = await retryWithBackoff(() => rds.send(command), RDS_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            dbInstanceIdentifier: response.DBInstance?.DBInstanceIdentifier!,
            status: response.DBInstance?.DBInstanceStatus,
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

  const stopDBInstance = tool({
    name: 'rds_stop_db_instance',
    description: 'Stop a running RDS database instance (can be restarted later)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      dbInstanceIdentifier: z.string().describe('DB instance identifier to stop'),
      dbSnapshotIdentifier: z.string().optional().describe('Snapshot name before stopping'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rds = await clientFactory.getRDSClient(context);

        const command = new StopDBInstanceCommand({
          DBInstanceIdentifier: input.dbInstanceIdentifier,
          DBSnapshotIdentifier: input.dbSnapshotIdentifier,
        });

        const response = await retryWithBackoff(() => rds.send(command), RDS_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            dbInstanceIdentifier: response.DBInstance?.DBInstanceIdentifier!,
            status: response.DBInstance?.DBInstanceStatus,
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

  const modifyDBInstance = tool({
    name: 'rds_modify_db_instance',
    description: 'Modify RDS database instance configuration (storage, instance class, etc.)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      dbInstanceIdentifier: z.string().describe('DB instance identifier to modify'),
      dbInstanceClass: z.string().optional().describe('New instance class (requires reboot)'),
      allocatedStorage: z.number().optional().describe('New storage size in GB'),
      backupRetentionPeriod: z.number().optional().describe('Backup retention in days'),
      applyImmediately: z.boolean().optional().describe('Apply changes immediately (default: false)'),
      masterUserPassword: z.string().optional().describe('New master password'),
      multiAZ: z.boolean().optional().describe('Enable/disable Multi-AZ'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rds = await clientFactory.getRDSClient(context);

        const command = new ModifyDBInstanceCommand({
          DBInstanceIdentifier: input.dbInstanceIdentifier,
          DBInstanceClass: input.dbInstanceClass,
          AllocatedStorage: input.allocatedStorage,
          BackupRetentionPeriod: input.backupRetentionPeriod,
          ApplyImmediately: input.applyImmediately ?? false,
          MasterUserPassword: input.masterUserPassword,
          MultiAZ: input.multiAZ,
        });

        const response = await retryWithBackoff(() => rds.send(command), RDS_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            dbInstanceIdentifier: response.DBInstance?.DBInstanceIdentifier!,
            status: response.DBInstance?.DBInstanceStatus,
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
    describeDBInstances,
    createDBInstance,
    deleteDBInstance,
    startDBInstance,
    stopDBInstance,
    modifyDBInstance,
  ];
}
