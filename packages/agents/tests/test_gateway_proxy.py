"""Tests for gateway_proxy module."""
import json
from io import BytesIO
from unittest.mock import MagicMock

import pytest

import gateway_proxy
from gateway_proxy import GatewayToolDefinition, create_gateway_proxy_tool, create_gateway_proxy_tools


def _lambda_response(result_dict: dict) -> dict:
    """Build a mock boto3 Lambda invoke response with a BytesIO payload."""
    return {
        'StatusCode': 200,
        'Payload': BytesIO(json.dumps(result_dict).encode('utf-8')),
    }


@pytest.fixture
def tool_def():
    return GatewayToolDefinition(
        name='list_s3_buckets',
        description='List all S3 buckets in the AWS account',
        service_identifier='s3',
        target_arn='arn:aws:lambda:us-east-1:123456789012:function:chimera-gateway-tools-tier1-dev',
        tier=1,
    )


@pytest.fixture
def mock_lambda(mocker):
    """Patch _get_lambda_client and the @tool decorator for unit testing.

    The @tool no-op ensures the proxy function is returned unwrapped,
    making it callable directly with **kwargs in assertions.
    """
    mock_client = MagicMock()
    mocker.patch('gateway_proxy._get_lambda_client', return_value=mock_client)
    mocker.patch('gateway_proxy.tool', side_effect=lambda f: f)
    # Reset the module-level singleton so each test starts fresh
    mocker.patch.object(gateway_proxy, '_lambda_client', None)
    return mock_client


class TestCreateGatewayProxyTool:
    def test_returns_callable(self, tool_def, mock_lambda):
        proxy = create_gateway_proxy_tool(tool_def, 'tenant-123')
        assert callable(proxy)

    def test_correct_name_and_doc(self, tool_def, mock_lambda):
        proxy = create_gateway_proxy_tool(tool_def, 'tenant-123')
        assert proxy.__name__ == 'list_s3_buckets'
        assert proxy.__doc__ == 'List all S3 buckets in the AWS account'

    def test_invokes_lambda_with_correct_payload(self, tool_def, mock_lambda):
        mock_lambda.invoke.return_value = _lambda_response({'statusCode': 200, 'result': 'ok'})
        proxy = create_gateway_proxy_tool(tool_def, 'tenant-123')

        proxy(prefix='my-')

        mock_lambda.invoke.assert_called_once()
        call_kwargs = mock_lambda.invoke.call_args.kwargs
        assert call_kwargs['FunctionName'] == tool_def.target_arn
        assert call_kwargs['InvocationType'] == 'RequestResponse'
        payload = json.loads(call_kwargs['Payload'])
        assert payload['tool_name'] == 's3'
        assert payload['action'] == 'list_s3_buckets'
        assert payload['tenant_id'] == 'tenant-123'
        assert payload['tool_input'] == {'prefix': 'my-'}

    def test_returns_result_string_from_response(self, tool_def, mock_lambda):
        mock_lambda.invoke.return_value = _lambda_response({
            'statusCode': 200,
            'result': 'Found 2 buckets: bucket-a, bucket-b',
        })
        proxy = create_gateway_proxy_tool(tool_def, 'tenant-123')
        assert proxy() == 'Found 2 buckets: bucket-a, bucket-b'

    def test_handles_non_result_dict_response(self, tool_def, mock_lambda):
        mock_lambda.invoke.return_value = _lambda_response({'statusCode': 200, 'data': 'raw'})
        proxy = create_gateway_proxy_tool(tool_def, 'tenant-123')
        result = proxy()
        # Returns str(result) when no 'result' key
        assert 'data' in result or 'raw' in result

    def test_handles_lambda_error_response(self, tool_def, mock_lambda):
        mock_lambda.invoke.return_value = _lambda_response({
            'statusCode': 400,
            'error': 'Tool s3 not available in Tier 1',
        })
        proxy = create_gateway_proxy_tool(tool_def, 'tenant-123')
        result = proxy()
        assert 'Error from gateway tool list_s3_buckets' in result
        assert 'not available' in result

    def test_handles_lambda_invocation_exception(self, tool_def, mock_lambda):
        mock_lambda.invoke.side_effect = Exception('Connection timeout')
        proxy = create_gateway_proxy_tool(tool_def, 'tenant-123')
        result = proxy()
        assert 'Error invoking gateway tool list_s3_buckets' in result
        assert 'Connection timeout' in result

    def test_tenant_id_injected_into_payload(self, tool_def, mock_lambda):
        mock_lambda.invoke.return_value = _lambda_response({'statusCode': 200, 'result': 'ok'})
        proxy = create_gateway_proxy_tool(tool_def, 'tenant-xyz')
        proxy()
        payload = json.loads(mock_lambda.invoke.call_args.kwargs['Payload'])
        assert payload['tenant_id'] == 'tenant-xyz'


class TestCreateGatewayProxyTools:
    def test_creates_tools_for_each_definition(self, mocker):
        mock_client = MagicMock()
        mocker.patch('gateway_proxy._get_lambda_client', return_value=mock_client)
        mocker.patch('gateway_proxy.tool', side_effect=lambda f: f)

        tool_defs = [
            GatewayToolDefinition('list_s3_buckets', 'List S3', 's3', 'arn:t1', 1),
            GatewayToolDefinition('list_lambda_functions', 'List Lambda', 'lambda', 'arn:t1', 1),
        ]
        tools = create_gateway_proxy_tools(tool_defs, 'tenant-456')
        assert len(tools) == 2
        assert all(callable(t) for t in tools)

    def test_continues_on_individual_failure(self, mocker):
        """Batch factory logs warnings for failures and continues."""
        mock_client = MagicMock()
        mocker.patch('gateway_proxy._get_lambda_client', return_value=mock_client)
        # Make @tool raise on first call, succeed on second
        mocker.patch(
            'gateway_proxy.tool',
            side_effect=[Exception('decorator failed'), lambda f: f],
        )

        tool_defs = [
            GatewayToolDefinition('fail_tool', 'Fails', 's3', 'arn:t1', 1),
            GatewayToolDefinition('ok_tool', 'Works', 'lambda', 'arn:t1', 1),
        ]
        tools = create_gateway_proxy_tools(tool_defs, 'tenant-789')
        assert len(tools) == 1

    def test_empty_input_returns_empty_list(self, mocker):
        mocker.patch('gateway_proxy._get_lambda_client', return_value=MagicMock())
        mocker.patch('gateway_proxy.tool', side_effect=lambda f: f)
        assert create_gateway_proxy_tools([], 'tenant-000') == []
