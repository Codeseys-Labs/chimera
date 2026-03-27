"""Tests for evolution_tools module."""
import importlib
from unittest.mock import MagicMock, patch

import pytest

import tools.evolution_tools as evo
from tools.evolution_tools import (
    _check_evolution_rate_limit,
    _check_kill_switch,
    _commit_to_codecommit,
    _validate_cdk_code,
    _validate_evolution_policy,
    check_evolution_status,
    list_evolution_history,
    register_capability,
    trigger_infra_evolution,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

VALID_CDK = """
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class MediaIngestionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // New S3 bucket for media files
  }
}
"""


# ---------------------------------------------------------------------------
# _check_kill_switch
# ---------------------------------------------------------------------------


class TestCheckKillSwitch:
    def test_enabled_when_param_true(self, mocker, monkeypatch):
        monkeypatch.setenv('CHIMERA_ENV_NAME', 'test')
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.return_value = {'Parameter': {'Value': 'true'}}
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_ssm)

        result = _check_kill_switch()

        assert result['enabled'] is True
        assert result['reason'] == ''

    def test_disabled_when_param_false(self, mocker, monkeypatch):
        monkeypatch.setenv('CHIMERA_ENV_NAME', 'test')
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.return_value = {'Parameter': {'Value': 'false'}}
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_ssm)

        result = _check_kill_switch()

        assert result['enabled'] is False
        assert 'off' in result['reason'].lower()

    def test_fails_open_when_ssm_raises(self, mocker):
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = Exception('ParameterNotFound')
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_ssm)

        result = _check_kill_switch()

        assert result['enabled'] is True

    def test_uses_chimera_env_name(self, mocker, monkeypatch):
        monkeypatch.setenv('CHIMERA_ENV_NAME', 'staging')
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.return_value = {'Parameter': {'Value': 'true'}}
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_ssm)

        _check_kill_switch()

        called_name = mock_ssm.get_parameter.call_args.kwargs['Name']
        assert 'staging' in called_name


# ---------------------------------------------------------------------------
# _validate_evolution_policy
# ---------------------------------------------------------------------------


class TestValidateEvolutionPolicy:
    def test_skips_when_no_policy_store(self, monkeypatch):
        monkeypatch.delenv('CEDAR_POLICY_STORE_ID', raising=False)

        result = _validate_evolution_policy('tenant-1', 'media', 10.0, 'us-east-1')

        assert result['allowed'] is True

    def test_allowed_when_avp_returns_allow(self, mocker, monkeypatch):
        monkeypatch.setenv('CEDAR_POLICY_STORE_ID', 'ps-abc123')
        mock_avp = MagicMock()
        mock_avp.is_authorized.return_value = {'decision': 'ALLOW', 'determiningPolicies': []}
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_avp)

        result = _validate_evolution_policy('tenant-1', 'media', 10.0, 'us-east-1')

        assert result['allowed'] is True
        assert result['reason'] == ''

    def test_denied_when_avp_returns_deny(self, mocker, monkeypatch):
        monkeypatch.setenv('CEDAR_POLICY_STORE_ID', 'ps-abc123')
        mock_avp = MagicMock()
        mock_avp.is_authorized.return_value = {
            'decision': 'DENY',
            'determiningPolicies': [{'policyId': 'policy-cost-limit'}],
        }
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_avp)

        result = _validate_evolution_policy('tenant-1', 'media', 999.0, 'us-east-1')

        assert result['allowed'] is False
        assert 'policy-cost-limit' in result['reason']

    def test_fails_open_when_avp_raises(self, mocker, monkeypatch):
        monkeypatch.setenv('CEDAR_POLICY_STORE_ID', 'ps-abc123')
        mock_avp = MagicMock()
        mock_avp.is_authorized.side_effect = Exception('AVP unavailable')
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_avp)

        result = _validate_evolution_policy('tenant-1', 'media', 10.0, 'us-east-1')

        assert result['allowed'] is True


# ---------------------------------------------------------------------------
# _check_evolution_rate_limit
# ---------------------------------------------------------------------------


