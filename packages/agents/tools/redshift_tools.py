"""
AWS Redshift Tools - Data warehouse management for Chimera agent

Provides Redshift operations for data warehouse cluster management.
All operations respect IAM policies enforced at the tenant level.
"""
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from typing import Optional, List, Dict
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def list_redshift_clusters(
    region: str = "us-east-1",
    cluster_identifier: Optional[str] = None,
    max_records: int = 100
) -> str:
    """
    Query Redshift data warehouse cluster metadata, configuration, and status.

    Args:
        region: AWS region (default: us-east-1)
        cluster_identifier: Specific cluster identifier (optional, lists all if omitted)
        max_records: Maximum number of results (default: 100)

    Returns:
        Formatted list of Redshift clusters with details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        redshift_client = boto3.client('redshift', region_name=region, config=_BOTO_CONFIG)

        params = {'MaxRecords': max_records}
        if cluster_identifier:
            params['ClusterIdentifier'] = cluster_identifier

        response = redshift_client.describe_clusters(**params)

        clusters = response.get('Clusters', [])

        if not clusters:
            return f"No Redshift clusters found in region {region}."

        result = f"Found {len(clusters)} Redshift cluster(s) in {region}:\n\n"

        for cluster in clusters:
            cluster_id = cluster['ClusterIdentifier']
            node_type = cluster['NodeType']
            status = cluster['ClusterStatus']
            num_nodes = cluster['NumberOfNodes']
            db_name = cluster.get('DBName', 'N/A')
            master_user = cluster.get('MasterUsername', 'N/A')

            result += f"• {cluster_id}\n"
            result += f"  Status: {status}\n"
            result += f"  Node Type: {node_type}\n"
            result += f"  Number of Nodes: {num_nodes}\n"
            result += f"  Database: {db_name}\n"
            result += f"  Master User: {master_user}\n"

            # Endpoint
            endpoint = cluster.get('Endpoint', {})
            if endpoint:
                address = endpoint.get('Address', 'N/A')
                port = endpoint.get('Port', 'N/A')
                result += f"  Endpoint: {address}:{port}\n"

            # Network info
            vpc_id = cluster.get('VpcId', 'N/A')
            az = cluster.get('AvailabilityZone', 'N/A')
            result += f"  VPC: {vpc_id}\n"
            result += f"  Availability Zone: {az}\n"

            # Encryption
            encrypted = cluster.get('Encrypted', False)
            result += f"  Encrypted: {encrypted}\n"

            # Creation time
            if 'ClusterCreateTime' in cluster:
                result += f"  Created: {cluster['ClusterCreateTime']}\n"

            result += "\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error listing Redshift clusters: {str(e)}"


@tool
def create_redshift_cluster(
    cluster_identifier: str,
    node_type: str,
    master_username: str,
    master_password: str,
    region: str = "us-east-1",
    number_of_nodes: int = 1,
    db_name: Optional[str] = None,
    vpc_security_group_ids: Optional[List[str]] = None,
    cluster_subnet_group_name: Optional[str] = None,
    publicly_accessible: bool = False,
    encrypted: bool = True
) -> str:
    """
    Create a new Redshift data warehouse cluster with specified node type and configuration.

    Args:
        cluster_identifier: Unique identifier for the cluster
        node_type: Node type (e.g., dc2.large, ra3.xlplus)
        master_username: Master username for database
        master_password: Master password (8-64 characters)
        region: AWS region (default: us-east-1)
        number_of_nodes: Number of nodes (default: 1 for single-node)
        db_name: Database name to create (optional)
        vpc_security_group_ids: VPC security group IDs (optional)
        cluster_subnet_group_name: Cluster subnet group name (optional)
        publicly_accessible: Allow public internet access (default: False)
        encrypted: Enable encryption at rest (default: True)

    Returns:
        Cluster creation confirmation with endpoint information.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        redshift_client = boto3.client('redshift', region_name=region, config=_BOTO_CONFIG)

        params = {
            'ClusterIdentifier': cluster_identifier,
            'NodeType': node_type,
            'MasterUsername': master_username,
            'MasterUserPassword': master_password,
            'NumberOfNodes': number_of_nodes,
            'ClusterType': 'single-node' if number_of_nodes == 1 else 'multi-node',
            'PubliclyAccessible': publicly_accessible,
            'Encrypted': encrypted
        }

        if db_name:
            params['DBName'] = db_name
        if vpc_security_group_ids:
            params['VpcSecurityGroupIds'] = vpc_security_group_ids
        if cluster_subnet_group_name:
            params['ClusterSubnetGroupName'] = cluster_subnet_group_name

        response = redshift_client.create_cluster(**params)

        cluster = response['Cluster']

        result = f"""Redshift cluster creation initiated!

Cluster ID: {cluster['ClusterIdentifier']}
Status: {cluster['ClusterStatus']}
Node Type: {cluster['NodeType']}
Number of Nodes: {cluster['NumberOfNodes']}
"""

        if 'Endpoint' in cluster and cluster['Endpoint']:
            endpoint_address = cluster['Endpoint'].get('Address', 'Pending')
            result += f"Endpoint: {endpoint_address}\n"
        else:
            result += "Endpoint: (will be available when cluster is ready)\n"

        result += "\nCluster creation takes several minutes. Use list_redshift_clusters() to check status."

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error creating Redshift cluster: {str(e)}"


