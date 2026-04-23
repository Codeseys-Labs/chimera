/**
 * Unit tests for GroupChat
 *
 * Every mutating lifecycle method on GroupChat (createGroup, addAgent,
 * removeAgent, publish, receive, deleteGroup) is a skeleton with no SNS
 * or SQS integration — the prior implementation fabricated ARNs and queue
 * URLs containing the placeholder account ID `123456789012` (Wave-14
 * audit M1/M2). Those methods now throw `not implemented`. These tests
 * lock that contract in place and preserve coverage for the still-real
 * surface: constructor, getters, and the pure-data message builders.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  GroupChat,
  createGroupChat,
  GroupChatMessageBuilder,
  type GroupChatConfig,
  type GroupChatMessage,
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
  // createGroupChat factory + constructor
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
      const gc = createGroupChat(
        defaultConfig({ topicArn: 'arn:aws:sns:us-east-1:TESTACCT:existing' })
      );
      expect(gc.getTopicArn()).toBe('arn:aws:sns:us-east-1:TESTACCT:existing');
    });
  });

  // =========================================================================
  // Guard contract — all AWS-facing methods throw "not implemented"
  // =========================================================================

  describe('AWS lifecycle methods throw "not implemented"', () => {
    it('createGroup should throw', async () => {
      await expect(groupChat.createGroup()).rejects.toThrow('not implemented');
    });

    it('addAgent should throw', async () => {
      await expect(groupChat.addAgent('agent-1')).rejects.toThrow('not implemented');
    });

    it('removeAgent should throw', async () => {
      await expect(groupChat.removeAgent('agent-1')).rejects.toThrow('not implemented');
    });

    it('publish should throw', async () => {
      await expect(groupChat.publish(buildTestMessage('swarm-alpha'))).rejects.toThrow(
        'not implemented'
      );
    });

    it('receive should throw', async () => {
      await expect(groupChat.receive('agent-1')).rejects.toThrow('not implemented');
    });

    it('deleteGroup should throw', async () => {
      await expect(groupChat.deleteGroup()).rejects.toThrow('not implemented');
    });
  });

  // =========================================================================
  // Getters still work (no AWS calls)
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
  });

  describe('isSubscribed', () => {
    it('should return false for non-subscribed agents', () => {
      expect(groupChat.isSubscribed('agent-1')).toBe(false);
    });
  });

  describe('getTopicArn', () => {
    it('should return undefined before createGroup is successfully run', () => {
      expect(groupChat.getTopicArn()).toBeUndefined();
    });

    it('should return a pre-injected topic ARN from config', () => {
      const gc = new GroupChat(
        defaultConfig({ topicArn: 'arn:aws:sns:us-east-1:TESTACCT:inj' })
      );
      expect(gc.getTopicArn()).toBe('arn:aws:sns:us-east-1:TESTACCT:inj');
    });
  });

  // =========================================================================
  // GroupChatMessageBuilder (pure data, no AWS)
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
