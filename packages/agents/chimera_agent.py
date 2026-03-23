"""
Chimera Platform Agent
Deployed to AgentCore Runtime via Docker container

This agent uses Strands SDK for the ReAct loop and AgentCore SDK for runtime integration.
Multi-tenant context is injected via JWT claims from Cognito.
"""
import os
import json
from typing import Any, Dict, AsyncIterator

from strands import Agent
from strands.models.bedrock import BedrockModel
from bedrock_agentcore.runtime import BedrockAgentCoreApp, entrypoint
from bedrock_agentcore.memory.integrations.strands import AgentCoreMemorySessionManager

from tools.hello_world import hello_world_tool
from tools.s3_tools import list_s3_buckets, get_bucket_info
from tools.ec2_tools import list_ec2_instances, get_ec2_instance_details
from tools.codecommit_tools import (
    list_codecommit_repos,
    get_repo_info,
    git_clone_repo,
    git_commit_push,
    get_commit_history
)
from tools.codepipeline_tools import (
    list_pipelines,
    get_pipeline_details,
    check_pipeline_status,
    trigger_pipeline,
    get_pipeline_execution_details,
    create_pipeline,
    delete_pipeline
)
from tools.background_task_tools import (
    start_background_task,
    check_background_task
)
# Analytics tools
from tools.athena_tools import (
    start_athena_query,
    get_athena_query_status,
    get_athena_query_results,
    stop_athena_query,
    list_athena_databases
)
from tools.glue_tools import (
    list_glue_databases,
    list_glue_tables,
    get_glue_table_schema,
    start_glue_job,
    get_glue_job_status
)
from tools.redshift_tools import (
    list_redshift_clusters,
    create_redshift_cluster,
    delete_redshift_cluster,
    pause_redshift_cluster,
    resume_redshift_cluster,
    execute_redshift_query,
    get_redshift_query_results
)
# Compute tools
from tools.codebuild_tools import (
    create_codebuild_project,
    start_codebuild_build,
    get_codebuild_build_details,
    list_codebuild_builds_for_project,
    stop_codebuild_build,
    delete_codebuild_project
)
from tools.lambda_tools import (
    list_lambda_functions,
    get_lambda_function,
    invoke_lambda_function,
    create_lambda_function,
    update_lambda_function_code,
    delete_lambda_function
)
from tools.stepfunctions_tools import (
    list_stepfunctions_state_machines,
    create_stepfunctions_state_machine,
    describe_stepfunctions_state_machine,
    start_stepfunctions_execution,
    describe_stepfunctions_execution,
    stop_stepfunctions_execution,
    delete_stepfunctions_state_machine
)
# AI/ML tools
from tools.bedrock_tools import (
    bedrock_invoke_model,
    bedrock_invoke_model_stream,
    bedrock_list_foundation_models,
    bedrock_get_foundation_model,
    bedrock_list_inference_profiles
)
from tools.rekognition_tools import (
    rekognition_detect_labels,
    rekognition_detect_faces,
    rekognition_detect_text,
    rekognition_detect_moderation_labels,
    rekognition_compare_faces
)
from tools.sagemaker_tools import (
    sagemaker_create_model,
    sagemaker_create_endpoint_config,
    sagemaker_create_endpoint,
    sagemaker_describe_endpoint,
    sagemaker_delete_endpoint,
    sagemaker_invoke_endpoint
)
from tools.textract_tools import (
    textract_detect_text,
    textract_analyze_document,
    textract_start_document_analysis,
    textract_get_document_analysis
)
from tools.transcribe_tools import (
    transcribe_start_job,
    transcribe_get_job,
    transcribe_list_jobs,
    transcribe_delete_job
)
# Monitoring & Databases tools
from tools.cloudwatch_tools import (
    put_cloudwatch_metric_data,
    start_cloudwatch_query,
    get_cloudwatch_query_results,
    put_cloudwatch_metric_alarm,
    describe_cloudwatch_alarms,
    delete_cloudwatch_alarms
)
from tools.opensearch_tools import (
    describe_opensearch_domains,
    create_opensearch_domain,
    delete_opensearch_domain,
    update_opensearch_domain_config,
    list_opensearch_domain_names,
    opensearch_index_document,
    opensearch_search_documents
)
from tools.rds_tools import (
    describe_rds_db_instances,
    create_rds_db_instance,
    delete_rds_db_instance,
    start_rds_db_instance,
    stop_rds_db_instance,
    create_rds_db_snapshot
)
from tools.sqs_tools import (
    create_sqs_queue,
    send_sqs_message,
    send_sqs_message_batch,
    receive_sqs_messages,
    delete_sqs_message,
    delete_sqs_queue,
    purge_sqs_queue
)


