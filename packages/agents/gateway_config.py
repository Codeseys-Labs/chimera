"""
Python Gateway Configuration for Chimera Agent

Mirrors packages/core/src/gateway/tier-config.ts and tool-loader.ts in Python.
Provides tier-based, lazily-loaded tool discovery for the Strands Agent.

Usage:
    gateway = GatewayToolDiscovery()
    tools = gateway.discover_tools(tenant_id, tier)

Tier assignments (mirrors TOOL_TIER_MAP in tier-config.ts):
- Core (always):       hello_world, background_task
- Tier 1 (basic+):    Lambda, EC2, S3, CloudWatch, SQS
- Tier 2 (advanced+): RDS, Redshift, Athena, Glue, OpenSearch
- Tier 3 (premium):   Step Functions, Bedrock, SageMaker, Rekognition,
                      Textract, Transcribe, CodeBuild, CodeCommit, CodePipeline
"""
import importlib
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Tenant tier → max tool tier (mirrors TENANT_TIER_ACCESS in tier-config.ts)
TENANT_TIER_ACCESS: Dict[str, int] = {
    'basic': 1,
    'advanced': 2,
    'premium': 3,
}

# Registry: module_path → (tier, [tool_names])
# Tier 0 = core tools available to all tenants regardless of subscription.
# Mirrors TOOL_TIER_MAP; lazy imports via importlib avoid loading unused
# AWS SDK clients at module import time (same as TypeScript dynamic imports).
_TOOL_TIER_REGISTRY: Dict[str, tuple] = {
    # Core (tier 0 — always available)
    'tools.hello_world': (0, ['hello_world_tool']),
    'tools.background_task_tools': (0, ['start_background_task', 'check_background_task']),

    # Tier 1: Core Compute & Storage
    'tools.lambda_tools': (1, [
        'list_lambda_functions', 'get_lambda_function', 'invoke_lambda_function',
        'create_lambda_function', 'update_lambda_function_code', 'delete_lambda_function',
    ]),
    'tools.ec2_tools': (1, [
        'list_ec2_instances', 'get_ec2_instance_details',
    ]),
    'tools.s3_tools': (1, [
        'list_s3_buckets', 'get_bucket_info',
    ]),
    'tools.cloudwatch_tools': (1, [
        'put_cloudwatch_metric_data', 'start_cloudwatch_query', 'get_cloudwatch_query_results',
        'put_cloudwatch_metric_alarm', 'describe_cloudwatch_alarms',
    ]),
    'tools.sqs_tools': (1, [
        'create_sqs_queue', 'send_sqs_message', 'send_sqs_message_batch',
        'receive_sqs_messages', 'delete_sqs_message', 'delete_sqs_queue',
        'get_sqs_queue_attributes', 'list_sqs_queues',
    ]),

    # Tier 2: Database & Messaging
    'tools.rds_tools': (2, [
        'describe_rds_db_instances', 'create_rds_db_instance', 'delete_rds_db_instance',
        'start_rds_db_instance', 'stop_rds_db_instance', 'modify_rds_db_instance',
    ]),
    'tools.redshift_tools': (2, [
        'list_redshift_clusters', 'create_redshift_cluster', 'delete_redshift_cluster',
        'pause_redshift_cluster', 'resume_redshift_cluster', 'modify_redshift_cluster',
    ]),
    'tools.athena_tools': (2, [
        'start_athena_query', 'get_athena_query_status', 'get_athena_query_results',
        'stop_athena_query', 'list_athena_databases',
    ]),
    'tools.glue_tools': (2, [
        'list_glue_databases', 'list_glue_tables', 'get_glue_table_schema',
        'start_glue_job', 'get_glue_job_status',
    ]),
    'tools.opensearch_tools': (2, [
        'describe_opensearch_domains', 'create_opensearch_domain', 'delete_opensearch_domain',
        'update_opensearch_domain_config', 'list_opensearch_domain_names',
        'get_opensearch_compatible_versions',
    ]),

    # Tier 3: Orchestration & ML
    'tools.stepfunctions_tools': (3, [
        'list_stepfunctions_state_machines', 'create_stepfunctions_state_machine',
        'describe_stepfunctions_state_machine', 'start_stepfunctions_execution',
        'describe_stepfunctions_execution', 'stop_stepfunctions_execution',
        'delete_stepfunctions_state_machine',
    ]),
    'tools.bedrock_tools': (3, [
        'bedrock_invoke_model', 'bedrock_invoke_model_stream',
        'bedrock_list_foundation_models', 'bedrock_get_foundation_model',
        'bedrock_list_inference_profiles',
    ]),
    'tools.sagemaker_tools': (3, [
        'sagemaker_create_model', 'sagemaker_create_endpoint_config',
        'sagemaker_create_endpoint', 'sagemaker_describe_endpoint',
        'sagemaker_delete_endpoint', 'sagemaker_list_endpoints',
    ]),
    'tools.rekognition_tools': (3, [
        'rekognition_detect_labels', 'rekognition_detect_faces', 'rekognition_detect_text',
        'rekognition_detect_moderation_labels', 'rekognition_compare_faces',
    ]),
    'tools.textract_tools': (3, [
        'textract_detect_text', 'textract_analyze_document',
        'textract_start_document_analysis', 'textract_get_document_analysis',
    ]),
    'tools.transcribe_tools': (3, [
        'transcribe_start_job', 'transcribe_get_job', 'transcribe_list_jobs', 'transcribe_delete_job',
    ]),
    'tools.codebuild_tools': (3, [
        'create_codebuild_project', 'start_codebuild_build', 'get_codebuild_build_details',
        'list_codebuild_builds_for_project', 'stop_codebuild_build', 'delete_codebuild_project',
    ]),
    'tools.codecommit_tools': (3, [
        'list_codecommit_repos', 'get_repo_info', 'git_clone_repo',
        'git_commit_push', 'get_commit_history',
    ]),
    'tools.codepipeline_tools': (3, [
        'list_pipelines', 'get_pipeline_details', 'check_pipeline_status',
        'trigger_pipeline', 'get_pipeline_execution_details',
        'create_pipeline', 'delete_pipeline',
    ]),
}

