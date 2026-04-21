"""
Lambda Tools - AWS Lambda operations for Chimera agent

Provides serverless function management operations with tenant-scoped access control.
All operations respect IAM policies enforced at the tenant level.
"""
import boto3
import json
import base64
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from typing import Optional, Dict, Any, List
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def list_lambda_functions(region: str = "us-east-1") -> str:
    """
    List all Lambda functions in the specified region.

    Args:
        region: AWS region to query (default: us-east-1)

    Returns:
        A formatted string listing all Lambda functions with their details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        lambda_client = boto3.client('lambda', region_name=region, config=_BOTO_CONFIG)
        response = lambda_client.list_functions()

        functions = response.get('Functions', [])
        if not functions:
            return f"No Lambda functions found in region {region}."

        result = f"Found {len(functions)} Lambda function(s) in {region}:\n\n"

        for func in functions:
            name = func['FunctionName']
            runtime = func.get('Runtime', 'N/A')
            memory = func.get('MemorySize', 'N/A')
            timeout = func.get('Timeout', 'N/A')
            last_modified = func.get('LastModified', 'N/A')

            result += f"• {name}\n"
            result += f"  Runtime: {runtime}\n"
            result += f"  Memory: {memory} MB\n"
            result += f"  Timeout: {timeout} seconds\n"
            result += f"  Last Modified: {last_modified}\n\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error listing Lambda functions in {region}: {str(e)}"


@tool
def get_lambda_function(function_name: str, region: str = "us-east-1") -> str:
    """
    Get detailed configuration and metadata for a Lambda function.

    Args:
        function_name: The name or ARN of the Lambda function
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with detailed function configuration.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        lambda_client = boto3.client('lambda', region_name=region, config=_BOTO_CONFIG)
        response = lambda_client.get_function(FunctionName=function_name)

        config = response.get('Configuration', {})
        code = response.get('Code', {})
        tags = response.get('Tags', {})

        # Extract configuration details
        function_arn = config.get('FunctionArn', 'N/A')
        runtime = config.get('Runtime', 'N/A')
        handler = config.get('Handler', 'N/A')
        code_size = config.get('CodeSize', 0)
        memory_size = config.get('MemorySize', 'N/A')
        timeout = config.get('Timeout', 'N/A')
        role = config.get('Role', 'N/A')
        last_modified = config.get('LastModified', 'N/A')
        state = config.get('State', 'N/A')

        # Environment variables
        env_vars = config.get('Environment', {}).get('Variables', {})
        env_str = '\n    '.join([f"{k}: {v}" for k, v in env_vars.items()]) if env_vars else 'None'

        # Layers
        layers = config.get('Layers', [])
        layers_str = '\n    '.join([layer['Arn'] for layer in layers]) if layers else 'None'

        # Format code size
        if code_size < 1024:
            size_str = f"{code_size} bytes"
        elif code_size < 1024 * 1024:
            size_str = f"{code_size / 1024:.2f} KB"
        else:
            size_str = f"{code_size / (1024 * 1024):.2f} MB"

        result = f"""Function: {function_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARN: {function_arn}
Runtime: {runtime}
Handler: {handler}
State: {state}

Configuration:
  Memory: {memory_size} MB
  Timeout: {timeout} seconds
  Code Size: {size_str}
  Role: {role}

Environment Variables:
    {env_str}

Layers:
    {layers_str}

Code Location:
  Repository Type: {code.get('RepositoryType', 'N/A')}
  Location: {code.get('Location', 'N/A')[:80]}...

Last Modified: {last_modified}

Tags: {', '.join([f'{k}={v}' for k, v in tags.items()]) if tags else 'None'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error getting function details for {function_name}: {str(e)}"


@tool
def invoke_lambda_function(
    function_name: str,
    payload: str,
    invocation_type: str = "RequestResponse",
    region: str = "us-east-1"
) -> str:
    """
    Invoke a Lambda function with the specified payload.

    Args:
        function_name: The name or ARN of the Lambda function
        payload: JSON string payload to pass to the function
        invocation_type: Invocation type - RequestResponse (sync), Event (async), or DryRun (default: RequestResponse)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with invocation results including response payload.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        lambda_client = boto3.client('lambda', region_name=region, config=_BOTO_CONFIG)

        # Validate invocation type
        if invocation_type not in ['RequestResponse', 'Event', 'DryRun']:
            return f"Error: Invalid invocation_type '{invocation_type}'. Must be 'RequestResponse', 'Event', or 'DryRun'."

        response = lambda_client.invoke(
            FunctionName=function_name,
            InvocationType=invocation_type,
            Payload=payload.encode('utf-8')
        )

        status_code = response.get('StatusCode', 'N/A')
        executed_version = response.get('ExecutedVersion', 'N/A')

        result = f"""Lambda Invocation Result:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Function: {function_name}
Invocation Type: {invocation_type}
Status Code: {status_code}
Executed Version: {executed_version}
"""

        # Parse response payload for synchronous invocations
        if invocation_type == 'RequestResponse' and 'Payload' in response:
            payload_bytes = response['Payload'].read()
            try:
                payload_data = json.loads(payload_bytes.decode('utf-8'))
                result += f"\nResponse Payload:\n{json.dumps(payload_data, indent=2)}\n"
            except (json.JSONDecodeError, UnicodeDecodeError):
                result += f"\nResponse Payload (raw):\n{payload_bytes.decode('utf-8', errors='replace')}\n"

        # Include function error if present
        if 'FunctionError' in response:
            result += f"\n⚠️  Function Error: {response['FunctionError']}\n"

        # Include log result if available
        if 'LogResult' in response:
            log_data = base64.b64decode(response['LogResult']).decode('utf-8')
            result += f"\nExecution Logs (last 4KB):\n{log_data}\n"

        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error invoking Lambda function {function_name}: {str(e)}"


