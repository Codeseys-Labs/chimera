/**
 * AWS EC2 Tool - Virtual machine management for agents
 *
 * Operations:
 * - run_instances: Launch EC2 instances
 * - describe_instances: Query instance metadata and state
 * - start_instances: Start stopped instances
 * - stop_instances: Stop running instances
 * - terminate_instances: Permanently delete instances
 * - modify_instance_attribute: Change instance configuration
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

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
import type { AWSToolContext, AWSToolResult } from './types';
import { createResourceTags } from './client-factory';

/**
 * Configuration for launching instances
 */
export interface RunInstancesConfig {
  imageId: string; // AMI ID
  instanceType: string; // e.g., 't3.micro', 'm5.large'
  minCount: number;
  maxCount: number;
  keyName?: string; // SSH key pair name
  securityGroupIds?: string[];
  subnetId?: string;
  userData?: string; // Base64-encoded startup script
  iamInstanceProfile?: {
    arn?: string;
    name?: string;
  };
  additionalTags?: Record<string, string>;
  blockDeviceMappings?: Array<{
    deviceName: string;
    volumeSize: number; // GB
    volumeType?: 'gp3' | 'gp2' | 'io2' | 'io1' | 'st1' | 'sc1';
    deleteOnTermination?: boolean;
  }>;
}

/**
 * Configuration for describing instances
 */
export interface DescribeInstancesConfig {
  instanceIds?: string[];
  filters?: Array<{
    name: string;
    values: string[];
  }>;
  maxResults?: number;
  nextToken?: string;
}

/**
 * Configuration for modifying instance attributes
 */
export interface ModifyInstanceAttributeConfig {
  instanceId: string;
  instanceType?: string;
  userData?: string; // Base64-encoded (will be converted to Buffer)
  sourceDestCheck?: boolean;
}

/**
 * AWS EC2 Tool
 */
export class EC2Tool {
  constructor(private clientFactory: AWSClientFactory) {}

