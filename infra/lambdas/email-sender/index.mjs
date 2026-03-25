/**
 * Email Sender Lambda
 *
<<<<<<< HEAD
 * Sends outbound email replies on behalf of an agent, maintaining proper
 * email thread context via RFC 2822 In-Reply-To and References headers.
 *
 * Triggered by:
 *   - EventBridge rule (detail-type: "Email Send Request")
 *   - SQS queue (body contains JSON payload)
 *   - Direct Lambda invocation (payload is the JSON body directly)
 *
 * Payload shape:
 *   {
 *     messageId?:  string   // Original message ID being replied to (for DDB update)
 *     agentId?:   string
 *     tenantId?:  string
 *     to:         string   // Recipient address
 *     subject:    string
 *     bodyText:   string   // Plain-text reply body
 *     inReplyTo?: string   // Message-ID of the email being replied to
 *     references?: string  // Space-separated References chain
 *   }
 *
 * Env vars:
 *   EMAIL_TABLE_NAME — DynamoDB table for email records (default: chimera-sessions)
 *   FROM_ADDRESS     — Verified SES sender address (default: chimera@example.com)
 */

const TABLE_NAME   = process.env.EMAIL_TABLE_NAME ?? 'chimera-sessions';
const FROM_ADDRESS = process.env.FROM_ADDRESS     ?? 'chimera@example.com';

// Lazy singletons — initialized on first handler invocation so pure functions
// can be imported and tested without resolving @aws-sdk/client-ses.
let _clients = null;

async function getClients() {
  if (_clients) return _clients;
  const [
    { SESClient, SendRawEmailCommand },
    { DynamoDBClient, UpdateItemCommand },
  ] = await Promise.all([
    import('@aws-sdk/client-ses'),
    import('@aws-sdk/client-dynamodb'),
  ]);
  _clients = {
    ses: new SESClient({}),
    ddb: new DynamoDBClient({}),
    SendRawEmailCommand,
    UpdateItemCommand,
  };
  return _clients;
}

// ---------------------------------------------------------------------------
// Pure helper functions — exported so unit tests can exercise them directly.
// ---------------------------------------------------------------------------

/**
 * Build a raw MIME email string suitable for SES SendRawEmail.
 * Includes proper threading headers when inReplyTo / references are provided.
 */
export function buildMimeEmail({ from, to, subject, bodyText, messageId, inReplyTo, references }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
  ];

  if (inReplyTo)  lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);

  lines.push('', encodeQuotedPrintable(bodyText));

  return lines.join('\r\n');
}

/**
 * Generate a Message-ID for an outbound email.
 * Format: <timestamp.agentId@chimera.aws>
 */
export function buildMessageId(agentId) {
  return `<${Date.now()}.${agentId ?? 'chimera'}@chimera.aws>`;
}

/**
 * Encode a plain-text string using quoted-printable transfer encoding (RFC 2045).
 * Only encodes characters that require it: '=' and non-ASCII / control chars.
 * Applies soft line breaks at 75 characters as required by the spec.
 */
export function encodeQuotedPrintable(text) {
  const encodedLines = text.split('\n').map(line => {
    let encoded = '';
    for (const char of line) {
      const code = char.charCodeAt(0);
      if (code === 61) {            // '=' must always be encoded
        encoded += '=3D';
      } else if (code > 126 || (code < 32 && code !== 9)) {
        encoded += '=' + code.toString(16).toUpperCase().padStart(2, '0');
      } else {
        encoded += char;
      }
    }

    // Insert soft line breaks so no encoded line exceeds 76 characters
    if (encoded.length <= 75) return encoded;
    const chunks = [];
    while (encoded.length > 75) {
      chunks.push(encoded.slice(0, 75) + '=');
      encoded = encoded.slice(75);
    }
    chunks.push(encoded);
    return chunks.join('\r\n');
  });

  return encodedLines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const { ses, ddb, SendRawEmailCommand, UpdateItemCommand } = await getClients();

  // Normalise the event into an array of send-request payloads.
  // Supports: EventBridge wrapper, SQS records, or direct invocation.
  const payloads = extractPayloads(event);

  for (const payload of payloads) {
    const { messageId, agentId, to, subject, bodyText, inReplyTo, references } = payload;

    if (!to || !bodyText) {
      console.error('email-sender: missing required fields to=%s hasBody=%s', to, !!bodyText);
      continue;
    }

    const outboundMessageId = buildMessageId(agentId ?? 'chimera');

    // Build References chain: existing references + inReplyTo (RFC 2822)
    const newReferences = [references, inReplyTo].filter(Boolean).join(' ').trim() || null;

    const rawMime = buildMimeEmail({
      from:       FROM_ADDRESS,
      to,
      subject:    subject ?? '(no subject)',
      bodyText,
      messageId:  outboundMessageId,
      inReplyTo:  inReplyTo  ?? null,
      references: newReferences,
    });

    // Send via SES
    try {
      await ses.send(new SendRawEmailCommand({
        RawMessage: { Data: Buffer.from(rawMime) },
      }));
    } catch (err) {
      console.error('email-sender: SES send failed to=%s err=%s', to, err.message);
      continue;
    }

    // Update original DynamoDB record with reply metadata
    if (agentId && messageId) {
      try {
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: { S: `AGENT#${agentId}` },
            SK: { S: `EMAIL#${messageId}` },
          },
          UpdateExpression: 'SET #st = :status, replyMessageId = :rid, repliedAt = :ts',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: {
            ':status': { S: 'REPLIED' },
            ':rid':    { S: outboundMessageId },
            ':ts':     { S: new Date().toISOString() },
          },
        }));
      } catch (err) {
        // Non-fatal: reply was sent; DDB update failure is logged only
        console.error('email-sender: DDB update failed agentId=%s messageId=%s err=%s',
          agentId, messageId, err.message);
      }
    }

    console.log('email-sender: sent reply to=%s outboundId=%s inReplyTo=%s',
      to, outboundMessageId, inReplyTo ?? 'none');
  }

  return { statusCode: 200, body: 'OK' };
};

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Unwrap the Lambda event into an array of send-request objects.
 * Handles EventBridge, SQS, and direct invocation shapes.
 */