# Short identifier for each module (used for allow/deny filtering)
# e.g. 'tools.s3_tools' → 's3', 'tools.hello_world' → 'hello_world'
_MODULE_IDENTIFIERS: Dict[str, str] = {
    module: module.split('.')[-1].replace('_tools', '')
    for module in _TOOL_TIER_REGISTRY
}


@dataclass
class ToolDiscoveryResult:
    """Result of a gateway tool discovery operation.

    Mirrors ToolLoadResult from packages/core/src/gateway/tool-loader.ts.
    """
    tools: List[Any]
    loaded_identifiers: List[str]
    denied_identifiers: List[str]
    count: int
    tier: str


class GatewayToolDiscovery:
    """Tier-based tool discovery gateway for the Python Strands Agent.

    Mirrors the TypeScript ToolLoader pattern from tool-loader.ts:
    - Lazy module imports (equivalent to TypeScript dynamic imports)
    - Tier-based access control (TENANT_TIER_ACCESS from tier-config.ts)
    - Optional allow/deny filtering per tenant
    - Per-tenant result caching

    Usage:
        gateway = GatewayToolDiscovery()
        tools = gateway.discover_tools(tenant_id, tier)
    """

    def __init__(self) -> None:
        # Cache keyed by '{tenant_id}:{tier}:{allow_list}:{deny_list}'
        self._cache: Dict[str, ToolDiscoveryResult] = {}

    def discover_tools(
        self,
        tenant_id: str,
        tier: str,
        allow_list: Optional[List[str]] = None,
        deny_list: Optional[List[str]] = None,
    ) -> List[Any]:
        """Discover and return tools available for a tenant's tier.

        Args:
            tenant_id: Tenant identifier (used for cache keying).
            tier:       Subscription tier ('basic', 'advanced', 'premium').
                        Unknown values fall back to 'basic'.
            allow_list: Short identifiers to include ('s3', 'lambda', …).
                        When set, only these (plus core tools) are loaded.
            deny_list:  Short identifiers to exclude unconditionally.

        Returns:
            List of tool callables ready to pass to the Strands Agent.
        """
        result = self._load(tenant_id, tier, allow_list, deny_list)
        logger.info(
            "Gateway: loaded %d tools for tenant=%s tier=%s (denied=%s)",
            result.count, tenant_id, tier, result.denied_identifiers,
        )
        return result.tools

    def get_discovery_result(
        self,
        tenant_id: str,
        tier: str,
        allow_list: Optional[List[str]] = None,
        deny_list: Optional[List[str]] = None,
    ) -> ToolDiscoveryResult:
        """Return the full ToolDiscoveryResult (tools + metadata)."""
        return self._load(tenant_id, tier, allow_list, deny_list)

    def clear_cache(self, tenant_id: Optional[str] = None) -> None:
        """Evict cached results for a tenant or clear the entire cache."""
        if tenant_id is None:
            self._cache.clear()
        else:
            prefix = f"{tenant_id}:"
            stale = [k for k in self._cache if k.startswith(prefix)]
            for key in stale:
                del self._cache[key]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _cache_key(
        self,
        tenant_id: str,
        tier: str,
        allow_list: Optional[List[str]],
        deny_list: Optional[List[str]],
    ) -> str:
        return (
            f"{tenant_id}:{tier}"
            f":{','.join(sorted(allow_list)) if allow_list else ''}"
            f":{','.join(sorted(deny_list)) if deny_list else ''}"
        )

    def _load(
        self,
        tenant_id: str,
        tier: str,
        allow_list: Optional[List[str]],
        deny_list: Optional[List[str]],
    ) -> ToolDiscoveryResult:
        key = self._cache_key(tenant_id, tier, allow_list, deny_list)
        if key in self._cache:
            return self._cache[key]

        result = _load_tools_for_tier(tier, allow_list, deny_list)
        self._cache[key] = result
        return result


