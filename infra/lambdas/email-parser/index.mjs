/**
 * Email Parser Lambda
 *
<<<<<<< HEAD
 * Handles inbound SES email events. Receives SES → Lambda invocation with
 * the raw message stored in S3, parses headers and body, stores a structured
 * record in DynamoDB, and emits an EventBridge event for agent orchestration.
 *
 * Input:  SES event (Records[].eventSource === 'aws:ses')
 * Output: { statusCode: 200, body: 'OK' }
 *
 * Env vars:
 *   EMAIL_TABLE_NAME  — DynamoDB table for email records (default: chimera-sessions)
 *   EVENT_BUS_NAME    — EventBridge bus name (default: chimera-orchestration)
 *   EMAIL_BUCKET      — S3 bucket holding raw MIME (default: chimera-emails)
 */

const TABLE_NAME  = process.env.EMAIL_TABLE_NAME ?? 'chimera-sessions';
const EVENT_BUS   = process.env.EVENT_BUS_NAME   ?? 'chimera-orchestration';
const EMAIL_BUCKET = process.env.EMAIL_BUCKET    ?? 'chimera-emails';

// Lazy singletons — initialized on first handler invocation so pure functions
// can be imported and tested without resolving AWS SDK packages.
let _clients = null;

async function getClients() {
  if (_clients) return _clients;
  const [
    { S3Client, GetObjectCommand },
    { DynamoDBClient, PutItemCommand },
    { EventBridgeClient, PutEventsCommand },
  ] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/client-eventbridge'),
  ]);
  _clients = {
    s3:  new S3Client({}),
    ddb: new DynamoDBClient({}),
    eb:  new EventBridgeClient({}),
    GetObjectCommand,
    PutItemCommand,
    PutEventsCommand,
  };
  return _clients;
}

// ---------------------------------------------------------------------------
// Pure helper functions — exported so unit tests can exercise them directly.
// ---------------------------------------------------------------------------

/**
 * Extract the plain-text body from a raw MIME email string.
 * Handles both simple (non-multipart) and multipart messages.
 */
export function extractTextBody(rawMime) {
  // Detect multipart boundary
  const boundaryMatch = rawMime.match(/boundary=["']?([^"'\r\n;]+)["']?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1].trim();
    const parts = rawMime.split(new RegExp(`--${escapeRegex(boundary)}(?:--)?`));
    for (const part of parts) {
      if (!/Content-Type:\s*text\/plain/i.test(part)) continue;
      // Body starts after the blank line that follows the part headers
      const blankCRLF = part.indexOf('\r\n\r\n');
      if (blankCRLF !== -1) return part.slice(blankCRLF + 4).trim();
      const blankLF = part.indexOf('\n\n');
      if (blankLF !== -1) return part.slice(blankLF + 2).trim();
    }
  }

  // Non-multipart: body starts after the first blank line
  const crlfIdx = rawMime.indexOf('\r\n\r\n');
  if (crlfIdx !== -1) return rawMime.slice(crlfIdx + 4).trim();
  const lfIdx = rawMime.indexOf('\n\n');
  if (lfIdx !== -1) return rawMime.slice(lfIdx + 2).trim();

  return '';
}

/**
 * Parse the agent ID from a recipient address.
 * Supports both bare addresses and RFC 2822 display-name form: "Name <addr@domain>".
 * Agent ID is the part before the first '+' in the local portion.
 * e.g.  "myagent+tenant123@chimera.aws"  → "myagent"
 *       "myagent@chimera.aws"            → "myagent"
 */
export function parseAgentId(address) {
  const addr = stripDisplayName(address);
  const local = addr.split('@')[0] ?? 'default';
  return local.split('+')[0] || 'default';
}

/**
 * Parse the tenant ID from a recipient address.
 * Tenant ID is the part after the first '+' in the local portion.
 * e.g.  "myagent+tenant123@chimera.aws"  → "tenant123"
 *       "myagent@chimera.aws"            → "default"
 */
