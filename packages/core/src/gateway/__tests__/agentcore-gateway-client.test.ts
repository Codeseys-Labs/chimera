import { describe, it, expect, beforeEach } from 'bun:test';
import {
  AgentcoreGatewayClient,
  type GatewaySdkClient,
} from '../agentcore-gateway-client';
import {
  GatewayAuthError,
  GatewayNotFoundError,
  GatewayRateLimitError,
  GatewayUnavailableError,
} from '../types';

const GATEWAY_ID = 'gw-abc123';
const REGION = 'us-west-2';

/**
 * Fake SDK command classes. The client's internal logic does
 * `new Cmd(input)` then `client.send(cmd)`. Our fakes capture the input on
 * construction so tests can assert on it.
 */
function makeCommandCtor(
  name: string
): new (input: unknown) => { _name: string; input: unknown } {
  return class {
    public readonly _name = name;
    public readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  };
}

interface FakeClient extends GatewaySdkClient {
  _commands: Record<string, new (input: unknown) => unknown>;
  _sent: Array<{ name: string; input: unknown }>;
  _nextResponse?: unknown;
  _nextError?: unknown;
}

function makeFakeControlClient(): FakeClient {
  const sent: FakeClient['_sent'] = [];
  const client: FakeClient = {
    _commands: {
      CreateGatewayCommand: makeCommandCtor('CreateGatewayCommand'),
      CreateGatewayTargetCommand: makeCommandCtor('CreateGatewayTargetCommand'),
      ListGatewayTargetsCommand: makeCommandCtor('ListGatewayTargetsCommand'),
      SynchronizeGatewayTargetsCommand: makeCommandCtor(
        'SynchronizeGatewayTargetsCommand'
      ),
    },
    _sent: sent,
    async send(command: unknown) {
      const c = command as { _name: string; input: unknown };
      sent.push({ name: c._name, input: c.input });
      if (client._nextError) {
        const e = client._nextError;
        client._nextError = undefined;
        throw e;
      }
      const resp = client._nextResponse;
      client._nextResponse = undefined;
      return resp;
    },
  };
  return client;
}

function makeFakeDataClient(): FakeClient {
  const sent: FakeClient['_sent'] = [];
  const client: FakeClient = {
    _commands: {
      InvokeGatewayToolCommand: makeCommandCtor('InvokeGatewayToolCommand'),
    },
    _sent: sent,
    async send(command: unknown) {
      const c = command as { _name: string; input: unknown };
      sent.push({ name: c._name, input: c.input });
      if (client._nextError) {
        const e = client._nextError;
        client._nextError = undefined;
        throw e;
      }
      const resp = client._nextResponse;
      client._nextResponse = undefined;
      return resp;
    },
  };
  return client;
}

describe('AgentcoreGatewayClient construction', () => {
  it('requires gatewayId and region', () => {
    expect(
      () => new AgentcoreGatewayClient({ gatewayId: '', region: REGION })
    ).toThrow(/gatewayId/);
    expect(
      () => new AgentcoreGatewayClient({ gatewayId: GATEWAY_ID, region: '' })
    ).toThrow(/region/);
  });

  it('exposes an MCP endpoint URL in the documented format', () => {
    const client = new AgentcoreGatewayClient({
      gatewayId: GATEWAY_ID,
      region: REGION,
    });
    expect(client.getMcpEndpoint()).toBe(
      `https://${GATEWAY_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com/mcp`
    );
  });

  it('allows overriding gatewayId per call in getMcpEndpoint', () => {
    const client = new AgentcoreGatewayClient({
      gatewayId: GATEWAY_ID,
      region: REGION,
    });
    expect(client.getMcpEndpoint('gw-other')).toContain('gw-other.gateway');
  });
});

