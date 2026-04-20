"""
CodePipeline Tools - AWS CodePipeline operations for Chimera agent

Provides CI/CD pipeline management for agent self-evolution workflows.
All operations respect IAM policies enforced at the tenant level.
"""
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from typing import Optional
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def list_pipelines(region: str = "us-east-1") -> str:
    """
    List all CodePipeline pipelines in the specified region.

    Args:
        region: AWS region to query (default: us-east-1)

    Returns:
        A formatted string listing all pipelines with their status.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codepipeline_client = boto3.client('codepipeline', region_name=region, config=_BOTO_CONFIG)
        response = codepipeline_client.list_pipelines()

        pipelines = response.get('pipelines', [])
        if not pipelines:
            return f"No CodePipeline pipelines found in region {region}."

        result = f"Found {len(pipelines)} pipeline(s) in {region}:\n\n"

        for pipeline in pipelines:
            name = pipeline['name']
            created = pipeline['created'].strftime('%Y-%m-%d %H:%M:%S')
            updated = pipeline['updated'].strftime('%Y-%m-%d %H:%M:%S')

            result += f"• {name}\n"
            result += f"  Created: {created}\n"
            result += f"  Updated: {updated}\n\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error listing pipelines in {region}: {str(e)}"


@tool
def get_pipeline_details(pipeline_name: str, region: str = "us-east-1") -> str:
    """
    Get detailed information about a specific CodePipeline.

    Args:
        pipeline_name: The name of the pipeline
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with pipeline configuration and stage details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codepipeline_client = boto3.client('codepipeline', region_name=region, config=_BOTO_CONFIG)

        # Get pipeline structure
        pipeline_response = codepipeline_client.get_pipeline(name=pipeline_name)
        pipeline = pipeline_response['pipeline']

        result = f"""Pipeline: {pipeline_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARN: {pipeline['metadata']['pipelineArn']}
Role ARN: {pipeline['roleArn']}
Created: {pipeline['metadata']['created'].strftime('%Y-%m-%d %H:%M:%S')}
Updated: {pipeline['metadata']['updated'].strftime('%Y-%m-%d %H:%M:%S')}

Stages ({len(pipeline['stages'])}):
"""

        for idx, stage in enumerate(pipeline['stages'], 1):
            stage_name = stage['name']
            actions = stage['actions']
            result += f"\n{idx}. {stage_name} ({len(actions)} action(s))\n"

            for action in actions:
                action_name = action['name']
                action_type = action['actionTypeId']['provider']
                result += f"   • {action_name} ({action_type})\n"

        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error getting pipeline details for {pipeline_name}: {str(e)}"


@tool
def check_pipeline_status(pipeline_name: str, region: str = "us-east-1") -> str:
    """
    Check the current execution status of a CodePipeline.

    Args:
        pipeline_name: The name of the pipeline
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with the latest pipeline execution status and stage details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codepipeline_client = boto3.client('codepipeline', region_name=region, config=_BOTO_CONFIG)

        # Get pipeline state
        state_response = codepipeline_client.get_pipeline_state(name=pipeline_name)

        pipeline_name = state_response['pipelineName']
        stages = state_response['stageStates']

        result = f"Pipeline Status: {pipeline_name}\n"
        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"

        if not stages:
            return result + "No execution history found."

        # Get latest execution info
        latest_execution = state_response.get('created')
        if latest_execution:
            result += f"Latest Execution Started: {latest_execution.strftime('%Y-%m-%d %H:%M:%S')}\n\n"

        # Display stage status
        result += "Stage Status:\n\n"

        for stage in stages:
            stage_name = stage['stageName']
            latest_execution = stage.get('latestExecution', {})

            if latest_execution:
                status = latest_execution.get('status', 'Unknown')
                result += f"• {stage_name}: {status}\n"
            else:
                result += f"• {stage_name}: Not executed\n"

            # Show action states if available
            action_states = stage.get('actionStates', [])
            for action_state in action_states:
                action_name = action_state['actionName']
                latest_exec = action_state.get('latestExecution', {})
                if latest_exec:
                    action_status = latest_exec.get('status', 'Unknown')
                    result += f"  └─ {action_name}: {action_status}\n"

            result += "\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error checking pipeline status for {pipeline_name}: {str(e)}"


@tool
def trigger_pipeline(pipeline_name: str, region: str = "us-east-1") -> str:
    """
    Manually trigger a pipeline execution.

    Args:
        pipeline_name: The name of the pipeline to trigger
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with the execution ID and status.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codepipeline_client = boto3.client('codepipeline', region_name=region, config=_BOTO_CONFIG)

        # Start pipeline execution
        response = codepipeline_client.start_pipeline_execution(name=pipeline_name)

        execution_id = response['pipelineExecutionId']

        result = f"""Pipeline execution started successfully!

Pipeline: {pipeline_name}
Execution ID: {execution_id}

Use check_pipeline_status('{pipeline_name}') to monitor progress."""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error triggering pipeline {pipeline_name}: {str(e)}"