class TestCheckEvolutionRateLimit:
    def _make_mock_table(self, count: int, limit: int = 5):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'count': count, 'limit': limit}
        }
        return mock_table

    def test_allows_when_under_limit(self, mocker):
        mock_table = self._make_mock_table(count=2)
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        result = _check_evolution_rate_limit('tenant-1')

        assert result['allowed'] is True
        mock_table.update_item.assert_called_once()

    def test_blocks_when_at_limit(self, mocker):
        mock_table = self._make_mock_table(count=5, limit=5)
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        result = _check_evolution_rate_limit('tenant-1')

        assert result['allowed'] is False
        assert '5/5' in result['reason']
        mock_table.update_item.assert_not_called()

    def test_fails_open_when_ddb_raises(self, mocker):
        mock_ddb = MagicMock()
        mock_ddb.Table.side_effect = Exception('DynamoDB unavailable')
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        result = _check_evolution_rate_limit('tenant-1')

        assert result['allowed'] is True

    def test_allows_when_no_existing_record(self, mocker):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # No 'Item' key
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        result = _check_evolution_rate_limit('tenant-1')

        assert result['allowed'] is True


# ---------------------------------------------------------------------------
# _validate_cdk_code
# ---------------------------------------------------------------------------


class TestValidateCdkCode:
    def test_valid_stack_passes(self):
        result = _validate_cdk_code(VALID_CDK)
        assert result['valid'] is True

    def test_empty_code_fails(self):
        result = _validate_cdk_code('')
        assert result['valid'] is False
        assert 'empty' in result['reason']

    def test_whitespace_only_fails(self):
        result = _validate_cdk_code('   \n  ')
        assert result['valid'] is False

    def test_missing_stack_class_fails(self):
        code = "const x = 1; // no class here"
        result = _validate_cdk_code(code)
        assert result['valid'] is False
        assert 'CDK Stack class' in result['reason']

    def test_code_too_large_fails(self):
        big_code = VALID_CDK * 10_000  # >> 100KB
        result = _validate_cdk_code(big_code)
        assert result['valid'] is False
        assert 'bytes' in result['reason']

    def test_administrator_access_forbidden(self):
        code = VALID_CDK + "\niam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')"
        result = _validate_cdk_code(code)
        assert result['valid'] is False
        assert 'AdministratorAccess' in result['reason']


# ---------------------------------------------------------------------------
# _commit_to_codecommit
# ---------------------------------------------------------------------------


class TestCommitToCodecommit:
    def test_returns_commit_id_on_success(self, mocker):
        mock_cc = MagicMock()
        mock_cc.get_branch.return_value = {'branch': {'commitId': 'parent-abc'}}
        mock_cc.create_commit.return_value = {'commitId': 'new-commit-xyz'}
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_cc)

        result = _commit_to_codecommit(
            repo_name='chimera-infra',
            file_path='infra/lib/agent-evolved/media-stack.ts',
            content=VALID_CDK,
            commit_message='Test commit',
            region='us-east-1',
        )

        assert result == {'commit_id': 'new-commit-xyz'}
        mock_cc.create_commit.assert_called_once()

    def test_returns_error_on_exception(self, mocker):
        mock_cc = MagicMock()
        mock_cc.get_branch.side_effect = Exception('Repository not found')
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_cc)

        result = _commit_to_codecommit('bad-repo', 'path', 'code', 'msg', 'us-east-1')

        assert 'error' in result
        assert 'Repository not found' in result['error']

    def test_encodes_content_as_utf8(self, mocker):
        mock_cc = MagicMock()
        mock_cc.get_branch.return_value = {'branch': {'commitId': 'parent'}}
        mock_cc.create_commit.return_value = {'commitId': 'abc'}
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_cc)

        _commit_to_codecommit('repo', 'path', 'code', 'msg', 'us-east-1')

        put_files = mock_cc.create_commit.call_args.kwargs['putFiles']
        assert put_files[0]['fileContent'] == b'code'


# ---------------------------------------------------------------------------
# trigger_infra_evolution (integration-style)
# ---------------------------------------------------------------------------


