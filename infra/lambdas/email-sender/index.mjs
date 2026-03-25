/**
 * Email Sender Lambda
 *
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
}
