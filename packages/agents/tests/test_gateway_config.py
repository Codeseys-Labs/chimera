"""Tests for gateway_config module — Gateway discovery and fallback paths."""
from unittest.mock import MagicMock, call

import pytest

import gateway_config
from gateway_config import GatewayToolDiscovery, _read_gateway_arns


@pytest.fixture(autouse=True)
def reset_module_singletons():
    """Reset module-level singletons before each test for isolation."""
    gateway_config._gateway_arns_cache = None
    gateway_config._ssm_client = None
    yield
    gateway_config._gateway_arns_cache = None
    gateway_config._ssm_client = None


@pytest.fixture
def discovery():
    return GatewayToolDiscovery()


# ---------------------------------------------------------------------------
# _read_gateway_arns
# ---------------------------------------------------------------------------

class TestReadGatewayArns:
    def test_reads_four_ssm_params(self, mocker):
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = lambda Name: {
            'Parameter': {'Value': f'arn:aws:lambda:us-east-1:123:{Name.split("/")[-1]}'}
        }
        mocker.patch('gateway_config._get_ssm_client', return_value=mock_ssm)

        arns = _read_gateway_arns()

        assert mock_ssm.get_parameter.call_count == 4
        assert 'tier1' in arns
        assert 'tier2' in arns
        assert 'tier3' in arns
        assert 'discovery' in arns

    def test_uses_chimera_env_name(self, mocker, monkeypatch):
        monkeypatch.setenv('CHIMERA_ENV_NAME', 'staging')
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = lambda Name: {'Parameter': {'Value': 'arn:fake'}}
        mocker.patch('gateway_config._get_ssm_client', return_value=mock_ssm)

        _read_gateway_arns()

        called_names = [c.kwargs['Name'] for c in mock_ssm.get_parameter.call_args_list]
        assert all('staging' in n for n in called_names)

    def test_defaults_env_name_to_dev(self, mocker, monkeypatch):
        monkeypatch.delenv('CHIMERA_ENV_NAME', raising=False)
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = lambda Name: {'Parameter': {'Value': 'arn:fake'}}
        mocker.patch('gateway_config._get_ssm_client', return_value=mock_ssm)

        _read_gateway_arns()

        called_names = [c.kwargs['Name'] for c in mock_ssm.get_parameter.call_args_list]
        assert all('/dev/' in n for n in called_names)

    def test_omits_missing_params(self, mocker):
        mock_ssm = MagicMock()
        # tier2 and tier3 raise, tier1 and discovery succeed
        def side_effect(Name):
            if 'tier2' in Name or 'tier3' in Name:
                raise Exception('ParameterNotFound')
            return {'Parameter': {'Value': f'arn:fake:{Name}'}}
        mock_ssm.get_parameter.side_effect = side_effect
        mocker.patch('gateway_config._get_ssm_client', return_value=mock_ssm)

        arns = _read_gateway_arns()

        assert 'tier1' in arns
        assert 'discovery' in arns
        assert 'tier2' not in arns
        assert 'tier3' not in arns

    def test_caches_result(self, mocker):
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = lambda Name: {'Parameter': {'Value': 'arn:fake'}}
        mocker.patch('gateway_config._get_ssm_client', return_value=mock_ssm)

        _read_gateway_arns()
        _read_gateway_arns()

        # SSM should only be called once due to caching
        assert mock_ssm.get_parameter.call_count == 4


# ---------------------------------------------------------------------------
# GatewayToolDiscovery._discover_from_gateway
# ---------------------------------------------------------------------------

FAKE_ARNS = {
    'tier1': 'arn:aws:lambda:us-east-1:123:function:tier1',
    'tier2': 'arn:aws:lambda:us-east-1:123:function:tier2',
    'tier3': 'arn:aws:lambda:us-east-1:123:function:tier3',
    'discovery': 'arn:aws:lambda:us-east-1:123:function:discovery',
}