describe('AgentcoreGatewayClient.listTargets', () => {
  let control: FakeClient;
  let client: AgentcoreGatewayClient;

  beforeEach(() => {
    control = makeFakeControlClient();
    client = new AgentcoreGatewayClient({
      gatewayId: GATEWAY_ID,
      region: REGION,
      _controlPlaneClient: control,
    });
  });

  it('calls ListGatewayTargetsCommand with the configured gatewayId', async () => {
    control._nextResponse = { targets: [] };
    const out = await client.listTargets();
    expect(control._sent).toHaveLength(1);
    expect(control._sent[0].name).toBe('ListGatewayTargetsCommand');
    expect(
      (control._sent[0].input as Record<string, unknown>).gatewayIdentifier
    ).toBe(GATEWAY_ID);
    expect(out).toEqual([]);
  });

  it('flattens lambda / openapi / smithy / mcp-remote targets into canonical shape', async () => {
    control._nextResponse = {
      targets: [
        {
          name: 's3',
          lambda: {
            targetArn: 'arn:aws:lambda:us-west-2:111:function:s3',
            schema: { tools: ['list'] },
          },
        },
        {
          name: 'public-api',
          openApi: { endpoint: 'https://api.example.com/openapi.json' },
        },
        { name: 'dynamodb-native', smithy: { model: 'smithy-json-model' } },
        {
          name: 'remote-mcp',
          mcpRemote: { endpoint: 'https://remote.example.com/mcp' },
        },
        {
          name: 'stage',
          apiGatewayStage: { apiId: 'abcd', stageName: 'prod' },
        },
        {
          name: 'slack',
          saasTemplate: { templateId: 'slack-oauth-v1' },
        },
      ],
    };
    const out = await client.listTargets();
    expect(out).toHaveLength(6);
    expect(out[0]).toEqual({
      type: 'lambda',
      name: 's3',
      arn: 'arn:aws:lambda:us-west-2:111:function:s3',
      schema: { tools: ['list'] },
      metadata: undefined,
    });
    expect(out[1].type).toBe('openapi');
    expect(out[2].type).toBe('smithy');
    expect(out[3].type).toBe('mcp-remote');
    expect(out[4].type).toBe('api-gateway-stage');
    expect(out[4].endpoint).toBe('apigateway://abcd/prod');
    expect(out[5].type).toBe('template');
    expect(out[5].metadata?.templateId).toBe('slack-oauth-v1');
  });

  it('accepts an explicit gatewayId override', async () => {
    control._nextResponse = { targets: [] };
    await client.listTargets('gw-override');
    expect(
      (control._sent[0].input as Record<string, unknown>).gatewayIdentifier
    ).toBe('gw-override');
  });

  it('maps AccessDeniedException to GatewayAuthError', async () => {
    control._nextError = {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 },
      message: 'denied',
    };
    await expect(client.listTargets()).rejects.toBeInstanceOf(GatewayAuthError);
  });

  it('maps ThrottlingException to GatewayRateLimitError', async () => {
    control._nextError = {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 429 },
      message: 'slow down',
    };
    await expect(client.listTargets()).rejects.toBeInstanceOf(
      GatewayRateLimitError
    );
  });

  it('maps ResourceNotFoundException to GatewayNotFoundError', async () => {
    control._nextError = {
      name: 'ResourceNotFoundException',
      $metadata: { httpStatusCode: 404 },
      message: 'missing',
    };
    await expect(client.listTargets()).rejects.toBeInstanceOf(
      GatewayNotFoundError
    );
  });

  it('maps unknown errors to GatewayUnavailableError', async () => {
    control._nextError = new Error('boom');
    await expect(client.listTargets()).rejects.toBeInstanceOf(
      GatewayUnavailableError
    );
  });
});

