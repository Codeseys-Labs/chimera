"""
CloudMap Tools - AWS Cloud Map service discovery for Chimera agent self-awareness

Provides infrastructure discovery by querying AWS Cloud Map. Services are registered
under the 'chimera-{env}' namespace with instance attributes: stackName, resourceType,
arn, endpoint, healthStatus.

Two discovery modes work together for full self-awareness:
  - Cloud Map (this module): runtime state — what's actually running
  - CodeCommit (codecommit_tools.py): intended state — what CDK says should exist
"""
import os
from typing import List, Optional

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from strands.tools import tool
from .gateway_instrumentation import instrument_tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
@instrument_tool("discover_infrastructure")
def discover_infrastructure(
    env_name: Optional[str] = None,
    resource_type: Optional[str] = None,
) -> str:
    """
    Discover all Chimera infrastructure components registered in AWS Cloud Map.

    Queries the 'chimera-{env}' namespace and returns all registered service
    instances with their stack name, resource type, ARN, endpoint, and health status.
    This gives agents real-time visibility into what infrastructure is actually running.

    Args:
        env_name: Environment name to query (default: CHIMERA_ENV_NAME env var, or 'dev').
        resource_type: Optional filter by resource type (e.g. 'ECS::Service', 'Lambda::Function').

    Returns:
        Formatted string listing all registered infrastructure components grouped by stack.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    env = env_name or os.environ.get('CHIMERA_ENV_NAME', 'dev')
    namespace_name = f'chimera-{env}'

    try:
        client = boto3.client('servicediscovery', config=_BOTO_CONFIG)

        namespace_id = _find_namespace_id(client, namespace_name)
        if not namespace_id:
            return (
                f"No Cloud Map namespace '{namespace_name}' found. "
                "Infrastructure may not be deployed yet."
            )

        services = _list_all_services(client, namespace_id)
        if not services:
            return f"Namespace '{namespace_name}' exists but has no registered services."

        # Collect instances from all services, applying optional resource_type filter
        all_instances = []
        for service in services:
            for instance in _list_all_instances(client, service['Id']):
                attrs = instance.get('Attributes', {})
                if resource_type and attrs.get('resourceType') != resource_type:
                    continue
                all_instances.append({
                    'service': service['Name'],
                    'instanceId': instance['Id'],
                    'stackName': attrs.get('stackName', 'N/A'),
                    'resourceType': attrs.get('resourceType', 'N/A'),
                    'arn': attrs.get('arn', 'N/A'),
                    'endpoint': attrs.get('endpoint', 'N/A'),
                    'healthStatus': attrs.get('healthStatus', 'N/A'),
                })

        if not all_instances:
            filter_msg = f" with resourceType='{resource_type}'" if resource_type else ""
            return f"No instances found{filter_msg} in namespace '{namespace_name}'."

        result = f"Infrastructure discovery for '{namespace_name}' — {len(all_instances)} component(s):\n\n"

        # Group by stackName for readability
        by_stack: dict = {}
        for inst in all_instances:
            by_stack.setdefault(inst['stackName'], []).append(inst)

        for stack_name, instances in sorted(by_stack.items()):
            result += f"Stack: {stack_name}\n"
            for inst in instances:
                result += f"  • {inst['service']}/{inst['instanceId']}\n"
                result += f"    Type:     {inst['resourceType']}\n"
                result += f"    ARN:      {inst['arn']}\n"
                if inst['endpoint'] != 'N/A':
                    result += f"    Endpoint: {inst['endpoint']}\n"
                result += f"    Health:   {inst['healthStatus']}\n"
            result += "\n"

        return result.rstrip()

    except (ClientError, BotoCoreError) as e:
        return f"Error discovering infrastructure: {str(e)}"


@tool
@instrument_tool("get_service_instances")
def get_service_instances(
    service_name: str,
    env_name: Optional[str] = None,
) -> str:
    """
    Get all registered instances for a specific Cloud Map service.

    Args:
        service_name: Name of the Cloud Map service (e.g. 'chat-gateway', 'api-gateway').
        env_name: Environment name (default: CHIMERA_ENV_NAME env var, or 'dev').

    Returns:
        Formatted string with all instances and their attributes.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    env = env_name or os.environ.get('CHIMERA_ENV_NAME', 'dev')
    namespace_name = f'chimera-{env}'

    try:
        client = boto3.client('servicediscovery', config=_BOTO_CONFIG)

        namespace_id = _find_namespace_id(client, namespace_name)
        if not namespace_id:
            return f"No Cloud Map namespace '{namespace_name}' found."

        service_id = _find_service_id(client, namespace_id, service_name)
        if not service_id:
            return f"Service '{service_name}' not found in namespace '{namespace_name}'."

        instances = _list_all_instances(client, service_id)
        if not instances:
            return f"Service '{service_name}' has no registered instances."

        result = f"Service: {service_name} (namespace: {namespace_name})\n"
        result += f"Instances: {len(instances)}\n\n"

        for inst in instances:
            attrs = inst.get('Attributes', {})
            result += f"Instance ID: {inst['Id']}\n"
            result += f"  Stack:         {attrs.get('stackName', 'N/A')}\n"
            result += f"  Resource Type: {attrs.get('resourceType', 'N/A')}\n"
            result += f"  ARN:           {attrs.get('arn', 'N/A')}\n"
            result += f"  Endpoint:      {attrs.get('endpoint', 'N/A')}\n"
            result += f"  Health Status: {attrs.get('healthStatus', 'N/A')}\n\n"

        return result.rstrip()

    except (ClientError, BotoCoreError) as e:
        return f"Error getting instances for service '{service_name}': {str(e)}"


