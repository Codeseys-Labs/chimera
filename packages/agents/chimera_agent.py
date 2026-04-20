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

from gateway_config import GatewayToolDiscovery
from system_prompt import CHIMERA_SYSTEM_PROMPT, wrap_untrusted_content


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

    # Set the tenant context for all tool invocations in this session.
    # Tools read tenant_id from this contextvar rather than accepting it as a
    # user-settable argument (prevents a misbehaving agent from spoofing tenant_id).
    # Cleared in a finally block at session end so a reused worker thread/task
    # cannot leak one tenant's context into the next invocation.
    from tools.tenant_context import clear_tenant_context, set_tenant_context
    set_tenant_context(tenant_id=tenant_id, tier=tier, user_id=user_id)

    try:
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
    finally:
        clear_tenant_context()


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
    Load tools for tenant based on tier via Gateway discovery.

    Delegates to GatewayToolDiscovery for tier-gated, lazy-loaded tool access.
    Basic tenants receive Tier 1 tools; advanced adds Tier 2; premium gets all.
    """
    gateway = GatewayToolDiscovery()
    return gateway.discover_tools(tenant_id, tier)


def _build_agentcore_namespace(
    strategy: str,
    tenant_id: str,
    user_id: str,
    session_id: str,
) -> str:
    """
    Build the canonical AgentCore Memory namespace.

    Format (mandatory trailing slash):
      /strategy/{strategy}/actor/tenant-{tenant_id}-user-{user_id}/session/{session_id}/

    The ``actor`` segment composes tenant and user ids so per-tenant IAM
    conditions (bedrock-agentcore:namespace=/strategy/*/actor/tenant-{id}-*/...)
    can enforce tenancy even if an agent attempts cross-namespace access.

    The trailing slash is required by the AgentCore Memory service — it
    prevents prefix collisions (e.g. ``/actor/Alice/`` vs ``/actor/Alice-admin``)
    when matching against IAM ``StringLike`` conditions on
    ``bedrock-agentcore:namespace``.

    Note: ``summaryStrategy`` requires the ``session/{session_id}/`` segment;
    strategies that are actor-scoped (user preference, semantic) technically
    operate at ``/strategy/{id}/actor/{actorId}/``. We still emit the full
    session-qualified namespace here so IAM condition matching, CloudWatch
    logging, and debugging all work against a single canonical form — the
    extra segment is harmless for actor-scoped strategies.
    """
    return (
        f"/strategy/{strategy}"
        f"/actor/tenant-{tenant_id}-user-{user_id}"
        f"/session/{session_id}/"
    )


def _resolve_runtime_session_id() -> str:
    """
    Resolve the AgentCore Runtime session ID for the current request.

    The Bedrock AgentCore Runtime threads the ``X-Amzn-Bedrock-AgentCore-Runtime-Session-Id``
    header into a per-request ContextVar (``BedrockAgentCoreContext._session_id``),
    which `summaryStrategy` namespaces depend on. When the agent is invoked
    outside the runtime (unit tests, local dev, background workers), fall back
    to the ``AGENTCORE_SESSION_ID`` environment variable and finally to a
    deterministic ``local-session`` sentinel so namespace construction never
    blows up on missing context.
    """
    try:
        from bedrock_agentcore.runtime.context import BedrockAgentCoreContext

        session_id = BedrockAgentCoreContext.get_session_id()
        if session_id:
            return session_id
    except Exception:  # pragma: no cover - runtime may be unavailable in tests
        pass

    return os.environ.get("AGENTCORE_SESSION_ID", "local-session")


def create_memory_manager(
    tenant_id: str,
    user_id: str,
    tier: str,
    config: Dict[str, Any],
    session_id: str | None = None,
) -> AgentCoreMemorySessionManager:
    """
    Create memory manager with tenant+user namespace isolation.

    Memory strategies by tier:
    - basic: summaryStrategy only
    - advanced: summaryStrategy + userPreferenceMemoryStrategy
    - premium: summaryStrategy + userPreferenceMemoryStrategy + semanticMemoryStrategy

    The caller may pass ``session_id`` explicitly (e.g. a unit test); when
    omitted it is resolved from the AgentCore Runtime request context so the
    ``summaryStrategy`` namespace — which mandates a ``session/{sessionId}/``
    suffix — is well-formed.

    TODO(rabbithole-02): The real ``AgentCoreMemorySessionManager`` accepts an
    ``AgentCoreMemoryConfig`` dataclass (``memory_id``, ``actor_id``,
    ``session_id``, ``retrieval_config`` keyed by namespace) rather than the
    flat ``namespace=`` / ``strategies=`` / ``retention_policy=`` kwargs used
    below. The constructor call here is preserved verbatim from the original
    implementation pending a follow-up task; this refactor focuses narrowly on
    producing a correct canonical namespace so IAM condition keys on
    ``bedrock-agentcore:namespace`` can enforce tenancy. The per-strategy
    namespaces are pre-computed and passed through so downstream code / IAM
    review can inspect them.
    """
    memory_config = get_memory_config_for_tier(tier)

    resolved_session_id = session_id or _resolve_runtime_session_id()

    # Pre-compute the canonical namespace for EACH strategy this tier enables.
    # These strings are what IAM policies target via
    # ``bedrock-agentcore:namespace=/strategy/*/actor/tenant-{id}-*/...``.
    strategy_namespaces = {
        strategy: _build_agentcore_namespace(
            strategy=strategy,
            tenant_id=tenant_id,
            user_id=user_id,
            session_id=resolved_session_id,
        )
        for strategy in memory_config['strategies']
    }

    # The legacy constructor only accepts a single ``namespace`` kwarg, so pass
    # the primary (summary) namespace — the most specific, session-scoped form
    # — and surface the full per-strategy map via ``namespaces`` for any code
    # path that can consume it. See TODO(rabbithole-02) above.
    primary_namespace = next(iter(strategy_namespaces.values()))

    return AgentCoreMemorySessionManager(
        memory_id=config['agentcore_memory_id'],
        namespace=primary_namespace,
        namespaces=strategy_namespaces,
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

    Strategy identifiers match the real AgentCore Memory SDK types
    (``summaryStrategy``, ``userPreferenceMemoryStrategy``,
    ``semanticMemoryStrategy``) — confirmed against
    ``bedrock_agentcore.memory.integrations.strands`` docs and the rabbithole
    deep-dive (docs/research/agentcore-rabbithole/02-runtime-memory-deep-dive.md).
    The previous uppercase constants (``SUMMARY`` etc.) were silently accepted
    by the Strands integration but never matched a real strategy, so long-term
    memory extraction and IAM ``strategy/{strategyId}`` conditions both broke.
    """
    configs = {
        'basic': {
            'strategies': ['summaryStrategy'],
            'stm_window': 10,
            'ltm_retention_days': 7,
        },
        'advanced': {
            'strategies': ['summaryStrategy', 'userPreferenceMemoryStrategy'],
            'stm_window': 50,
            'ltm_retention_days': 30,
        },
        'premium': {
            'strategies': [
                'summaryStrategy',
                'userPreferenceMemoryStrategy',
                'semanticMemoryStrategy',
            ],
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

    Falls back to CHIMERA_SYSTEM_PROMPT constant from system_prompt.py if the
    identity files are missing (e.g. running in a container without the repo root).

    Prompt-injection defense:
        Any content sourced from disk files (SOUL.md, AGENTS.md) or from tenant
        configuration (features list, allowedModels) is **user-controlled** and
        must be wrapped in an [END TRUSTED SYSTEM PROMPT]…[END UNTRUSTED CONTENT]
        delimiter block via ``wrap_untrusted_content`` so the model treats it as
        data, not instructions. The trusted portion is only CHIMERA_SYSTEM_PROMPT
        itself.
    """
    # Load agent identity and capability documents. Both files live in the
    # project root and can be edited by operators / self-evolution, so we treat
    # their contents as untrusted relative to the baked-in CHIMERA_SYSTEM_PROMPT.
    soul_content = load_identity_file("SOUL.md")
    agents_content = load_identity_file("AGENTS.md")

    # If both files are missing, fall back to the structured system prompt constant
    soul_missing = "not found" in soul_content or "Error loading" in soul_content
    agents_missing = "not found" in agents_content or "Error loading" in agents_content

    # CHIMERA_SYSTEM_PROMPT is the only piece we trust verbatim — everything
    # loaded from disk gets wrapped in an explicit untrusted-content delimiter.
    if soul_missing and agents_missing:
        base_prompt = CHIMERA_SYSTEM_PROMPT
    elif soul_missing:
        base_prompt = (
            f"{CHIMERA_SYSTEM_PROMPT}\n\n"
            f"{wrap_untrusted_content(agents_content, source='AGENTS.md')}"
        )
    elif agents_missing:
        base_prompt = (
            f"{CHIMERA_SYSTEM_PROMPT}\n\n"
            f"{wrap_untrusted_content(soul_content, source='SOUL.md')}"
        )
    else:
        identity_block = f"{soul_content}\n\n---\n\n{agents_content}"
        base_prompt = (
            f"{CHIMERA_SYSTEM_PROMPT}\n\n"
            f"{wrap_untrusted_content(identity_block, source='SOUL.md+AGENTS.md')}"
        )

    features_str = ', '.join(config['features']) if config['features'] else 'standard features'
    allowed_models = config.get('allowedModels') or []
    allowed_models_str = ', '.join(allowed_models) if allowed_models else 'tier default'

    # Tenant-config values (features, allowedModels, tenant_id itself) originate
    # in DynamoDB and may have been written by external systems, so they are
    # also wrapped in the untrusted-content delimiter before being concatenated.
    tenant_block = (
        f"# Tenant Context\n\n"
        f"You are now operating for tenant: {tenant_id}\n\n"
        f"**Tier:** {tier}\n"
        f"**Available features:** {features_str}\n"
        f"**Allowed models:** {allowed_models_str}\n"
        f"**Monthly budget:** ${config['monthlyBudget']:.2f}\n"
        f"**Current spend:** ${config['currentSpend']:.2f}\n\n"
        f"Follow tenant-specific guidelines and respect budget constraints.\n"
        f"Always provide helpful, accurate, and safe responses."
    )

    return (
        f"{base_prompt}\n\n"
        f"{wrap_untrusted_content(tenant_block, source='tenant-config')}"
    )


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