def _load_tools_for_tier(
    tier: str,
    allow_list: Optional[List[str]],
    deny_list: Optional[List[str]],
) -> ToolDiscoveryResult:
    """Internal tier-gated tool loader.

    Filter priority (mirrors tool-loader.ts):
    1. deny_list → excluded unconditionally
    2. allow_list → only these included (core tools always pass)
    3. Tier gate → TENANT_TIER_ACCESS lookup
    """
    max_tier = TENANT_TIER_ACCESS.get(tier, TENANT_TIER_ACCESS['basic'])
    tools: List[Any] = []
    loaded_identifiers: List[str] = []
    denied_identifiers: List[str] = []

    for module_path, (tool_tier, tool_names) in _TOOL_TIER_REGISTRY.items():
        identifier = _MODULE_IDENTIFIERS[module_path]
        is_core = tool_tier == 0

        # 1. Deny list wins unconditionally
        if deny_list and identifier in deny_list:
            denied_identifiers.append(identifier)
            continue

        # 2. Allow list overrides tier gating; core tools always pass
        if allow_list is not None and not is_core and identifier not in allow_list:
            denied_identifiers.append(identifier)
            continue

        # 3. Tier gate (core tools always pass)
        if not is_core and tool_tier > max_tier:
            denied_identifiers.append(identifier)
            continue

        # Lazily import module and collect callables
        try:
            module = importlib.import_module(module_path)
            for name in tool_names:
                tools.append(getattr(module, name))
            loaded_identifiers.append(identifier)
        except (ImportError, AttributeError) as exc:
            logger.warning("Failed to load tool module %s: %s", module_path, exc)

    return ToolDiscoveryResult(
        tools=tools,
        loaded_identifiers=loaded_identifiers,
        denied_identifiers=denied_identifiers,
        count=len(tools),
        tier=tier,
    )
