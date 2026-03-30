"""Tests for cloudmap_tools module."""
from unittest.mock import MagicMock, patch

import pytest

import tools.cloudmap_tools as cm
from tools.cloudmap_tools import (
    _find_namespace_id,
    _find_service_id,
    _list_all_instances,
    _list_all_services,
    discover_infrastructure,
    get_namespace_summary,
    get_service_instances,
)

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

NAMESPACE_ID = 'ns-abc123'
SERVICE_ID = 'srv-def456'

NAMESPACE_PAGE = {
    'Namespaces': [
        {'Id': NAMESPACE_ID, 'Name': 'chimera-dev', 'Type': 'HTTP'},
    ]
}

SERVICES_PAGE = {
    'Services': [
        {'Id': 'srv-chat', 'Name': 'chat-gateway'},
        {'Id': 'srv-api', 'Name': 'api-gateway'},
    ]
}

INSTANCE_CHAT = {
    'Id': 'chat-instance-1',
    'Attributes': {
        'stackName': 'ChimeraChatStack',
        'resourceType': 'ECS::Service',
        'arn': 'arn:aws:ecs:us-east-1:123456789012:service/chimera-chat',
        'endpoint': 'https://chat.chimera.internal',
        'healthStatus': 'HEALTHY',
    },
}

INSTANCE_API = {
    'Id': 'api-instance-1',
    'Attributes': {
        'stackName': 'ChimeraApiStack',
        'resourceType': 'ApiGateway::RestApi',
        'arn': 'arn:aws:apigateway:us-east-1::/restapis/abc123',
        'endpoint': 'https://api.chimera.internal',
        'healthStatus': 'HEALTHY',
    },
}


def _make_paginator(pages):
    """Create a mock paginator that yields the given pages."""
    mock_paginator = MagicMock()
    mock_paginator.paginate.return_value = iter(pages)
    return mock_paginator


def _make_client(namespaces=None, services=None, instances=None, namespace_detail=None):
    """Build a mock servicediscovery client with configurable paginator responses."""
    client = MagicMock()

    def get_paginator(operation_name):
        if operation_name == 'list_namespaces':
            return _make_paginator([namespaces or {'Namespaces': []}])
        if operation_name == 'list_services':
            return _make_paginator([services or {'Services': []}])
        if operation_name == 'list_instances':
            return _make_paginator([instances or {'Instances': []}])
        raise ValueError(f"Unexpected paginator: {operation_name}")

    client.get_paginator.side_effect = get_paginator

    if namespace_detail:
        client.get_namespace.return_value = {'Namespace': namespace_detail}

    return client


# ---------------------------------------------------------------------------
# _find_namespace_id
# ---------------------------------------------------------------------------


class TestFindNamespaceId:
    def test_returns_id_when_found(self):
        client = _make_client(namespaces=NAMESPACE_PAGE)
        result = _find_namespace_id(client, 'chimera-dev')
        assert result == NAMESPACE_ID

    def test_returns_none_when_not_found(self):
        client = _make_client(namespaces={'Namespaces': []})
        result = _find_namespace_id(client, 'chimera-missing')
        assert result is None

    def test_matches_exact_name(self):
        client = _make_client(namespaces=NAMESPACE_PAGE)
        result = _find_namespace_id(client, 'chimera-prod')
        assert result is None  # 'chimera-prod' != 'chimera-dev'


# ---------------------------------------------------------------------------
# _find_service_id
# ---------------------------------------------------------------------------


class TestFindServiceId:
    def test_returns_id_when_found(self):
        client = _make_client(services=SERVICES_PAGE)
        result = _find_service_id(client, NAMESPACE_ID, 'chat-gateway')
        assert result == 'srv-chat'

    def test_returns_none_when_not_found(self):
        client = _make_client(services=SERVICES_PAGE)
        result = _find_service_id(client, NAMESPACE_ID, 'missing-service')
        assert result is None

    def test_passes_namespace_filter(self):
        client = _make_client(services=SERVICES_PAGE)
        _find_service_id(client, NAMESPACE_ID, 'chat-gateway')
        # list_services paginator must be called with NAMESPACE_ID filter
        call_kwargs = client.get_paginator.return_value.paginate.call_args
        # The mock returns via side_effect; check paginator was requested
        assert client.get_paginator.called