@tool
@instrument_tool("get_namespace_summary")
def get_namespace_summary(env_name: Optional[str] = None) -> str:
    """
    Get a summary of the Chimera Cloud Map namespace with service and instance counts.

    Args:
        env_name: Environment name (default: CHIMERA_ENV_NAME env var, or 'dev').

    Returns:
        Formatted string with namespace metadata and per-service instance counts.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    env = env_name or os.environ.get('CHIMERA_ENV_NAME', 'dev')
    namespace_name = f'chimera-{env}'

    try:
        client = boto3.client('servicediscovery', config=_BOTO_CONFIG)

        namespace_id = _find_namespace_id(client, namespace_name)
        if not namespace_id:
            return (
                f"No Cloud Map namespace '{namespace_name}' found. "
                "Infrastructure may not be deployed yet."
            )

        ns = client.get_namespace(Id=namespace_id)['Namespace']
        services = _list_all_services(client, namespace_id)

        # Count instances per service
        service_counts = {}
        total_instances = 0
        for svc in services:
            count = len(_list_all_instances(client, svc['Id']))
            service_counts[svc['Name']] = count
            total_instances += count

        created = ns.get('CreateDate', '')
        if created and hasattr(created, 'strftime'):
            created = created.strftime('%Y-%m-%d %H:%M:%S UTC')

        result = f"""Cloud Map Namespace: {namespace_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Namespace ID: {namespace_id}
Type:         {ns.get('Type', 'N/A')}
Created:      {created}
Services:     {len(services)}
Instances:    {total_instances}

Services registered:\n"""

        for name in sorted(service_counts):
            result += f"  • {name} ({service_counts[name]} instance(s))\n"

        return result.rstrip()

    except (ClientError, BotoCoreError) as e:
        return f"Error getting namespace summary: {str(e)}"


# ---------------------------------------------------------------------------
# Internal helpers (not exposed as tools)
# ---------------------------------------------------------------------------

def _find_namespace_id(client, namespace_name: str) -> Optional[str]:
    """Find a Cloud Map namespace ID by name via paginated list."""
    paginator = client.get_paginator('list_namespaces')
    for page in paginator.paginate():
        for ns in page.get('Namespaces', []):
            if ns['Name'] == namespace_name:
                return ns['Id']
    return None


def _find_service_id(client, namespace_id: str, service_name: str) -> Optional[str]:
    """Find a Cloud Map service ID by name within a namespace."""
    paginator = client.get_paginator('list_services')
    for page in paginator.paginate(
        Filters=[{'Name': 'NAMESPACE_ID', 'Values': [namespace_id], 'Condition': 'EQ'}]
    ):
        for svc in page.get('Services', []):
            if svc['Name'] == service_name:
                return svc['Id']
    return None


def _list_all_services(client, namespace_id: str) -> List[dict]:
    """Return all services in a namespace, handling pagination."""
    paginator = client.get_paginator('list_services')
    services = []
    for page in paginator.paginate(
        Filters=[{'Name': 'NAMESPACE_ID', 'Values': [namespace_id], 'Condition': 'EQ'}]
    ):
        services.extend(page.get('Services', []))
    return services


def _list_all_instances(client, service_id: str) -> List[dict]:
    """Return all instances for a service, handling pagination."""
    paginator = client.get_paginator('list_instances')
    instances = []
    for page in paginator.paginate(ServiceId=service_id):
        instances.extend(page.get('Instances', []))
    return instances