class TestTriggerInfraEvolution:
    def _patch_happy_path(self, mocker):
        mocker.patch(
            'tools.evolution_tools._check_kill_switch',
            return_value={'enabled': True, 'reason': ''},
        )
        mocker.patch(
            'tools.evolution_tools._validate_evolution_policy',
            return_value={'allowed': True, 'reason': ''},
        )
        mocker.patch(
            'tools.evolution_tools._check_evolution_rate_limit',
            return_value={'allowed': True, 'reason': ''},
        )
        mocker.patch(
            'tools.evolution_tools._commit_to_codecommit',
            return_value={'commit_id': 'abc123'},
        )
        mocker.patch('tools.evolution_tools._record_evolution_request')

    def test_returns_evolution_id_on_success(self, mocker):
        self._patch_happy_path(mocker)

        result = trigger_infra_evolution(
            capability_name='media-ingestion',
            cdk_stack_code=VALID_CDK,
            tenant_id='tenant-abc',
            rationale='Users requested S3 media pipeline',
        )

        assert 'Evolution ID:' in result
        assert 'media-ingestion' in result
        assert 'abc123' in result

    def test_kill_switch_blocks(self, mocker):
        mocker.patch(
            'tools.evolution_tools._check_kill_switch',
            return_value={'enabled': False, 'reason': 'Kill switch is off'},
        )

        result = trigger_infra_evolution(
            capability_name='media-ingestion',
            cdk_stack_code=VALID_CDK,
            tenant_id='tenant-abc',
            rationale='test',
        )

        assert 'Evolution disabled' in result
        assert 'Kill switch is off' in result

    def test_cedar_denial_blocks(self, mocker):
        mocker.patch(
            'tools.evolution_tools._check_kill_switch',
            return_value={'enabled': True, 'reason': ''},
        )
        mocker.patch(
            'tools.evolution_tools._validate_evolution_policy',
            return_value={'allowed': False, 'reason': 'policy-cost-limit'},
        )

        result = trigger_infra_evolution(
            capability_name='media-ingestion',
            cdk_stack_code=VALID_CDK,
            tenant_id='tenant-abc',
            rationale='test',
        )

        assert 'denied by policy' in result
        assert 'policy-cost-limit' in result

    def test_rate_limit_blocks(self, mocker):
        mocker.patch(
            'tools.evolution_tools._check_kill_switch',
            return_value={'enabled': True, 'reason': ''},
        )
        mocker.patch(
            'tools.evolution_tools._validate_evolution_policy',
            return_value={'allowed': True, 'reason': ''},
        )
        mocker.patch(
            'tools.evolution_tools._check_evolution_rate_limit',
            return_value={'allowed': False, 'reason': 'Daily limit of 5 reached (5/5)'},
        )

        result = trigger_infra_evolution(
            capability_name='media-ingestion',
            cdk_stack_code=VALID_CDK,
            tenant_id='tenant-abc',
            rationale='test',
        )

        assert 'rate limit' in result.lower()
        assert '5/5' in result

    def test_invalid_cdk_blocks(self, mocker):
        mocker.patch(
            'tools.evolution_tools._check_kill_switch',
            return_value={'enabled': True, 'reason': ''},
        )
        mocker.patch(
            'tools.evolution_tools._validate_evolution_policy',
            return_value={'allowed': True, 'reason': ''},
        )
        mocker.patch(
            'tools.evolution_tools._check_evolution_rate_limit',
            return_value={'allowed': True, 'reason': ''},
        )

        result = trigger_infra_evolution(
            capability_name='media-ingestion',
            cdk_stack_code='',  # empty
            tenant_id='tenant-abc',
            rationale='test',
        )

        assert 'CDK code validation failed' in result

    def test_codecommit_error_propagates(self, mocker):
        self._patch_happy_path(mocker)
        mocker.patch(
            'tools.evolution_tools._commit_to_codecommit',
            return_value={'error': 'Repository not found'},
        )

        result = trigger_infra_evolution(
            capability_name='media-ingestion',
            cdk_stack_code=VALID_CDK,
            tenant_id='tenant-abc',
            rationale='test',
        )

        assert 'Failed to commit' in result
        assert 'Repository not found' in result

    def test_records_audit_trail_on_success(self, mocker):
        self._patch_happy_path(mocker)
        mock_record = mocker.patch('tools.evolution_tools._record_evolution_request')

        trigger_infra_evolution(
            capability_name='media-ingestion',
            cdk_stack_code=VALID_CDK,
            tenant_id='tenant-abc',
            rationale='test rationale',
        )

        mock_record.assert_called_once()
        call_kwargs = mock_record.call_args.kwargs
        assert call_kwargs['tenant_id'] == 'tenant-abc'
        assert call_kwargs['capability_name'] == 'media-ingestion'
        assert call_kwargs['rationale'] == 'test rationale'


