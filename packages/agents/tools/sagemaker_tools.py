"""
AWS SageMaker Tools - ML model deployment and inference for Chimera agents

Provides SageMaker operations for model registration, endpoint configuration,
deployment, and management of ML inference infrastructure.

Operations:
- sagemaker_create_model: Register trained model from S3
- sagemaker_create_endpoint_config: Define deployment configuration
- sagemaker_create_endpoint: Deploy model to inference endpoint
- sagemaker_describe_endpoint: Get endpoint status and metadata
- sagemaker_delete_endpoint: Remove inference endpoint
- sagemaker_list_endpoints: List all endpoints with filtering
"""
import boto3
import json
from botocore.config import Config
from typing import Optional, List, Dict, Any
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def sagemaker_create_model(
    model_name: str,
    execution_role_arn: str,
    primary_container_image: str,
    primary_container_model_data_url: str,
    region: str = "us-east-1",
    primary_container_environment: Optional[Dict[str, str]] = None,
) -> str:
    """
    Register SageMaker model from S3 artifact for deployment.

    Args:
        model_name: Unique model name
        execution_role_arn: IAM role ARN with SageMaker permissions
        primary_container_image: Docker image URI for inference
        primary_container_model_data_url: S3 path to model artifact (model.tar.gz)
        region: AWS region (default: us-east-1)
        primary_container_environment: Environment variables for container (optional)

    Returns:
        JSON string with model ARN
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sagemaker = boto3.client('sagemaker', region_name=region, config=_BOTO_CONFIG)

        primary_container = {
            'Image': primary_container_image,
            'ModelDataUrl': primary_container_model_data_url
        }
        if primary_container_environment:
            primary_container['Environment'] = primary_container_environment

        response = sagemaker.create_model(
            ModelName=model_name,
            ExecutionRoleArn=execution_role_arn,
            PrimaryContainer=primary_container
        )

        return json.dumps({
            "success": True,
            "data": {
                "model_arn": response.get('ModelArn')
            },
            "metadata": {
                "region": region
            }
        })

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })


@tool
def sagemaker_create_endpoint_config(
    endpoint_config_name: str,
    production_variants: List[Dict[str, Any]],
    region: str = "us-east-1",
) -> str:
    """
    Create SageMaker endpoint configuration with instance type and count.

    Args:
        endpoint_config_name: Unique endpoint config name
        production_variants: List of variant configs, each with:
            - variant_name: Variant name
            - model_name: Model name (from create_model)
            - initial_instance_count: Number of instances
            - instance_type: Instance type (e.g., ml.t2.medium, ml.m5.xlarge)
            - initial_variant_weight: Traffic weight 0.0-1.0 (optional)
        region: AWS region (default: us-east-1)

    Returns:
        JSON string with endpoint config ARN
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sagemaker = boto3.client('sagemaker', region_name=region, config=_BOTO_CONFIG)

        formatted_variants = []
        for variant in production_variants:
            formatted_variant = {
                'VariantName': variant['variant_name'],
                'ModelName': variant['model_name'],
                'InitialInstanceCount': variant['initial_instance_count'],
                'InstanceType': variant['instance_type'],
                'InitialVariantWeight': variant.get('initial_variant_weight', 1.0)
            }
            formatted_variants.append(formatted_variant)

        response = sagemaker.create_endpoint_config(
            EndpointConfigName=endpoint_config_name,
            ProductionVariants=formatted_variants
        )

        return json.dumps({
            "success": True,
            "data": {
                "endpoint_config_arn": response.get('EndpointConfigArn')
            },
            "metadata": {
                "region": region
            }
        })

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })


@tool
def sagemaker_create_endpoint(
    endpoint_name: str,
    endpoint_config_name: str,
    region: str = "us-east-1",
) -> str:
    """
    Deploy SageMaker endpoint with specified configuration.

    Args:
        endpoint_name: Unique endpoint name
        endpoint_config_name: Endpoint config name (from create_endpoint_config)
        region: AWS region (default: us-east-1)

    Returns:
        JSON string with endpoint ARN
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sagemaker = boto3.client('sagemaker', region_name=region, config=_BOTO_CONFIG)

        response = sagemaker.create_endpoint(
            EndpointName=endpoint_name,
            EndpointConfigName=endpoint_config_name
        )

        return json.dumps({
            "success": True,
            "data": {
                "endpoint_arn": response.get('EndpointArn')
            },
            "metadata": {
                "region": region
            }
        })

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })


@tool
def sagemaker_describe_endpoint(
    endpoint_name: str,
    region: str = "us-east-1"
) -> str:
    """
    Get SageMaker endpoint status, configuration, and metadata.

    Args:
        endpoint_name: Endpoint name
        region: AWS region (default: us-east-1)

    Returns:
        JSON string with endpoint details
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sagemaker = boto3.client('sagemaker', region_name=region, config=_BOTO_CONFIG)

        response = sagemaker.describe_endpoint(EndpointName=endpoint_name)

        production_variants = []
        for pv in response.get('ProductionVariants', []):
            production_variants.append({
                "variant_name": pv.get('VariantName'),
                "deployed_images": pv.get('DeployedImages'),
                "current_weight": pv.get('CurrentWeight'),
                "desired_weight": pv.get('DesiredWeight'),
                "current_instance_count": pv.get('CurrentInstanceCount'),
                "desired_instance_count": pv.get('DesiredInstanceCount')
            })

        return json.dumps({
            "success": True,
            "data": {
                "endpoint_name": response.get('EndpointName'),
                "endpoint_arn": response.get('EndpointArn'),
                "endpoint_config_name": response.get('EndpointConfigName'),
                "endpoint_status": response.get('EndpointStatus'),
                "creation_time": response.get('CreationTime').isoformat() if response.get('CreationTime') else None,
                "last_modified_time": response.get('LastModifiedTime').isoformat() if response.get('LastModifiedTime') else None,
                "production_variants": production_variants
            },
            "metadata": {
                "region": region
            }
        })

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })


@tool
def sagemaker_delete_endpoint(
    endpoint_name: str,
    region: str = "us-east-1"
) -> str:
    """
    Delete SageMaker endpoint (stops billing for instances).

    Args:
        endpoint_name: Endpoint name to delete
        region: AWS region (default: us-east-1)

    Returns:
        JSON string confirming deletion
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sagemaker = boto3.client('sagemaker', region_name=region, config=_BOTO_CONFIG)

        sagemaker.delete_endpoint(EndpointName=endpoint_name)

        return json.dumps({
            "success": True,
            "data": {
                "endpoint_name": endpoint_name,
                "deleted": True
            },
            "metadata": {
                "region": region
            }
        })

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })


@tool
def sagemaker_list_endpoints(
    region: str = "us-east-1",
    status_equals: Optional[str] = None,
    name_contains: Optional[str] = None,
    max_results: Optional[int] = None,
    next_token: Optional[str] = None,
) -> str:
    """
    List SageMaker endpoints with filtering and pagination.

    Args:
        region: AWS region (default: us-east-1)
        status_equals: Filter by status (OutOfService, Creating, Updating, SystemUpdating,
                      RollingBack, InService, Deleting, Failed)
        name_contains: Filter by name substring
        max_results: Max results (1-100)
        next_token: Pagination token

    Returns:
        JSON string with endpoint summaries
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sagemaker = boto3.client('sagemaker', region_name=region, config=_BOTO_CONFIG)

        params = {}
        if status_equals:
            params['StatusEquals'] = status_equals
        if name_contains:
            params['NameContains'] = name_contains
        if max_results:
            params['MaxResults'] = max_results
        if next_token:
            params['NextToken'] = next_token

        response = sagemaker.list_endpoints(**params)

        endpoints = []
        for ep in response.get('Endpoints', []):
            endpoints.append({
                "endpoint_name": ep.get('EndpointName'),
                "endpoint_arn": ep.get('EndpointArn'),
                "endpoint_status": ep.get('EndpointStatus'),
                "creation_time": ep.get('CreationTime').isoformat() if ep.get('CreationTime') else None,
                "last_modified_time": ep.get('LastModifiedTime').isoformat() if ep.get('LastModifiedTime') else None
            })

        return json.dumps({
            "success": True,
            "data": {
                "endpoints": endpoints,
                "next_token": response.get('NextToken')
            },
            "metadata": {
                "region": region
            }
        })

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })
