/**
 * Agents API Handler
 *
 * Manages per-tenant agent configuration records.
 *
 * Routes (all require Cognito JWT with matching custom:tenant_id claim):
 *   GET    /api/v1/tenants/{tenantId}/agents              — list agent configs
 *   POST   /api/v1/tenants/{tenantId}/agents              — create agent config
 *   GET    /api/v1/tenants/{tenantId}/agents/{agentId}    — get agent config
 *   PUT    /api/v1/tenants/{tenantId}/agents/{agentId}    — update agent config
 *   DELETE /api/v1/tenants/{tenantId}/agents/{agentId}    — delete agent config
 *
 * DynamoDB schema (chimera-tenants):
 *   Agent configs are stored in the tenants table using a different SK prefix:
 *   PK = TENANT#{tenantId}
 *   SK = AGENT#{agentId}
 *
 * Env vars:
 *   TENANTS_TABLE — DynamoDB table name (required)
 */

const TENANTS_TABLE = process.env.TENANTS_TABLE;
const DEFAULT_PAGE_LIMIT = 50;

let _clients = null;

async function getClients() {
  if (_clients) return _clients;
  const [
    { DynamoDBClient },
    { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand },
  ] = await Promise.all([
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
  ]);
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  _clients = { ddb, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand };
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

function created(body) {
  return { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
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

function generateAgentId() {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Mutable fields for PUT updates
const MUTABLE_AGENT_FIELDS = new Set([
  'name', 'description', 'modelId', 'systemPrompt', 'tools', 'skills',
  'maxTokens', 'temperature', 'status', 'metadata',
]);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const { ddb, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } = await getClients();
  const { tenantId, agentId } = event.pathParameters ?? {};

  if (!tenantId) return err(400, 'MISSING_PARAM', 'tenantId path parameter is required');

  if (!validateTenantAccess(event, tenantId)) {
    return err(403, 'FORBIDDEN', 'You may only manage agents for your own tenant');
  }

  const PK = `TENANT#${tenantId}`;

  // ── DELETE agent ─────────────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE' && agentId) {
    const existing = await ddb.send(new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { PK, SK: `AGENT#${agentId}` },
    }));
    if (!existing.Item) {
      return err(404, 'NOT_FOUND', `Agent '${agentId}' not found`);
    }
    await ddb.send(new DeleteCommand({
      TableName: TENANTS_TABLE,
      Key: { PK, SK: `AGENT#${agentId}` },
    }));
    return ok({ deleted: true, agentId, timestamp: new Date().toISOString() });
  }

  // ── GET single agent ─────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && agentId) {
    const result = await ddb.send(new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { PK, SK: `AGENT#${agentId}` },
    }));
    if (!result.Item) {
      return err(404, 'NOT_FOUND', `Agent '${agentId}' not found`);
    }
    return ok({ agent: stripKeys(result.Item), timestamp: new Date().toISOString() });
  }

  // ── GET list agents ───────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const limit = Math.min(
      parseInt(event.queryStringParameters?.limit ?? String(DEFAULT_PAGE_LIMIT), 10),
      100
    );
    const nextToken = event.queryStringParameters?.nextToken;

    const params = {
      TableName: TENANTS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': 'AGENT#' },
      Limit: limit,
    };
    if (nextToken) {
      try {
        params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString());
      } catch {
        return err(400, 'INVALID_TOKEN', 'Invalid pagination token');
      }
    }

    const result = await ddb.send(new QueryCommand(params));
    const agents = (result.Items ?? []).map(stripKeys);
    const responseNextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return ok({
      agents,
      count: agents.length,
      nextToken: responseNextToken,
      timestamp: new Date().toISOString(),
    });
  }

  // ── POST: create agent ────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return err(400, 'INVALID_JSON', 'Request body must be valid JSON');
    }

    const { name, modelId, systemPrompt, tools, skills, maxTokens, temperature, metadata } = body;
    if (!name) {
      return err(400, 'MISSING_FIELDS', 'Required field: name');
    }

    const newAgentId = body.agentId ?? generateAgentId();
    const existing = await ddb.send(new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { PK, SK: `AGENT#${newAgentId}` },
    }));
    if (existing.Item) {
      return err(409, 'ALREADY_EXISTS', `Agent '${newAgentId}' already exists`);
    }

    const now = new Date().toISOString();
    const item = {
      PK,
      SK: `AGENT#${newAgentId}`,
      agentId: newAgentId,
      tenantId,
      name,
      modelId: modelId ?? process.env.DEFAULT_MODEL_ID ?? 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
      systemPrompt: systemPrompt ?? '',
      tools: tools ?? [],
      skills: skills ?? [],
      maxTokens: maxTokens ?? 4096,
      temperature: temperature ?? 1.0,
      status: 'ACTIVE',
      metadata: metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    await ddb.send(new PutCommand({ TableName: TENANTS_TABLE, Item: item }));

    const { PK: _pk, SK: _sk, ...agent } = item;
    return created({ agent, timestamp: now });
  }

  // ── PUT: update agent ─────────────────────────────────────────────────────
  if (event.httpMethod === 'PUT' && agentId) {
    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return err(400, 'INVALID_JSON', 'Request body must be valid JSON');
    }

    const existing = await ddb.send(new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { PK, SK: `AGENT#${agentId}` },
    }));
    if (!existing.Item) {
      return err(404, 'NOT_FOUND', `Agent '${agentId}' not found`);
    }

    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => MUTABLE_AGENT_FIELDS.has(k))
    );
    if (Object.keys(updates).length === 0) {
      return err(400, 'NO_MUTABLE_FIELDS',
        `No mutable fields provided. Allowed: ${[...MUTABLE_AGENT_FIELDS].join(', ')}`);
    }

    const exprNames = {};
    const exprValues = { ':updatedAt': new Date().toISOString() };
    const setParts = ['#updatedAt = :updatedAt'];

    for (const [field, value] of Object.entries(updates)) {
      const alias = `#f_${field}`;
      const valAlias = `:v_${field}`;
      exprNames[alias] = field;
      exprValues[valAlias] = value;
      setParts.push(`${alias} = ${valAlias}`);
    }
    exprNames['#updatedAt'] = 'updatedAt';

    await ddb.send(new UpdateCommand({
      TableName: TENANTS_TABLE,
      Key: { PK, SK: `AGENT#${agentId}` },
      UpdateExpression: `SET ${setParts.join(', ')}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    }));

    const updated = await ddb.send(new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { PK, SK: `AGENT#${agentId}` },
    }));
    return ok({ agent: stripKeys(updated.Item), timestamp: new Date().toISOString() });
  }

  return err(405, 'METHOD_NOT_ALLOWED', `Method ${event.httpMethod} not supported`);
};