class TestDiscoverFromGateway:
    def test_creates_proxy_tools_for_accessible_tiers(self, discovery, mocker):
        mocker.patch('gateway_config._read_gateway_arns', return_value=FAKE_ARNS)
        mock_tool = MagicMock()
        mocker.patch('gateway_config.create_gateway_proxy_tools', return_value=[mock_tool] * 5)

        result = discovery._discover_from_gateway('t1', 'basic', None, None)

        assert result.count == 5
        assert result.tier == 'basic'

    def test_tier_gating_blocks_tier2_for_basic(self, discovery, mocker):
        mocker.patch('gateway_config._read_gateway_arns', return_value=FAKE_ARNS)
        mocker.patch('gateway_config.create_gateway_proxy_tools', return_value=[])

        result = discovery._discover_from_gateway('t1', 'basic', None, None)

        # rds, redshift, athena, glue, opensearch (tier 2) should all be denied
        tier2_ids = {'rds', 'redshift', 'athena', 'glue', 'opensearch'}
        assert tier2_ids.issubset(set(result.denied_identifiers))

    def test_tier_gating_blocks_tier3_for_advanced(self, discovery, mocker):
        mocker.patch('gateway_config._read_gateway_arns', return_value=FAKE_ARNS)
        mocker.patch('gateway_config.create_gateway_proxy_tools', return_value=[])

        result = discovery._discover_from_gateway('t1', 'advanced', None, None)

        # stepfunctions (tier 3) should be denied for advanced
        assert 'stepfunctions' in result.denied_identifiers

    def test_premium_gets_all_tiers(self, discovery, mocker):
        mocker.patch('gateway_config._read_gateway_arns', return_value=FAKE_ARNS)
        mocker.patch('gateway_config.create_gateway_proxy_tools', return_value=[])

        result = discovery._discover_from_gateway('t1', 'premium', None, None)

        assert result.denied_identifiers == []

    def test_deny_list_excludes_modules(self, discovery, mocker):
        mocker.patch('gateway_config._read_gateway_arns', return_value=FAKE_ARNS)
        mocker.patch('gateway_config.create_gateway_proxy_tools', return_value=[])

        result = discovery._discover_from_gateway('t1', 'premium', None, ['s3', 'lambda'])

        assert 's3' in result.denied_identifiers
        assert 'lambda' in result.denied_identifiers

    def test_allow_list_includes_only_listed_non_core(self, discovery, mocker):
        mocker.patch('gateway_config._read_gateway_arns', return_value=FAKE_ARNS)
        mocker.patch('gateway_config.create_gateway_proxy_tools', return_value=[])

        result = discovery._discover_from_gateway('t1', 'premium', ['s3'], None)

        # lambda, ec2, etc. should be denied (not in allow_list, not core)
        assert 'lambda' in result.denied_identifiers
        assert 'ec2' in result.denied_identifiers

    def test_core_tools_always_pass_allow_list(self, discovery, mocker):
        mocker.patch('gateway_config._read_gateway_arns', return_value=FAKE_ARNS)
        mocker.patch('gateway_config.create_gateway_proxy_tools', return_value=[])

        result = discovery._discover_from_gateway('t1', 'premium', ['s3'], None)

        # hello_world and background_task are core (tier 0) — always pass
        assert 'hello_world' not in result.denied_identifiers
        assert 'background_task' not in result.denied_identifiers

    def test_skips_modules_with_missing_arns(self, discovery, mocker):
        arns_no_tier2 = {'tier1': FAKE_ARNS['tier1'], 'discovery': FAKE_ARNS['discovery']}
        mocker.patch('gateway_config._read_gateway_arns', return_value=arns_no_tier2)
        mocker.patch('gateway_config.create_gateway_proxy_tools', return_value=[])

        # Should not raise — modules with missing ARNs are skipped
        result = discovery._discover_from_gateway('t1', 'advanced', None, None)
        assert result is not None

    def test_passes_correct_arns_to_proxy_tools(self, discovery, mocker):
        mocker.patch('gateway_config._read_gateway_arns', return_value=FAKE_ARNS)
        mock_create = mocker.patch('gateway_config.create_gateway_proxy_tools', return_value=[])

        discovery._discover_from_gateway('t1', 'premium', None, None)

        tool_defs = mock_create.call_args.args[0]
        # Tier 1 tools should use tier1 ARN
        tier1_defs = [d for d in tool_defs if d.tier == 1]
        assert all(d.target_arn == FAKE_ARNS['tier1'] for d in tier1_defs)
        # Tier 3 tools should use tier3 ARN
        tier3_defs = [d for d in tool_defs if d.tier == 3]
        assert all(d.target_arn == FAKE_ARNS['tier3'] for d in tier3_defs)