# Initialize AgentCore app
app = BedrockAgentCoreApp()


@entrypoint
async def handle(context) -> AsyncIterator[str]:
    """
    AgentCore Runtime entrypoint

    Context attributes:
    - context.auth.claims: JWT claims (tenantId, tier, userId from Cognito)
    - context.input_text: User's message
    - context.session: Session metadata
    """

    # 1. Extract tenant context from JWT claims
    tenant_id = context.auth.claims.get('tenantId')
    tier = context.auth.claims.get('tier', 'basic')
    user_id = context.auth.claims.get('userId')

    if not tenant_id:
        raise ValueError("Missing tenantId in JWT claims - multi-tenant context required")

    # 2. Load tenant configuration from DynamoDB
    tenant_config = load_tenant_config(tenant_id)

    # 3. Select model based on tier
    model_id = select_model_for_tier(tier, tenant_config)

    # 4. Load tenant-specific tools (tier-gated)
    tools = load_tenant_tools(tenant_id, tier, tenant_config)

    # 5. Configure memory with tenant+user namespace isolation
    memory_manager = create_memory_manager(tenant_id, user_id, tier, tenant_config)

    # 6. Build system prompt with tenant context
    system_prompt = build_system_prompt(tenant_id, tier, tenant_config)

    # 7. Create Strands agent
    agent = Agent(
        model=BedrockModel(model_id),
        system_prompt=system_prompt,
        tools=tools,
        session_manager=memory_manager,
        max_iterations=20,  # ReAct loop limit
    )

    # 8. Execute agent and stream response
    async for chunk in agent.stream(context.input_text):
        yield chunk


def load_tenant_config(tenant_id: str) -> Dict[str, Any]:
    """
    Load tenant configuration from DynamoDB.

    Returns tenant profile with tier, features, allowed models, memory config, and budget.
    """
    import boto3

    dynamodb = boto3.client('dynamodb')

    try:
        response = dynamodb.get_item(
            TableName=os.environ.get('TENANTS_TABLE', 'chimera-tenants'),
            Key={
                'PK': {'S': f'TENANT#{tenant_id}'},
                'SK': {'S': 'PROFILE'}
            }
        )
    except Exception as e:
        raise ValueError(f"Failed to load tenant config for {tenant_id}: {e}")

    if 'Item' not in response:
        raise ValueError(f"Tenant {tenant_id} not found in tenants table")

    # Parse DynamoDB item
    item = response['Item']
    return {
        'tier': item.get('tier', {}).get('S', 'basic'),
        'features': json.loads(item.get('features', {}).get('S', '[]')),
        'allowedModels': json.loads(item.get('allowedModels', {}).get('S', '[]')),
        'agentcore_memory_id': item.get('agentcore_memory_id', {}).get('S', ''),
        'monthlyBudget': float(item.get('monthlyBudget', {}).get('N', '1000')),
        'currentSpend': float(item.get('currentSpend', {}).get('N', '0')),
    }


def select_model_for_tier(tier: str, config: Dict[str, Any]) -> str:
    """
    Select Bedrock model based on tenant tier.

    Tier model mapping:
    - basic: Nova Lite ($0.06/$0.24 per MTok)
    - advanced: Claude Sonnet 4.6 ($3/$15 per MTok)
    - premium: Claude Opus 4.6 ($15/$75 per MTok)
    """
    tier_models = {
        'basic': 'us.amazon.nova-lite-v1:0',
        'advanced': 'us.anthropic.claude-sonnet-4-6-v1:0',
        'premium': 'us.anthropic.claude-opus-4-6-v1:0',
    }

    default_model = tier_models.get(tier, tier_models['basic'])

    # Allow tenant override if in allowedModels
    if config['allowedModels']:
        return config['allowedModels'][0]  # Use first allowed model

    return default_model


