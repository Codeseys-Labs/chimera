"""
AWS Bedrock Tools - Foundation model inference for Chimera agents

Provides Bedrock operations for model invocation, listing models, and
inference profile management. All operations support multi-region deployment.

Operations:
- bedrock_invoke_model: Synchronous model invocation
- bedrock_invoke_model_stream: Streaming model invocation
- bedrock_list_foundation_models: List available foundation models
- bedrock_get_foundation_model: Get specific model details
- bedrock_list_inference_profiles: List cross-region inference profiles
"""
import boto3
import json
import base64
from botocore.config import Config
from typing import Optional, Dict, Any, List
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def bedrock_invoke_model(
    model_id: str,
    prompt: str,
    region: str = "us-east-1",
    max_tokens: int = 1000,
    temperature: float = 0.7,
) -> str:
    """
    Invoke a Bedrock foundation model synchronously.

    Args:
        model_id: Model ID (e.g., anthropic.claude-3-sonnet-20240229-v1:0)
        prompt: Input prompt for the model
        region: AWS region (default: us-east-1)
        max_tokens: Maximum tokens to generate
        temperature: Temperature for sampling (0.0-1.0)

    Returns:
        JSON string with model response
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        bedrock_runtime = boto3.client('bedrock-runtime', region_name=region, config=_BOTO_CONFIG)

        # Use Converse API format (unified across models)
        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": prompt}]
                }
            ]
        }

        response = bedrock_runtime.invoke_model(
            modelId=model_id,
            body=json.dumps(request_body),
            accept='application/json',
            contentType='application/json'
        )

        response_body = json.loads(response['body'].read())

        return json.dumps({
            "success": True,
            "data": {
                "response": response_body,
                "model_id": model_id
            },
            "metadata": {
                "region": region,
                "request_id": response['ResponseMetadata'].get('RequestId')
            }
        })

    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })


@tool
def bedrock_invoke_model_stream(
    model_id: str,
    prompt: str,
    region: str = "us-east-1",
    max_tokens: int = 1000,
    temperature: float = 0.7,
) -> str:
    """
    Invoke a Bedrock foundation model with streaming response.

    Args:
        model_id: Model ID (e.g., anthropic.claude-3-sonnet-20240229-v1:0)
        prompt: Input prompt for the model
        region: AWS region (default: us-east-1)
        max_tokens: Maximum tokens to generate
        temperature: Temperature for sampling (0.0-1.0)

    Returns:
        JSON string with accumulated streaming chunks
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        bedrock_runtime = boto3.client('bedrock-runtime', region_name=region, config=_BOTO_CONFIG)

        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "text", "text": prompt}]
                }
            ]
        }

        response = bedrock_runtime.invoke_model_with_response_stream(
            modelId=model_id,
            body=json.dumps(request_body),
            accept='application/json',
            contentType='application/json'
        )

        # Accumulate streaming chunks
        chunks = []
        for event in response['body']:
            if 'chunk' in event:
                chunk_data = json.loads(event['chunk']['bytes'].decode('utf-8'))
                chunks.append(chunk_data)

        return json.dumps({
            "success": True,
            "data": {
                "chunks": chunks,
                "chunk_count": len(chunks),
                "model_id": model_id
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
def bedrock_list_foundation_models(
    region: str = "us-east-1",
    by_provider: Optional[str] = None,
    by_output_modality: Optional[str] = None,
    by_inference_type: Optional[str] = None,
) -> str:
    """
    List available Bedrock foundation models with optional filtering.

    Args:
        region: AWS region (default: us-east-1)
        by_provider: Filter by provider (e.g., Anthropic, Amazon, AI21, Cohere)
        by_output_modality: Filter by output modality (TEXT, IMAGE, EMBEDDING)
        by_inference_type: Filter by inference type (ON_DEMAND, PROVISIONED)

    Returns:
        JSON string with list of available models
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        bedrock = boto3.client('bedrock', region_name=region, config=_BOTO_CONFIG)

        params = {}
        if by_provider:
            params['byProvider'] = by_provider
        if by_output_modality:
            params['byOutputModality'] = by_output_modality
        if by_inference_type:
            params['byInferenceType'] = by_inference_type

        response = bedrock.list_foundation_models(**params)

        models = []
        for model in response.get('modelSummaries', []):
            models.append({
                "model_id": model.get('modelId'),
                "model_name": model.get('modelName'),
                "provider_name": model.get('providerName'),
                "input_modalities": model.get('inputModalities', []),
                "output_modalities": model.get('outputModalities', []),
                "response_streaming_supported": model.get('responseStreamingSupported', False),
                "customizations_supported": model.get('customizationsSupported', []),
                "inference_types_supported": model.get('inferenceTypesSupported', [])
            })

        return json.dumps({
            "success": True,
            "data": {
                "models": models,
                "count": len(models)
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
def bedrock_get_foundation_model(
    model_id: str,
    region: str = "us-east-1"
) -> str:
    """
    Get detailed information about a specific Bedrock foundation model.

    Args:
        model_id: Model ID or ARN
        region: AWS region (default: us-east-1)

    Returns:
        JSON string with model details
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        bedrock = boto3.client('bedrock', region_name=region, config=_BOTO_CONFIG)

        response = bedrock.get_foundation_model(modelIdentifier=model_id)

        model_details = response.get('modelDetails', {})

        return json.dumps({
            "success": True,
            "data": {
                "model_id": model_details.get('modelId'),
                "model_name": model_details.get('modelName'),
                "provider_name": model_details.get('providerName'),
                "input_modalities": model_details.get('inputModalities', []),
                "output_modalities": model_details.get('outputModalities', []),
                "response_streaming_supported": model_details.get('responseStreamingSupported', False),
                "customizations_supported": model_details.get('customizationsSupported', []),
                "inference_types_supported": model_details.get('inferenceTypesSupported', []),
                "model_lifecycle": model_details.get('modelLifecycle', {})
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
def bedrock_list_inference_profiles(
    region: str = "us-east-1",
    max_results: int = 100,
    next_token: Optional[str] = None
) -> str:
    """
    List Bedrock cross-region inference profiles for high availability.

    Args:
        region: AWS region (default: us-east-1)
        max_results: Maximum number of results (1-1000)
        next_token: Pagination token for next page

    Returns:
        JSON string with inference profiles
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        bedrock = boto3.client('bedrock', region_name=region, config=_BOTO_CONFIG)

        params = {'maxResults': max_results}
        if next_token:
            params['nextToken'] = next_token

        response = bedrock.list_inference_profiles(**params)

        profiles = []
        for profile in response.get('inferenceProfileSummaries', []):
            profiles.append({
                "inference_profile_id": profile.get('inferenceProfileId'),
                "inference_profile_name": profile.get('inferenceProfileName'),
                "description": profile.get('description'),
                "status": profile.get('status'),
                "type": profile.get('type'),
                "models": profile.get('models', [])
            })

        return json.dumps({
            "success": True,
            "data": {
                "profiles": profiles,
                "next_token": response.get('nextToken')
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
