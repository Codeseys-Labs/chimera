/**
 * Tests for PersistenceListener — session metadata writes
 *
 * Mocks DynamoDBDocumentClient to verify PK/SK patterns, session lifecycle,
 * and message persistence without hitting real AWS infrastructure.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// DynamoDB mock infrastructure — must be set up BEFORE importing the module
// ---------------------------------------------------------------------------

interface CapturedCommand {
  type: string;
  input: any;
}

const capturedCommands: CapturedCommand[] = [];
let getCommandResponse: any = { Item: undefined };

const mockSend = mock(async (command: any) => {
  const type = command?._type || 'unknown';
  capturedCommands.push({ type, input: command.input });

  if (type === 'GetCommand') {
    return getCommandResponse;
  }
  return {};
});

// Mock @aws-sdk/client-dynamodb — must happen before import of persistence-listener
mock.module('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class MockDynamoDBClient {},
}));

// Mock @aws-sdk/lib-dynamodb — the module under test calls DynamoDBDocumentClient.from() at load time
mock.module('@aws-sdk/lib-dynamodb', () => {
  class PutCommand {
    _type = 'PutCommand';
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  class UpdateCommand {
    _type = 'UpdateCommand';
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  class GetCommand {
    _type = 'GetCommand';
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  return {
    DynamoDBDocumentClient: {
      from: () => ({ send: mockSend }),
    },
    PutCommand,
    UpdateCommand,
    GetCommand,
  };
});

// NOW import the module under test (after mocks are in place)
const { createPersistenceListener } = await import('../persistence-listener');
type PersistenceOpts = Parameters<typeof createPersistenceListener>[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOpts(overrides?: Partial<PersistenceOpts>): PersistenceOpts {
  return {
    messageId: 'msg_abc123',
    sessionId: 'sess_001',
    tenantId: 'tenant_42',
    userId: 'user_99',
    userContent: 'Hello, what can you do?',
    ...overrides,
  };
}

/** Wait for fire-and-forget async operations to settle */
async function settle(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersistenceListener — session metadata', () => {
  beforeEach(() => {
    capturedCommands.length = 0;
    getCommandResponse = { Item: undefined }; // No existing session by default
    mockSend.mockClear();
  });

  describe('initial writes on creation', () => {
    it('should create user message with correct PK/SK pattern', async () => {
      createPersistenceListener(defaultOpts());
      await settle();

      const userPut = capturedCommands.find(
        (c) => c.type === 'PutCommand' && c.input?.Item?.role === 'user'
      );
      expect(userPut).toBeDefined();
      expect(userPut!.input.Item.PK).toBe('TENANT#tenant_42#SESSION#sess_001');
      expect(userPut!.input.Item.SK).toMatch(/^MSG#\d+#user$/);
      expect(userPut!.input.Item.content).toBe('Hello, what can you do?');
      expect(userPut!.input.Item.status).toBe('complete');
    });

    it('should create assistant placeholder with streaming status', async () => {
      createPersistenceListener(defaultOpts());
      await settle();

      const assistantPut = capturedCommands.find(
        (c) => c.type === 'PutCommand' && c.input?.Item?.role === 'assistant'
      );
      expect(assistantPut).toBeDefined();
      expect(assistantPut!.input.Item.PK).toBe('TENANT#tenant_42#SESSION#sess_001');
      expect(assistantPut!.input.Item.SK).toMatch(/^MSG#\d+#msg_abc123$/);
      expect(assistantPut!.input.Item.content).toBe('');
      expect(assistantPut!.input.Item.status).toBe('streaming');
      expect(assistantPut!.input.Item.messageId).toBe('msg_abc123');
    });
  });

  describe('session metadata — new session', () => {
    it('should create session metadata with correct PK/SK', async () => {
      getCommandResponse = { Item: undefined }; // No existing session
      createPersistenceListener(defaultOpts());
      await settle();

      // Should have GetCommand for session check
      const getCmd = capturedCommands.find(
        (c) =>
          c.type === 'GetCommand' &&
          c.input?.Key?.PK === 'TENANT#tenant_42' &&
          c.input?.Key?.SK === 'SESSION#sess_001'
      );
      expect(getCmd).toBeDefined();

      // Should create new session (PK: TENANT#{tenantId}, SK: SESSION#{sessionId})
      const sessionPut = capturedCommands.find(
        (c) =>
          c.type === 'PutCommand' &&
          c.input?.Item?.PK === 'TENANT#tenant_42' &&
          c.input?.Item?.SK === 'SESSION#sess_001'
      );
      expect(sessionPut).toBeDefined();
    });

    it('should derive title from userContent', async () => {
      createPersistenceListener(defaultOpts({ userContent: 'Hello, what can you do?' }));
      await settle();

      const sessionPut = capturedCommands.find(
        (c) =>
          c.type === 'PutCommand' &&
          c.input?.Item?.PK === 'TENANT#tenant_42' &&
          c.input?.Item?.SK === 'SESSION#sess_001'
      );
      expect(sessionPut).toBeDefined();
      expect(sessionPut!.input.Item.title).toBe('Hello, what can you do?');
    });

    it('should truncate title to 80 chars with "..." ellipsis', async () => {
      const longContent = 'A'.repeat(100);
      createPersistenceListener(defaultOpts({ userContent: longContent }));
      await settle();

      const sessionPut = capturedCommands.find(
        (c) =>
          c.type === 'PutCommand' &&
          c.input?.Item?.PK === 'TENANT#tenant_42' &&
          c.input?.Item?.SK === 'SESSION#sess_001'
      );
      expect(sessionPut).toBeDefined();
      expect(sessionPut!.input.Item.title).toBe('A'.repeat(77) + '...');
      expect(sessionPut!.input.Item.title.length).toBe(80);
    });

    it('should not truncate title when content is exactly 80 chars', async () => {
      const exactContent = 'B'.repeat(80);
      createPersistenceListener(defaultOpts({ userContent: exactContent }));
      await settle();

      const sessionPut = capturedCommands.find(
        (c) =>
          c.type === 'PutCommand' &&
          c.input?.Item?.PK === 'TENANT#tenant_42' &&
          c.input?.Item?.SK === 'SESSION#sess_001'
      );
      expect(sessionPut).toBeDefined();
      expect(sessionPut!.input.Item.title).toBe(exactContent);
    });

    it('should set session status to active on creation', async () => {
      createPersistenceListener(defaultOpts());
      await settle();

      const sessionPut = capturedCommands.find(
        (c) =>
          c.type === 'PutCommand' &&
          c.input?.Item?.PK === 'TENANT#tenant_42' &&
          c.input?.Item?.SK === 'SESSION#sess_001'
      );
      expect(sessionPut).toBeDefined();
      expect(sessionPut!.input.Item.status).toBe('active');
    });

    it('should set messageCount to 2 (user + assistant)', async () => {
      createPersistenceListener(defaultOpts());
      await settle();

      const sessionPut = capturedCommands.find(
        (c) =>
          c.type === 'PutCommand' &&
          c.input?.Item?.PK === 'TENANT#tenant_42' &&
          c.input?.Item?.SK === 'SESSION#sess_001'
      );
      expect(sessionPut).toBeDefined();
      expect(sessionPut!.input.Item.messageCount).toBe(2);
    });

    it('should include tenantId, userId, sessionId', async () => {
      createPersistenceListener(defaultOpts());
      await settle();

      const sessionPut = capturedCommands.find(
        (c) =>
          c.type === 'PutCommand' &&
          c.input?.Item?.PK === 'TENANT#tenant_42' &&
          c.input?.Item?.SK === 'SESSION#sess_001'
      );
      expect(sessionPut!.input.Item.tenantId).toBe('tenant_42');
      expect(sessionPut!.input.Item.userId).toBe('user_99');
      expect(sessionPut!.input.Item.sessionId).toBe('sess_001');
    });
  });

  describe('session metadata — existing session', () => {
    it('should update existing session (increment messageCount by 2)', async () => {
      getCommandResponse = {
        Item: {
          PK: 'TENANT#tenant_42',
          SK: 'SESSION#sess_001',
          messageCount: 4,
          status: 'idle',
        },
      };

      createPersistenceListener(defaultOpts());
      await settle();

      const sessionUpdate = capturedCommands.find(
        (c) =>
          c.type === 'UpdateCommand' &&
          c.input?.Key?.PK === 'TENANT#tenant_42' &&
          c.input?.Key?.SK === 'SESSION#sess_001'
      );
      expect(sessionUpdate).toBeDefined();
      expect(sessionUpdate!.input.UpdateExpression).toContain('messageCount');
      expect(sessionUpdate!.input.ExpressionAttributeValues[':two']).toBe(2);
    });
  });

  describe('onPart — text accumulation', () => {
    it('should accumulate text-delta parts (verified on onComplete)', async () => {
      const listener = createPersistenceListener(defaultOpts());
      await settle();
      capturedCommands.length = 0;

      listener.onPart({ type: 'text-delta', delta: 'Hello' });
      listener.onPart({ type: 'text-delta', delta: ' world' });

      await listener.onComplete();

      const updateCmd = capturedCommands.find(
        (c) =>
          c.type === 'UpdateCommand' &&
          c.input?.ExpressionAttributeValues?.[':content'] !== undefined
      );
      expect(updateCmd).toBeDefined();
      expect(updateCmd!.input.ExpressionAttributeValues[':content']).toBe('Hello world');
    });

    it('should support textDelta field name', async () => {
      const listener = createPersistenceListener(defaultOpts());
      await settle();
      capturedCommands.length = 0;

      listener.onPart({ type: 'text-delta', textDelta: 'Using textDelta' });

      await listener.onComplete();

      const updateCmd = capturedCommands.find(
        (c) =>
          c.type === 'UpdateCommand' &&
          c.input?.ExpressionAttributeValues?.[':content'] !== undefined
      );
      expect(updateCmd!.input.ExpressionAttributeValues[':content']).toBe('Using textDelta');
    });
  });

  describe('onComplete', () => {
    it('should set assistant message status to complete', async () => {
      const listener = createPersistenceListener(defaultOpts());
      await settle();
      capturedCommands.length = 0;

      listener.onPart({ type: 'text-delta', delta: 'Done' });
      listener.onPart({ type: 'finish', finishReason: 'stop' });
      await listener.onComplete();

      const completeUpdate = capturedCommands.find(
        (c) =>
          c.type === 'UpdateCommand' &&
          c.input?.ExpressionAttributeValues?.[':status'] === 'complete'
      );
      expect(completeUpdate).toBeDefined();
      expect(completeUpdate!.input.Key.PK).toMatch(/^TENANT#tenant_42#SESSION#sess_001$/);
    });

    it('should set session status to idle', async () => {
      const listener = createPersistenceListener(defaultOpts());
      await settle();
      capturedCommands.length = 0;

      await listener.onComplete();
      await settle();

      const idleUpdate = capturedCommands.find(
        (c) =>
          c.type === 'UpdateCommand' && c.input?.ExpressionAttributeValues?.[':idle'] === 'idle'
      );
      expect(idleUpdate).toBeDefined();
      expect(idleUpdate!.input.Key.PK).toBe('TENANT#tenant_42');
      expect(idleUpdate!.input.Key.SK).toBe('SESSION#sess_001');
    });

    it('should include finishReason in completed message', async () => {
      const listener = createPersistenceListener(defaultOpts());
      await settle();
      capturedCommands.length = 0;

      listener.onPart({ type: 'finish', finishReason: 'stop' });
      await listener.onComplete();

      const completeUpdate = capturedCommands.find(
        (c) =>
          c.type === 'UpdateCommand' &&
          c.input?.ExpressionAttributeValues?.[':status'] === 'complete'
      );
      expect(completeUpdate!.input.ExpressionAttributeValues[':fr']).toBe('stop');
    });

    it('should include tool calls when present', async () => {
      const listener = createPersistenceListener(defaultOpts());
      await settle();
      capturedCommands.length = 0;

      listener.onPart({ type: 'tool-input-start', id: 'tool_1', toolName: 'get_weather' });
      listener.onPart({ type: 'tool-input-delta', delta: '{"loc":"NY"}' });
      listener.onPart({ type: 'tool-result', id: 'tool_1', result: { temp: 72 } });

      await listener.onComplete();

      const completeUpdate = capturedCommands.find(
        (c) =>
          c.type === 'UpdateCommand' &&
          c.input?.ExpressionAttributeValues?.[':status'] === 'complete' &&
          c.input?.ExpressionAttributeValues?.[':tc']
      );
      expect(completeUpdate).toBeDefined();
      const toolCalls = completeUpdate!.input.ExpressionAttributeValues[':tc'];
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe('get_weather');
    });
  });

  describe('onError', () => {
    it('should set assistant message status to error', async () => {
      const listener = createPersistenceListener(defaultOpts());
      await settle();
      capturedCommands.length = 0;

      listener.onPart({ type: 'text-delta', delta: 'Partial content' });
      await listener.onError(new Error('Model timeout'));

      const errorUpdate = capturedCommands.find(
        (c) =>
          c.type === 'UpdateCommand' && c.input?.ExpressionAttributeValues?.[':status'] === 'error'
      );
      expect(errorUpdate).toBeDefined();
      expect(errorUpdate!.input.ExpressionAttributeValues[':content']).toBe('Partial content');
      expect(errorUpdate!.input.ExpressionAttributeValues[':err']).toBe('Model timeout');
    });

    it('should set session status to error', async () => {
      const listener = createPersistenceListener(defaultOpts());
      await settle();
      capturedCommands.length = 0;

      await listener.onError(new Error('Crash'));
      await settle();

      const sessionErrorUpdate = capturedCommands.find(
        (c) =>
          c.type === 'UpdateCommand' &&
          c.input?.Key?.PK === 'TENANT#tenant_42' &&
          c.input?.Key?.SK === 'SESSION#sess_001' &&
          c.input?.ExpressionAttributeValues?.[':err'] === 'error'
      );
      expect(sessionErrorUpdate).toBeDefined();
    });
  });

  describe('onPart — metadata tracking', () => {
    it('should capture usage from data-usage parts', async () => {
      const listener = createPersistenceListener(defaultOpts());
      await settle();
      capturedCommands.length = 0;

      listener.onPart({
        type: 'data-usage',
        data: { inputTokens: 100, outputTokens: 50 },
      });

      await listener.onComplete();

      const completeUpdate = capturedCommands.find(
        (c) =>
          c.type === 'UpdateCommand' &&
          c.input?.ExpressionAttributeValues?.[':status'] === 'complete'
      );
      expect(completeUpdate!.input.ExpressionAttributeValues[':usage']).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      });
    });
  });
});
