/**
 * AWS OpenSearch Tool - Search and analytics engine management for agents (Strands format)
 *
 * Operations:
 * - opensearch_describe_domains: Query OpenSearch domain metadata
 * - opensearch_create_domain: Launch a new OpenSearch domain
 * - opensearch_delete_domain: Delete an OpenSearch domain
 * - opensearch_update_domain_config: Modify domain configuration
 * - opensearch_list_domain_names: List all OpenSearch domains
 * - opensearch_get_compatible_versions: Get compatible OpenSearch upgrade versions
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  OpenSearchClient,
  DescribeDomainsCommand,
  CreateDomainCommand,
  DeleteDomainCommand,
  UpdateDomainConfigCommand,
  ListDomainNamesCommand,
  GetCompatibleVersionsCommand,
} from '@aws-sdk/client-opensearch';
import type { AWSClientFactory } from './client-factory';
import { createResourceTags } from './client-factory';
import { retryWithBackoff, formatToolError, OPENSEARCH_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create OpenSearch Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of OpenSearch tools for Strands Agent
 */
export function createOpenSearchTools(clientFactory: AWSClientFactory) {
  const describeDomains = tool({
    name: 'opensearch_describe_domains',
    description: 'Query OpenSearch domain metadata, configuration, and status',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      domainNames: z.array(z.string()).describe('List of domain names to describe'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const opensearch = await clientFactory.getOpenSearchClient(context);

        const command = new DescribeDomainsCommand({
          DomainNames: input.domainNames,
        });

        const response = await retryWithBackoff(() => opensearch.send(command), OPENSEARCH_RETRYABLE_ERRORS);

        const domains = (response.DomainStatusList ?? []).map((domain) => ({
          domainId: domain.DomainId!,
          domainName: domain.DomainName!,
          arn: domain.ARN,
          created: domain.Created,
          deleted: domain.Deleted,
          endpoint: domain.Endpoint,
          endpoints: domain.Endpoints,
          processing: domain.Processing,
          upgradeProcessing: domain.UpgradeProcessing,
          engineVersion: domain.EngineVersion,
          clusterConfig: domain.ClusterConfig ? {
            instanceType: domain.ClusterConfig.InstanceType,
            instanceCount: domain.ClusterConfig.InstanceCount,
            dedicatedMasterEnabled: domain.ClusterConfig.DedicatedMasterEnabled,
            zoneAwarenessEnabled: domain.ClusterConfig.ZoneAwarenessEnabled,
          } : undefined,
          ebsOptions: domain.EBSOptions ? {
            ebsEnabled: domain.EBSOptions.EBSEnabled,
            volumeType: domain.EBSOptions.VolumeType,
            volumeSize: domain.EBSOptions.VolumeSize,
          } : undefined,
          vpcOptions: domain.VPCOptions ? {
            vpcId: domain.VPCOptions.VPCId,
            subnetIds: domain.VPCOptions.SubnetIds,
            securityGroupIds: domain.VPCOptions.SecurityGroupIds,
          } : undefined,
        }));

        return JSON.stringify({
          success: true,
          data: { domains },
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

  const createDomain = tool({
    name: 'opensearch_create_domain',
    description: 'Create a new AWS OpenSearch domain with specified engine version and configuration',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      domainName: z.string().describe('Unique domain name'),
      engineVersion: z.string().optional().describe('OpenSearch version (e.g., OpenSearch_2.5)'),
      instanceType: z.string().optional().describe('Instance type (e.g., t3.small.search, m5.large.search)'),
      instanceCount: z.number().optional().describe('Number of instances (default: 1)'),
      dedicatedMasterEnabled: z.boolean().optional().describe('Enable dedicated master nodes'),
      zoneAwarenessEnabled: z.boolean().optional().describe('Enable zone awareness'),
      ebsEnabled: z.boolean().optional().describe('Enable EBS storage'),
      volumeType: z.enum(['gp2', 'gp3', 'io1']).optional().describe('EBS volume type'),
      volumeSize: z.number().optional().describe('EBS volume size in GB'),
      vpcSubnetIds: z.array(z.string()).optional().describe('VPC subnet IDs'),
      vpcSecurityGroupIds: z.array(z.string()).optional().describe('VPC security group IDs'),
      encryptionAtRestEnabled: z.boolean().optional().describe('Enable encryption at rest'),
      nodeToNodeEncryptionEnabled: z.boolean().optional().describe('Enable node-to-node encryption'),
      additionalTags: z.record(z.string()).optional().describe('Additional resource tags'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const opensearch = await clientFactory.getOpenSearchClient(context);

        const tags = createResourceTags(input.tenantId, input.agentId, input.additionalTags ?? {});

        const command = new CreateDomainCommand({
          DomainName: input.domainName,
          EngineVersion: input.engineVersion ?? 'OpenSearch_2.5',
          ClusterConfig: {
            InstanceType: (input.instanceType ?? 't3.small.search') as any,
            InstanceCount: input.instanceCount ?? 1,
            DedicatedMasterEnabled: input.dedicatedMasterEnabled ?? false,
            ZoneAwarenessEnabled: input.zoneAwarenessEnabled ?? false,
          },
          EBSOptions: input.ebsEnabled !== false ? {
            EBSEnabled: true,
            VolumeType: input.volumeType ?? 'gp3',
            VolumeSize: input.volumeSize ?? 10,
          } : undefined,
          VPCOptions: input.vpcSubnetIds ? {
            SubnetIds: input.vpcSubnetIds,
            SecurityGroupIds: input.vpcSecurityGroupIds,
          } : undefined,
          EncryptionAtRestOptions: {
            Enabled: input.encryptionAtRestEnabled ?? true,
          },
          NodeToNodeEncryptionOptions: {
            Enabled: input.nodeToNodeEncryptionEnabled ?? true,
          },
          TagList: tags,
        });

        const response = await retryWithBackoff(() => opensearch.send(command), OPENSEARCH_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            domainName: response.DomainStatus?.DomainName,
            arn: response.DomainStatus?.ARN,
            domainId: response.DomainStatus?.DomainId,
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

  const deleteDomain = tool({
    name: 'opensearch_delete_domain',
    description: 'Delete an AWS OpenSearch domain (permanent operation)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      domainName: z.string().describe('Domain name to delete'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const opensearch = await clientFactory.getOpenSearchClient(context);

        const command = new DeleteDomainCommand({
          DomainName: input.domainName,
        });

        const response = await retryWithBackoff(() => opensearch.send(command), OPENSEARCH_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            domainName: response.DomainStatus?.DomainName,
            domainId: response.DomainStatus?.DomainId,
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

  const updateDomainConfig = tool({
    name: 'opensearch_update_domain_config',
    description: 'Modify AWS OpenSearch domain configuration (instance type, count, storage, etc.)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      domainName: z.string().describe('Domain name to update'),
      instanceType: z.string().optional().describe('New instance type'),
      instanceCount: z.number().optional().describe('New number of instances'),
      dedicatedMasterEnabled: z.boolean().optional().describe('Enable/disable dedicated master nodes'),
      volumeSize: z.number().optional().describe('New EBS volume size in GB'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const opensearch = await clientFactory.getOpenSearchClient(context);

        const command = new UpdateDomainConfigCommand({
          DomainName: input.domainName,
          ClusterConfig: input.instanceType || input.instanceCount !== undefined || input.dedicatedMasterEnabled !== undefined ? {
            InstanceType: input.instanceType as any,
            InstanceCount: input.instanceCount,
            DedicatedMasterEnabled: input.dedicatedMasterEnabled,
          } : undefined,
          EBSOptions: input.volumeSize ? {
            EBSEnabled: true,
            VolumeSize: input.volumeSize,
          } : undefined,
        });

        const response = await retryWithBackoff(() => opensearch.send(command), OPENSEARCH_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            domainName: input.domainName,
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

  const listDomainNames = tool({
    name: 'opensearch_list_domain_names',
    description: 'List all AWS OpenSearch domain names in the account',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      engineType: z.enum(['OpenSearch', 'Elasticsearch']).optional().describe('Filter by engine type'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const opensearch = await clientFactory.getOpenSearchClient(context);

        const command = new ListDomainNamesCommand({
          EngineType: input.engineType,
        });

        const response = await retryWithBackoff(() => opensearch.send(command), OPENSEARCH_RETRYABLE_ERRORS);

        const domains = (response.DomainNames ?? []).map((domain) => ({
          domainName: domain.DomainName!,
          engineType: domain.EngineType,
        }));

        return JSON.stringify({
          success: true,
          data: { domains },
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

  const getCompatibleVersions = tool({
    name: 'opensearch_get_compatible_versions',
    description: 'Get compatible OpenSearch/Elasticsearch upgrade versions for a domain',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      domainName: z.string().optional().describe('Domain name (if omitted, returns all version maps)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const opensearch = await clientFactory.getOpenSearchClient(context);

        const command = new GetCompatibleVersionsCommand({
          DomainName: input.domainName,
        });

        const response = await retryWithBackoff(() => opensearch.send(command), OPENSEARCH_RETRYABLE_ERRORS);

        const versionMaps = (response.CompatibleVersions ?? []).map((versionMap) => ({
          sourceVersion: versionMap.SourceVersion,
          targetVersions: versionMap.TargetVersions ?? [],
        }));

        return JSON.stringify({
          success: true,
          data: { versionMaps },
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
    describeDomains,
    createDomain,
    deleteDomain,
    updateDomainConfig,
    listDomainNames,
    getCompatibleVersions,
  ];
}