@tool
def get_pipeline_execution_details(
    pipeline_name: str,
    execution_id: str,
    region: str = "us-east-1"
) -> str:
    """
    Get detailed information about a specific pipeline execution.

    Args:
        pipeline_name: The name of the pipeline
        execution_id: The pipeline execution ID
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with execution details including stage and action results.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codepipeline_client = boto3.client('codepipeline', region_name=region, config=_BOTO_CONFIG)

        # Get execution details
        response = codepipeline_client.get_pipeline_execution(
            pipelineName=pipeline_name,
            pipelineExecutionId=execution_id
        )

        execution = response['pipelineExecution']

        status = execution['status']
        start_time = execution.get('startTime', 'N/A')
        if start_time != 'N/A':
            start_time = start_time.strftime('%Y-%m-%d %H:%M:%S')

        result = f"""Pipeline Execution Details
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pipeline: {pipeline_name}
Execution ID: {execution_id}
Status: {status}
Start Time: {start_time}
"""

        # Add artifact revisions
        artifact_revisions = execution.get('artifactRevisions', [])
        if artifact_revisions:
            result += "\nArtifact Revisions:\n"
            for artifact in artifact_revisions:
                name = artifact.get('name', 'Unknown')
                revision_id = artifact.get('revisionId', 'N/A')
                revision_url = artifact.get('revisionUrl', 'N/A')
                result += f"  • {name}: {revision_id}\n"
                if revision_url != 'N/A':
                    result += f"    URL: {revision_url}\n"

        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error getting execution details for {pipeline_name}/{execution_id}: {str(e)}"


@tool
def create_pipeline(
    pipeline_name: str,
    role_arn: str,
    source_repo: str,
    source_branch: str,
    build_project: str,
    region: str = "us-east-1"
) -> str:
    """
    Create a new CodePipeline with source and build stages.

    Args:
        pipeline_name: Name for the new pipeline
        role_arn: IAM role ARN for the pipeline
        source_repo: CodeCommit repository name
        source_branch: Branch to monitor
        build_project: CodeBuild project name
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with pipeline creation status.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codepipeline_client = boto3.client('codepipeline', region_name=region, config=_BOTO_CONFIG)

        # Define pipeline structure
        pipeline_structure = {
            'name': pipeline_name,
            'roleArn': role_arn,
            'artifactStore': {
                'type': 'S3',
                'location': f'{pipeline_name}-artifacts'  # S3 bucket must exist
            },
            'stages': [
                {
                    'name': 'Source',
                    'actions': [
                        {
                            'name': 'SourceAction',
                            'actionTypeId': {
                                'category': 'Source',
                                'owner': 'AWS',
                                'provider': 'CodeCommit',
                                'version': '1'
                            },
                            'configuration': {
                                'RepositoryName': source_repo,
                                'BranchName': source_branch,
                                'PollForSourceChanges': 'false'
                            },
                            'outputArtifacts': [
                                {
                                    'name': 'SourceOutput'
                                }
                            ]
                        }
                    ]
                },
                {
                    'name': 'Build',
                    'actions': [
                        {
                            'name': 'BuildAction',
                            'actionTypeId': {
                                'category': 'Build',
                                'owner': 'AWS',
                                'provider': 'CodeBuild',
                                'version': '1'
                            },
                            'configuration': {
                                'ProjectName': build_project
                            },
                            'inputArtifacts': [
                                {
                                    'name': 'SourceOutput'
                                }
                            ],
                            'outputArtifacts': [
                                {
                                    'name': 'BuildOutput'
                                }
                            ]
                        }
                    ]
                }
            ]
        }

        # Create pipeline
        response = codepipeline_client.create_pipeline(pipeline=pipeline_structure)

        created_pipeline = response['pipeline']

        result = f"""Pipeline created successfully!

Pipeline Name: {pipeline_name}
Source: {source_repo} (branch: {source_branch})
Build Project: {build_project}

Use trigger_pipeline('{pipeline_name}') to start the first execution."""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error creating pipeline {pipeline_name}: {str(e)}"


@tool
def delete_pipeline(pipeline_name: str, region: str = "us-east-1") -> str:
    """
    Delete a CodePipeline.

    Args:
        pipeline_name: The name of the pipeline to delete
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string confirming deletion.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codepipeline_client = boto3.client('codepipeline', region_name=region, config=_BOTO_CONFIG)

        # Delete pipeline
        codepipeline_client.delete_pipeline(name=pipeline_name)

        return f"Pipeline '{pipeline_name}' deleted successfully."

    except (ClientError, BotoCoreError) as e:
        return f"Error deleting pipeline {pipeline_name}: {str(e)}"
