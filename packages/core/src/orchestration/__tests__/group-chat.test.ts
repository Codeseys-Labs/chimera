/**
 * Comprehensive unit tests for GroupChat
 *
 * Tests SNS/SQS fan-out pattern for multi-agent pub-sub communication:
 * group creation, agent subscription/unsubscription, message publishing,
 * message receiving, group deletion, metrics, and message builders.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  GroupChat,
  createGroupChat,
  GroupChatMessageBuilder,
  type GroupChatConfig,
  type GroupChatMessage,
  type GroupChatMetrics,
  type AgentSubscription,
} from '../groupchat';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig(overrides?: Partial<GroupChatConfig>): GroupChatConfig {
  return {
    tenantId: 'tenant-123',
    groupId: 'swarm-alpha',
    region: 'us-east-1',
    agentIds: ['agent-1', 'agent-2', 'agent-3'],
    ...overrides,
  };
}

function buildTestMessage(
  groupId: string,
  overrides?: Partial<GroupChatMessage>
): GroupChatMessage {
  return {
    messageId: 'test-msg-1',
    type: 'broadcast',
    sourceAgentId: 'agent-1',
    tenantId: 'tenant-123',
    groupId,
    visibility: 'group',
    priority: 'normal',
    timestamp: new Date().toISOString(),
    payload: {
      type: 'broadcast',
      topic: 'test_topic',
      message: 'Hello from agent-1!',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GroupChat', () => {
  let groupChat: GroupChat;

  beforeEach(() => {
    groupChat = new GroupChat(defaultConfig());
  });

  // =========================================================================
  // createGroupChat factory
  // =========================================================================

  describe('createGroupChat', () => {
    it('should create GroupChat instance', () => {
      const gc = createGroupChat(defaultConfig());
      expect(gc).toBeInstanceOf(GroupChat);
    });

    it('should initialize without topic ARN', () => {
      const gc = createGroupChat(defaultConfig());
      expect(gc.getTopicArn()).toBeUndefined();
    });

    it('should initialize with no subscriptions', () => {
      const gc = createGroupChat(defaultConfig());
      expect(gc.getSubscriptions()).toEqual([]);
    });

    it('should accept pre-existing topic ARN', () => {
      const gc = createGroupChat(defaultConfig({ topicArn: 'arn:aws:sns:us-east-1:123:existing' }));
      expect(gc.getTopicArn()).toBe('arn:aws:sns:us-east-1:123:existing');
    });
  });

  // =========================================================================
  // createGroup
  // =========================================================================

  describe('createGroup', () => {
    it('should create SNS topic and return ARN', async () => {
      const topicArn = await groupChat.createGroup();

      expect(topicArn).toMatch(/^arn:aws:sns:/);
      expect(topicArn).toContain('chimera-groupchat');
      expect(topicArn).toContain('tenant-123');
      expect(topicArn).toContain('swarm-alpha');
    });

    it('should store topic ARN after creation', async () => {
      await groupChat.createGroup();
      expect(groupChat.getTopicArn()).toBeTruthy();
    });

    it('should return same ARN on repeated calls (idempotent)', async () => {
      const arn1 = await groupChat.createGroup();
      const arn2 = await groupChat.createGroup();
      expect(arn1).toBe(arn2);
    });

    it('should use the configured region in the ARN', async () => {
      const gc = new GroupChat(defaultConfig({ region: 'eu-west-1' }));
      const arn = await gc.createGroup();
      expect(arn).toContain('eu-west-1');
    });

    it('should default region to us-east-1 when not specified', async () => {
      const gc = new GroupChat(defaultConfig({ region: undefined }));
      const arn = await gc.createGroup();
      expect(arn).toContain('us-east-1');
    });
  });

  // =========================================================================
  // addAgent (addParticipant)
  // =========================================================================

  describe('addAgent', () => {
    it('should add agent with active subscription', async () => {
      await groupChat.createGroup();
      const sub = await groupChat.addAgent('agent-1');

      expect(sub.agentId).toBe('agent-1');
      expect(sub.status).toBe('active');
      expect(sub.queueUrl).toBeTruthy();
      expect(sub.queueArn).toBeTruthy();
      expect(sub.subscriptionArn).toBeTruthy();
    });

    it('should include tenant/group/agent in queue name', async () => {
      await groupChat.createGroup();
      const sub = await groupChat.addAgent('agent-1');

      expect(sub.queueUrl).toContain('tenant-123');
      expect(sub.queueUrl).toContain('swarm-alpha');
      expect(sub.queueUrl).toContain('agent-1');
    });

    it('should auto-create group if not exists', async () => {
      expect(groupChat.getTopicArn()).toBeUndefined();

      await groupChat.addAgent('agent-1');

      expect(groupChat.getTopicArn()).toBeTruthy();
    });

    it('should return existing subscription on duplicate add', async () => {
      await groupChat.createGroup();
      const sub1 = await groupChat.addAgent('agent-1');
      const sub2 = await groupChat.addAgent('agent-1');

      expect(sub1).toEqual(sub2);
    });

    it('should increment activeSubscriptions metric', async () => {
      await groupChat.createGroup();
      expect(groupChat.getMetrics().activeSubscriptions).toBe(0);

      await groupChat.addAgent('agent-1');
      expect(groupChat.getMetrics().activeSubscriptions).toBe(1);

      await groupChat.addAgent('agent-2');
      expect(groupChat.getMetrics().activeSubscriptions).toBe(2);
    });

    it('should track all subscriptions in getSubscriptions()', async () => {
      await groupChat.createGroup();
      await groupChat.addAgent('agent-1');
      await groupChat.addAgent('agent-2');
      await groupChat.addAgent('agent-3');

      const subs = groupChat.getSubscriptions();
      expect(subs).toHaveLength(3);
      expect(subs.map((s) => s.agentId).sort()).toEqual(['agent-1', 'agent-2', 'agent-3']);
    });
  });

  // =========================================================================
  // removeAgent (removeParticipant)
  // =========================================================================

  describe('removeAgent', () => {
    it('should remove agent from subscriptions', async () => {
      await groupChat.addAgent('agent-1');
      expect(groupChat.isSubscribed('agent-1')).toBe(true);

      await groupChat.removeAgent('agent-1');

      expect(groupChat.isSubscribed('agent-1')).toBe(false);
      expect(groupChat.getSubscriptions()).toHaveLength(0);
    });

    it('should decrement activeSubscriptions metric', async () => {
      await groupChat.addAgent('agent-1');
      await groupChat.addAgent('agent-2');
      expect(groupChat.getMetrics().activeSubscriptions).toBe(2);

      await groupChat.removeAgent('agent-1');
      expect(groupChat.getMetrics().activeSubscriptions).toBe(1);
    });

    it('should not throw for non-subscribed agent', async () => {
      await expect(groupChat.removeAgent('non-existent')).resolves.toBeUndefined();
    });

    it('should allow re-adding agent after removal', async () => {
      await groupChat.addAgent('agent-1');
      await groupChat.removeAgent('agent-1');

      const sub = await groupChat.addAgent('agent-1');
      expect(sub.agentId).toBe('agent-1');
      expect(sub.status).toBe('active');
      expect(groupChat.isSubscribed('agent-1')).toBe(true);
    });
  });

  // =========================================================================
  // isSubscribed
  // =========================================================================

  describe('isSubscribed', () => {
    it('should return true for subscribed agents', async () => {
      await groupChat.addAgent('agent-1');
      expect(groupChat.isSubscribed('agent-1')).toBe(true);
    });

    it('should return false for non-subscribed agents', () => {
      expect(groupChat.isSubscribed('agent-1')).toBe(false);
    });

    it('should return false after agent is removed', async () => {
      await groupChat.addAgent('agent-1');
      await groupChat.removeAgent('agent-1');
      expect(groupChat.isSubscribed('agent-1')).toBe(false);
    });
  });

  // =========================================================================
  // publish (sendMessage)
  // =========================================================================

  describe('publish', () => {
    it('should publish message and return message ID', async () => {
      await groupChat.createGroup();

      const msg = buildTestMessage('swarm-alpha');
      const messageId = await groupChat.publish(msg);

      expect(messageId).toBeTruthy();
      expect(messageId).toMatch(/^msg-/);
    });

    it('should increment messagesPublished metric', async () => {
      await groupChat.createGroup();

      await groupChat.publish(buildTestMessage('swarm-alpha'));
      await groupChat.publish(buildTestMessage('swarm-alpha'));

      expect(groupChat.getMetrics().messagesPublished).toBe(2);
    });

    it('should update lastActivityAt on publish', async () => {
      await groupChat.createGroup();
      const before = groupChat.getMetrics().lastActivityAt;

      await new Promise((r) => setTimeout(r, 10));
      await groupChat.publish(buildTestMessage('swarm-alpha'));

      const after = groupChat.getMetrics().lastActivityAt;
      expect(after >= before).toBe(true);
    });

    it('should throw if group not initialized (no topic)', async () => {
      const msg = buildTestMessage('swarm-alpha');
      await expect(groupChat.publish(msg)).rejects.toThrow(
        'GroupChat not initialized. Call createGroup() first.'
      );
    });

    it('should throw if message groupId does not match config', async () => {
      await groupChat.createGroup();

      const msg = buildTestMessage('wrong-group-id');
      await expect(groupChat.publish(msg)).rejects.toThrow('groupId mismatch');
    });

    it('should accept various message types', async () => {
      await groupChat.createGroup();

      const broadcastMsg = buildTestMessage('swarm-alpha', { type: 'broadcast' });
      const eventMsg = buildTestMessage('swarm-alpha', { type: 'event' });
      const requestMsg = buildTestMessage('swarm-alpha', { type: 'request' });

      await expect(groupChat.publish(broadcastMsg)).resolves.toBeTruthy();
      await expect(groupChat.publish(eventMsg)).resolves.toBeTruthy();
      await expect(groupChat.publish(requestMsg)).resolves.toBeTruthy();
    });
  });

  // =========================================================================
  // receive
  // =========================================================================

  describe('receive', () => {
    it('should return empty array from placeholder implementation', async () => {
      await groupChat.addAgent('agent-1');
      const messages = await groupChat.receive('agent-1');

      expect(Array.isArray(messages)).toBe(true);
      expect(messages).toEqual([]);
    });

    it('should throw if agent not subscribed', async () => {
      await expect(groupChat.receive('non-existent')).rejects.toThrow(
        'Agent not subscribed: non-existent'
      );
    });

    it('should accept receive options', async () => {
      await groupChat.addAgent('agent-1');
      const messages = await groupChat.receive('agent-1', {
        maxMessages: 5,
        waitTimeSeconds: 10,
      });

      expect(messages).toEqual([]);
    });

    it('should throw after agent is removed', async () => {
      await groupChat.addAgent('agent-1');
      await groupChat.removeAgent('agent-1');

      await expect(groupChat.receive('agent-1')).rejects.toThrow('Agent not subscribed');
    });
  });

  // =========================================================================
  // deleteGroup
  // =========================================================================

  describe('deleteGroup', () => {
    it('should remove all subscriptions and clear topic ARN', async () => {
      await groupChat.addAgent('agent-1');
      await groupChat.addAgent('agent-2');

      expect(groupChat.getSubscriptions()).toHaveLength(2);
      expect(groupChat.getTopicArn()).toBeTruthy();

      await groupChat.deleteGroup();

      expect(groupChat.getSubscriptions()).toHaveLength(0);
      expect(groupChat.getTopicArn()).toBeUndefined();
      expect(groupChat.getMetrics().activeSubscriptions).toBe(0);
    });

    it('should not throw when no topic exists', async () => {
      await expect(groupChat.deleteGroup()).resolves.toBeUndefined();
    });

    it('should not throw when topic exists but no agents', async () => {
      await groupChat.createGroup();
      await expect(groupChat.deleteGroup()).resolves.toBeUndefined();
      expect(groupChat.getTopicArn()).toBeUndefined();
    });
  });

  // =========================================================================
  // getMetrics
  // =========================================================================

  describe('getMetrics', () => {
    it('should return initial metrics with zero counts', () => {
      const metrics = groupChat.getMetrics();

      expect(metrics.messagesPublished).toBe(0);
      expect(metrics.messagesReceived).toBe(0);
      expect(metrics.activeSubscriptions).toBe(0);
      expect(metrics.failedDeliveries).toBe(0);
      expect(metrics.lastActivityAt).toBeTruthy();
    });

    it('should return a copy (not a reference)', () => {
      const m1 = groupChat.getMetrics();
      m1.messagesPublished = 999;

      const m2 = groupChat.getMetrics();
      expect(m2.messagesPublished).toBe(0);
    });

    it('should accumulate metrics across operations', async () => {
      await groupChat.createGroup();
      await groupChat.addAgent('agent-1');
      await groupChat.addAgent('agent-2');

      await groupChat.publish(buildTestMessage('swarm-alpha'));
      await groupChat.publish(buildTestMessage('swarm-alpha'));
      await groupChat.publish(buildTestMessage('swarm-alpha'));

      const metrics = groupChat.getMetrics();
      expect(metrics.activeSubscriptions).toBe(2);
      expect(metrics.messagesPublished).toBe(3);
    });
  });

  // =========================================================================
  // getTopicArn
  // =========================================================================

  describe('getTopicArn', () => {
    it('should return undefined before createGroup', () => {
      expect(groupChat.getTopicArn()).toBeUndefined();
    });

    it('should return ARN after createGroup', async () => {
      await groupChat.createGroup();
      expect(groupChat.getTopicArn()).toMatch(/^arn:aws:sns:/);
    });

    it('should return undefined after deleteGroup', async () => {
      await groupChat.createGroup();
      await groupChat.deleteGroup();
      expect(groupChat.getTopicArn()).toBeUndefined();
    });
  });

  // =========================================================================
  // GroupChatMessageBuilder
  // =========================================================================

  describe('GroupChatMessageBuilder', () => {
    const groupId = 'swarm-alpha';
    const tenantId = 'tenant-123';
    const source = 'agent-1';

    describe('status', () => {
      it('should build status update message', () => {
        const msg = GroupChatMessageBuilder.status(groupId, tenantId, source, 'Processing...', {
          progress: 50,
        });

        expect(msg.type).toBe('broadcast');
        expect(msg.groupId).toBe(groupId);
        expect(msg.tenantId).toBe(tenantId);
        expect(msg.sourceAgentId).toBe(source);
        expect(msg.visibility).toBe('group');
        expect(msg.priority).toBe('normal');
        expect(msg.messageId).toMatch(/^gchat-status-/);
        expect(msg.timestamp).toBeTruthy();
        expect(msg.payload.type).toBe('broadcast');
        expect(msg.payload.topic).toBe('agent_status');
        expect(msg.payload.message).toBe('Processing...');
        expect(msg.payload.data).toEqual({ progress: 50 });
      });

      it('should work without optional data', () => {
        const msg = GroupChatMessageBuilder.status(groupId, tenantId, source, 'Done');
        expect(msg.payload.data).toBeUndefined();
      });
    });

    describe('question', () => {
      it('should build high-priority question message', () => {
        const msg = GroupChatMessageBuilder.question(
          groupId,
          tenantId,
          source,
          'What schema to use?',
          { table: 'users' }
        );

        expect(msg.priority).toBe('high');
        expect(msg.payload.topic).toBe('agent_question');
        expect(msg.payload.message).toBe('What schema to use?');
        expect(msg.payload.data).toEqual({ table: 'users' });
        expect(msg.messageId).toMatch(/^gchat-question-/);
      });
    });

    describe('result', () => {
      it('should build result message', () => {
        const msg = GroupChatMessageBuilder.result(groupId, tenantId, source, 'Analysis complete', {
          score: 0.95,
        });

        expect(msg.priority).toBe('normal');
        expect(msg.payload.topic).toBe('agent_result');
        expect(msg.payload.message).toBe('Analysis complete');
        expect(msg.payload.data).toEqual({ score: 0.95 });
        expect(msg.messageId).toMatch(/^gchat-result-/);
      });
    });

    describe('error', () => {
      it('should build urgent error message', () => {
        const msg = GroupChatMessageBuilder.error(
          groupId,
          tenantId,
          source,
          'Connection failed',
          'DB_CONN_ERR'
        );

        expect(msg.priority).toBe('urgent');
        expect(msg.payload.topic).toBe('agent_error');
        expect(msg.payload.message).toBe('Connection failed');
        expect(msg.payload.data).toEqual({ errorCode: 'DB_CONN_ERR' });
        expect(msg.messageId).toMatch(/^gchat-error-/);
      });

      it('should work without error code', () => {
        const msg = GroupChatMessageBuilder.error(groupId, tenantId, source, 'Unknown error');
        expect(msg.payload.data).toEqual({ errorCode: undefined });
      });
    });

    describe('event', () => {
      it('should build low-priority event message', () => {
        const msg = GroupChatMessageBuilder.event(groupId, tenantId, source, 'task_completed', {
          taskId: 'task-123',
          duration: 5000,
        });

        expect(msg.type).toBe('event');
        expect(msg.priority).toBe('low');
        expect(msg.payload.type).toBe('event');
        expect(msg.payload.eventType).toBe('task_completed');
        expect(msg.payload.eventData).toEqual({ taskId: 'task-123', duration: 5000 });
        expect(msg.messageId).toMatch(/^gchat-event-/);
      });
    });

    describe('message IDs', () => {
      it('should generate unique message IDs', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 20; i++) {
          const msg = GroupChatMessageBuilder.status(groupId, tenantId, source, `msg ${i}`);
          ids.add(msg.messageId);
        }
        expect(ids.size).toBe(20);
      });
    });
  });
});
