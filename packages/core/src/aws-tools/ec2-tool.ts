/**
 * AWS EC2 Tool - Virtual machine management for agents (Strands format)
 *
 * Operations:
 * - ec2_run_instances: Launch EC2 instances
 * - ec2_describe_instances: Query instance metadata and state
 * - ec2_start_instances: Start stopped instances
 * - ec2_stop_instances: Stop running instances
 * - ec2_terminate_instances: Permanently delete instances
 * - ec2_modify_instance_attribute: Change instance configuration
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  ModifyInstanceAttributeCommand,
} from '@aws-sdk/client-ec2';
import type { AWSClientFactory } from './client-factory';
import { createResourceTags } from './client-factory';
import { retryWithBackoff, formatToolError, EC2_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create EC2 Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of EC2 tools for Strands Agent
 */
export function createEC2Tools(clientFactory: AWSClientFactory) {
  const runInstances = tool({
    name: 'ec2_run_instances',
    description: 'Launch EC2 instances with specified configuration, AMI, instance type, and networking settings',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      imageId: z.string().describe('AMI ID to launch'),
      instanceType: z.string().describe('Instance type (e.g., t3.micro, m5.large)'),
      minCount: z.number().describe('Minimum number of instances to launch'),
      maxCount: z.number().describe('Maximum number of instances to launch'),
      keyName: z.string().optional().describe('SSH key pair name'),
      securityGroupIds: z.array(z.string()).optional().describe('Security group IDs'),
      subnetId: z.string().optional().describe('Subnet ID for instance placement'),
      userData: z.string().optional().describe('Base64-encoded startup script'),
      iamInstanceProfile: z.object({
        arn: z.string().optional(),
        name: z.string().optional(),
      }).optional().describe('IAM instance profile'),
      additionalTags: z.record(z.string()).optional().describe('Additional resource tags'),
      blockDeviceMappings: z.array(z.object({
        deviceName: z.string(),
        volumeSize: z.number(),
        volumeType: z.enum(['gp3', 'gp2', 'io2', 'io1', 'st1', 'sc1']).optional(),
        deleteOnTermination: z.boolean().optional(),
      })).optional().describe('EBS volume configuration'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const ec2 = await clientFactory.getEC2Client(context);

        const tags = createResourceTags(input.tenantId, input.agentId, input.additionalTags ?? {});

        const blockDeviceMappings = input.blockDeviceMappings?.map((bdm) => ({
          DeviceName: bdm.deviceName,
          Ebs: {
            VolumeSize: bdm.volumeSize,
            VolumeType: bdm.volumeType ?? 'gp3',
            DeleteOnTermination: bdm.deleteOnTermination ?? true,
          },
        }));

        const command = new RunInstancesCommand({
          ImageId: input.imageId,
          InstanceType: input.instanceType as any,
          MinCount: input.minCount,
          MaxCount: input.maxCount,
          KeyName: input.keyName,
          SecurityGroupIds: input.securityGroupIds,
          SubnetId: input.subnetId,
          UserData: input.userData,
          IamInstanceProfile: input.iamInstanceProfile
            ? {
                Arn: input.iamInstanceProfile.arn,
                Name: input.iamInstanceProfile.name,
              }
            : undefined,
          TagSpecifications: [
            {
              ResourceType: 'instance',
              Tags: tags,
            },
          ],
          BlockDeviceMappings: blockDeviceMappings,
        });

        const response = await retryWithBackoff(() => ec2.send(command), EC2_RETRYABLE_ERRORS);

        const instances = (response.Instances ?? []).map((inst) => ({
          instanceId: inst.InstanceId!,
          privateIp: inst.PrivateIpAddress,
          publicIp: inst.PublicIpAddress,
          state: inst.State?.Name ?? 'unknown',
        }));

        return JSON.stringify({
          success: true,
          data: { instances },
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

  const describeInstances = tool({
    name: 'ec2_describe_instances',
    description: 'Query EC2 instance metadata and state with optional filters',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      instanceIds: z.array(z.string()).optional().describe('Specific instance IDs to query'),
      filters: z.array(z.object({
        name: z.string(),
        values: z.array(z.string()),
      })).optional().describe('EC2 filters (e.g., tag:Name, instance-state-name)'),
      maxResults: z.number().optional().describe('Maximum number of results'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const ec2 = await clientFactory.getEC2Client(context);

        const command = new DescribeInstancesCommand({
          InstanceIds: input.instanceIds,
          Filters: input.filters?.map((f) => ({
            Name: f.name,
            Values: f.values,
          })),
          MaxResults: input.maxResults,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => ec2.send(command), EC2_RETRYABLE_ERRORS);

        // Flatten reservations -> instances
        const instances: Array<{
          instanceId: string;
          state: string;
          instanceType: string;
          publicIp?: string;
          privateIp?: string;
          launchTime?: string;
          tags: Record<string, string>;
        }> = [];

        for (const reservation of response.Reservations ?? []) {
          for (const inst of reservation.Instances ?? []) {
            const tags: Record<string, string> = {};
            for (const tag of inst.Tags ?? []) {
              if (tag.Key && tag.Value) {
                tags[tag.Key] = tag.Value;
              }
            }

            instances.push({
              instanceId: inst.InstanceId!,
              state: inst.State?.Name ?? 'unknown',
              instanceType: inst.InstanceType!,
              publicIp: inst.PublicIpAddress,
              privateIp: inst.PrivateIpAddress,
              launchTime: inst.LaunchTime?.toISOString(),
              tags,
            });
          }
        }

        return JSON.stringify({
          success: true,
          data: {
            instances,
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

  const startInstances = tool({
    name: 'ec2_start_instances',
    description: 'Start one or more stopped EC2 instances',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      instanceIds: z.array(z.string()).describe('Instance IDs to start'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const ec2 = await clientFactory.getEC2Client(context);

        const command = new StartInstancesCommand({
          InstanceIds: input.instanceIds,
        });

        const response = await retryWithBackoff(() => ec2.send(command), EC2_RETRYABLE_ERRORS);

        const startingInstances = (response.StartingInstances ?? []).map((inst) => ({
          instanceId: inst.InstanceId!,
          currentState: inst.CurrentState?.Name ?? 'unknown',
          previousState: inst.PreviousState?.Name ?? 'unknown',
        }));

        return JSON.stringify({
          success: true,
          data: { startingInstances },
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

  const stopInstances = tool({
    name: 'ec2_stop_instances',
    description: 'Stop one or more running EC2 instances (can be restarted later)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      instanceIds: z.array(z.string()).describe('Instance IDs to stop'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const ec2 = await clientFactory.getEC2Client(context);

        const command = new StopInstancesCommand({
          InstanceIds: input.instanceIds,
        });

        const response = await retryWithBackoff(() => ec2.send(command), EC2_RETRYABLE_ERRORS);

        const stoppingInstances = (response.StoppingInstances ?? []).map((inst) => ({
          instanceId: inst.InstanceId!,
          currentState: inst.CurrentState?.Name ?? 'unknown',
          previousState: inst.PreviousState?.Name ?? 'unknown',
        }));

        return JSON.stringify({
          success: true,
          data: { stoppingInstances },
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

  const terminateInstances = tool({
    name: 'ec2_terminate_instances',
    description: 'Permanently delete one or more EC2 instances (cannot be restarted)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      instanceIds: z.array(z.string()).describe('Instance IDs to terminate'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const ec2 = await clientFactory.getEC2Client(context);

        const command = new TerminateInstancesCommand({
          InstanceIds: input.instanceIds,
        });

        const response = await retryWithBackoff(() => ec2.send(command), EC2_RETRYABLE_ERRORS);

        const terminatingInstances = (response.TerminatingInstances ?? []).map((inst) => ({
          instanceId: inst.InstanceId!,
          currentState: inst.CurrentState?.Name ?? 'unknown',
          previousState: inst.PreviousState?.Name ?? 'unknown',
        }));

        return JSON.stringify({
          success: true,
          data: { terminatingInstances },
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

  const modifyInstanceAttribute = tool({
    name: 'ec2_modify_instance_attribute',
    description: 'Modify EC2 instance attributes like instance type, user data, or source/destination check',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      instanceId: z.string().describe('Instance ID to modify'),
      instanceType: z.string().optional().describe('New instance type (instance must be stopped)'),
      userData: z.string().optional().describe('Base64-encoded user data (instance must be stopped)'),
      sourceDestCheck: z.boolean().optional().describe('Enable/disable source/destination check for NAT instances'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const ec2 = await clientFactory.getEC2Client(context);

        const command = new ModifyInstanceAttributeCommand({
          InstanceId: input.instanceId,
          InstanceType: input.instanceType ? { Value: input.instanceType } : undefined,
          UserData: input.userData ? { Value: Buffer.from(input.userData, 'base64') } : undefined,
          SourceDestCheck: input.sourceDestCheck !== undefined ? { Value: input.sourceDestCheck } : undefined,
        });

        await retryWithBackoff(() => ec2.send(command), EC2_RETRYABLE_ERRORS);

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

  return [
    runInstances,
    describeInstances,
    startInstances,
    stopInstances,
    terminateInstances,
    modifyInstanceAttribute,
  ];
}

// Legacy config types removed - now defined inline with Zod schemas
