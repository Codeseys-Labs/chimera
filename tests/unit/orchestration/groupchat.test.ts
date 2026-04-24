/**
 * GroupChat Test Suite (top-level smoke)
 *
 * GroupChat's SNS/SQS integration is a skeleton (Wave-14 audit M1/M2)
 * and all mutating lifecycle methods now throw `not implemented`.
 * Authoritative unit tests live under
 * `packages/core/src/orchestration/__tests__/group-chat.test.ts`.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  GroupChat,
  createGroupChat,
  GroupChatMessageBuilder,
  type GroupChatConfig,
  type GroupChatMessage,
} from '../../../packages/core/src/orchestration/groupchat';

const baseConfig: GroupChatConfig = {
  tenantId: 'tenant-123',
  groupId: 'swarm-abc',
  region: 'us-east-1',
  agentIds: ['agent-1', 'agent-2'],
};

function buildMessage(groupId: string): GroupChatMessage {
  return {
    messageId: 'test-msg-1',
    type: 'broadcast',
    sourceAgentId: 'agent-1',
    tenantId: baseConfig.tenantId,
    groupId,
    visibility: 'group',
    priority: 'normal',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'broadcast',
      topic: 'test_topic',
      message: 'Hello',
    },
  };
}

describe('GroupChat', () => {
  describe('createGroupChat', () => {
    it('should create GroupChat instance with valid config', () => {
      const gc = createGroupChat(baseConfig);
      expect(gc).toBeInstanceOf(GroupChat);
      expect(gc.getTopicArn()).toBeUndefined();
      expect(gc.getSubscriptions()).toEqual([]);
    });

    it('should accept existing topic ARN in config', () => {
      const gc = createGroupChat({
        ...baseConfig,
        topicArn: 'arn:aws:sns:us-east-1:TESTACCT:existing-topic',
      });

      expect(gc.getTopicArn()).toBe('arn:aws:sns:us-east-1:TESTACCT:existing-topic');
    });
  });

  describe('AWS lifecycle methods throw "not implemented"', () => {
    let gc: GroupChat;

    beforeEach(() => {
      gc = createGroupChat(baseConfig);
    });

    it('createGroup should throw', async () => {
      await expect(gc.createGroup()).rejects.toThrow('not implemented');
    });

    it('addAgent should throw', async () => {
      await expect(gc.addAgent('agent-1')).rejects.toThrow('not implemented');
    });

    it('removeAgent should throw', async () => {
      await expect(gc.removeAgent('agent-1')).rejects.toThrow('not implemented');
    });

    it('publish should throw', async () => {
      await expect(gc.publish(buildMessage(baseConfig.groupId))).rejects.toThrow(
        'not implemented'
      );
    });

    it('receive should throw', async () => {
      await expect(gc.receive('agent-1')).rejects.toThrow('not implemented');
    });

    it('deleteGroup should throw', async () => {
      await expect(gc.deleteGroup()).rejects.toThrow('not implemented');
    });
  });

  describe('getMetrics', () => {
    it('should return initial metrics', () => {
      const gc = createGroupChat(baseConfig);
      const metrics = gc.getMetrics();

      expect(metrics.messagesPublished).toBe(0);
      expect(metrics.messagesReceived).toBe(0);
      expect(metrics.activeSubscriptions).toBe(0);
      expect(metrics.failedDeliveries).toBe(0);
      expect(metrics.lastActivityAt).toBeTruthy();
    });
  });

  describe('GroupChatMessageBuilder (pure data)', () => {
    const groupId = 'swarm-abc';
    const tenantId = 'tenant-123';
    const sourceAgentId = 'agent-1';

    it('should build status message', () => {
      const message = GroupChatMessageBuilder.status(
        groupId,
        tenantId,
        sourceAgentId,
        'Task in progress',
        { progress: 50 }
      );

      expect(message.type).toBe('broadcast');
      expect(message.priority).toBe('normal');
      expect(message.payload.topic).toBe('agent_status');
      expect(message.payload.message).toBe('Task in progress');
      expect(message.payload.data).toEqual({ progress: 50 });
    });

    it('should build question message', () => {
      const message = GroupChatMessageBuilder.question(
        groupId,
        tenantId,
        sourceAgentId,
        'Need help with schema?'
      );

      expect(message.priority).toBe('high');
      expect(message.payload.topic).toBe('agent_question');
    });

    it('should build result message', () => {
      const message = GroupChatMessageBuilder.result(
        groupId,
        tenantId,
        sourceAgentId,
        'Task completed'
      );

      expect(message.priority).toBe('normal');
      expect(message.payload.topic).toBe('agent_result');
    });

    it('should build error message', () => {
      const message = GroupChatMessageBuilder.error(
        groupId,
        tenantId,
        sourceAgentId,
        'Database connection failed',
        'DB_CONN_ERROR'
      );

      expect(message.priority).toBe('urgent');
      expect(message.payload.topic).toBe('agent_error');
      expect(message.payload.data).toEqual({ errorCode: 'DB_CONN_ERROR' });
    });

    it('should build event notification message', () => {
      const message = GroupChatMessageBuilder.event(
        groupId,
        tenantId,
        sourceAgentId,
        'task_completed',
        { taskId: 'task-123', duration: 5000 }
      );

      expect(message.type).toBe('event');
      expect(message.priority).toBe('low');
      expect(message.payload.type).toBe('event');
      expect(message.payload.eventType).toBe('task_completed');
    });
  });
});