def load_tenant_tools(tenant_id: str, tier: str, config: Dict[str, Any]) -> list:
    """
    Load tools for tenant based on tier and skill registry.

    Tool loading pipeline:
    1. Core tools (always available)
    2. Tier-based AWS tools
    3. Custom skills from DynamoDB registry
    4. Cedar policy filter
    """
    # Core tools (always available)
    tools = [
        hello_world_tool,
    ]

    # Phase 1D: AWS tools for all tiers (validation phase)
    # In production, these would be tier-gated
    tools.extend([
        # Storage & Compute
        list_s3_buckets,
        get_bucket_info,
        list_ec2_instances,
        get_ec2_instance_details,
        # Self-evolution: Git operations
        list_codecommit_repos,
        get_repo_info,
        git_clone_repo,
        git_commit_push,
        get_commit_history,
        # Self-evolution: CI/CD automation
        list_pipelines,
        get_pipeline_details,
        check_pipeline_status,
        trigger_pipeline,
        get_pipeline_execution_details,
        create_pipeline,
        delete_pipeline,
        # Analytics: Athena serverless SQL
        start_athena_query,
        get_athena_query_status,
        get_athena_query_results,
        stop_athena_query,
        list_athena_databases,
        # Analytics: Glue ETL
        list_glue_databases,
        list_glue_tables,
        get_glue_table_schema,
        start_glue_job,
        get_glue_job_status,
        # Analytics: Redshift data warehouse
        list_redshift_clusters,
        create_redshift_cluster,
        delete_redshift_cluster,
        pause_redshift_cluster,
        resume_redshift_cluster,
        execute_redshift_query,
        get_redshift_query_results,
        # Compute: CodeBuild CI/CD
        create_codebuild_project,
        start_codebuild_build,
        get_codebuild_build_details,
        list_codebuild_builds_for_project,
        stop_codebuild_build,
        delete_codebuild_project,
        # Compute: Lambda serverless functions
        list_lambda_functions,
        get_lambda_function,
        invoke_lambda_function,
        create_lambda_function,
        update_lambda_function_code,
        delete_lambda_function,
        # Compute: Step Functions orchestration
        list_stepfunctions_state_machines,
        create_stepfunctions_state_machine,
        describe_stepfunctions_state_machine,
        start_stepfunctions_execution,
        describe_stepfunctions_execution,
        stop_stepfunctions_execution,
        delete_stepfunctions_state_machine,
        # AI/ML: Bedrock foundation models
        bedrock_invoke_model,
        bedrock_invoke_model_stream,
        bedrock_list_foundation_models,
        bedrock_get_foundation_model,
        bedrock_list_inference_profiles,
        # AI/ML: Rekognition image/video analysis
        rekognition_detect_labels,
        rekognition_detect_faces,
        rekognition_detect_text,
        rekognition_detect_moderation_labels,
        rekognition_compare_faces,
        # AI/ML: SageMaker model deployment
        sagemaker_create_model,
        sagemaker_create_endpoint_config,
        sagemaker_create_endpoint,
        sagemaker_describe_endpoint,
        sagemaker_delete_endpoint,
        sagemaker_invoke_endpoint,
        # AI/ML: Textract document extraction
        textract_detect_text,
        textract_analyze_document,
        textract_start_document_analysis,
        textract_get_document_analysis,
        # AI/ML: Transcribe speech-to-text
        transcribe_start_job,
        transcribe_get_job,
        transcribe_list_jobs,
        transcribe_delete_job,
        # Monitoring: CloudWatch metrics/logs
        put_cloudwatch_metric_data,
        start_cloudwatch_query,
        get_cloudwatch_query_results,
        put_cloudwatch_metric_alarm,
        describe_cloudwatch_alarms,
        delete_cloudwatch_alarms,
        # Database: OpenSearch full-text search
        describe_opensearch_domains,
        create_opensearch_domain,
        delete_opensearch_domain,
        update_opensearch_domain_config,
        list_opensearch_domain_names,
        opensearch_index_document,
        opensearch_search_documents,
        # Database: RDS relational database
        describe_rds_db_instances,
        create_rds_db_instance,
        delete_rds_db_instance,
        start_rds_db_instance,
        stop_rds_db_instance,
        create_rds_db_snapshot,
        # Messaging: SQS queues
        create_sqs_queue,
        send_sqs_message,
        send_sqs_message_batch,
        receive_sqs_messages,
        delete_sqs_message,
        delete_sqs_queue,
        purge_sqs_queue,
        # Background task delegation for long-running operations
        start_background_task,
        check_background_task,
    ])

    # TODO: Phase 2 - Add tier-gating for AWS tools
    # if tier in ['advanced', 'premium']:
    #     tools.extend([list_s3_buckets, get_bucket_info])
    # if tier == 'premium':
    #     tools.extend([list_ec2_instances, get_ec2_instance_details])

    # TODO: Phase 3 - Load custom skills from DynamoDB registry
    # custom_skills = load_custom_skills(tenant_id)
    # tools.extend(custom_skills)

    return tools


