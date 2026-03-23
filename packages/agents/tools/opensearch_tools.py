"""
OpenSearch Tools - AWS OpenSearch operations for Chimera agent

Provides OpenSearch domain management operations for search and
analytics engine deployment and configuration.
"""
import boto3
from typing import List, Dict, Any, Optional
from strands.tools import tool


@tool
def describe_opensearch_domains(
    domain_names: str,
    region: str = "us-east-1"
) -> str:
    """
    Query OpenSearch domain metadata, configuration, and status.

    Args:
        domain_names: JSON array of domain names to describe ["domain1", "domain2"]
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with domain details.
    """
    try:
        import json
        opensearch = boto3.client('opensearch', region_name=region)

        domains = json.loads(domain_names)

        response = opensearch.describe_domains(DomainNames=domains)

        domain_list = response.get('DomainStatusList', [])

        if not domain_list:
            return f"No OpenSearch domains found in region {region}."

        result = f"Found {len(domain_list)} OpenSearch domain(s):\n\n"

        for domain in domain_list:
            name = domain['DomainName']
            domain_id = domain.get('DomainId', 'N/A')
            endpoint = domain.get('Endpoint', 'N/A')
            engine_version = domain.get('EngineVersion', 'N/A')
            processing = domain.get('Processing', False)

            cluster_config = domain.get('ClusterConfig', {})
            instance_type = cluster_config.get('InstanceType', 'N/A')
            instance_count = cluster_config.get('InstanceCount', 'N/A')

            ebs_options = domain.get('EBSOptions', {})
            volume_size = ebs_options.get('VolumeSize', 'N/A')

            result += f"• {name}\n"
            result += f"  Domain ID: {domain_id}\n"
            result += f"  Endpoint: {endpoint}\n"
            result += f"  Engine: {engine_version}\n"
            result += f"  Instance: {instance_type} x {instance_count}\n"
            result += f"  Storage: {volume_size} GB\n"
            result += f"  Processing: {processing}\n\n"

        return result

    except Exception as e:
        return f"Error describing OpenSearch domains: {str(e)}"


@tool
def create_opensearch_domain(
    domain_name: str,
    instance_type: str = "t3.small.search",
    instance_count: int = 1,
    volume_size: int = 10,
    region: str = "us-east-1"
) -> str:
    """
    Create a new AWS OpenSearch domain with specified engine version and configuration.

    Args:
        domain_name: Unique domain name
        instance_type: Instance type (e.g., t3.small.search, m5.large.search)
        instance_count: Number of instances (default: 1)
        volume_size: EBS volume size in GB (default: 10)
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with creation status.
    """
    try:
        opensearch = boto3.client('opensearch', region_name=region)

        response = opensearch.create_domain(
            DomainName=domain_name,
            EngineVersion='OpenSearch_2.5',
            ClusterConfig={
                'InstanceType': instance_type,
                'InstanceCount': instance_count,
                'DedicatedMasterEnabled': False,
                'ZoneAwarenessEnabled': False
            },
            EBSOptions={
                'EBSEnabled': True,
                'VolumeType': 'gp3',
                'VolumeSize': volume_size
            },
            EncryptionAtRestOptions={
                'Enabled': True
            },
            NodeToNodeEncryptionOptions={
                'Enabled': True
            }
        )

        domain = response['DomainStatus']
        name = domain['DomainName']
        domain_id = domain.get('DomainId', 'N/A')

        return f"""OpenSearch Domain Creation Started:
Domain Name: {name}
Domain ID: {domain_id}
Instance: {instance_type} x {instance_count}
Storage: {volume_size} GB
Region: {region}

Note: Domain creation takes 15-30 minutes. Use describe_opensearch_domains to check status."""

    except Exception as e:
        return f"Error creating OpenSearch domain: {str(e)}"