@tool
def delete_redshift_cluster(
    cluster_identifier: str,
    region: str = "us-east-1",
    skip_final_snapshot: bool = False,
    final_snapshot_identifier: Optional[str] = None
) -> str:
    """
    Delete a Redshift data warehouse cluster (permanent operation).

    Args:
        cluster_identifier: Cluster identifier to delete
        region: AWS region (default: us-east-1)
        skip_final_snapshot: Skip final snapshot (default: False)
        final_snapshot_identifier: Final snapshot name (required if skip_final_snapshot=False)

    Returns:
        Deletion confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        redshift_client = boto3.client('redshift', region_name=region, config=_BOTO_CONFIG)

        params = {
            'ClusterIdentifier': cluster_identifier,
            'SkipFinalClusterSnapshot': skip_final_snapshot
        }

        if not skip_final_snapshot:
            if not final_snapshot_identifier:
                return "Error: final_snapshot_identifier is required when skip_final_snapshot is False."
            params['FinalClusterSnapshotIdentifier'] = final_snapshot_identifier

        response = redshift_client.delete_cluster(**params)

        cluster = response['Cluster']
        status = cluster['ClusterStatus']

        result = f"""Redshift cluster deletion initiated.

Cluster ID: {cluster_identifier}
Status: {status}
"""

        if not skip_final_snapshot:
            result += f"Final Snapshot: {final_snapshot_identifier}\n"

        result += "\nDeletion may take several minutes to complete."

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error deleting Redshift cluster: {str(e)}"


@tool
def pause_redshift_cluster(
    cluster_identifier: str,
    region: str = "us-east-1"
) -> str:
    """
    Pause a running Redshift cluster to save costs (compute charges stop).

    Args:
        cluster_identifier: Cluster identifier to pause
        region: AWS region (default: us-east-1)

    Returns:
        Pause confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        redshift_client = boto3.client('redshift', region_name=region, config=_BOTO_CONFIG)

        response = redshift_client.pause_cluster(
            ClusterIdentifier=cluster_identifier
        )

        cluster = response['Cluster']
        status = cluster['ClusterStatus']

        result = f"""Redshift cluster pause initiated.

Cluster ID: {cluster_identifier}
Status: {status}

Note: While paused, you only pay for storage, not compute.
Use resume_redshift_cluster() to resume operations."""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error pausing Redshift cluster: {str(e)}"


@tool
def resume_redshift_cluster(
    cluster_identifier: str,
    region: str = "us-east-1"
) -> str:
    """
    Resume a paused Redshift cluster (compute charges resume).

    Args:
        cluster_identifier: Cluster identifier to resume
        region: AWS region (default: us-east-1)

    Returns:
        Resume confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        redshift_client = boto3.client('redshift', region_name=region, config=_BOTO_CONFIG)

        response = redshift_client.resume_cluster(
            ClusterIdentifier=cluster_identifier
        )

        cluster = response['Cluster']
        status = cluster['ClusterStatus']

        result = f"""Redshift cluster resume initiated.

Cluster ID: {cluster_identifier}
Status: {status}

Cluster will be available for queries once status is 'available'."""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error resuming Redshift cluster: {str(e)}"


@tool
def modify_redshift_cluster(
    cluster_identifier: str,
    region: str = "us-east-1",
    node_type: Optional[str] = None,
    number_of_nodes: Optional[int] = None,
    master_password: Optional[str] = None,
    publicly_accessible: Optional[bool] = None
) -> str:
    """
    Modify Redshift cluster configuration (node type, number of nodes, etc.).

    Args:
        cluster_identifier: Cluster identifier to modify
        region: AWS region (default: us-east-1)
        node_type: New node type (optional)
        number_of_nodes: New number of nodes (optional)
        master_password: New master password (optional)
        publicly_accessible: Change public accessibility (optional)

    Returns:
        Modification confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        redshift_client = boto3.client('redshift', region_name=region, config=_BOTO_CONFIG)

        params = {'ClusterIdentifier': cluster_identifier}

        # Only include parameters that were provided
        if node_type:
            params['NodeType'] = node_type
        if number_of_nodes:
            params['NumberOfNodes'] = number_of_nodes
        if master_password:
            params['MasterUserPassword'] = master_password
        if publicly_accessible is not None:
            params['PubliclyAccessible'] = publicly_accessible

        if len(params) == 1:
            return "Error: At least one modification parameter must be provided."

        response = redshift_client.modify_cluster(**params)

        cluster = response['Cluster']
        status = cluster['ClusterStatus']

        result = f"""Redshift cluster modification initiated.

Cluster ID: {cluster_identifier}
Status: {status}

Modifications applied:
"""

        if node_type:
            result += f"  • Node Type: {node_type}\n"
        if number_of_nodes:
            result += f"  • Number of Nodes: {number_of_nodes}\n"
        if master_password:
            result += f"  • Master Password: updated\n"
        if publicly_accessible is not None:
            result += f"  • Publicly Accessible: {publicly_accessible}\n"

        result += "\nModification may take several minutes to complete."

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error modifying Redshift cluster: {str(e)}"