function extractPayloads(event) {
  // SQS Records
  if (Array.isArray(event.Records)) {
    return event.Records.map(r => {
      try { return JSON.parse(r.body); } catch { return null; }
    }).filter(Boolean);
  }

  // EventBridge event (detail wrapper)
  if (event.detail) return [event.detail];

  // Direct invocation
  return [event];
=======
 * Triggered by SQS queue receiving EventBridge "Email Send Request" events
 * from the chimera-agents event bus. Sends agent email replies via SES v2,
 * preserving email threading headers (In-Reply-To, References).
 *
 * For each record:
 * 1. Parses the Email Send Request event from the SQS body
 * 2. Looks up original email metadata from DynamoDB (for threading headers)
 * 3. Sends reply via SES v2 SendEmail API with correct threading headers
 * 4. Updates DDB record status to REPLIED with the sent message ID
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

// Module-level singletons (per aws-sdk-module-level-singletons convention)
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const ses = new SESv2Client({});

const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const FROM_ADDRESS = process.env.FROM_ADDRESS; // e.g. "Chimera Agent <agent@mail.chimera.example.com>"

export async function handler(event) {
  const errors = [];

  for (const sqsRecord of event.Records) {
    try {
      // SQS body is a JSON EventBridge event envelope
      const ebEvent = JSON.parse(sqsRecord.body);
      // EventBridge wraps the actual detail inside the envelope
      const detail = ebEvent.detail ?? ebEvent;

      await sendReply(detail);
    } catch (err) {
      console.error('Failed to process email send request', { error: err.message, record: sqsRecord.messageId });
      errors.push({ messageId: sqsRecord.messageId, error: err.message });
    }
  }

  // Partial batch response for SQS retry on failure
  return {
    batchItemFailures: errors.map(e => ({ itemIdentifier: e.messageId })),
  };
}

async function sendReply(detail) {
  const {
    originalMessageId, // message-id of the email we're replying to
    to,                // recipient address
    subject,           // reply subject (caller should prefix "Re: " if desired)
    bodyText,          // plain text body of the reply
    bodyHtml,          // optional HTML body
  } = detail;

  if (!originalMessageId || !to || !bodyText) {
    throw new Error(`Missing required fields: originalMessageId=${originalMessageId}, to=${to}, bodyText=${!!bodyText}`);
  }

  // 1. Look up original email record for threading headers
  const getResp = await ddb.send(new GetCommand({
    TableName: SESSIONS_TABLE,
    Key: { PK: `EMAIL#${originalMessageId}`, SK: 'META' },
  }));

  const original = getResp.Item;
  const inReplyTo = originalMessageId;
  // Build References header: original references + original message ID
  const existingRefs = original?.references ?? '';
  const references = existingRefs
    ? `${existingRefs} <${originalMessageId}>`
    : `<${originalMessageId}>`;

  // 2. Compose the reply via SES v2
  const messageBody = {
    Text: { Data: bodyText, Charset: 'UTF-8' },
  };
  if (bodyHtml) {
    messageBody.Html = { Data: bodyHtml, Charset: 'UTF-8' };
  }

  const sendResp = await ses.send(new SendEmailCommand({
    FromEmailAddress: FROM_ADDRESS,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject ?? `Re: ${original?.subject ?? ''}`, Charset: 'UTF-8' },
        Body: messageBody,
        Headers: [
          { Name: 'In-Reply-To', Value: `<${inReplyTo}>` },
          { Name: 'References', Value: references },
        ],
      },
    },
  }));

  const sentMessageId = sendResp.MessageId;

  // 3. Update original email record: status → REPLIED
  await ddb.send(new UpdateCommand({
    TableName: SESSIONS_TABLE,
    Key: { PK: `EMAIL#${originalMessageId}`, SK: 'META' },
    UpdateExpression: 'SET #status = :replied, replyMessageId = :replyMsgId, repliedAt = :ts',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':replied': 'REPLIED',
      ':replyMsgId': sentMessageId,
      ':ts': new Date().toISOString(),
    },
  }));

  console.info('Email reply sent', { originalMessageId, sentMessageId, to });
>>>>>>> overstory/builder-email-cdk/chimera-0f23
}