# ---------------------------------------------------------------------------
# _list_all_services
# ---------------------------------------------------------------------------


class TestListAllServices:
    def test_returns_all_services(self):
        client = _make_client(services=SERVICES_PAGE)
        result = _list_all_services(client, NAMESPACE_ID)
        assert len(result) == 2
        assert result[0]['Name'] == 'chat-gateway'

    def test_returns_empty_list_when_none(self):
        client = _make_client(services={'Services': []})
        result = _list_all_services(client, NAMESPACE_ID)
        assert result == []


# ---------------------------------------------------------------------------
# _list_all_instances
# ---------------------------------------------------------------------------


class TestListAllInstances:
    def test_returns_all_instances(self):
        client = _make_client(instances={'Instances': [INSTANCE_CHAT]})
        result = _list_all_instances(client, SERVICE_ID)
        assert len(result) == 1
        assert result[0]['Id'] == 'chat-instance-1'

    def test_returns_empty_list_when_none(self):
        client = _make_client(instances={'Instances': []})
        result = _list_all_instances(client, SERVICE_ID)
        assert result == []


# ---------------------------------------------------------------------------
# discover_infrastructure
# ---------------------------------------------------------------------------


class TestDiscoverInfrastructure:
    def _patch_client(self, mocker, client):
        mocker.patch('tools.cloudmap_tools.boto3.client', return_value=client)

    def test_returns_all_instances_grouped_by_stack(self, mocker, monkeypatch):
        monkeypatch.setenv('CHIMERA_ENV_NAME', 'dev')

        def get_paginator(op):
            if op == 'list_namespaces':
                return _make_paginator([NAMESPACE_PAGE])
            if op == 'list_services':
                return _make_paginator([SERVICES_PAGE])
            if op == 'list_instances':
                # Return one instance per service call
                return _make_paginator([{'Instances': [INSTANCE_CHAT]}])
            raise ValueError(op)

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        self._patch_client(mocker, client)

        result = discover_infrastructure()

        assert 'chimera-dev' in result
        assert 'ChimeraChatStack' in result
        assert 'chat-instance-1' in result
        assert 'ECS::Service' in result
        assert 'HEALTHY' in result

    def test_uses_chimera_env_name_env_var(self, mocker, monkeypatch):
        monkeypatch.setenv('CHIMERA_ENV_NAME', 'prod')

        def get_paginator(op):
            return _make_paginator([{'Namespaces': [], 'Services': [], 'Instances': []}])

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        self._patch_client(mocker, client)

        result = discover_infrastructure()

        assert 'chimera-prod' in result

    def test_env_name_arg_overrides_env_var(self, mocker, monkeypatch):
        monkeypatch.setenv('CHIMERA_ENV_NAME', 'dev')

        def get_paginator(op):
            return _make_paginator([{'Namespaces': [], 'Services': [], 'Instances': []}])

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        self._patch_client(mocker, client)

        result = discover_infrastructure(env_name='staging')

        assert 'chimera-staging' in result

    def test_namespace_not_found_message(self, mocker):
        client = _make_client(namespaces={'Namespaces': []})
        self._patch_client(mocker, client)

        result = discover_infrastructure(env_name='dev')

        assert "No Cloud Map namespace 'chimera-dev' found" in result

    def test_namespace_with_no_services(self, mocker):
        client = _make_client(namespaces=NAMESPACE_PAGE, services={'Services': []})
        self._patch_client(mocker, client)

        result = discover_infrastructure(env_name='dev')

        assert 'no registered services' in result

    def test_resource_type_filter_applied(self, mocker):
        def get_paginator(op):
            if op == 'list_namespaces':
                return _make_paginator([NAMESPACE_PAGE])
            if op == 'list_services':
                return _make_paginator([{'Services': [{'Id': 'srv-chat', 'Name': 'chat-gateway'}]}])
            if op == 'list_instances':
                return _make_paginator([{'Instances': [INSTANCE_CHAT, INSTANCE_API]}])
            raise ValueError(op)

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        mocker.patch('tools.cloudmap_tools.boto3.client', return_value=client)

        result = discover_infrastructure(env_name='dev', resource_type='ECS::Service')

        assert 'ECS::Service' in result
        assert 'ApiGateway::RestApi' not in result

    def test_no_matching_instances_after_filter(self, mocker):
        def get_paginator(op):
            if op == 'list_namespaces':
                return _make_paginator([NAMESPACE_PAGE])
            if op == 'list_services':
                return _make_paginator([{'Services': [{'Id': 'srv-chat', 'Name': 'chat-gateway'}]}])
            if op == 'list_instances':
                return _make_paginator([{'Instances': [INSTANCE_CHAT]}])
            raise ValueError(op)

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        mocker.patch('tools.cloudmap_tools.boto3.client', return_value=client)

        result = discover_infrastructure(env_name='dev', resource_type='Lambda::Function')

        assert "No instances found with resourceType='Lambda::Function'" in result

    def test_endpoint_omitted_when_na(self, mocker):
        instance_no_endpoint = {
            'Id': 'lambda-1',
            'Attributes': {
                'stackName': 'ChimeraStack',
                'resourceType': 'Lambda::Function',
                'arn': 'arn:aws:lambda:us-east-1:123:function/test',
                'endpoint': 'N/A',
                'healthStatus': 'HEALTHY',
            },
        }

        def get_paginator(op):
            if op == 'list_namespaces':
                return _make_paginator([NAMESPACE_PAGE])
            if op == 'list_services':
                return _make_paginator([{'Services': [{'Id': 'srv-lambda', 'Name': 'lambda-svc'}]}])
            if op == 'list_instances':
                return _make_paginator([{'Instances': [instance_no_endpoint]}])
            raise ValueError(op)

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        mocker.patch('tools.cloudmap_tools.boto3.client', return_value=client)

        result = discover_infrastructure(env_name='dev')

        assert 'Endpoint:' not in result

    def test_reports_error_on_exception(self, mocker):
        client = MagicMock()
        client.get_paginator.side_effect = Exception('Connection refused')
        mocker.patch('tools.cloudmap_tools.boto3.client', return_value=client)

        result = discover_infrastructure(env_name='dev')

        assert 'Error discovering infrastructure' in result
        assert 'Connection refused' in result


