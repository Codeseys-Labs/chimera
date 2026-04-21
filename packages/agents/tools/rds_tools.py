"""
RDS Tools - AWS RDS operations for Chimera agent

Provides RDS database instance management operations for launching,
monitoring, and managing relational databases.
"""
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from typing import List, Dict, Any, Optional
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def describe_rds_db_instances(
    db_instance_identifier: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    Query RDS database instance metadata, configuration, and status.

    Args:
        db_instance_identifier: Specific DB instance identifier (optional)
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with database instance details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rds = boto3.client('rds', region_name=region, config=_BOTO_CONFIG)

        kwargs = {}
        if db_instance_identifier:
            kwargs['DBInstanceIdentifier'] = db_instance_identifier

        response = rds.describe_db_instances(**kwargs)

        instances = response.get('DBInstances', [])

        if not instances:
            return f"No RDS instances found in region {region}."

        result = f"Found {len(instances)} RDS instance(s):\n\n"

        for db in instances:
            identifier = db['DBInstanceIdentifier']
            instance_class = db['DBInstanceClass']
            engine = db['Engine']
            engine_version = db.get('EngineVersion', 'N/A')
            status = db['DBInstanceStatus']

            endpoint = db.get('Endpoint', {})
            address = endpoint.get('Address', 'N/A')
            port = endpoint.get('Port', 'N/A')

            storage = db.get('AllocatedStorage', 'N/A')
            multi_az = db.get('MultiAZ', False)

            result += f"• {identifier}\n"
            result += f"  Class: {instance_class}\n"
            result += f"  Engine: {engine} {engine_version}\n"
            result += f"  Status: {status}\n"
            result += f"  Endpoint: {address}:{port}\n"
            result += f"  Storage: {storage} GB\n"
            result += f"  Multi-AZ: {multi_az}\n\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error describing RDS instances: {str(e)}"


@tool
def create_rds_db_instance(
    db_instance_identifier: str,
    db_instance_class: str,
    engine: str,
    master_username: str,
    master_user_password: str,
    allocated_storage: int,
    region: str = "us-east-1"
) -> str:
    """
    Create a new RDS database instance with specified engine and configuration.

    Args:
        db_instance_identifier: Unique identifier for the DB instance
        db_instance_class: Instance class (e.g., db.t3.micro, db.r5.large)
        engine: Database engine (mysql, postgres, mariadb, etc.)
        master_username: Master username for database
        master_user_password: Master password (8-41 characters)
        allocated_storage: Storage size in GB
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with creation status.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rds = boto3.client('rds', region_name=region, config=_BOTO_CONFIG)

        response = rds.create_db_instance(
            DBInstanceIdentifier=db_instance_identifier,
            DBInstanceClass=db_instance_class,
            Engine=engine,
            MasterUsername=master_username,
            MasterUserPassword=master_user_password,
            AllocatedStorage=allocated_storage,
            StorageType='gp3',
            BackupRetentionPeriod=7,
            PubliclyAccessible=False
        )

        db = response['DBInstance']
        identifier = db['DBInstanceIdentifier']
        status = db['DBInstanceStatus']

        return f"""RDS Instance Creation Started:
Identifier: {identifier}
Class: {db_instance_class}
Engine: {engine}
Storage: {allocated_storage} GB
Status: {status}
Region: {region}

Note: Instance creation takes 10-20 minutes. Use describe_rds_db_instances to check status."""

    except (ClientError, BotoCoreError) as e:
        return f"Error creating RDS instance: {str(e)}"


@tool
def delete_rds_db_instance(
    db_instance_identifier: str,
    skip_final_snapshot: bool = False,
    final_snapshot_identifier: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    Delete an RDS database instance (permanent operation).

    Args:
        db_instance_identifier: DB instance identifier to delete
        skip_final_snapshot: Skip final snapshot (default: False)
        final_snapshot_identifier: Final snapshot name (required if skip_final_snapshot=False)
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rds = boto3.client('rds', region_name=region, config=_BOTO_CONFIG)

        kwargs = {
            'DBInstanceIdentifier': db_instance_identifier,
            'SkipFinalSnapshot': skip_final_snapshot,
            'DeleteAutomatedBackups': True
        }

        if not skip_final_snapshot and final_snapshot_identifier:
            kwargs['FinalDBSnapshotIdentifier'] = final_snapshot_identifier

        response = rds.delete_db_instance(**kwargs)

        db = response['DBInstance']
        status = db['DBInstanceStatus']

        return f"""RDS Instance Deletion Started:
Identifier: {db_instance_identifier}
Status: {status}
Final Snapshot: {'Created' if not skip_final_snapshot else 'Skipped'}"""

    except (ClientError, BotoCoreError) as e:
        return f"Error deleting RDS instance: {str(e)}"


@tool
def start_rds_db_instance(
    db_instance_identifier: str,
    region: str = "us-east-1"
) -> str:
    """
    Start a stopped RDS database instance.

    Args:
        db_instance_identifier: DB instance identifier to start
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rds = boto3.client('rds', region_name=region, config=_BOTO_CONFIG)

        response = rds.start_db_instance(
            DBInstanceIdentifier=db_instance_identifier
        )

        db = response['DBInstance']
        status = db['DBInstanceStatus']

        return f"""RDS Instance Starting:
Identifier: {db_instance_identifier}
Status: {status}

Note: Startup takes 5-10 minutes."""

    except (ClientError, BotoCoreError) as e:
        return f"Error starting RDS instance: {str(e)}"


@tool
def stop_rds_db_instance(
    db_instance_identifier: str,
    region: str = "us-east-1"
) -> str:
    """
    Stop a running RDS database instance (can be restarted later).

    Args:
        db_instance_identifier: DB instance identifier to stop
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rds = boto3.client('rds', region_name=region, config=_BOTO_CONFIG)

        response = rds.stop_db_instance(
            DBInstanceIdentifier=db_instance_identifier
        )

        db = response['DBInstance']
        status = db['DBInstanceStatus']

        return f"""RDS Instance Stopping:
Identifier: {db_instance_identifier}
Status: {status}

Note: Stopped instances automatically restart after 7 days."""

    except (ClientError, BotoCoreError) as e:
        return f"Error stopping RDS instance: {str(e)}"


@tool
def modify_rds_db_instance(
    db_instance_identifier: str,
    db_instance_class: Optional[str] = None,
    allocated_storage: Optional[int] = None,
    apply_immediately: bool = False,
    region: str = "us-east-1"
) -> str:
    """
    Modify RDS database instance configuration (storage, instance class, etc.).

    Args:
        db_instance_identifier: DB instance identifier to modify
        db_instance_class: New instance class (requires reboot) (optional)
        allocated_storage: New storage size in GB (optional)
        apply_immediately: Apply changes immediately (default: False, applies during maintenance window)
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rds = boto3.client('rds', region_name=region, config=_BOTO_CONFIG)

        kwargs = {
            'DBInstanceIdentifier': db_instance_identifier,
            'ApplyImmediately': apply_immediately
        }

        changes = []
        if db_instance_class:
            kwargs['DBInstanceClass'] = db_instance_class
            changes.append(f"Instance Class: {db_instance_class}")
        if allocated_storage:
            kwargs['AllocatedStorage'] = allocated_storage
            changes.append(f"Storage: {allocated_storage} GB")

        if not changes:
            return "No modifications specified. Provide db_instance_class or allocated_storage."

        response = rds.modify_db_instance(**kwargs)

        db = response['DBInstance']
        status = db['DBInstanceStatus']

        timing = "immediately" if apply_immediately else "during next maintenance window"

        return f"""RDS Instance Modification Started:
Identifier: {db_instance_identifier}
Changes: {', '.join(changes)}
Status: {status}
Timing: Applied {timing}"""

    except (ClientError, BotoCoreError) as e:
        return f"Error modifying RDS instance: {str(e)}"
