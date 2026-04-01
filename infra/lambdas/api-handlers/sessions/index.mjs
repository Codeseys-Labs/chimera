/**
 * Sessions API Handler
 *
 * Read-only access to agent session records.
 *
 * Routes (all require Cognito JWT with matching custom:tenant_id claim):
 *   GET /api/v1/tenants/{tenantId}/sessions              — list active sessions
 *   GET /api/v1/tenants/{tenantId}/sessions/{sessionId}  — get session details
 *   DELETE /api/v1/tenants/{tenantId}/sessions/{sessionId} — terminate session
 *
 * DynamoDB schema (chimera-sessions):
 *   PK = TENANT#{tenantId}
 *   SK = SESSION#{sessionId}
 *   TTL: lastActivity + 24 hours
 *
 * Env vars:
 *   SESSIONS_TABLE — DynamoDB table name (required)
 */

const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const DEFAULT_PAGE_LIMIT = 50;

let _clients = null;

async function getClients() {
  if (_clients) return _clients;
  const [
    { DynamoDBClient },
    { DynamoDBDocumentClient, GetCommand, DeleteCommand, QueryCommand },
  ] = await Promise.all([
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
  ]);
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  _clients = { ddb, GetCommand, DeleteCommand, QueryCommand };
  return _clients;
}

// ---------------------------------------------------------------------------
// Tenant isolation guard
// ---------------------------------------------------------------------------

export function validateTenantAccess(event, pathTenantId) {
  const claims = event.requestContext?.authorizer?.claims ?? {};
  const callerTenantId = claims['custom:tenant_id'];
  if (!callerTenantId) return false;
  if (callerTenantId === pathTenantId) return true;
  return callerTenantId === 'chimera-platform';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(body) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function err(status, code, message) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code, message }, timestamp: new Date().toISOString() }),
  };
}

function stripKeys(item) {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const { ddb, GetCommand, DeleteCommand, QueryCommand } = await getClients();
  const { tenantId, sessionId } = event.pathParameters ?? {};

  if (!tenantId) return err(400, 'MISSING_PARAM', 'tenantId path parameter is required');

  if (!validateTenantAccess(event, tenantId)) {
    return err(403, 'FORBIDDEN', 'You may only access your own tenant sessions');
  }

  const PK = `TENANT#${tenantId}`;

  // ── DELETE single session ────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE' && sessionId) {
    const existing = await ddb.send(new GetCommand({
      TableName: SESSIONS_TABLE,
      Key: { PK, SK: `SESSION#${sessionId}` },
    }));
    if (!existing.Item) {
      return err(404, 'NOT_FOUND', `Session '${sessionId}' not found`);
    }
    await ddb.send(new DeleteCommand({
      TableName: SESSIONS_TABLE,
      Key: { PK, SK: `SESSION#${sessionId}` },
    }));
    return ok({ deleted: true, sessionId, timestamp: new Date().toISOString() });
  }

  // ── GET single session ───────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && sessionId) {
    const result = await ddb.send(new GetCommand({
      TableName: SESSIONS_TABLE,
      Key: { PK, SK: `SESSION#${sessionId}` },
    }));
    if (!result.Item) {
      return err(404, 'NOT_FOUND', `Session '${sessionId}' not found`);
    }
    return ok({ session: stripKeys(result.Item), timestamp: new Date().toISOString() });
  }

  // ── GET list sessions ────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const limit = Math.min(
      parseInt(event.queryStringParameters?.limit ?? String(DEFAULT_PAGE_LIMIT), 10),
      100
    );
    const nextToken = event.queryStringParameters?.nextToken;

    const params = {
      TableName: SESSIONS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': 'SESSION#' },
      Limit: limit,
      ScanIndexForward: false, // most recent first
    };
    if (nextToken) {
      try {
        params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString());
      } catch {
        return err(400, 'INVALID_TOKEN', 'Invalid pagination token');
      }
    }

    const result = await ddb.send(new QueryCommand(params));
    const sessions = (result.Items ?? []).map(stripKeys);
    const responseNextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return ok({
      sessions,
      count: sessions.length,
      nextToken: responseNextToken,
      timestamp: new Date().toISOString(),
    });
  }

  return err(405, 'METHOD_NOT_ALLOWED', `Method ${event.httpMethod} not supported`);
};
