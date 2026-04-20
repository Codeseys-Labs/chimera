"""
DynamoDB Tools — Agent-callable DynamoDB operations

Provides Query, Scan, GetItem, PutItem, UpdateItem, and DeleteItem.
All operations require tenantId for audit logging.

IMPORTANT: All queries against tenant-scoped tables MUST include
FilterExpression for tenantId to enforce tenant isolation.
"""

import json
import logging
import os
from typing import Optional

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from strands.tools import tool

from .tenant_context import TenantContextError, ensure_tenant_filter, require_tenant_id

logger = logging.getLogger(__name__)


def _get_ddb_client():
    region = os.environ.get("AWS_REGION", "us-west-2")
    return boto3.resource("dynamodb", region_name=region)


@tool
def dynamodb_query(
    table_name: str,
    key_condition: str,
    expression_values: str,
    filter_expression: str = "",
    index_name: str = "",
    limit: int = 50,
    scan_forward: bool = True,
    region: str = "us-west-2",
) -> str:
    """
    Query a DynamoDB table using a key condition expression.

    Args:
        table_name: Name of the DynamoDB table.
        key_condition: KeyConditionExpression (e.g., "PK = :pk AND begins_with(SK, :prefix)").
        expression_values: JSON string of ExpressionAttributeValues (e.g., '{ ":pk": "TENANT#123" }').
        filter_expression: Optional FilterExpression for additional filtering.
        index_name: Optional GSI name. Empty string for base table.
        limit: Maximum items to return (default 50, max 100).
        scan_forward: True for ascending sort, False for descending.
        region: AWS region.

    Returns:
        JSON array of items, or error message.
    """
    try:
        # Enforce tenant isolation: inject tenantId = :__chimera_tid into the
        # filter expression unconditionally (regardless of whether the agent
        # supplied a filter_expression).
        filter_expression, expression_values = ensure_tenant_filter(
            filter_expression, expression_values
        )

        ddb = _get_ddb_client()
        table = ddb.Table(table_name)
        limit = min(limit, 100)

        values = json.loads(expression_values)

        kwargs = {
            "KeyConditionExpression": key_condition,
            "ExpressionAttributeValues": values,
            "FilterExpression": filter_expression,
            "Limit": limit,
            "ScanIndexForward": scan_forward,
        }
        if index_name:
            kwargs["IndexName"] = index_name

        response = table.query(**kwargs)
        items = response.get("Items", [])
        count = response.get("Count", 0)
        scanned = response.get("ScannedCount", 0)

        return json.dumps(
            {
                "count": count,
                "scannedCount": scanned,
                "items": items[:limit],
            },
            default=str,
            indent=2,
        )

    except (ClientError, BotoCoreError, ValueError) as e:
        return f"DynamoDB query failed: {str(e)[:500]}"


@tool
def dynamodb_get_item(
    table_name: str,
    key: str,
    region: str = "us-west-2",
) -> str:
    """
    Get a single item from a DynamoDB table by primary key.

    Args:
        table_name: Name of the DynamoDB table.
        key: JSON string of the primary key (e.g., '{ "PK": "TENANT#123", "SK": "PROFILE" }').
        region: AWS region.

    Returns:
        JSON object of the item, or "Item not found".
    """
    try:
        ddb = _get_ddb_client()
        table = ddb.Table(table_name)
        key_dict = json.loads(key)

        response = table.get_item(Key=key_dict)
        item = response.get("Item")

        if not item:
            return "Item not found."

        return json.dumps(item, default=str, indent=2)

    except (ClientError, BotoCoreError, ValueError) as e:
        return f"DynamoDB GetItem failed: {str(e)[:500]}"


@tool
def dynamodb_put_item(
    table_name: str,
    item: str,
    condition_expression: str = "",
    region: str = "us-west-2",
) -> str:
    """
    Put (create or replace) an item in a DynamoDB table.

    Args:
        table_name: Name of the DynamoDB table.
        item: JSON string of the item to write.
        condition_expression: Optional ConditionExpression to prevent overwrites.
        region: AWS region.

    Returns:
        Success confirmation or error message.
    """
    try:
        ddb = _get_ddb_client()
        table = ddb.Table(table_name)
        item_dict = json.loads(item)

        kwargs = {"Item": item_dict}
        if condition_expression:
            kwargs["ConditionExpression"] = condition_expression

        table.put_item(**kwargs)
        return f"Item written to {table_name} successfully."

    except (ClientError, BotoCoreError, ValueError) as e:
        return f"DynamoDB PutItem failed: {str(e)[:500]}"


@tool
def dynamodb_update_item(
    table_name: str,
    key: str,
    update_expression: str,
    expression_values: str,
    condition_expression: str = "",
    region: str = "us-west-2",
) -> str:
    """
    Update attributes of an existing item in a DynamoDB table.

    Args:
        table_name: Name of the DynamoDB table.
        key: JSON string of the primary key.
        update_expression: UpdateExpression (e.g., "SET #name = :val").
        expression_values: JSON string of ExpressionAttributeValues.
        condition_expression: Optional ConditionExpression.
        region: AWS region.

    Returns:
        Updated attributes or error message.
    """
    try:
        ddb = _get_ddb_client()
        table = ddb.Table(table_name)
        key_dict = json.loads(key)
        values = json.loads(expression_values)

        kwargs = {
            "Key": key_dict,
            "UpdateExpression": update_expression,
            "ExpressionAttributeValues": values,
            "ReturnValues": "ALL_NEW",
        }
        if condition_expression:
            kwargs["ConditionExpression"] = condition_expression

        response = table.update_item(**kwargs)
        return json.dumps(response.get("Attributes", {}), default=str, indent=2)

    except (ClientError, BotoCoreError, ValueError) as e:
        return f"DynamoDB UpdateItem failed: {str(e)[:500]}"


@tool
def dynamodb_scan(
    table_name: str,
    filter_expression: str = "",
    expression_values: str = "{}",
    limit: int = 25,
    region: str = "us-west-2",
) -> str:
    """
    Scan a DynamoDB table (use sparingly — prefer Query with key conditions).

    Args:
        table_name: Name of the DynamoDB table.
        filter_expression: Optional FilterExpression.
        expression_values: JSON string of ExpressionAttributeValues.
        limit: Maximum items to return (default 25, max 50).
        region: AWS region.

    Returns:
        JSON array of items.
    """
    try:
        # Enforce tenant isolation on scans too — scans without a tenant filter
        # are the worst offender for cross-tenant leakage.
        filter_expression, expression_values = ensure_tenant_filter(
            filter_expression, expression_values
        )

        ddb = _get_ddb_client()
        table = ddb.Table(table_name)
        limit = min(limit, 50)

        kwargs = {
            "Limit": limit,
            "FilterExpression": filter_expression,
        }
        values = json.loads(expression_values)
        if values:
            kwargs["ExpressionAttributeValues"] = values

        response = table.scan(**kwargs)
        items = response.get("Items", [])

        return json.dumps(
            {
                "count": len(items),
                "items": items,
            },
            default=str,
            indent=2,
        )

    except (ClientError, BotoCoreError, ValueError) as e:
        return f"DynamoDB Scan failed: {str(e)[:500]}"