# ---------------------------------------------------------------------------
# get_service_instances
# ---------------------------------------------------------------------------


class TestGetServiceInstances:
    def _patch_client(self, mocker, client):
        mocker.patch('tools.cloudmap_tools.boto3.client', return_value=client)

    def test_returns_instance_details(self, mocker):
        def get_paginator(op):
            if op == 'list_namespaces':
                return _make_paginator([NAMESPACE_PAGE])
            if op == 'list_services':
                return _make_paginator([SERVICES_PAGE])
            if op == 'list_instances':
                return _make_paginator([{'Instances': [INSTANCE_CHAT]}])
            raise ValueError(op)

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        self._patch_client(mocker, client)

        result = get_service_instances(service_name='chat-gateway', env_name='dev')

        assert 'chat-gateway' in result
        assert 'chat-instance-1' in result
        assert 'ChimeraChatStack' in result
        assert 'ECS::Service' in result
        assert 'HEALTHY' in result

    def test_namespace_not_found(self, mocker):
        client = _make_client(namespaces={'Namespaces': []})
        self._patch_client(mocker, client)

        result = get_service_instances(service_name='chat-gateway', env_name='dev')

        assert "No Cloud Map namespace 'chimera-dev' found" in result

    def test_service_not_found(self, mocker):
        client = _make_client(namespaces=NAMESPACE_PAGE, services={'Services': []})
        self._patch_client(mocker, client)

        result = get_service_instances(service_name='missing-service', env_name='dev')

        assert "'missing-service' not found" in result

    def test_service_with_no_instances(self, mocker):
        def get_paginator(op):
            if op == 'list_namespaces':
                return _make_paginator([NAMESPACE_PAGE])
            if op == 'list_services':
                return _make_paginator([SERVICES_PAGE])
            if op == 'list_instances':
                return _make_paginator([{'Instances': []}])
            raise ValueError(op)

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        self._patch_client(mocker, client)

        result = get_service_instances(service_name='chat-gateway', env_name='dev')

        assert 'no registered instances' in result

    def test_reports_error_on_exception(self, mocker):
        client = MagicMock()
        client.get_paginator.side_effect = Exception('Throttled')
        self._patch_client(mocker, client)

        result = get_service_instances(service_name='chat-gateway', env_name='dev')

        assert "Error getting instances for service 'chat-gateway'" in result
        assert 'Throttled' in result

    def test_instance_count_shown(self, mocker):
        def get_paginator(op):
            if op == 'list_namespaces':
                return _make_paginator([NAMESPACE_PAGE])
            if op == 'list_services':
                return _make_paginator([SERVICES_PAGE])
            if op == 'list_instances':
                return _make_paginator([{'Instances': [INSTANCE_CHAT, INSTANCE_CHAT]}])
            raise ValueError(op)

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        self._patch_client(mocker, client)

        result = get_service_instances(service_name='chat-gateway', env_name='dev')

        assert 'Instances: 2' in result


