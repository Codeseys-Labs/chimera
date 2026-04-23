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
                      Textract, Transcribe, CodeBuild, CodeCommit, CodePipeline,
                      Evolution (self-evolution workflow tools)
"""

import importlib
import logging
import os
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import boto3
from gateway_proxy import GatewayToolDefinition, create_gateway_proxy_tools

logger = logging.getLogger(__name__)

# Tenant tier → max tool tier (mirrors TENANT_TIER_ACCESS in tier-config.ts)
TENANT_TIER_ACCESS: Dict[str, int] = {
    "basic": 1,
    "advanced": 2,
    "premium": 3,
}

# Registry: module_path → (tier, [tool_names])
# Tier 0 = core tools available to all tenants regardless of subscription.
# Mirrors TOOL_TIER_MAP; lazy imports via importlib avoid loading unused
# AWS SDK clients at module import time (same as TypeScript dynamic imports).
# Modules that are diagnostic-only and must be excluded when CHIMERA_ENV=prod.
# Mirrors the __production_excluded__ sentinel in tools.hello_world; listed
# here as well so the gateway-proxy discovery path (which does not import the
# target module locally) can filter without a lazy import. Wave-15 M3.
_PRODUCTION_EXCLUDED_MODULES = frozenset({"tools.hello_world"})

_TOOL_TIER_REGISTRY: Dict[str, tuple] = {
    # Core (tier 0 — always available)
    "tools.hello_world": (0, ["hello_world_tool"]),
    "tools.background_task_tools": (
        0,
        ["start_background_task", "check_background_task"],
    ),
    "tools.cloudmap_tools": (
        0,
        ["discover_infrastructure", "get_service_instances", "get_namespace_summary"],
    ),
    # Tier 1: Core Compute & Storage
    "tools.lambda_tools": (
        1,
        [
            "list_lambda_functions",
            "get_lambda_function",
            "invoke_lambda_function",
            "create_lambda_function",
            "update_lambda_function_code",
            "delete_lambda_function",
        ],
    ),
    "tools.ec2_tools": (
        1,
        [
            "list_ec2_instances",
            "get_ec2_instance_details",
        ],
    ),
    "tools.s3_tools": (
        1,
        [
            "list_s3_buckets",
            "get_bucket_info",
        ],
    ),
    "tools.cloudwatch_tools": (
        1,
        [
            "put_cloudwatch_metric_data",
            "start_cloudwatch_query",
            "get_cloudwatch_query_results",
            "put_cloudwatch_metric_alarm",
            "describe_cloudwatch_alarms",
        ],
    ),
    "tools.sqs_tools": (
        1,
        [
            "create_sqs_queue",
            "send_sqs_message",
            "send_sqs_message_batch",
            "receive_sqs_messages",
            "delete_sqs_message",
            "delete_sqs_queue",
            "get_sqs_queue_attributes",
            "list_sqs_queues",
        ],
    ),
    "tools.dynamodb_tools": (
        1,
        [
            "dynamodb_query",
            "dynamodb_get_item",
            "dynamodb_put_item",
            "dynamodb_update_item",
            "dynamodb_scan",
        ],
    ),
    # Tier 2: Database & Messaging
    "tools.rds_tools": (
        2,
        [
            "describe_rds_db_instances",
            "create_rds_db_instance",
            "delete_rds_db_instance",
            "start_rds_db_instance",
            "stop_rds_db_instance",
            "modify_rds_db_instance",
        ],
    ),
    "tools.redshift_tools": (
        2,
        [
            "list_redshift_clusters",
            "create_redshift_cluster",
            "delete_redshift_cluster",
            "pause_redshift_cluster",
            "resume_redshift_cluster",
            "modify_redshift_cluster",
        ],
    ),
    "tools.athena_tools": (
        2,
        [
            "start_athena_query",
            "get_athena_query_status",
            "get_athena_query_results",
            "stop_athena_query",
            "list_athena_databases",
        ],
    ),
    "tools.glue_tools": (
        2,
        [
            "list_glue_databases",
            "list_glue_tables",
            "get_glue_table_schema",
            "start_glue_job",
            "get_glue_job_status",
        ],
    ),
    "tools.opensearch_tools": (
        2,
        [
            "describe_opensearch_domains",
            "create_opensearch_domain",
            "delete_opensearch_domain",
            "update_opensearch_domain_config",
            "list_opensearch_domain_names",
            "get_opensearch_compatible_versions",
        ],
    ),
    # Tier 3: Orchestration & ML
    "tools.stepfunctions_tools": (
        3,
        [
            "list_stepfunctions_state_machines",
            "create_stepfunctions_state_machine",
            "describe_stepfunctions_state_machine",
            "start_stepfunctions_execution",
            "describe_stepfunctions_execution",
            "stop_stepfunctions_execution",
            "delete_stepfunctions_state_machine",
        ],
    ),
    "tools.bedrock_tools": (
        3,
        [
            "bedrock_invoke_model",
            "bedrock_invoke_model_stream",
            "bedrock_list_foundation_models",
            "bedrock_get_foundation_model",
            "bedrock_list_inference_profiles",
        ],
    ),
    "tools.sagemaker_tools": (
        3,
        [
            "sagemaker_create_model",
            "sagemaker_create_endpoint_config",
            "sagemaker_create_endpoint",
            "sagemaker_describe_endpoint",
            "sagemaker_delete_endpoint",
            "sagemaker_list_endpoints",
        ],
    ),
    "tools.rekognition_tools": (
        3,
        [
            "rekognition_detect_labels",
            "rekognition_detect_faces",
            "rekognition_detect_text",
            "rekognition_detect_moderation_labels",
            "rekognition_compare_faces",
        ],
    ),
    "tools.textract_tools": (
        3,
        [
            "textract_detect_text",
            "textract_analyze_document",
            "textract_start_document_analysis",
            "textract_get_document_analysis",
        ],
    ),
    "tools.transcribe_tools": (
        3,
        [
            "transcribe_start_job",
            "transcribe_get_job",
            "transcribe_list_jobs",
            "transcribe_delete_job",
        ],
    ),
    "tools.codebuild_tools": (
        3,
        [
            "create_codebuild_project",
            "start_codebuild_build",
            "get_codebuild_build_details",
            "list_codebuild_builds_for_project",
            "stop_codebuild_build",
            "delete_codebuild_project",
        ],
    ),
    "tools.codecommit_tools": (
        3,
        [
            "list_codecommit_repos",
            "get_repo_info",
            "git_clone_repo",
            "git_commit_push",
            "get_commit_history",
        ],
    ),
    "tools.codepipeline_tools": (
        3,
        [
            "list_pipelines",
            "get_pipeline_details",
            "check_pipeline_status",
            "trigger_pipeline",
            "get_pipeline_execution_details",
            "create_pipeline",
            "delete_pipeline",
        ],
    ),
    "tools.evolution_tools": (
        3,
        [
            "trigger_infra_evolution",
            "check_evolution_status",
            "wait_for_evolution_deployment",
            "register_capability",
            "list_evolution_history",
        ],
    ),
    # Code Interpreter (sandbox execution via AgentCore)
    # Module tier is 1 (basic+); individual tools gated higher via _TOOL_TIER_OVERRIDES.
    "tools.code_interpreter_tools": (
        1,
        [
            "fetch_url_content",
            "execute_in_sandbox",
            "validate_cdk_in_sandbox",
        ],
    ),
    # Tier 2: Multi-Agent Swarm Orchestration
    "tools.swarm_tools": (
        2,
        [
            "decompose_and_execute",
            "check_swarm_status",
            "wait_for_swarm",
            "delegate_subtask",
        ],
    ),
}

# Per-tool tier overrides for modules that contain tools at different tiers.
# If a tool name is listed here, it requires this tier INSTEAD of the module tier.
# Tools not listed here inherit the module-level tier from _TOOL_TIER_REGISTRY.
_TOOL_TIER_OVERRIDES: Dict[str, int] = {
    "execute_in_sandbox": 2,  # advanced+ (data analysis, boto3 sandbox)
    "validate_cdk_in_sandbox": 3,  # premium only (CDK evolution validation)
}

# Short identifier for each module (used for allow/deny filtering)
# e.g. 'tools.s3_tools' → 's3', 'tools.hello_world' → 'hello_world'
_MODULE_IDENTIFIERS: Dict[str, str] = {
    module: module.split(".")[-1].replace("_tools", "")
    for module in _TOOL_TIER_REGISTRY
}

# Human-readable descriptions for each tool function.
# Used by create_gateway_proxy_tool to describe tools to the LLM.
_TOOL_DESCRIPTIONS: Dict[str, str] = {
    # Core (tier 0)
    "hello_world_tool": "Say hello to test agent connectivity",
    "start_background_task": "Start a long-running background task via EventBridge",
    "check_background_task": "Check the status of a running background task",
    "discover_infrastructure": "Discover all Chimera infrastructure components registered in Cloud Map (runtime state)",
    "get_service_instances": "Get all registered instances for a specific Cloud Map service",
    "get_namespace_summary": "Get a summary of the Chimera Cloud Map namespace with service and instance counts",
    # Tier 1: Compute & Storage
    "list_lambda_functions": "List all Lambda functions in the AWS account",
    "get_lambda_function": "Get details of a specific Lambda function",
    "invoke_lambda_function": "Invoke a Lambda function with a given payload",
    "create_lambda_function": "Create a new Lambda function",
    "update_lambda_function_code": "Update the code of an existing Lambda function",
    "delete_lambda_function": "Delete a Lambda function",
    "list_ec2_instances": "List all EC2 instances in the AWS account",
    "get_ec2_instance_details": "Get detailed information about an EC2 instance",
    "list_s3_buckets": "List all S3 buckets in the AWS account",
    "get_bucket_info": "Get detailed information about a specific S3 bucket",
    "put_cloudwatch_metric_data": "Publish custom metrics to CloudWatch",
    "start_cloudwatch_query": "Start a CloudWatch Logs Insights query",
    "get_cloudwatch_query_results": "Get results of a CloudWatch Logs Insights query",
    "put_cloudwatch_metric_alarm": "Create or update a CloudWatch alarm",
    "describe_cloudwatch_alarms": "List CloudWatch alarms and their states",
    "create_sqs_queue": "Create a new SQS queue",
    "send_sqs_message": "Send a message to an SQS queue",
    "send_sqs_message_batch": "Send a batch of messages to an SQS queue",
    "receive_sqs_messages": "Receive messages from an SQS queue",
    "delete_sqs_message": "Delete a processed message from an SQS queue",
    "delete_sqs_queue": "Delete an SQS queue",
    "get_sqs_queue_attributes": "Get attributes of an SQS queue",
    "list_sqs_queues": "List all SQS queues in the AWS account",
    "dynamodb_query": "Query a DynamoDB table using a key condition expression",
    "dynamodb_get_item": "Get a single item from a DynamoDB table by primary key",
    "dynamodb_put_item": "Put (create or replace) an item in a DynamoDB table",
    "dynamodb_update_item": "Update attributes of an existing item in a DynamoDB table",
    "dynamodb_scan": "Scan a DynamoDB table with optional filter expression",
    # Tier 2: Database & Analytics
    "describe_rds_db_instances": "List and describe RDS database instances",
    "create_rds_db_instance": "Create a new RDS database instance",
    "delete_rds_db_instance": "Delete an RDS database instance",
    "start_rds_db_instance": "Start a stopped RDS database instance",
    "stop_rds_db_instance": "Stop a running RDS database instance",
    "modify_rds_db_instance": "Modify configuration of an RDS database instance",
    "list_redshift_clusters": "List all Redshift data warehouse clusters",
    "create_redshift_cluster": "Create a new Redshift data warehouse cluster",
    "delete_redshift_cluster": "Delete a Redshift data warehouse cluster",
    "pause_redshift_cluster": "Pause a running Redshift cluster",
    "resume_redshift_cluster": "Resume a paused Redshift cluster",
    "modify_redshift_cluster": "Modify configuration of a Redshift cluster",
    "start_athena_query": "Start an Athena SQL query execution",
    "get_athena_query_status": "Check the status of an Athena query",
    "get_athena_query_results": "Retrieve results of a completed Athena query",
    "stop_athena_query": "Stop a running Athena query execution",
    "list_athena_databases": "List databases in the Athena data catalog",
    "list_glue_databases": "List databases in the AWS Glue Data Catalog",
    "list_glue_tables": "List tables in a Glue database",
    "get_glue_table_schema": "Get the schema definition of a Glue table",
    "start_glue_job": "Start an AWS Glue ETL job run",
    "get_glue_job_status": "Get the status of a Glue job run",
    "describe_opensearch_domains": "List and describe OpenSearch Service domains",
    "create_opensearch_domain": "Create a new OpenSearch Service domain",
    "delete_opensearch_domain": "Delete an OpenSearch Service domain",
    "update_opensearch_domain_config": "Update configuration of an OpenSearch domain",
    "list_opensearch_domain_names": "List the names of all OpenSearch domains",
    "get_opensearch_compatible_versions": "Get compatible OpenSearch version upgrade paths",
    # Tier 3: Orchestration & ML
    "list_stepfunctions_state_machines": "List all Step Functions state machines",
    "create_stepfunctions_state_machine": "Create a new Step Functions state machine",
    "describe_stepfunctions_state_machine": "Get details of a Step Functions state machine",
    "start_stepfunctions_execution": "Start execution of a Step Functions state machine",
    "describe_stepfunctions_execution": "Get status and details of a state machine execution",
    "stop_stepfunctions_execution": "Stop a running state machine execution",
    "delete_stepfunctions_state_machine": "Delete a Step Functions state machine",
    "bedrock_invoke_model": "Invoke an Amazon Bedrock foundation model",
    "bedrock_invoke_model_stream": "Invoke a Bedrock model with streaming response",
    "bedrock_list_foundation_models": "List available Amazon Bedrock foundation models",
    "bedrock_get_foundation_model": "Get details of a specific Bedrock foundation model",
    "bedrock_list_inference_profiles": "List Amazon Bedrock inference profiles",
    "sagemaker_create_model": "Create a SageMaker model for deployment",
    "sagemaker_create_endpoint_config": "Create a SageMaker endpoint configuration",
    "sagemaker_create_endpoint": "Deploy a SageMaker model endpoint",
    "sagemaker_describe_endpoint": "Get status and details of a SageMaker endpoint",
    "sagemaker_delete_endpoint": "Delete a SageMaker endpoint",
    "sagemaker_list_endpoints": "List all SageMaker endpoints",
    "rekognition_detect_labels": "Detect objects and scenes in an image using Rekognition",
    "rekognition_detect_faces": "Detect faces and facial attributes in an image",
    "rekognition_detect_text": "Detect text in an image using Rekognition",
    "rekognition_detect_moderation_labels": "Detect unsafe or inappropriate content in an image",
    "rekognition_compare_faces": "Compare faces in two images for similarity",
    "textract_detect_text": "Extract text from a document using Amazon Textract",
    "textract_analyze_document": "Analyze a document for text, forms, and tables",
    "textract_start_document_analysis": "Start asynchronous document analysis with Textract",
    "textract_get_document_analysis": "Get results of a Textract document analysis job",
    "transcribe_start_job": "Start an Amazon Transcribe speech-to-text job",
    "transcribe_get_job": "Get status and results of a Transcribe job",
    "transcribe_list_jobs": "List Amazon Transcribe transcription jobs",
    "transcribe_delete_job": "Delete a Transcribe transcription job",
    "create_codebuild_project": "Create a new CodeBuild build project",
    "start_codebuild_build": "Start a build in a CodeBuild project",
    "get_codebuild_build_details": "Get details and status of a CodeBuild build",
    "list_codebuild_builds_for_project": "List builds for a CodeBuild project",
    "stop_codebuild_build": "Stop a running CodeBuild build",
    "delete_codebuild_project": "Delete a CodeBuild project",
    "list_codecommit_repos": "List CodeCommit repositories",
    "get_repo_info": "Get information about a CodeCommit repository",
    "git_clone_repo": "Clone a CodeCommit repository",
    "git_commit_push": "Commit and push changes to a CodeCommit repository",
    "get_commit_history": "Get commit history of a CodeCommit repository",
    "list_pipelines": "List CodePipeline pipelines",
    "get_pipeline_details": "Get details and configuration of a CodePipeline pipeline",
    "check_pipeline_status": "Check the current execution status of a pipeline",
    "trigger_pipeline": "Trigger a CodePipeline pipeline execution",
    "get_pipeline_execution_details": "Get details of a specific pipeline execution",
    "create_pipeline": "Create a new CodePipeline pipeline",
    "delete_pipeline": "Delete a CodePipeline pipeline",
    # Tier 3: Self-Evolution
    "trigger_infra_evolution": "Commit agent-generated CDK stack code to CodeCommit to trigger infrastructure self-evolution",
    "check_evolution_status": "Check the CodePipeline deployment status of a self-evolution request",
    "wait_for_evolution_deployment": "Poll and wait for an evolution deployment to reach a terminal state (deployed, failed, or stopped)",
    "register_capability": "Register a deployed capability in the Gateway skills registry for tenant discovery",
    "list_evolution_history": "List recent self-evolution requests and their deployment status for a tenant",
    # Code Interpreter (sandbox)
    "fetch_url_content": "Fetch and extract text content from a URL in a sandboxed Code Interpreter environment",
    "execute_in_sandbox": "Execute Python/JS/TS code in a sandboxed Code Interpreter microVM with 200+ packages pre-installed",
    "validate_cdk_in_sandbox": "Validate CDK TypeScript code by running cdk synth in a sandbox before committing to CodeCommit",
    # Tier 2: Multi-Agent Swarm
    "decompose_and_execute": "Decompose a complex task into subtasks and execute them in parallel via specialist agents",
    "check_swarm_status": "Check progress of a multi-agent swarm execution with per-task status breakdown",
    "wait_for_swarm": "Poll and wait for a swarm execution to complete (default: 10 min timeout, 15s interval)",
    "delegate_subtask": "Delegate a single subtask to a specialist agent (planner, researcher, builder, validator, coordinator)",
}

# Maps tool tier number to the SSM key for that tier's Lambda ARN.
# Tier 0 (core) tools are hosted by the tier1 Lambda target.
_TIER_TO_ARN_KEY: Dict[int, str] = {0: "tier1", 1: "tier1", 2: "tier2", 3: "tier3"}

# Module-level SSM client singleton — reuse connections across ARN lookups
_ssm_client = None

# Module-level cache for gateway ARNs — SSM params don't change during runtime
_gateway_arns_cache: Optional[Dict[str, str]] = None


def _get_ssm_client():
    """Return the module-level boto3 SSM client, creating it on first call."""
    global _ssm_client
    if _ssm_client is None:
        _ssm_client = boto3.client("ssm")
    return _ssm_client


def _read_gateway_arns() -> Dict[str, str]:
    """Read Gateway Lambda target ARNs from SSM Parameter Store.

    Reads four parameters under /chimera/gateway/tool-targets/{env_name}/:
      tier1, tier2, tier3, discovery

    The env_name comes from CHIMERA_ENV_NAME (defaults to 'dev').
    Result is cached in-process since SSM params don't change at runtime.

    Returns:
        Dict mapping tier key to Lambda ARN, e.g. {'tier1': 'arn:...', ...}.
        Missing params are omitted (logged as warnings).
    """
    global _gateway_arns_cache
    if _gateway_arns_cache is not None:
        return _gateway_arns_cache

    env_name = os.environ.get("CHIMERA_ENV_NAME", "dev")
    prefix = f"/chimera/gateway/tool-targets/{env_name}"
    ssm = _get_ssm_client()

    arns: Dict[str, str] = {}
    for key in ("tier1", "tier2", "tier3", "discovery"):
        try:
            resp = ssm.get_parameter(Name=f"{prefix}/{key}")
            arns[key] = resp["Parameter"]["Value"]
        except Exception as exc:
            logger.warning("Failed to read SSM param %s/%s: %s", prefix, key, exc)

    _gateway_arns_cache = arns
    return arns


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
            result.count,
            tenant_id,
            tier,
            result.denied_identifiers,
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

        if os.environ.get("AGENTCORE_GATEWAY_ENDPOINT"):
            result = self._discover_from_gateway(tenant_id, tier, allow_list, deny_list)
        else:
            result = _load_tools_for_tier(tier, allow_list, deny_list)

        self._cache[key] = result
        return result

    def _discover_from_gateway(
        self,
        tenant_id: str,
        tier: str,
        allow_list: Optional[List[str]],
        deny_list: Optional[List[str]],
    ) -> ToolDiscoveryResult:
        """Discover tools by creating Gateway Lambda proxy callables.

        Applies the same tier/allow/deny filtering as _load_tools_for_tier, but
        instead of importing local modules, creates proxy tools that invoke the
        appropriate Gateway Lambda target.  Falls back gracefully if a Lambda ARN
        is missing (logs a warning and skips that module).

        Args:
            tenant_id:  Tenant identifier injected into every proxy invocation.
            tier:       Subscription tier ('basic', 'advanced', 'premium').
            allow_list: Short identifiers to include (core tools always pass).
            deny_list:  Short identifiers to exclude unconditionally.

        Returns:
            ToolDiscoveryResult with proxy callables ready for the Strands Agent.
        """
        arns = _read_gateway_arns()
        max_tier = TENANT_TIER_ACCESS.get(tier, TENANT_TIER_ACCESS["basic"])

        tool_defs: List[GatewayToolDefinition] = []
        loaded_identifiers: List[str] = []
        denied_identifiers: List[str] = []

        for module_path, (tool_tier, tool_names) in _TOOL_TIER_REGISTRY.items():
            identifier = _MODULE_IDENTIFIERS[module_path]
            is_core = tool_tier == 0

            # 0. Production exclusion (Wave-15 M3): diagnostic modules must
            # not be surfaced to tenant tool sets in prod.  Matches the
            # __production_excluded__ sentinel checked in _load_tools_for_tier.
            if _is_production() and module_path in _PRODUCTION_EXCLUDED_MODULES:
                denied_identifiers.append(identifier)
                continue

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

            arn_key = _TIER_TO_ARN_KEY.get(tool_tier, "tier1")
            target_arn = arns.get(arn_key, "")
            if not target_arn:
                logger.warning(
                    "No ARN for tier %d (key=%s), skipping module %s",
                    tool_tier,
                    arn_key,
                    module_path,
                )
                continue

            for name in tool_names:
                # Per-tool tier override: skip tools that require a higher tier
                effective_tier = _TOOL_TIER_OVERRIDES.get(name, tool_tier)
                if not is_core and effective_tier > max_tier:
                    continue
                # Route overridden tools to the correct tier Lambda target
                effective_arn_key = _TIER_TO_ARN_KEY.get(effective_tier, arn_key)
                effective_arn = arns.get(effective_arn_key, target_arn)
                description = _TOOL_DESCRIPTIONS.get(name, f"Gateway tool: {name}")
                tool_defs.append(
                    GatewayToolDefinition(
                        name=name,
                        description=description,
                        service_identifier=identifier,
                        target_arn=effective_arn,
                        tier=effective_tier,
                    )
                )

            loaded_identifiers.append(identifier)

        tools: List[Callable] = create_gateway_proxy_tools(tool_defs, tenant_id)

        logger.info(
            "Gateway discovery: %d proxy tools for tenant=%s tier=%s (denied=%s)",
            len(tools),
            tenant_id,
            tier,
            denied_identifiers,
        )
        return ToolDiscoveryResult(
            tools=tools,
            loaded_identifiers=loaded_identifiers,
            denied_identifiers=denied_identifiers,
            count=len(tools),
            tier=tier,
        )


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
    max_tier = TENANT_TIER_ACCESS.get(tier, TENANT_TIER_ACCESS["basic"])
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
            # Production gating: modules that declare __production_excluded__
            # are diagnostics-only (e.g. hello_world) and must not be exposed
            # to tenant tool sets in prod.  See Wave-15 M3 in
            # docs/reviews/OPEN-PUNCH-LIST.md.
            if _is_production() and getattr(module, "__production_excluded__", False):
                denied_identifiers.append(identifier)
                continue
            for name in tool_names:
                # Per-tool tier override: skip tools that require a higher tier
                effective_tier = _TOOL_TIER_OVERRIDES.get(name, tool_tier)
                if not is_core and effective_tier > max_tier:
                    continue
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


def _is_production() -> bool:
    """Return True when running in a production environment.

    Reads CHIMERA_ENV (preferred) or ENVIRONMENT as a fallback; any
    value in {"prod", "production"} (case-insensitive) is treated as
    production.  Non-prod envs (dev, staging, test, unset) return False,
    keeping diagnostic tools like hello_world available for e2e tests.
    """
    env = (os.environ.get("CHIMERA_ENV") or os.environ.get("ENVIRONMENT") or "").lower()
    return env in {"prod", "production"}