@tool
def create_lambda_function(
    function_name: str,
    runtime: str,
    handler: str,
    role: str,
    zip_file_base64: Optional[str] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
    timeout: int = 3,
    memory_size: int = 128,
    environment_variables: Optional[Dict[str, str]] = None,
    region: str = "us-east-1"
) -> str:
    """
    Create a new Lambda function from a ZIP file or S3 artifact.

    Args:
        function_name: Unique name for the function
        runtime: Runtime identifier (e.g., python3.12, nodejs20.x)
        handler: Handler function (e.g., index.handler, lambda_function.lambda_handler)
        role: IAM role ARN with Lambda execution permissions
        zip_file_base64: Base64-encoded ZIP file content (mutually exclusive with s3_bucket/s3_key)
        s3_bucket: S3 bucket containing deployment package (requires s3_key)
        s3_key: S3 key of deployment package (requires s3_bucket)
        timeout: Function timeout in seconds (default: 3)
        memory_size: Memory allocation in MB (default: 128)
        environment_variables: Dictionary of environment variables
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with the created function details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        lambda_client = boto3.client('lambda', region_name=region, config=_BOTO_CONFIG)

        # Build code configuration
        code = {}
        if zip_file_base64:
            code['ZipFile'] = base64.b64decode(zip_file_base64)
        elif s3_bucket and s3_key:
            code['S3Bucket'] = s3_bucket
            code['S3Key'] = s3_key
        else:
            return "Error: Must provide either zip_file_base64 or both s3_bucket and s3_key"

        # Build function configuration
        function_config = {
            'FunctionName': function_name,
            'Runtime': runtime,
            'Role': role,
            'Handler': handler,
            'Code': code,
            'Timeout': timeout,
            'MemorySize': memory_size
        }

        # Add environment variables if provided
        if environment_variables:
            function_config['Environment'] = {'Variables': environment_variables}

        response = lambda_client.create_function(**function_config)

        function_arn = response.get('FunctionArn', 'N/A')
        version = response.get('Version', 'N/A')
        code_size = response.get('CodeSize', 0)
        state = response.get('State', 'N/A')

        size_str = f"{code_size / (1024 * 1024):.2f} MB" if code_size >= 1024 * 1024 else f"{code_size / 1024:.2f} KB"

        result = f"""Lambda Function Created:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Function Name: {function_name}
