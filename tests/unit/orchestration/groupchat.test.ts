/**
 * GroupChat Test Suite
 *
 * Tests SNS/SQS fan-out pattern for multi-agent communication
 */

import {
  GroupChat,
  createGroupChat,
  GroupChatMessageBuilder,
  type GroupChatConfig,
  type GroupChatMessage,
} from '../../../packages/core/src/orchestration/groupchat';

describe('GroupChat', () => {
  describe('createGroupChat', () => {
    it('should create GroupChat instance with valid config', () => {
      const config: GroupChatConfig = {
        tenantId: 'tenant-123',
        groupId: 'swarm-abc',
        region: 'us-east-1',
        agentIds: ['agent-1', 'agent-2', 'agent-3'],
      };

      const groupChat = createGroupChat(config);

      expect(groupChat).toBeInstanceOf(GroupChat);
      expect(groupChat.getTopicArn()).toBeUndefined(); // Topic not created yet
      expect(groupChat.getSubscriptions()).toEqual([]);
    });

    it('should accept existing topic ARN in config', () => {
      const config: GroupChatConfig = {
        tenantId: 'tenant-123',
        groupId: 'swarm-abc',
        region: 'us-east-1',
        agentIds: ['agent-1'],
        topicArn: 'arn:aws:sns:us-east-1:123456789012:existing-topic',
      };

      const groupChat = createGroupChat(config);

      expect(groupChat.getTopicArn()).toBe('arn:aws:sns:us-east-1:123456789012:existing-topic');
    });
  });

  describe('GroupChat lifecycle', () => {
    let groupChat: GroupChat;
    const config: GroupChatConfig = {
      tenantId: 'tenant-123',
      groupId: 'swarm-abc',
      region: 'us-east-1',
      agentIds: ['agent-1', 'agent-2'],
    };

    beforeEach(() => {
      groupChat = createGroupChat(config);
    });

    describe('createGroup', () => {
      it('should create SNS topic and return ARN', async () => {
        const topicArn = await groupChat.createGroup();

        expect(topicArn).toBeTruthy();
        expect(topicArn).toContain('arn:aws:sns');
        expect(topicArn).toContain('chimera-groupchat');
        expect(topicArn).toContain(config.tenantId);
        expect(topicArn).toContain(config.groupId);
      });

      it('should return existing topic ARN if already created', async () => {
        const topicArn1 = await groupChat.createGroup();
        const topicArn2 = await groupChat.createGroup();

        expect(topicArn1).toBe(topicArn2);
      });
    });

    describe('addAgent', () => {
      it('should add agent with SQS queue and SNS subscription', async () => {
        await groupChat.createGroup();

        const subscription = await groupChat.addAgent('agent-1');

        expect(subscription.agentId).toBe('agent-1');
        expect(subscription.queueUrl).toBeTruthy();
        expect(subscription.queueArn).toBeTruthy();
        expect(subscription.subscriptionArn).toBeTruthy();
        expect(subscription.status).toBe('active');
      });

      it('should create topic automatically if not exists', async () => {
        expect(groupChat.getTopicArn()).toBeUndefined();

        await groupChat.addAgent('agent-1');

        expect(groupChat.getTopicArn()).toBeTruthy();
      });

      it('should return existing subscription if agent already added', async () => {
        await groupChat.createGroup();
        const subscription1 = await groupChat.addAgent('agent-1');
        const subscription2 = await groupChat.addAgent('agent-1');

        expect(subscription1).toEqual(subscription2);
      });

      it('should increment active subscriptions metric', async () => {
        await groupChat.createGroup();

        expect(groupChat.getMetrics().activeSubscriptions).toBe(0);

        await groupChat.addAgent('agent-1');
        expect(groupChat.getMetrics().activeSubscriptions).toBe(1);

        await groupChat.addAgent('agent-2');
        expect(groupChat.getMetrics().activeSubscriptions).toBe(2);
      });

      it('should track subscription in getSubscriptions()', async () => {
        await groupChat.createGroup();
        await groupChat.addAgent('agent-1');
        await groupChat.addAgent('agent-2');

        const subscriptions = groupChat.getSubscriptions();

        expect(subscriptions).toHaveLength(2);
        expect(subscriptions.map((s) => s.agentId)).toEqual(['agent-1', 'agent-2']);
      });
    });

    describe('isSubscribed', () => {
      it('should return true for subscribed agents', async () => {
        await groupChat.addAgent('agent-1');

        expect(groupChat.isSubscribed('agent-1')).toBe(true);
        expect(groupChat.isSubscribed('agent-2')).toBe(false);
      });
    });

    describe('removeAgent', () => {
      it('should remove agent subscription and delete queue', async () => {
        await groupChat.addAgent('agent-1');
        expect(groupChat.isSubscribed('agent-1')).toBe(true);

        await groupChat.removeAgent('agent-1');

        expect(groupChat.isSubscribed('agent-1')).toBe(false);
        expect(groupChat.getMetrics().activeSubscriptions).toBe(0);
      });

      it('should not throw if agent not subscribed', async () => {
        await expect(groupChat.removeAgent('non-existent')).resolves.toBeUndefined();
      });
    });

    describe('publish', () => {
      it('should publish message to SNS topic', async () => {
        await groupChat.createGroup();

        const message: GroupChatMessage = {
          messageId: 'test-msg-1',
          type: 'broadcast',
          sourceAgentId: 'agent-1',
          tenantId: config.tenantId,
          groupId: config.groupId,
          visibility: 'group',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          payload: {
            type: 'broadcast',
            topic: 'test_topic',
            message: 'Hello group!',
          },
        };

        const messageId = await groupChat.publish(message);

        expect(messageId).toBeTruthy();
        expect(groupChat.getMetrics().messagesPublished).toBe(1);
      });

      it('should throw if group not initialized', async () => {
        const message: GroupChatMessage = {
          messageId: 'test-msg-1',
          type: 'broadcast',
          sourceAgentId: 'agent-1',
          tenantId: config.tenantId,
          groupId: config.groupId,
          visibility: 'group',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          payload: {
            type: 'broadcast',
            topic: 'test_topic',
            message: 'Hello group!',
          },
        };

        await expect(groupChat.publish(message)).rejects.toThrow(
          'GroupChat not initialized'
        );
      });

      it('should throw if message groupId mismatch', async () => {
        await groupChat.createGroup();

        const message: GroupChatMessage = {
          messageId: 'test-msg-1',
          type: 'broadcast',
          sourceAgentId: 'agent-1',
          tenantId: config.tenantId,
          groupId: 'wrong-group-id',
          visibility: 'group',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          payload: {
            type: 'broadcast',
            topic: 'test_topic',
            message: 'Hello group!',
          },
        };

        await expect(groupChat.publish(message)).rejects.toThrow('groupId mismatch');
      });
    });

    describe('receive', () => {
      it('should poll messages from agent SQS queue', async () => {
        await groupChat.addAgent('agent-1');

        const messages = await groupChat.receive('agent-1');

        expect(Array.isArray(messages)).toBe(true);
        // Placeholder returns empty array
        expect(messages).toEqual([]);
      });

      it('should throw if agent not subscribed', async () => {
        await expect(groupChat.receive('non-existent')).rejects.toThrow(
          'Agent not subscribed'
        );
      });

      it('should accept receive options', async () => {
        await groupChat.addAgent('agent-1');

        const messages = await groupChat.receive('agent-1', {
          maxMessages: 5,
          waitTimeSeconds: 10,
        });

        expect(Array.isArray(messages)).toBe(true);
      });
    });

    describe('deleteGroup', () => {
      it('should delete all subscriptions and topic', async () => {
        await groupChat.addAgent('agent-1');
        await groupChat.addAgent('agent-2');

        expect(groupChat.getSubscriptions()).toHaveLength(2);
        expect(groupChat.getTopicArn()).toBeTruthy();

        await groupChat.deleteGroup();

        expect(groupChat.getSubscriptions()).toHaveLength(0);
        expect(groupChat.getTopicArn()).toBeUndefined();
        expect(groupChat.getMetrics().activeSubscriptions).toBe(0);
      });

      it('should not throw if no topic exists', async () => {
        await expect(groupChat.deleteGroup()).resolves.toBeUndefined();
      });
    });

    describe('getMetrics', () => {
      it('should return initial metrics', () => {
        const metrics = groupChat.getMetrics();

        expect(metrics.messagesPublished).toBe(0);
        expect(metrics.messagesReceived).toBe(0);
        expect(metrics.activeSubscriptions).toBe(0);
        expect(metrics.failedDeliveries).toBe(0);
        expect(metrics.lastActivityAt).toBeTruthy();
      });

      it('should update metrics on operations', async () => {
        await groupChat.createGroup();
        await groupChat.addAgent('agent-1');

        const message: GroupChatMessage = {
          messageId: 'test-msg-1',
          type: 'broadcast',
          sourceAgentId: 'agent-1',
          tenantId: config.tenantId,
          groupId: config.groupId,
          visibility: 'group',
          priority: 'normal',
          timestamp: new Date().toISOString(),
          payload: {
            type: 'broadcast',
            topic: 'test_topic',
            message: 'Hello!',
          },
        };

        await groupChat.publish(message);

        const metrics = groupChat.getMetrics();
        expect(metrics.messagesPublished).toBe(1);
        expect(metrics.activeSubscriptions).toBe(1);
      });
    });
  });

  describe('GroupChatMessageBuilder', () => {
    const groupId = 'swarm-abc';
    const tenantId = 'tenant-123';
    const sourceAgentId = 'agent-1';

    describe('status', () => {
      it('should build status message', () => {
        const message = GroupChatMessageBuilder.status(
          groupId,
          tenantId,
          sourceAgentId,
          'Task in progress',
          { progress: 50 }
        );

        expect(message.type).toBe('broadcast');
        expect(message.groupId).toBe(groupId);
        expect(message.tenantId).toBe(tenantId);
        expect(message.sourceAgentId).toBe(sourceAgentId);
        expect(message.priority).toBe('normal');
        expect(message.payload.type).toBe('broadcast');
        expect(message.payload.topic).toBe('agent_status');
        expect(message.payload.message).toBe('Task in progress');
        expect(message.payload.data).toEqual({ progress: 50 });
      });
    });

    describe('question', () => {
      it('should build question message', () => {
        const message = GroupChatMessageBuilder.question(
          groupId,
          tenantId,
          sourceAgentId,
          'Need help with schema?',
          { schema: 'users' }
        );

        expect(message.type).toBe('broadcast');
        expect(message.priority).toBe('high');
        expect(message.payload.topic).toBe('agent_question');
        expect(message.payload.message).toBe('Need help with schema?');
      });
    });

    describe('result', () => {
      it('should build result message', () => {
        const message = GroupChatMessageBuilder.result(
          groupId,
          tenantId,
          sourceAgentId,
          'Task completed',
          { output: 'success' }
        );

        expect(message.type).toBe('broadcast');
        expect(message.priority).toBe('normal');
        expect(message.payload.topic).toBe('agent_result');
        expect(message.payload.message).toBe('Task completed');
      });
    });

    describe('error', () => {
      it('should build error message', () => {
        const message = GroupChatMessageBuilder.error(
          groupId,
          tenantId,
          sourceAgentId,
          'Database connection failed',
          'DB_CONN_ERROR'
        );

        expect(message.type).toBe('broadcast');
        expect(message.priority).toBe('urgent');
        expect(message.payload.topic).toBe('agent_error');
        expect(message.payload.message).toBe('Database connection failed');
        expect(message.payload.data).toEqual({ errorCode: 'DB_CONN_ERROR' });
      });
    });

    describe('event', () => {
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
        expect(message.payload.eventData).toEqual({
          taskId: 'task-123',
          duration: 5000,
        });
      });
    });
  });
});