  /**
   * Launch EC2 instances
   */
  async runInstances(
    context: AWSToolContext,
    config: RunInstancesConfig
  ): Promise<
    AWSToolResult<{
      instances: Array<{
        instanceId: string;
        privateIp?: string;
        publicIp?: string;
        state: string;
      }>;
    }>
  > {
    const startTime = Date.now();

    try {
      const ec2 = await this.clientFactory.getEC2Client(context);

      // Build tags
      const tags = createResourceTags(
        context.tenantId,
        context.agentId,
        config.additionalTags ?? {}
      );

      // Build block device mappings if provided
      const blockDeviceMappings = config.blockDeviceMappings?.map((bdm) => ({
        DeviceName: bdm.deviceName,
        Ebs: {
          VolumeSize: bdm.volumeSize,
          VolumeType: bdm.volumeType ?? 'gp3',
          DeleteOnTermination: bdm.deleteOnTermination ?? true,
        },
      }));

      const command = new RunInstancesCommand({
        ImageId: config.imageId,
        InstanceType: config.instanceType as any,
        MinCount: config.minCount,
        MaxCount: config.maxCount,
        KeyName: config.keyName,
        SecurityGroupIds: config.securityGroupIds,
        SubnetId: config.subnetId,
        UserData: config.userData,
        IamInstanceProfile: config.iamInstanceProfile
          ? {
              Arn: config.iamInstanceProfile.arn,
              Name: config.iamInstanceProfile.name,
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

      const response = await this.retryWithBackoff(() => ec2.send(command));

      const instances = (response.Instances ?? []).map((inst) => ({
        instanceId: inst.InstanceId!,
        privateIp: inst.PrivateIpAddress,
        publicIp: inst.PublicIpAddress,
        state: inst.State?.Name ?? 'unknown',
      }));

      return {
        success: true,
        data: { instances },
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
   * Describe EC2 instances
   */
  async describeInstances(
    context: AWSToolContext,
    config?: DescribeInstancesConfig
  ): Promise<
    AWSToolResult<{
      instances: Array<{
        instanceId: string;
        state: string;
        instanceType: string;
        publicIp?: string;
        privateIp?: string;
        launchTime?: Date;
        tags: Record<string, string>;
      }>;
      nextToken?: string;
    }>
  > {
    const startTime = Date.now();

    try {
      const ec2 = await this.clientFactory.getEC2Client(context);

      const command = new DescribeInstancesCommand({
        InstanceIds: config?.instanceIds,
        Filters: config?.filters?.map((f) => ({
          Name: f.name,
          Values: f.values,
        })),
        MaxResults: config?.maxResults,
        NextToken: config?.nextToken,
      });

      const response = await this.retryWithBackoff(() => ec2.send(command));

      // Flatten reservations -> instances
      const instances: Array<{
        instanceId: string;
        state: string;
        instanceType: string;
        publicIp?: string;
        privateIp?: string;
        launchTime?: Date;
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
            launchTime: inst.LaunchTime,
            tags,
          });
        }
      }

      return {
        success: true,
        data: {
          instances,
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
   * Start stopped instances
   */
  async startInstances(
    context: AWSToolContext,
    instanceIds: string[]
  ): Promise<
    AWSToolResult<{
      startingInstances: Array<{
        instanceId: string;
        currentState: string;
        previousState: string;
      }>;
    }>
  > {
    const startTime = Date.now();

    try {
      const ec2 = await this.clientFactory.getEC2Client(context);

      const command = new StartInstancesCommand({
        InstanceIds: instanceIds,
      });

      const response = await this.retryWithBackoff(() => ec2.send(command));

      const startingInstances = (response.StartingInstances ?? []).map(
        (inst) => ({
          instanceId: inst.InstanceId!,
          currentState: inst.CurrentState?.Name ?? 'unknown',
          previousState: inst.PreviousState?.Name ?? 'unknown',
        })
      );

      return {
        success: true,
        data: { startingInstances },
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
   * Stop running instances
   */
  async stopInstances(
    context: AWSToolContext,
    instanceIds: string[]
  ): Promise<
    AWSToolResult<{
      stoppingInstances: Array<{
        instanceId: string;
        currentState: string;
        previousState: string;
      }>;
    }>
  > {
    const startTime = Date.now();

    try {
      const ec2 = await this.clientFactory.getEC2Client(context);

      const command = new StopInstancesCommand({
        InstanceIds: instanceIds,
      });

      const response = await this.retryWithBackoff(() => ec2.send(command));

      const stoppingInstances = (response.StoppingInstances ?? []).map(
        (inst) => ({
          instanceId: inst.InstanceId!,
          currentState: inst.CurrentState?.Name ?? 'unknown',
          previousState: inst.PreviousState?.Name ?? 'unknown',
        })
      );

      return {
        success: true,
        data: { stoppingInstances },
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
   * Terminate instances (permanent deletion)
   */
  async terminateInstances(
    context: AWSToolContext,
    instanceIds: string[]
  ): Promise<
    AWSToolResult<{
      terminatingInstances: Array<{
        instanceId: string;
        currentState: string;
        previousState: string;
      }>;
    }>
  > {
    const startTime = Date.now();

    try {
      const ec2 = await this.clientFactory.getEC2Client(context);

      const command = new TerminateInstancesCommand({
        InstanceIds: instanceIds,
      });

      const response = await this.retryWithBackoff(() => ec2.send(command));

      const terminatingInstances = (response.TerminatingInstances ?? []).map(
        (inst) => ({
          instanceId: inst.InstanceId!,
          currentState: inst.CurrentState?.Name ?? 'unknown',
          previousState: inst.PreviousState?.Name ?? 'unknown',
        })
      );

      return {
        success: true,
        data: { terminatingInstances },
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
   * Modify instance attributes
   */
  async modifyInstanceAttribute(
    context: AWSToolContext,
    config: ModifyInstanceAttributeConfig
  ): Promise<AWSToolResult<void>> {
    const startTime = Date.now();

    try {
      const ec2 = await this.clientFactory.getEC2Client(context);

      const command = new ModifyInstanceAttributeCommand({
        InstanceId: config.instanceId,
        InstanceType: config.instanceType
          ? { Value: config.instanceType }
          : undefined,
        UserData: config.userData
          ? { Value: Buffer.from(config.userData, 'base64') }
          : undefined,
        SourceDestCheck: config.sourceDestCheck !== undefined
          ? { Value: config.sourceDestCheck }
          : undefined,
      });

      await this.retryWithBackoff(() => ec2.send(command));

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
        const errorCode = error.Code ?? error.name;
        const retryableErrors = [
          'RequestLimitExceeded',
          'ServiceUnavailable',
          'InternalError',
          'ThrottlingException',
          'TimeoutError',
        ];

        if (retryableErrors.includes(errorCode) && attempt < maxRetries) {
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
    const errorCode = error.Code ?? error.name;
    const retryableErrors = [
      'RequestLimitExceeded',
      'ServiceUnavailable',
      'InternalError',
      'ThrottlingException',
      'TimeoutError',
    ];

    return {
      success: false,
      error: {
        message: error.message ?? 'Unknown error',
        code: errorCode ?? 'UnknownError',
        retryable: retryableErrors.includes(errorCode),
      },
      metadata: {
        region: context.region ?? 'us-east-1',
        durationMs: Date.now() - startTime,
      },
    };
  }
}