# ---------------------------------------------------------------------------
# check_evolution_status
# ---------------------------------------------------------------------------


class TestCheckEvolutionStatus:
    def test_returns_not_found_for_unknown_id(self, mocker):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # No 'Item'
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)
        mocker.patch('tools.evolution_tools.boto3.client')  # pipeline client

        result = check_evolution_status(evolution_id='evo-bad-id')

        assert 'not found' in result.lower()

    def test_returns_status_on_known_id(self, mocker):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'PK': 'EVOLUTION#evo-abc',
                'SK': 'REQUEST',
                'commit_id': 'deadbeef',
                'capability_name': 'media-ingestion',
                'submitted_at': '2026-03-27T08:00:00+00:00',
            }
        }
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        mock_cc = MagicMock()
        mock_cc.get_pipeline_state.return_value = {
            'pipelineName': 'chimera-infra-pipeline',
            'stageStates': [
                {'stageName': 'Source', 'latestExecution': {'status': 'Succeeded'}},
                {'stageName': 'Build', 'latestExecution': {'status': 'InProgress'}},
            ],
        }
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_cc)

        result = check_evolution_status(evolution_id='evo-abc')

        assert 'media-ingestion' in result
        assert 'deadbeef' in result
        assert 'Source' in result
        assert 'Build' in result

    def test_handles_pipeline_unavailable(self, mocker):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'commit_id': 'abc',
                'capability_name': 'media',
                'submitted_at': '2026-03-27',
            }
        }
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        mock_cc = MagicMock()
        mock_cc.get_pipeline_state.side_effect = Exception('Pipeline not found')
        mocker.patch('tools.evolution_tools.boto3.client', return_value=mock_cc)

        result = check_evolution_status(evolution_id='evo-abc')

        assert 'unavailable' in result.lower()


# ---------------------------------------------------------------------------
# register_capability
# ---------------------------------------------------------------------------


class TestRegisterCapability:
    def test_registers_successfully(self, mocker):
        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        result = register_capability(
            capability_name='media-ingestion',
            tool_module='tools.media_ingestion_tools',
            tool_names=['ingest_media', 'get_media_status'],
            tier=3,
            description='S3-based media ingestion pipeline',
            tenant_id='tenant-abc',
        )

        assert 'registered successfully' in result.lower()
        assert 'media-ingestion' in result
        assert 'premium' in result
        mock_table.put_item.assert_called()

    def test_invalid_tier_rejected(self, mocker):
        result = register_capability(
            capability_name='media',
            tool_module='tools.media',
            tool_names=['tool_a'],
            tier=4,  # invalid
            description='test',
            tenant_id='tenant-abc',
        )
        assert 'Invalid tier' in result

    def test_empty_tool_names_rejected(self, mocker):
        result = register_capability(
            capability_name='media',
            tool_module='tools.media',
            tool_names=[],
            tier=1,
            description='test',
            tenant_id='tenant-abc',
        )
        assert 'non-empty' in result

    def test_ddb_error_reported(self, mocker):
        mock_table = MagicMock()
        mock_table.put_item.side_effect = Exception('DynamoDB unavailable')
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        result = register_capability(
            capability_name='media',
            tool_module='tools.media',
            tool_names=['tool_a'],
            tier=1,
            description='test',
            tenant_id='tenant-abc',
        )
        assert 'Failed to register' in result

    @pytest.mark.parametrize("tier,expected_label", [
        (1, 'basic+'),
        (2, 'advanced+'),
        (3, 'premium'),
    ])
    def test_tier_label_in_output(self, mocker, tier, expected_label):
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = MagicMock()
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        result = register_capability(
            capability_name='cap',
            tool_module='tools.cap',
            tool_names=['cap_tool'],
            tier=tier,
            description='test',
            tenant_id='tenant-abc',
        )
        assert expected_label in result


