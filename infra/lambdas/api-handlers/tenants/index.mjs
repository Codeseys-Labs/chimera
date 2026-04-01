/**
 * Tenants API Handler
 *
 * Manages tenant configuration records in DynamoDB.
 *
 * Routes (all require Cognito JWT with matching custom:tenant_id claim):
 *   GET  /api/v1/tenants/{tenantId} — fetch tenant profile + config
 *   POST /api/v1/tenants/{tenantId} — update tenant profile fields
 *
 * DynamoDB schema (chimera-tenants):
 *   PK = TENANT#{tenantId}
 *   SK = PROFILE  — core metadata (name, tier, status, adminEmail, dataRegion)
 *   SK = CONFIG#features, CONFIG#models, CONFIG#channels, BILLING#current, QUOTA#*
 *
 * Env vars:
 *   TENANTS_TABLE — DynamoDB table name (required)
 */

const TENANTS_TABLE = process.env.TENANTS_TABLE;

let _clients = null;

async function getClients() {
  if (_clients) return _clients;
  const [
    { DynamoDBClient },
    { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand },
  ] = await Promise.all([
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
  ]);
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  _clients = { ddb, GetCommand, UpdateCommand, QueryCommand };
  return _clients;
}

// ---------------------------------------------------------------------------
// Tenant isolation guard — caller's JWT tenant must match path param
// ---------------------------------------------------------------------------

export function validateTenantAccess(event, pathTenantId) {
  const claims = event.requestContext?.authorizer?.claims ?? {};
  const callerTenantId = claims['custom:tenant_id'];
  if (!callerTenantId) return false;
  if (callerTenantId === pathTenantId) return true;
  // Platform admins (chimera-platform tenant) may access any tenant
  return callerTenantId === 'chimera-platform';
}

// ---------------------------------------------------------------------------
// Allowed fields for POST updates (prevent overwriting PK/SK/internal fields)
// ---------------------------------------------------------------------------
const MUTABLE_PROFILE_FIELDS = new Set([
  'name', 'adminEmail', 'dataRegion', 'tier', 'status',
]);

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

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const { ddb, GetCommand, UpdateCommand, QueryCommand } = await getClients();
  const tenantId = event.pathParameters?.tenantId;
  if (!tenantId) return err(400, 'MISSING_PARAM', 'tenantId path parameter is required');

  // Tenant isolation — caller may only access their own tenant (or be platform admin)
  if (!validateTenantAccess(event, tenantId)) {
    return err(403, 'FORBIDDEN', 'You may only access your own tenant');
  }

  const PK = `TENANT#${tenantId}`;

  // ── GET: fetch full tenant profile ──────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const result = await ddb.send(new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { PK, SK: 'PROFILE' },
    }));

    if (!result.Item) {
      return err(404, 'NOT_FOUND', `Tenant '${tenantId}' not found`);
    }

    const { PK: _pk, SK: _sk, ...profile } = result.Item;
    return ok({ tenant: profile, timestamp: new Date().toISOString() });
  }

  // ── POST: update tenant profile ──────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return err(400, 'INVALID_JSON', 'Request body must be valid JSON');
    }

    // Only allow mutable fields
    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => MUTABLE_PROFILE_FIELDS.has(k))
    );
    if (Object.keys(updates).length === 0) {
      return err(400, 'NO_MUTABLE_FIELDS',
        `No mutable fields provided. Allowed: ${[...MUTABLE_PROFILE_FIELDS].join(', ')}`);
    }

    // Verify tenant exists
    const existing = await ddb.send(new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { PK, SK: 'PROFILE' },
    }));
    if (!existing.Item) {
      return err(404, 'NOT_FOUND', `Tenant '${tenantId}' not found`);
    }

    // Build UpdateExpression dynamically — avoid DDB reserved words via ExpressionAttributeNames
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
      Key: { PK, SK: 'PROFILE' },
      UpdateExpression: `SET ${setParts.join(', ')}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    }));

    // Return updated item
    const updated = await ddb.send(new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { PK, SK: 'PROFILE' },
    }));
    const { PK: _pk, SK: _sk, ...profile } = updated.Item;
    return ok({ tenant: profile, timestamp: new Date().toISOString() });
  }

  return err(405, 'METHOD_NOT_ALLOWED', `Method ${event.httpMethod} not supported`);
};
