/**
 * AWS SQS Tool - Message queue management for agents (Strands format)
 *
 * Operations:
 * - sqs_create_queue: Create standard or FIFO queue
 * - sqs_send_message: Send message to queue
 * - sqs_send_message_batch: Send up to 10 messages in one call
 * - sqs_receive_message: Poll messages from queue
 * - sqs_delete_message: Remove message after processing
 * - sqs_delete_queue: Permanently delete queue
 * - sqs_get_queue_attributes: Query queue configuration
 * - sqs_list_queues: List queues with name prefix filter
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  type QueueAttributeName,
} from '@aws-sdk/client-sqs';
import type { AWSClientFactory } from './client-factory';
import { createResourceTags } from './client-factory';
import { retryWithBackoff, formatToolError, SQS_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create SQS Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of SQS tools for Strands Agent
 */
export function createSQSTools(clientFactory: AWSClientFactory) {
  const createQueue = tool({
    name: 'sqs_create_queue',
    description: 'Create SQS queue (standard or FIFO) with configurable attributes',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queueName: z.string().describe('Queue name (must end with .fifo for FIFO queues)'),
      fifoQueue: z.boolean().optional().describe('Create FIFO queue (default: false)'),
      contentBasedDeduplication: z.boolean().optional().describe('Enable content-based deduplication for FIFO (default: false)'),
      delaySeconds: z.number().optional().describe('Message delivery delay in seconds (0-900, default: 0)'),
      messageRetentionPeriod: z.number().optional().describe('Message retention in seconds (60-1209600, default: 345600/4 days)'),
      visibilityTimeout: z.number().optional().describe('Visibility timeout in seconds (0-43200, default: 30)'),
      receiveMessageWaitTimeSeconds: z.number().optional().describe('Long polling wait time (0-20, default: 0)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sqs = await clientFactory.getSQSClient(context);

        const tags = createResourceTags(input.tenantId, input.agentId, { billingCategory: 'messaging-sqs' });
        const tagMap = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));

        const attributes: Record<string, string> = {};
        if (input.fifoQueue) {
          attributes.FifoQueue = 'true';
        }
        if (input.contentBasedDeduplication) {
          attributes.ContentBasedDeduplication = 'true';
        }
        if (input.delaySeconds !== undefined) {
          attributes.DelaySeconds = input.delaySeconds.toString();
        }
        if (input.messageRetentionPeriod !== undefined) {
          attributes.MessageRetentionPeriod = input.messageRetentionPeriod.toString();
        }
        if (input.visibilityTimeout !== undefined) {
          attributes.VisibilityTimeout = input.visibilityTimeout.toString();
        }
        if (input.receiveMessageWaitTimeSeconds !== undefined) {
          attributes.ReceiveMessageWaitTimeSeconds = input.receiveMessageWaitTimeSeconds.toString();
        }

        const command = new CreateQueueCommand({
          QueueName: input.queueName,
          Attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
          tags: tagMap,
        });

        const response = await retryWithBackoff(() => sqs.send(command), SQS_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            queueUrl: response.QueueUrl,
          },
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

  const sendMessage = tool({
    name: 'sqs_send_message',
    description: 'Send a single message to SQS queue',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queueUrl: z.string().describe('Queue URL'),
      messageBody: z.string().describe('Message body (up to 256KB)'),
      messageGroupId: z.string().optional().describe('Message group ID (required for FIFO queues)'),
      messageDeduplicationId: z.string().optional().describe('Deduplication ID (required for FIFO without content-based dedup)'),
      delaySeconds: z.number().optional().describe('Message-level delivery delay (0-900)'),
      messageAttributes: z.record(z.object({
        stringValue: z.string().optional(),
        binaryValue: z.string().optional(),
        dataType: z.string(),
      })).optional().describe('Message attributes'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sqs = await clientFactory.getSQSClient(context);

        const messageAttributes: Record<string, any> = {};
        if (input.messageAttributes) {
          for (const [key, value] of Object.entries(input.messageAttributes)) {
            messageAttributes[key] = {
              DataType: value.dataType,
              StringValue: value.stringValue,
              BinaryValue: value.binaryValue,
            };
          }
        }

        const command = new SendMessageCommand({
          QueueUrl: input.queueUrl,
          MessageBody: input.messageBody,
          MessageGroupId: input.messageGroupId,
          MessageDeduplicationId: input.messageDeduplicationId,
          DelaySeconds: input.delaySeconds,
          MessageAttributes: Object.keys(messageAttributes).length > 0 ? messageAttributes : undefined,
        });

        const response = await retryWithBackoff(() => sqs.send(command), SQS_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            messageId: response.MessageId,
            md5OfMessageBody: response.MD5OfMessageBody,
            sequenceNumber: response.SequenceNumber,
          },
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

  const sendMessageBatch = tool({
    name: 'sqs_send_message_batch',
    description: 'Send up to 10 messages to SQS queue in a single request',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queueUrl: z.string().describe('Queue URL'),
      messages: z.array(z.object({
        id: z.string().describe('Unique ID for this message in the batch'),
        messageBody: z.string().describe('Message body'),
        messageGroupId: z.string().optional(),
        messageDeduplicationId: z.string().optional(),
        delaySeconds: z.number().optional(),
      })).max(10).describe('Messages to send (max 10)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sqs = await clientFactory.getSQSClient(context);

        const entries = input.messages.map((msg) => ({
          Id: msg.id,
          MessageBody: msg.messageBody,
          MessageGroupId: msg.messageGroupId,
          MessageDeduplicationId: msg.messageDeduplicationId,
          DelaySeconds: msg.delaySeconds,
        }));

        const command = new SendMessageBatchCommand({
          QueueUrl: input.queueUrl,
          Entries: entries,
        });

        const response = await retryWithBackoff(() => sqs.send(command), SQS_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            successful: response.Successful?.map((s) => ({
              id: s.Id,
              messageId: s.MessageId,
              md5OfMessageBody: s.MD5OfMessageBody,
              sequenceNumber: s.SequenceNumber,
            })) ?? [],
            failed: response.Failed?.map((f) => ({
              id: f.Id,
              senderFault: f.SenderFault,
              code: f.Code,
              message: f.Message,
            })) ?? [],
          },
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

  const receiveMessage = tool({
    name: 'sqs_receive_message',
    description: 'Poll messages from SQS queue (long polling supported)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queueUrl: z.string().describe('Queue URL'),
      maxNumberOfMessages: z.number().optional().describe('Max messages to return (1-10, default: 1)'),
      visibilityTimeout: z.number().optional().describe('Visibility timeout override (0-43200)'),
      waitTimeSeconds: z.number().optional().describe('Long polling wait time (0-20, default: 0)'),
      attributeNames: z.array(z.string()).optional().describe('Message attributes to retrieve'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sqs = await clientFactory.getSQSClient(context);

        const command = new ReceiveMessageCommand({
          QueueUrl: input.queueUrl,
          MaxNumberOfMessages: input.maxNumberOfMessages ?? 1,
          VisibilityTimeout: input.visibilityTimeout,
          WaitTimeSeconds: input.waitTimeSeconds ?? 0,
          AttributeNames: input.attributeNames as QueueAttributeName[] | undefined,
        });

        const response = await retryWithBackoff(() => sqs.send(command), SQS_RETRYABLE_ERRORS);

        const messages = (response.Messages ?? []).map((msg) => ({
          messageId: msg.MessageId,
          receiptHandle: msg.ReceiptHandle,
          body: msg.Body,
          attributes: msg.Attributes ?? {},
          messageAttributes: msg.MessageAttributes ?? {},
          md5OfBody: msg.MD5OfBody,
        }));

        return JSON.stringify({
          success: true,
          data: {
            messages,
            count: messages.length,
          },
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

  const deleteMessage = tool({
    name: 'sqs_delete_message',
    description: 'Delete message from queue after processing (using receipt handle from receive)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queueUrl: z.string().describe('Queue URL'),
      receiptHandle: z.string().describe('Receipt handle from receive_message'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sqs = await clientFactory.getSQSClient(context);

        const command = new DeleteMessageCommand({
          QueueUrl: input.queueUrl,
          ReceiptHandle: input.receiptHandle,
        });

        await retryWithBackoff(() => sqs.send(command), SQS_RETRYABLE_ERRORS);

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

  const deleteQueue = tool({
    name: 'sqs_delete_queue',
    description: 'Permanently delete SQS queue and all messages',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queueUrl: z.string().describe('Queue URL to delete'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sqs = await clientFactory.getSQSClient(context);

        const command = new DeleteQueueCommand({
          QueueUrl: input.queueUrl,
        });

        await retryWithBackoff(() => sqs.send(command), SQS_RETRYABLE_ERRORS);

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

  const getQueueAttributes = tool({
    name: 'sqs_get_queue_attributes',
    description: 'Query queue attributes and configuration',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queueUrl: z.string().describe('Queue URL'),
      attributeNames: z.array(z.string()).optional().describe('Attributes to retrieve (default: All)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sqs = await clientFactory.getSQSClient(context);

        const command = new GetQueueAttributesCommand({
          QueueUrl: input.queueUrl,
          AttributeNames: (input.attributeNames as QueueAttributeName[]) ?? ['All'],
        });

        const response = await retryWithBackoff(() => sqs.send(command), SQS_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            attributes: response.Attributes ?? {},
          },
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

  const listQueues = tool({
    name: 'sqs_list_queues',
    description: 'List SQS queues with optional name prefix filter',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      queueNamePrefix: z.string().optional().describe('Filter queues by name prefix'),
      maxResults: z.number().optional().describe('Maximum queues to return'),
      nextToken: z.string().optional().describe('Pagination token'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const sqs = await clientFactory.getSQSClient(context);

        const command = new ListQueuesCommand({
          QueueNamePrefix: input.queueNamePrefix,
          MaxResults: input.maxResults,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => sqs.send(command), SQS_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            queueUrls: response.QueueUrls ?? [],
            nextToken: response.NextToken,
          },
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
    createQueue,
    sendMessage,
    sendMessageBatch,
    receiveMessage,
    deleteMessage,
    deleteQueue,
    getQueueAttributes,
    listQueues,
  ];
}