describe('AgentcoreGatewayClient.invokeTool', () => {
  let data: FakeClient;
  let client: AgentcoreGatewayClient;

  beforeEach(() => {
    data = makeFakeDataClient();
    client = new AgentcoreGatewayClient({
      gatewayId: GATEWAY_ID,
      region: REGION,
      _dataPlaneClient: data,
    });
  });

  it('calls InvokeGatewayToolCommand with the right input (3-arg form)', async () => {
    data._nextResponse = { payload: { buckets: ['a', 'b'] } };
    const out = await client.invokeTool(GATEWAY_ID, 's3___list_buckets', {
      region: 'us-east-1',
    });
    expect(data._sent).toHaveLength(1);
    expect(data._sent[0].name).toBe('InvokeGatewayToolCommand');
    const input = data._sent[0].input as Record<string, unknown>;
    expect(input.gatewayIdentifier).toBe(GATEWAY_ID);
    expect(input.toolName).toBe('s3___list_buckets');
    expect(input.arguments).toEqual({ region: 'us-east-1' });
    expect(out.status).toBe('success');
    expect(out.toolName).toBe('s3___list_buckets');
    expect(out.payload).toEqual({ buckets: ['a', 'b'] });
  });

  it('supports the 2-arg convenience form (toolName, args) using default gatewayId', async () => {
    data._nextResponse = { payload: 'ok' };
    const out = await client.invokeTool('s3___list_buckets', { region: 'us-east-1' });
    expect(
      (data._sent[0].input as Record<string, unknown>).gatewayIdentifier
    ).toBe(GATEWAY_ID);
    expect(out.status).toBe('success');
  });

  it('converts Gateway-reported tool errors into an error-status result envelope', async () => {
    data._nextResponse = {
      isError: true,
      errorMessage: 'S3 bucket not found',
    };
    const out = await client.invokeTool(GATEWAY_ID, 's3___get_bucket', {});
    expect(out.status).toBe('error');
    expect(out.error).toBe('S3 bucket not found');
  });

  it('raises GatewayAuthError on 403 from SDK', async () => {
    data._nextError = {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403 },
      message: 'nope',
    };
    await expect(
      client.invokeTool(GATEWAY_ID, 'foo', {})
    ).rejects.toBeInstanceOf(GatewayAuthError);
  });

  it('rejects empty toolName', async () => {
    await expect(client.invokeTool(GATEWAY_ID, '', {})).rejects.toThrow(
      /toolName/
    );
  });

  it('rejects when neither default gatewayId nor per-call gatewayId is set', async () => {
    // Construct a client with a dummy default then attempt to call with
    // falsy per-call gatewayId — the constructor rejects empty IDs so the
    // only way to trigger the "no gatewayId" path is via the 2-arg call
    // form with the default also cleared. We simulate by poking the field.
    const bareClient = new AgentcoreGatewayClient({
      gatewayId: 'temp',
      region: REGION,
      _dataPlaneClient: data,
    });
    // Type-unsafe but intentional for this edge test.
    (bareClient as unknown as { defaultGatewayId: string }).defaultGatewayId =
      '';
    // 2-arg form: (toolName, args). With empty toolName AND empty default
    // gatewayId, the gatewayId check fires first.
    await expect(
      bareClient.invokeTool('some-tool', { k: 'v' })
    ).rejects.toThrow(/gatewayId/);
  });
});

describe('AgentcoreGatewayClient unavailable paths', () => {
  it('raises GatewayUnavailableError when no control client injected and SDK missing', async () => {
    const client = new AgentcoreGatewayClient({
      gatewayId: GATEWAY_ID,
      region: REGION,
    });
    await expect(client.listTargets()).rejects.toBeInstanceOf(
      GatewayUnavailableError
    );
  });

  it('raises GatewayUnavailableError when no data client injected and SDK missing', async () => {
    const client = new AgentcoreGatewayClient({
      gatewayId: GATEWAY_ID,
      region: REGION,
    });
    await expect(client.invokeTool(GATEWAY_ID, 'foo', {})).rejects.toBeInstanceOf(
      GatewayUnavailableError
    );
  });
});

describe('AgentcoreGatewayClient error mapping edge cases', () => {
  it('maps 401 to GatewayAuthError', async () => {
    const control = makeFakeControlClient();
    const client = new AgentcoreGatewayClient({
      gatewayId: GATEWAY_ID,
      region: REGION,
      _controlPlaneClient: control,
    });
    control._nextError = {
      $metadata: { httpStatusCode: 401 },
      message: 'no auth',
    };
    await expect(client.listTargets()).rejects.toBeInstanceOf(GatewayAuthError);
  });

  it('exposes the last command name for debugging', async () => {
    const control = makeFakeControlClient();
    const client = new AgentcoreGatewayClient({
      gatewayId: GATEWAY_ID,
      region: REGION,
      _controlPlaneClient: control,
    });
    control._nextResponse = { targets: [] };
    await client.listTargets();
    expect(client.getLastCommandName()).toBe('ListGatewayTargetsCommand');
  });
});
