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
    # Core tools (always available - Phase 1A just hello world)
    tools = [
        hello_world_tool,
    ]

    # TODO: Phase 1B - Add tier-gated AWS tools
    # if tier in ['advanced', 'premium']:
    #     tools.extend(load_aws_tools_tier2())
    # if tier == 'premium':
    #     tools.extend(load_aws_tools_tier3_4())

    # TODO: Phase 2 - Load custom skills from DynamoDB registry
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

    Includes tier, features, budget constraints, and tenant-specific guidelines.
    """
    features_str = ', '.join(config['features']) if config['features'] else 'standard features'

    return f"""You are Chimera, an AI assistant for {tenant_id}.

Tier: {tier}
Available features: {features_str}
Monthly budget: ${config['monthlyBudget']:.2f}
Current spend: ${config['currentSpend']:.2f}

Follow tenant-specific guidelines and respect budget constraints.
Always provide helpful, accurate, and safe responses."""