export function parseTenantId(address) {
  const addr = stripDisplayName(address);
  const local = addr.split('@')[0] ?? '';
  return local.split('+')[1] ?? 'default';
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const { s3, ddb, eb, GetObjectCommand, PutItemCommand, PutEventsCommand } =
    await getClients();

  for (const record of (event.Records ?? [])) {
    if (record.eventSource !== 'aws:ses') continue;

    const ses     = record.ses;
    const mail    = ses.mail;
    const receipt = ses.receipt;
    const messageId = mail.messageId;

    // Fetch raw MIME from S3 (SES receipt rule stores it before invoking Lambda)
    const s3Key = `${receipt?.action?.objectKeyPrefix ?? 'emails/'}${messageId}`;
    let rawMime = '';
    try {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: EMAIL_BUCKET,
        Key: s3Key,
      }));
      rawMime = await obj.Body.transformToString();
    } catch (err) {
      console.error('email-parser: S3 fetch failed key=%s err=%s', s3Key, err.message);
      // Continue with headers from SES event even if S3 fetch fails
    }

    const common   = mail.commonHeaders ?? {};
    const fromAddr = (Array.isArray(common.from)    ? common.from[0]    : common.from)    ?? mail.source ?? '';
    const toAddr   = (Array.isArray(common.to)      ? common.to.join(', ') : common.to) ?? '';
    const subject  = (Array.isArray(common.subject) ? common.subject[0] : common.subject) ?? '(no subject)';
    const inReplyTo = (Array.isArray(common['in-reply-to']) ? common['in-reply-to'][0] : common['in-reply-to']) ?? '';
    const references = Array.isArray(common.references)
      ? common.references.join(' ')
      : (common.references ?? '');

    // Thread ID: use In-Reply-To for replies, otherwise start a new thread
    const threadId = inReplyTo || messageId;

    // Parse agent + tenant from the first SES recipient
    const recipient  = (receipt?.recipients?.[0]) ?? toAddr;
    const agentId    = parseAgentId(recipient);
    const tenantId   = parseTenantId(recipient);
    const bodyText   = rawMime ? extractTextBody(rawMime) : '';
    const receivedAt = new Date().toISOString();
    const ttl        = Math.floor(Date.now() / 1000) + 90 * 24 * 3600; // 90 days

    // Store email record in DynamoDB (raw attribute format — no util-dynamodb)
    try {
      await ddb.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          PK:         { S: `AGENT#${agentId}` },
          SK:         { S: `EMAIL#${messageId}` },
          messageId:  { S: messageId },
          threadId:   { S: threadId },
          agentId:    { S: agentId },
          tenantId:   { S: tenantId },
          from:       { S: fromAddr },
          to:         { S: toAddr },
          subject:    { S: subject },
          bodyText:   { S: bodyText.slice(0, 50_000) },
          bodyKey:    { S: s3Key },
          receivedAt: { S: receivedAt },
          inReplyTo:  { S: inReplyTo },
          references: { S: references },
          status:     { S: 'PENDING' },
          ttl:        { N: String(ttl) },
        },
      }));
    } catch (err) {
      console.error('email-parser: DynamoDB write failed messageId=%s err=%s', messageId, err.message);
    }

    // Emit EventBridge event for agent orchestration
    try {
      await eb.send(new PutEventsCommand({
        Entries: [{
          Source:       'chimera.email',
          DetailType:   'Email Received',
          EventBusName: EVENT_BUS,
          Detail: JSON.stringify({
            messageId,
            threadId,
            agentId,
            tenantId,
            from:       fromAddr,
            to:         toAddr,
            subject,
            receivedAt,
            bodyKey:    s3Key,
            inReplyTo:  inReplyTo  || null,
            references: references || null,
          }),
        }],
      }));
    } catch (err) {
      console.error('email-parser: EventBridge emit failed messageId=%s err=%s', messageId, err.message);
    }

    console.log('email-parser: processed messageId=%s threadId=%s agentId=%s tenantId=%s',
      messageId, threadId, agentId, tenantId);
  }

  return { statusCode: 200, body: 'OK' };
};

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function stripDisplayName(address) {
  const m = address.match(/<([^>]+)>/);
  return m ? m[1] : address.trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
=======
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
>>>>>>> overstory/builder-email-cdk/chimera-0f23
}
