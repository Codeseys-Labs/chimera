/**
 * Skills API Handler
 *
 * Manages per-tenant skill installations in DynamoDB.
 *
 * Routes (all require Cognito JWT with matching custom:tenant_id claim):
 *   GET    /api/v1/tenants/{tenantId}/skills             — list installed skills
 *   POST   /api/v1/tenants/{tenantId}/skills             — install a skill
 *   GET    /api/v1/tenants/{tenantId}/skills/{skillId}   — get skill details
 *   DELETE /api/v1/tenants/{tenantId}/skills/{skillId}   — uninstall a skill
 *
 * DynamoDB schema (chimera-skills):
 *   Installed skills use a tenant-partition pattern:
 *   PK = TENANT#{tenantId}    (distinct from marketplace PK = SKILL#{name})
 *   SK = SKILL#{skillId}
 *
 * Env vars:
 *   SKILLS_TABLE — DynamoDB table name (required)
 */

const SKILLS_TABLE = process.env.SKILLS_TABLE;
const DEFAULT_PAGE_LIMIT = 50;

let _clients = null;

async function getClients() {
  if (_clients) return _clients;
  const [
    { DynamoDBClient },
    { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand },
  ] = await Promise.all([
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
  ]);
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  _clients = { ddb, GetCommand, PutCommand, DeleteCommand, QueryCommand };
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

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const { ddb, GetCommand, PutCommand, DeleteCommand, QueryCommand } = await getClients();
  const { tenantId, skillId } = event.pathParameters ?? {};

  if (!tenantId) return err(400, 'MISSING_PARAM', 'tenantId path parameter is required');

  if (!validateTenantAccess(event, tenantId)) {
    return err(403, 'FORBIDDEN', 'You may only manage skills for your own tenant');
  }

  const PK = `TENANT#${tenantId}`;

  // ── DELETE: uninstall skill ──────────────────────────────────────────────
  if (event.httpMethod === 'DELETE' && skillId) {
    const existing = await ddb.send(new GetCommand({
      TableName: SKILLS_TABLE,
      Key: { PK, SK: `SKILL#${skillId}` },
    }));
    if (!existing.Item) {
      return err(404, 'NOT_FOUND', `Skill '${skillId}' is not installed for this tenant`);
    }
    await ddb.send(new DeleteCommand({
      TableName: SKILLS_TABLE,
      Key: { PK, SK: `SKILL#${skillId}` },
    }));
    return ok({ deleted: true, skillId, timestamp: new Date().toISOString() });
  }

  // ── GET: single skill ────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && skillId) {
    const result = await ddb.send(new GetCommand({
      TableName: SKILLS_TABLE,
      Key: { PK, SK: `SKILL#${skillId}` },
    }));
    if (!result.Item) {
      return err(404, 'NOT_FOUND', `Skill '${skillId}' is not installed for this tenant`);
    }
    return ok({ skill: stripKeys(result.Item), timestamp: new Date().toISOString() });
  }

  // ── GET: list installed skills ───────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const limit = Math.min(
      parseInt(event.queryStringParameters?.limit ?? String(DEFAULT_PAGE_LIMIT), 10),
      100
    );
    const nextToken = event.queryStringParameters?.nextToken;

    const params = {
      TableName: SKILLS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': PK, ':prefix': 'SKILL#' },
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
    const skills = (result.Items ?? []).map(stripKeys);
    const responseNextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return ok({
      skills,
      count: skills.length,
      nextToken: responseNextToken,
      timestamp: new Date().toISOString(),
    });
  }

  // ── POST: install skill ──────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return err(400, 'INVALID_JSON', 'Request body must be valid JSON');
    }

    const { skillId: newSkillId, name, version, config } = body;
    if (!newSkillId || !name) {
      return err(400, 'MISSING_FIELDS', 'Required fields: skillId, name');
    }

    // Prevent re-installation without explicit force flag
    const existing = await ddb.send(new GetCommand({
      TableName: SKILLS_TABLE,
      Key: { PK, SK: `SKILL#${newSkillId}` },
    }));
    if (existing.Item && !body.force) {
      return err(409, 'ALREADY_INSTALLED', `Skill '${newSkillId}' is already installed`);
    }

    const now = new Date().toISOString();
    const item = {
      PK,
      SK: `SKILL#${newSkillId}`,
      skillId: newSkillId,
      tenantId,
      name,
      version: version ?? 'latest',
      config: config ?? {},
      installedAt: existing.Item?.installedAt ?? now,
      updatedAt: now,
      status: 'ACTIVE',
    };

    await ddb.send(new PutCommand({ TableName: SKILLS_TABLE, Item: item }));

    const { PK: _pk, SK: _sk, ...skill } = item;
    return created({ skill, timestamp: now });
  }

  return err(405, 'METHOD_NOT_ALLOWED', `Method ${event.httpMethod} not supported`);
};
