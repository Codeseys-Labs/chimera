/**
 * Email Parser Lambda
 *
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
}