# ---------------------------------------------------------------------------
# list_evolution_history
# ---------------------------------------------------------------------------


class TestListEvolutionHistory:
    def test_returns_no_history_message(self, mocker):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        result = list_evolution_history(tenant_id='tenant-abc')

        assert 'No evolution history' in result

    def test_returns_formatted_items(self, mocker):
        mock_table = MagicMock()
        mock_table.query.return_value = {
            'Items': [
                {
                    'evolution_id': 'evo-abc-media-20260327',
                    'capability_name': 'media-ingestion',
                    'status': 'SUCCEEDED',
                    'submitted_at': '2026-03-27T08:00:00+00:00',
                    'rationale': 'Users wanted video processing',
                }
            ]
        }
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        result = list_evolution_history(tenant_id='tenant-abc')

        assert 'evo-abc-media-20260327' in result
        assert 'media-ingestion' in result
        assert 'SUCCEEDED' in result
        assert 'video processing' in result

    def test_caps_limit_at_50(self, mocker):
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        list_evolution_history(tenant_id='tenant-abc', limit=200)

        call_kwargs = mock_table.query.call_args.kwargs
        assert call_kwargs['Limit'] == 50

    def test_reports_error_on_ddb_failure(self, mocker):
        mock_table = MagicMock()
        mock_table.query.side_effect = Exception('DynamoDB unavailable')
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mocker.patch('tools.evolution_tools.boto3.resource', return_value=mock_ddb)

        result = list_evolution_history(tenant_id='tenant-abc')

        assert 'Failed to query' in result


# ---------------------------------------------------------------------------
# gateway_config integration: evolution_tools registered at tier 3
# ---------------------------------------------------------------------------


class TestGatewayConfigIntegration:
    def test_evolution_tools_in_registry(self):
        import gateway_config

        assert 'tools.evolution_tools' in gateway_config._TOOL_TIER_REGISTRY

    def test_evolution_tools_at_tier_3(self):
        import gateway_config

        tier, tool_names = gateway_config._TOOL_TIER_REGISTRY['tools.evolution_tools']
        assert tier == 3

    def test_all_evolution_tools_have_descriptions(self):
        import gateway_config

        _, tool_names = gateway_config._TOOL_TIER_REGISTRY['tools.evolution_tools']
        for name in tool_names:
            assert name in gateway_config._TOOL_DESCRIPTIONS, (
                f"Missing description for {name}"
            )

    def test_evolution_denied_for_advanced_tier(self):
        import gateway_config

        gateway = gateway_config.GatewayToolDiscovery()
        with patch('gateway_config._read_gateway_arns') as mock_arns, \
             patch('gateway_config.create_gateway_proxy_tools', return_value=[]):
            mock_arns.return_value = {
                'tier1': 'arn:tier1',
                'tier2': 'arn:tier2',
                'tier3': 'arn:tier3',
                'discovery': 'arn:discovery',
            }
            result = gateway._discover_from_gateway('t1', 'advanced', None, None)

        assert 'evolution' in result.denied_identifiers

    def test_evolution_allowed_for_premium_tier(self):
        import gateway_config

        gateway = gateway_config.GatewayToolDiscovery()
        with patch('gateway_config._read_gateway_arns') as mock_arns, \
             patch('gateway_config.create_gateway_proxy_tools', return_value=[]):
            mock_arns.return_value = {
                'tier1': 'arn:tier1',
                'tier2': 'arn:tier2',
                'tier3': 'arn:tier3',
                'discovery': 'arn:discovery',
            }
            result = gateway._discover_from_gateway('t1', 'premium', None, None)

        assert 'evolution' not in result.denied_identifiers