# ---------------------------------------------------------------------------
# get_namespace_summary
# ---------------------------------------------------------------------------


class TestGetNamespaceSummary:
    def _patch_client(self, mocker, client):
        mocker.patch('tools.cloudmap_tools.boto3.client', return_value=client)

    def test_returns_namespace_metadata(self, mocker):
        from datetime import datetime, timezone

        ns_detail = {
            'Id': NAMESPACE_ID,
            'Name': 'chimera-dev',
            'Type': 'HTTP',
            'CreateDate': datetime(2026, 1, 15, 10, 30, 0, tzinfo=timezone.utc),
        }

        def get_paginator(op):
            if op == 'list_namespaces':
                return _make_paginator([NAMESPACE_PAGE])
            if op == 'list_services':
                return _make_paginator([SERVICES_PAGE])
            if op == 'list_instances':
                return _make_paginator([{'Instances': [INSTANCE_CHAT]}])
            raise ValueError(op)

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        client.get_namespace.return_value = {'Namespace': ns_detail}
        self._patch_client(mocker, client)

        result = get_namespace_summary(env_name='dev')

        assert 'chimera-dev' in result
        assert NAMESPACE_ID in result
        assert 'HTTP' in result
        assert '2026-01-15' in result
        assert 'Services:     2' in result

    def test_lists_all_services_with_counts(self, mocker):
        ns_detail = {'Id': NAMESPACE_ID, 'Name': 'chimera-dev', 'Type': 'HTTP', 'CreateDate': ''}

        def get_paginator(op):
            if op == 'list_namespaces':
                return _make_paginator([NAMESPACE_PAGE])
            if op == 'list_services':
                return _make_paginator([SERVICES_PAGE])
            if op == 'list_instances':
                return _make_paginator([{'Instances': [INSTANCE_CHAT]}])
            raise ValueError(op)

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        client.get_namespace.return_value = {'Namespace': ns_detail}
        self._patch_client(mocker, client)

        result = get_namespace_summary(env_name='dev')

        assert 'chat-gateway' in result
        assert 'api-gateway' in result
        assert '1 instance(s)' in result

    def test_namespace_not_found(self, mocker):
        client = _make_client(namespaces={'Namespaces': []})
        self._patch_client(mocker, client)

        result = get_namespace_summary(env_name='dev')

        assert "No Cloud Map namespace 'chimera-dev' found" in result

    def test_reports_error_on_exception(self, mocker):
        client = MagicMock()
        client.get_paginator.side_effect = Exception('AccessDenied')
        self._patch_client(mocker, client)

        result = get_namespace_summary(env_name='dev')

        assert 'Error getting namespace summary' in result
        assert 'AccessDenied' in result

    def test_total_instance_count(self, mocker):
        ns_detail = {'Id': NAMESPACE_ID, 'Name': 'chimera-dev', 'Type': 'HTTP', 'CreateDate': ''}

        call_count = [0]

        def get_paginator(op):
            if op == 'list_namespaces':
                return _make_paginator([NAMESPACE_PAGE])
            if op == 'list_services':
                return _make_paginator([{'Services': [
                    {'Id': 'srv-a', 'Name': 'svc-a'},
                    {'Id': 'srv-b', 'Name': 'svc-b'},
                ]}])
            if op == 'list_instances':
                call_count[0] += 1
                # First service: 2 instances, second: 1 instance
                if call_count[0] == 1:
                    return _make_paginator([{'Instances': [INSTANCE_CHAT, INSTANCE_CHAT]}])
                return _make_paginator([{'Instances': [INSTANCE_API]}])
            raise ValueError(op)

        client = MagicMock()
        client.get_paginator.side_effect = get_paginator
        client.get_namespace.return_value = {'Namespace': ns_detail}
        self._patch_client(mocker, client)

        result = get_namespace_summary(env_name='dev')

        assert 'Instances:    3' in result