# ---------------------------------------------------------------------------
# GatewayToolDiscovery.discover_tools — gateway vs local path selection
# ---------------------------------------------------------------------------

class TestDiscoverToolsRouting:
    def test_uses_gateway_when_endpoint_set(self, discovery, mocker, monkeypatch):
        monkeypatch.setenv('AGENTCORE_GATEWAY_ENDPOINT', 'https://gateway.example.com')
        mock_gateway = mocker.patch.object(
            discovery, '_discover_from_gateway',
            return_value=MagicMock(tools=[], count=0, tier='basic',
                                   loaded_identifiers=[], denied_identifiers=[]),
        )

        discovery.discover_tools('tenant-001', 'basic')

        mock_gateway.assert_called_once_with('tenant-001', 'basic', None, None)

    def test_falls_back_to_local_when_no_endpoint(self, discovery, mocker, monkeypatch):
        monkeypatch.delenv('AGENTCORE_GATEWAY_ENDPOINT', raising=False)
        mock_local = mocker.patch('gateway_config._load_tools_for_tier')
        mock_local.return_value = MagicMock(
            tools=[], count=0, tier='basic',
            loaded_identifiers=[], denied_identifiers=[],
        )

        discovery.discover_tools('tenant-002', 'basic')

        mock_local.assert_called_once_with('basic', None, None)

    def test_gateway_result_is_cached(self, discovery, mocker, monkeypatch):
        monkeypatch.setenv('AGENTCORE_GATEWAY_ENDPOINT', 'https://gateway.example.com')
        mock_result = MagicMock(
            tools=[], count=0, tier='basic',
            loaded_identifiers=[], denied_identifiers=[],
        )
        mock_gateway = mocker.patch.object(
            discovery, '_discover_from_gateway', return_value=mock_result,
        )

        discovery.discover_tools('tenant-003', 'basic')
        discovery.discover_tools('tenant-003', 'basic')  # second call

        # _discover_from_gateway called only once — cache hit on second call
        assert mock_gateway.call_count == 1

    def test_local_result_is_cached(self, discovery, mocker, monkeypatch):
        monkeypatch.delenv('AGENTCORE_GATEWAY_ENDPOINT', raising=False)
        mock_result = MagicMock(
            tools=[], count=0, tier='basic',
            loaded_identifiers=[], denied_identifiers=[],
        )
        mock_local = mocker.patch('gateway_config._load_tools_for_tier', return_value=mock_result)

        discovery.discover_tools('tenant-004', 'basic')
        discovery.discover_tools('tenant-004', 'basic')

        assert mock_local.call_count == 1

    def test_allow_deny_lists_forwarded_to_gateway(self, discovery, mocker, monkeypatch):
        monkeypatch.setenv('AGENTCORE_GATEWAY_ENDPOINT', 'https://gateway.example.com')
        mock_gateway = mocker.patch.object(
            discovery, '_discover_from_gateway',
            return_value=MagicMock(tools=[], count=0, tier='basic',
                                   loaded_identifiers=[], denied_identifiers=[]),
        )

        discovery.discover_tools('tenant-005', 'advanced', allow_list=['s3'], deny_list=['ec2'])

        mock_gateway.assert_called_once_with('tenant-005', 'advanced', ['s3'], ['ec2'])

    def test_unknown_tier_falls_back_to_basic(self, discovery, mocker, monkeypatch):
        monkeypatch.setenv('AGENTCORE_GATEWAY_ENDPOINT', 'https://gateway.example.com')
        mocker.patch('gateway_config._read_gateway_arns', return_value=FAKE_ARNS)
        mocker.patch('gateway_config.create_gateway_proxy_tools', return_value=[])

        result = discovery._discover_from_gateway('t1', 'unknown_tier', None, None)

        # unknown tier → max_tier=1 (basic fallback), tier 2/3 denied
        assert 'rds' in result.denied_identifiers
