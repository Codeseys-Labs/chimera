/**
 * Tests for reseedFromArchive in destroy commands.
 * Verifies UnprocessedItems retry logic with exponential backoff.
 */

import * as path from 'path';
import * as fs from 'fs';
import { DynamoDBClient, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';
import { reseedFromArchive } from '../src/commands/destroy';

// Bun's jest.mock() requires a factory function as the second argument
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
  BatchWriteItemCommand: jest.fn().mockImplementation((input: unknown) => input),
}));

const ARCHIVE_PATH = '/tmp/test-archive';
const TABLE_NAME = 'chimera-tenants';

const MANIFEST = JSON.stringify({
  tables: [TABLE_NAME],
  timestamp: '2026-01-01T00:00:00.000Z',
  env: 'test',
  region: 'us-east-1',
});

const ITEMS_JSON = JSON.stringify([
  { id: { S: 'item-1' }, name: { S: 'Alice' } },
  { id: { S: 'item-2' }, name: { S: 'Bob' } },
]);

describe('reseedFromArchive', () => {
  const mockSend = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();

    // Wire DynamoDBClient constructor to return an object with our mockSend
    (DynamoDBClient as jest.MockedClass<typeof DynamoDBClient>)
      .mockImplementation(() => ({ send: mockSend } as any));
    (BatchWriteItemCommand as jest.MockedClass<typeof BatchWriteItemCommand>)
      .mockImplementation((input: unknown) => input as any);

    // Spy on fs functions instead of module-mocking to avoid cross-file pollution
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockImplementation((filePath: fs.PathOrFileDescriptor) =>
      filePath.toString().endsWith('manifest.json') ? MANIFEST : ITEMS_JSON
    );

    // Make setTimeout call its callback synchronously to avoid real delays in tests
    jest.spyOn(global, 'setTimeout').mockImplementation((fn: TimerHandler) => {
      if (typeof fn === 'function') (fn as (...args: unknown[]) => void)();
      return 0 as unknown as NodeJS.Timeout;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes all items successfully on first attempt', async () => {
    mockSend.mockResolvedValue({ UnprocessedItems: {} });

    await reseedFromArchive(ARCHIVE_PATH, 'us-east-1');

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('retries when UnprocessedItems are returned and succeeds on retry', async () => {
    const unprocessed = { PutRequest: { Item: { id: { S: 'item-1' } } } };
    mockSend
      .mockResolvedValueOnce({ UnprocessedItems: { [TABLE_NAME]: [unprocessed] } })
      .mockResolvedValueOnce({ UnprocessedItems: {} });

    await reseedFromArchive(ARCHIVE_PATH, 'us-east-1');

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting 5 retries with unprocessed items', async () => {
    const unprocessed = { PutRequest: { Item: { id: { S: 'item-1' } } } };
    mockSend.mockResolvedValue({ UnprocessedItems: { [TABLE_NAME]: [unprocessed] } });

    await expect(reseedFromArchive(ARCHIVE_PATH, 'us-east-1'))
      .rejects.toThrow(
        `BatchWriteItem failed after 5 retries: 1 items unprocessed in table "${TABLE_NAME}"`
      );

    // 1 initial attempt + 5 retries = 6 total send calls
    expect(mockSend).toHaveBeenCalledTimes(6);
  });

  it('throws when archive manifest is missing', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);

    await expect(reseedFromArchive(ARCHIVE_PATH, 'us-east-1'))
      .rejects.toThrow(
        `Archive manifest not found at ${path.join(ARCHIVE_PATH, 'manifest.json')}`
      );

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('skips table silently when data file is missing', async () => {
    jest.spyOn(fs, 'existsSync').mockImplementation(
      (p: fs.PathLike) => p.toString().endsWith('manifest.json')
    );

    await reseedFromArchive(ARCHIVE_PATH, 'us-east-1');

    expect(mockSend).not.toHaveBeenCalled();
  });
});