# ---------------------------------------------------------------------------
# gateway_config integration: cloudmap_tools registered at tier 0
# ---------------------------------------------------------------------------


class TestGatewayConfigIntegration:
    def test_cloudmap_tools_in_registry(self):
        import gateway_config
        assert 'tools.cloudmap_tools' in gateway_config._TOOL_TIER_REGISTRY

    def test_cloudmap_tools_at_tier_0(self):
        import gateway_config
        tier, _ = gateway_config._TOOL_TIER_REGISTRY['tools.cloudmap_tools']
        assert tier == 0

    def test_all_cloudmap_tools_have_descriptions(self):
        import gateway_config
        _, tool_names = gateway_config._TOOL_TIER_REGISTRY['tools.cloudmap_tools']
        for name in tool_names:
            assert name in gateway_config._TOOL_DESCRIPTIONS, (
                f"Missing description for {name}"
            )

    def test_cloudmap_tools_available_to_basic_tier(self):
        import gateway_config
        from unittest.mock import patch
        gateway = gateway_config.GatewayToolDiscovery()
        with patch('gateway_config._read_gateway_arns') as mock_arns, \
             patch('gateway_config.create_gateway_proxy_tools', return_value=[]):
            mock_arns.return_value = {
                'tier1': 'arn:tier1', 'tier2': 'arn:tier2',
                'tier3': 'arn:tier3', 'discovery': 'arn:discovery',
            }
            result = gateway._discover_from_gateway('tenant-1', 'basic', None, None)

        assert 'cloudmap' not in result.denied_identifiers

    def test_cloudmap_tools_available_to_premium_tier(self):
        import gateway_config
        from unittest.mock import patch
        gateway = gateway_config.GatewayToolDiscovery()
        with patch('gateway_config._read_gateway_arns') as mock_arns, \
             patch('gateway_config.create_gateway_proxy_tools', return_value=[]):
            mock_arns.return_value = {
                'tier1': 'arn:tier1', 'tier2': 'arn:tier2',
                'tier3': 'arn:tier3', 'discovery': 'arn:discovery',
            }
            result = gateway._discover_from_gateway('tenant-1', 'premium', None, None)

        assert 'cloudmap' not in result.denied_identifiers