def create_memory_manager(
    tenant_id: str,
    user_id: str,
    tier: str,
    config: Dict[str, Any]
) -> AgentCoreMemorySessionManager:
    """
    Create memory manager with tenant+user namespace isolation.

    Memory strategies by tier:
    - basic: SUMMARY only
    - advanced: SUMMARY + USER_PREFERENCE
    - premium: SUMMARY + USER_PREFERENCE + SEMANTIC_MEMORY
    """
    memory_config = get_memory_config_for_tier(tier)

    # Namespace template: tenant-{tenantId}-user-{userId}
    namespace = f"tenant-{tenant_id}-user-{user_id}"

    return AgentCoreMemorySessionManager(
        memory_id=config['agentcore_memory_id'],
        namespace=namespace,
        strategies=memory_config['strategies'],
        conversation_window_size=memory_config['stm_window'],
        retention_policy={
            'max_age_days': memory_config['ltm_retention_days'],
        },
    )


def get_memory_config_for_tier(tier: str) -> Dict[str, Any]:
    """
    Memory configuration by tier.

    Returns strategies, STM window size, and LTM retention days.
    """
    configs = {
        'basic': {
            'strategies': ['SUMMARY'],
            'stm_window': 10,
            'ltm_retention_days': 7,
        },
        'advanced': {
            'strategies': ['SUMMARY', 'USER_PREFERENCE'],
            'stm_window': 50,
            'ltm_retention_days': 30,
        },
        'premium': {
            'strategies': ['SUMMARY', 'USER_PREFERENCE', 'SEMANTIC_MEMORY'],
            'stm_window': 200,
            'ltm_retention_days': 365,
        },
    }
    return configs.get(tier, configs['basic'])


def build_system_prompt(tenant_id: str, tier: str, config: Dict[str, Any]) -> str:
    """
    Build system prompt with tenant context.

    Loads SOUL.md (agent identity) and AGENTS.md (capability reference) from project root,
    then appends tenant-specific context (tier, features, budget).
    """
    # Load agent identity and capability documents
    soul_content = load_identity_file("SOUL.md")
    agents_content = load_identity_file("AGENTS.md")

    features_str = ', '.join(config['features']) if config['features'] else 'standard features'

    # Combine identity docs + tenant context
    return f"""{soul_content}

---

{agents_content}

---

# Tenant Context

You are now operating for tenant: {tenant_id}

**Tier:** {tier}
**Available features:** {features_str}
**Monthly budget:** ${config['monthlyBudget']:.2f}
**Current spend:** ${config['currentSpend']:.2f}

Follow tenant-specific guidelines and respect budget constraints.
Always provide helpful, accurate, and safe responses."""


def load_identity_file(filename: str) -> str:
    """
    Load agent identity file (SOUL.md or AGENTS.md) from project root.

    Falls back to a minimal message if file is missing.
    """
    import pathlib

    # Navigate from packages/agents/ to project root
    project_root = pathlib.Path(__file__).parent.parent.parent
    file_path = project_root / filename

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        return f"# {filename} not found\n\nAgent identity document missing from project root."
    except Exception as e:
        return f"# Error loading {filename}\n\nFailed to load agent identity: {e}"
