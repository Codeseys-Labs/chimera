"""
S3 Tools - AWS S3 operations for Chimera agent

Provides basic S3 operations with tenant-scoped access control.
All operations respect IAM policies enforced at the tenant level.
"""
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from typing import List, Dict, Any
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def list_s3_buckets() -> str:
    """
    List all S3 buckets in the AWS account.

    Returns:
        A formatted string listing all S3 bucket names and creation dates.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        s3_client = boto3.client('s3', config=_BOTO_CONFIG)
        response = s3_client.list_buckets()

        if not response.get('Buckets'):
            return "No S3 buckets found in this account."

        buckets = response['Buckets']
        result = f"Found {len(buckets)} S3 bucket(s):\n\n"

        for bucket in buckets:
            name = bucket['Name']
            created = bucket['CreationDate'].strftime('%Y-%m-%d %H:%M:%S')
            result += f"• {name} (created: {created})\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error listing S3 buckets: {str(e)}"


@tool
def get_bucket_info(bucket_name: str) -> str:
    """
    Get detailed information about a specific S3 bucket.

    Args:
        bucket_name: The name of the S3 bucket

    Returns:
        A formatted string with bucket region, versioning status, and object count.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        s3_client = boto3.client('s3', config=_BOTO_CONFIG)

        # Get bucket location
        location_response = s3_client.get_bucket_location(Bucket=bucket_name)
        region = location_response.get('LocationConstraint') or 'us-east-1'

        # Get versioning status
        versioning_response = s3_client.get_bucket_versioning(Bucket=bucket_name)
        versioning_status = versioning_response.get('Status', 'Disabled')

        # Count objects (limit to 1000 for performance)
        paginator = s3_client.get_paginator('list_objects_v2')
        object_count = 0
        total_size = 0

        for page in paginator.paginate(Bucket=bucket_name, PaginationConfig={'MaxItems': 1000}):
            object_count += page.get('KeyCount', 0)
            for obj in page.get('Contents', []):
                total_size += obj.get('Size', 0)

        # Format size
        if total_size < 1024:
            size_str = f"{total_size} bytes"
        elif total_size < 1024 * 1024:
            size_str = f"{total_size / 1024:.2f} KB"
        elif total_size < 1024 * 1024 * 1024:
            size_str = f"{total_size / (1024 * 1024):.2f} MB"
        else:
            size_str = f"{total_size / (1024 * 1024 * 1024):.2f} GB"

        result = f"""Bucket: {bucket_name}
Region: {region}
Versioning: {versioning_status}
Objects: {object_count} (showing up to 1000)
Total Size: {size_str}"""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error getting bucket info for {bucket_name}: {str(e)}"