@tool
def delete_opensearch_domain(
    domain_name: str,
    region: str = "us-east-1"
) -> str:
    """
    Delete an AWS OpenSearch domain (permanent operation).

    Args:
        domain_name: Domain name to delete
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        opensearch = boto3.client('opensearch', region_name=region)

        response = opensearch.delete_domain(DomainName=domain_name)

        domain = response['DomainStatus']
        name = domain['DomainName']

        return f"""OpenSearch Domain Deletion Started:
Domain Name: {name}
Region: {region}

Note: Deletion takes 10-15 minutes."""

    except Exception as e:
        return f"Error deleting OpenSearch domain: {str(e)}"


@tool
def update_opensearch_domain_config(
    domain_name: str,
    instance_type: Optional[str] = None,
    instance_count: Optional[int] = None,
    volume_size: Optional[int] = None,
    region: str = "us-east-1"
) -> str:
    """
    Modify AWS OpenSearch domain configuration (instance type, count, storage, etc.).

    Args:
        domain_name: Domain name to update
        instance_type: New instance type (optional)
        instance_count: New number of instances (optional)
        volume_size: New EBS volume size in GB (optional)
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        opensearch = boto3.client('opensearch', region_name=region)

        kwargs = {'DomainName': domain_name}

        changes = []
        if instance_type or instance_count is not None:
            cluster_config = {}
            if instance_type:
                cluster_config['InstanceType'] = instance_type
                changes.append(f"Instance Type: {instance_type}")
            if instance_count is not None:
                cluster_config['InstanceCount'] = instance_count
                changes.append(f"Instance Count: {instance_count}")
            kwargs['ClusterConfig'] = cluster_config

        if volume_size:
            kwargs['EBSOptions'] = {
                'EBSEnabled': True,
                'VolumeSize': volume_size
            }
            changes.append(f"Storage: {volume_size} GB")

        if not changes:
            return "No modifications specified. Provide instance_type, instance_count, or volume_size."

        response = opensearch.update_domain_config(**kwargs)

        return f"""OpenSearch Domain Update Started:
Domain Name: {domain_name}
Changes: {', '.join(changes)}
Region: {region}

Note: Configuration changes take 15-30 minutes to apply."""

    except Exception as e:
        return f"Error updating OpenSearch domain: {str(e)}"


@tool
def list_opensearch_domain_names(
    region: str = "us-east-1"
) -> str:
    """
    List all AWS OpenSearch domain names in the account.

    Args:
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string listing all domain names.
    """
    try:
        opensearch = boto3.client('opensearch', region_name=region)

        response = opensearch.list_domain_names()

        domains = response.get('DomainNames', [])

        if not domains:
            return f"No OpenSearch domains found in region {region}."

        result = f"Found {len(domains)} OpenSearch domain(s):\n\n"

        for domain in domains:
            name = domain['DomainName']
            engine_type = domain.get('EngineType', 'OpenSearch')
            result += f"• {name} ({engine_type})\n"

        return result

    except Exception as e:
        return f"Error listing OpenSearch domains: {str(e)}"


@tool
def get_opensearch_compatible_versions(
    domain_name: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    Get compatible OpenSearch/Elasticsearch upgrade versions for a domain.

    Args:
        domain_name: Domain name (if omitted, returns all version maps) (optional)
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with compatible upgrade versions.
    """
    try:
        opensearch = boto3.client('opensearch', region_name=region)

        kwargs = {}
        if domain_name:
            kwargs['DomainName'] = domain_name

        response = opensearch.get_compatible_versions(**kwargs)

        version_maps = response.get('CompatibleVersions', [])

        if not version_maps:
            return "No compatible version mappings found."

        result = "Compatible Upgrade Versions:\n\n"

        for version_map in version_maps:
            source = version_map.get('SourceVersion', 'Unknown')
            targets = version_map.get('TargetVersions', [])

            result += f"From {source}:\n"
            for target in targets:
                result += f"  → {target}\n"
            result += "\n"

        return result

    except Exception as e:
        return f"Error getting compatible versions: {str(e)}"
