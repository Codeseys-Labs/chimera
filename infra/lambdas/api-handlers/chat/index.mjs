/**
 * Chat API Handler — Synchronous (non-streaming) chat
 *
 * Invokes Amazon Bedrock Converse API directly for synchronous responses.
 * For streaming chat, clients should use the ALB->ECS SSE endpoint.
 *
 * Route (requires Cognito JWT with matching custom:tenant_id claim):
 *   POST /api/v1/tenants/{tenantId}/chat
 *
 * Request body:
 *   {
 *     "message": "User message text",
 *     "sessionId": "optional session ID for context",
 *     "modelId": "optional model override",
 *     "systemPrompt": "optional system prompt override"
 *   }
 *
 * Response:
 *   {
 *     "response": "Assistant response text",
 *     "sessionId": "...",
 *     "usage": { "inputTokens": N, "outputTokens": N },
 *     "timestamp": "..."
 *   }
 *
 * Env vars:
 *   TENANTS_TABLE  — DynamoDB table (for rate limit and session context)
 *   BEDROCK_MODEL_ID — inference profile ID (default: us.anthropic.claude-3-5-haiku-20241022-v1:0)
 */

const TENANTS_TABLE = process.env.TENANTS_TABLE;
const DEFAULT_MODEL = process.env.BEDROCK_MODEL_ID
  ?? 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
const MAX_TOKENS = 4096;

let _clients = null;

async function getClients() {
  if (_clients) return _clients;
  const [
    { BedrockRuntimeClient, ConverseCommand },
  ] = await Promise.all([
    import('@aws-sdk/client-bedrock-runtime'),
  ]);
  const bedrock = new BedrockRuntimeClient({});
  _clients = { bedrock, ConverseCommand };
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

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const { bedrock, ConverseCommand } = await getClients();
  const { tenantId } = event.pathParameters ?? {};

  if (!tenantId) return err(400, 'MISSING_PARAM', 'tenantId path parameter is required');

  if (!validateTenantAccess(event, tenantId)) {
    return err(403, 'FORBIDDEN', 'You may only chat within your own tenant');
  }

  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return err(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }

  const { message, sessionId, systemPrompt } = body;
  if (!message || typeof message !== 'string' || message.trim() === '') {
    return err(400, 'MISSING_FIELD', 'Field "message" is required and must be a non-empty string');
  }

  const modelId = body.modelId ?? DEFAULT_MODEL;
  const system = systemPrompt ? [{ text: systemPrompt }] : undefined;

  let bedrockResponse;
  try {
    bedrockResponse = await bedrock.send(new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: message.trim() }] }],
      system,
      inferenceConfig: { maxTokens: MAX_TOKENS },
    }));
  } catch (invokeErr) {
    console.error('chat: Bedrock invocation failed tenantId=%s err=%s', tenantId, invokeErr.message);
    return err(502, 'BEDROCK_ERROR', 'Failed to get response from model');
  }

  const responseText = bedrockResponse.output?.message?.content
    ?.filter(b => b.text != null)
    ?.map(b => b.text)
    ?.join('') ?? '';

  const usage = bedrockResponse.usage ?? {};

  console.log('chat: success tenantId=%s modelId=%s inputTokens=%d outputTokens=%d',
    tenantId, modelId, usage.inputTokens ?? 0, usage.outputTokens ?? 0);

  return ok({
    response: responseText,
    sessionId: sessionId ?? null,
    modelId,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    },
    timestamp: new Date().toISOString(),
  });
};