ARN: {function_arn}
Runtime: {runtime}
Version: {version}
State: {state}
Code Size: {size_str}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error creating Lambda function {function_name}: {str(e)}"


@tool
def update_lambda_function_code(
    function_name: str,
    zip_file_base64: Optional[str] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    Update Lambda function code from a ZIP file or S3 artifact.

    Args:
        function_name: The name or ARN of the Lambda function
        zip_file_base64: Base64-encoded ZIP file content (mutually exclusive with s3_bucket/s3_key)
        s3_bucket: S3 bucket containing deployment package (requires s3_key)
        s3_key: S3 key of deployment package (requires s3_bucket)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with the update status.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        lambda_client = boto3.client('lambda', region_name=region, config=_BOTO_CONFIG)

        # Build update configuration
        update_config = {'FunctionName': function_name}

        if zip_file_base64:
            update_config['ZipFile'] = base64.b64decode(zip_file_base64)
        elif s3_bucket and s3_key:
            update_config['S3Bucket'] = s3_bucket
            update_config['S3Key'] = s3_key
        else:
            return "Error: Must provide either zip_file_base64 or both s3_bucket and s3_key"

        response = lambda_client.update_function_code(**update_config)

        last_modified = response.get('LastModified', 'N/A')
        code_size = response.get('CodeSize', 0)
        size_str = f"{code_size / (1024 * 1024):.2f} MB" if code_size >= 1024 * 1024 else f"{code_size / 1024:.2f} KB"

        result = f"""Lambda Function Code Updated:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Function: {function_name}
New Code Size: {size_str}
Last Modified: {last_modified}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error updating Lambda function code for {function_name}: {str(e)}"


@tool
def update_lambda_function_config(
    function_name: str,
    runtime: Optional[str] = None,
    timeout: Optional[int] = None,
    memory_size: Optional[int] = None,
    handler: Optional[str] = None,
    environment_variables: Optional[Dict[str, str]] = None,
    region: str = "us-east-1"
) -> str:
    """
    Update Lambda function configuration (runtime, timeout, memory, environment variables).

    Args:
        function_name: The name or ARN of the Lambda function
        runtime: Runtime identifier (e.g., python3.12, nodejs20.x)
        timeout: Function timeout in seconds
        memory_size: Memory allocation in MB
        handler: Handler function (e.g., index.handler)
        environment_variables: Dictionary of environment variables
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with the update status.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        lambda_client = boto3.client('lambda', region_name=region, config=_BOTO_CONFIG)

        # Build update configuration
        update_config = {'FunctionName': function_name}

        if runtime is not None:
            update_config['Runtime'] = runtime
        if timeout is not None:
            update_config['Timeout'] = timeout
        if memory_size is not None:
            update_config['MemorySize'] = memory_size
        if handler is not None:
            update_config['Handler'] = handler
        if environment_variables is not None:
            update_config['Environment'] = {'Variables': environment_variables}

        if len(update_config) == 1:  # Only FunctionName
            return "Error: Must provide at least one configuration parameter to update"

        response = lambda_client.update_function_configuration(**update_config)

        last_modified = response.get('LastModified', 'N/A')
        updated_fields = [k for k in update_config.keys() if k != 'FunctionName']

        result = f"""Lambda Function Configuration Updated:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Function: {function_name}
Updated Fields: {', '.join(updated_fields)}
Last Modified: {last_modified}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error updating Lambda function configuration for {function_name}: {str(e)}"


@tool
def delete_lambda_function(function_name: str, region: str = "us-east-1") -> str:
    """
    Delete a Lambda function permanently.

    Args:
        function_name: The name or ARN of the Lambda function to delete
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string confirming deletion.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        lambda_client = boto3.client('lambda', region_name=region, config=_BOTO_CONFIG)
        lambda_client.delete_function(FunctionName=function_name)

        return f"Successfully deleted Lambda function: {function_name}"

    except (ClientError, BotoCoreError) as e:
        return f"Error deleting Lambda function {function_name}: {str(e)}"
