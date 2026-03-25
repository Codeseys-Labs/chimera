/**
 * Email Parser Lambda
 *
 * Triggered by SQS queue receiving S3 event notifications when SES writes
 * inbound MIME emails to the chimera-inbound-email bucket.
 *
 * For each record:
 * 1. Extracts S3 bucket/key from the SQS→S3 event payload
 * 2. Fetches raw MIME email from S3
 * 3. Parses headers: From, To, Subject, Message-ID, In-Reply-To, References
 * 4. Extracts text body (prefers text/plain, falls back to stripping text/html)
 * 5. Writes email record to chimera-sessions DynamoDB table
 * 6. Emits email.received event to chimera-orchestration EventBridge bus
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

// Module-level singletons (per aws-sdk-module-level-singletons convention)
const s3 = new S3Client({});
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const eb = new EventBridgeClient({});

const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;
const INBOUND_BUCKET = process.env.INBOUND_BUCKET;

/**
 * Parse MIME headers from raw email text.
 * Returns a map of lowercased header names to their values.
 * Handles multi-line (folded) headers per RFC 5322.
 */
function parseHeaders(rawEmail) {
  const headers = {};
  // Split at the first blank line to get just the header section
  const headerSection = rawEmail.split(/\r?\n\r?\n/)[0] ?? '';
  // Unfold multi-line headers
  const unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // Keep first occurrence of each header (RFC 5321 § 3.6: duplicates allowed)
    if (!(name in headers)) {
      headers[name] = value;
    }
  }
  return headers;
}

/**
 * Extract plain-text body from a MIME email.
 * Prefers text/plain parts; falls back to stripping HTML tags from text/html.
 * For multipart messages, scans each part boundary.
 */
function extractBody(rawEmail) {
  const contentType = (rawEmail.match(/^content-type:\s*([^\r\n;]+)/im) ?? [])[1]?.trim() ?? '';

  if (contentType.startsWith('multipart/')) {
    const boundary = (rawEmail.match(/boundary="?([^"\r\n;]+)"?/i) ?? [])[1];
    if (boundary) {
      const parts = rawEmail.split(`--${boundary}`);
      let htmlBody = '';
      for (const part of parts) {
        const partContentType = (part.match(/^content-type:\s*([^\r\n;]+)/im) ?? [])[1]?.trim() ?? '';
        const partBody = part.split(/\r?\n\r?\n/).slice(1).join('\n\n').trim();
        if (partContentType.startsWith('text/plain')) {
          return partBody;
        }
        if (partContentType.startsWith('text/html') && !htmlBody) {
          htmlBody = partBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }
      return htmlBody;
    }
  }

  // Single-part email: body is after the blank line separator
  const bodyStart = rawEmail.search(/\r?\n\r?\n/);
  if (bodyStart === -1) return '';
  const body = rawEmail.slice(bodyStart).trim();

  if (contentType.startsWith('text/html')) {
    return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return body;
}

export async function handler(event) {
  const errors = [];

  for (const sqsRecord of event.Records) {
    let s3Key;
    let s3Bucket;

    try {
      // SQS record body is a JSON string containing the S3 event
      const s3Event = JSON.parse(sqsRecord.body);

      // Handle EventBridge wrapping (S3 → EventBridge → SQS path)
      const s3Records = s3Event.detail?.Records ?? s3Event.Records ?? [];

      for (const s3Record of s3Records) {
        s3Bucket = s3Record.s3?.bucket?.name ?? INBOUND_BUCKET;
        s3Key = decodeURIComponent((s3Record.s3?.object?.key ?? '').replace(/\+/g, ' '));

        if (!s3Key) {
          console.warn('No S3 key in record, skipping', JSON.stringify(s3Record));
          continue;
        }

        await processEmail(s3Bucket, s3Key);
      }
    } catch (err) {
      console.error('Failed to process SQS record', { s3Bucket, s3Key, error: err.message });
      errors.push({ messageId: sqsRecord.messageId, error: err.message });
    }
  }

  // Partial batch response: report failed message IDs so SQS can retry them
  if (errors.length > 0) {
    return {
      batchItemFailures: errors.map(e => ({ itemIdentifier: e.messageId })),
    };
  }
  return { batchItemFailures: [] };
}

async function processEmail(bucket, key) {
  // 1. Fetch raw MIME email from S3
  const s3Resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const rawEmail = await s3Resp.Body.transformToString('utf-8');

  // 2. Parse headers
  const headers = parseHeaders(rawEmail);
  const messageId = (headers['message-id'] ?? '').replace(/[<>]/g, '').trim();
  const inReplyTo = (headers['in-reply-to'] ?? '').replace(/[<>]/g, '').trim();
  const references = headers['references'] ?? '';
  const from = headers['from'] ?? '';
  const to = headers['to'] ?? '';
  const subject = headers['subject'] ?? '(no subject)';

  if (!messageId) {
    console.warn('Email missing Message-ID, using S3 key as fallback', { key });
  }

  const effectiveMessageId = messageId || key;
  // Thread ID: use In-Reply-To if present (continuing a thread), else this message starts a new thread
  const threadId = inReplyTo || effectiveMessageId;
  const receivedAt = new Date().toISOString();

  // 3. Extract text body
  const bodyText = extractBody(rawEmail);

  // 4. Write email record to chimera-sessions table
  const ddbItem = {
    PK: `EMAIL#${effectiveMessageId}`,
    SK: 'META',
    messageId: effectiveMessageId,
    threadId,
    from,
    to,
    subject,
    bodyKey: key,
    bodyText: bodyText.slice(0, 4000), // Truncate for DDB; full body is in S3
    receivedAt,
    inReplyTo,
    references,
    status: 'PENDING',
    // TTL: 90 days for email records
    ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
  };

  await ddb.send(new PutCommand({
    TableName: SESSIONS_TABLE,
    Item: ddbItem,
    ConditionExpression: 'attribute_not_exists(PK)', // Idempotent: skip if already processed
  })).catch(err => {
    if (err.name === 'ConditionalCheckFailedException') {
      console.info('Email already processed, skipping DDB write', { messageId: effectiveMessageId });
    } else {
      throw err;
    }
  });

  // 5. Emit email.received event to orchestration EventBridge bus
  await eb.send(new PutEventsCommand({
    Entries: [{
      EventBusName: EVENT_BUS_NAME,
      Source: 'chimera.email',
      DetailType: 'Email Received',
      Detail: JSON.stringify({
        messageId: effectiveMessageId,
        threadId,
        from,
        to,
        subject,
        bodyKey: key,
        receivedAt,
        inReplyTo,
        references,
      }),
    }],
  }));

  console.info('Email processed', { messageId: effectiveMessageId, threadId, from, subject });
}
