"""
CodeBuild Tools - AWS CodeBuild operations for Chimera agent

Provides CI/CD build management operations with tenant-scoped access control.
All operations respect IAM policies enforced at the tenant level.
"""
import boto3
from typing import Optional, Dict, Any, List
from strands.tools import tool


@tool
def create_codebuild_project(
    project_name: str,
    service_role: str,
    source_type: str,
    environment_type: str,
    image: str,
    compute_type: str,
    source_location: Optional[str] = None,
    buildspec: Optional[str] = None,
    artifacts_type: str = "NO_ARTIFACTS",
    region: str = "us-east-1"
) -> str:
    """
    Create a CodeBuild project with source, environment, and buildspec configuration.

    Args:
        project_name: Unique project name
        service_role: IAM role ARN with CodeBuild permissions
        source_type: Source provider type (CODECOMMIT, GITHUB, S3, NO_SOURCE)
        environment_type: Build environment type (LINUX_CONTAINER, ARM_CONTAINER, etc.)
        image: Docker image for build environment (e.g., aws/codebuild/standard:7.0)
        compute_type: Compute size (BUILD_GENERAL1_SMALL, BUILD_GENERAL1_MEDIUM, etc.)
        source_location: Source repository location (optional, required for most source types)
        buildspec: Inline buildspec YAML or path to buildspec.yml in repo (optional)
        artifacts_type: Artifact output type - NO_ARTIFACTS, S3, or CODEPIPELINE (default: NO_ARTIFACTS)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with the created project details.
    """
    try:
        codebuild_client = boto3.client('codebuild', region_name=region)

        # Validate source type
        valid_source_types = ['CODECOMMIT', 'GITHUB', 'S3', 'NO_SOURCE']
        if source_type not in valid_source_types:
            return f"Error: Invalid source_type '{source_type}'. Must be one of: {', '.join(valid_source_types)}"

        # Build source configuration
        source_config = {'type': source_type}
        if source_location:
            source_config['location'] = source_location
        if buildspec:
            source_config['buildspec'] = buildspec

        # Build environment configuration
        environment_config = {
            'type': environment_type,
            'image': image,
            'computeType': compute_type
        }

        # Build artifacts configuration
        artifacts_config = {'type': artifacts_type}

        response = codebuild_client.create_project(
            name=project_name,
            source=source_config,
            artifacts=artifacts_config,
            environment=environment_config,
            serviceRole=service_role
        )

        project = response.get('project', {})
        project_arn = project.get('arn', 'N/A')
        created = project.get('created', 'N/A')
        if created != 'N/A':
            created = created.strftime('%Y-%m-%d %H:%M:%S')

        result = f"""CodeBuild Project Created:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Project Name: {project_name}
ARN: {project_arn}
Source Type: {source_type}
Environment: {environment_type} / {image}
Compute Type: {compute_type}
Created: {created}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except Exception as e:
        return f"Error creating CodeBuild project {project_name}: {str(e)}"


@tool
def start_codebuild_build(
    project_name: str,
    source_version: Optional[str] = None,
    buildspec_override: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    Trigger build execution for a CodeBuild project.

    Args:
        project_name: CodeBuild project name
        source_version: Source version (commit SHA, branch, tag) - optional
        buildspec_override: Override buildspec for this build - optional
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with the build execution details.
    """
    try:
        codebuild_client = boto3.client('codebuild', region_name=region)

        # Build start configuration
        start_config = {'projectName': project_name}
        if source_version:
            start_config['sourceVersion'] = source_version
        if buildspec_override:
            start_config['buildspecOverride'] = buildspec_override

        response = codebuild_client.start_build(**start_config)

        build = response.get('build', {})
        build_id = build.get('id', 'N/A')
        build_number = build.get('buildNumber', 'N/A')
        build_status = build.get('buildStatus', 'N/A')
        start_time = build.get('startTime', 'N/A')
        if start_time != 'N/A':
            start_time = start_time.strftime('%Y-%m-%d %H:%M:%S')

        result = f"""CodeBuild Build Started:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Project: {project_name}
Build ID: {build_id}
Build Number: {build_number}
Status: {build_status}
Start Time: {start_time}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except Exception as e:
        return f"Error starting CodeBuild build for {project_name}: {str(e)}"


@tool
def get_codebuild_build_details(build_ids: List[str], region: str = "us-east-1") -> str:
    """
    Get details for one or more builds (status, logs, artifacts, duration).

    Args:
        build_ids: List of build IDs to retrieve (up to 100)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with build details.
    """
    try:
        codebuild_client = boto3.client('codebuild', region_name=region)

        if not build_ids:
            return "Error: Must provide at least one build ID"

        response = codebuild_client.batch_get_builds(ids=build_ids)

        builds = response.get('builds', [])
        builds_not_found = response.get('buildsNotFound', [])

        if not builds:
            return f"No builds found for the provided IDs. Builds not found: {', '.join(builds_not_found)}"

        result = f"Found {len(builds)} build(s):\n\n"

        for build in builds:
            build_id = build.get('id', 'N/A')
            build_number = build.get('buildNumber', 'N/A')
            build_status = build.get('buildStatus', 'N/A')
            source_version = build.get('sourceVersion', 'N/A')

            start_time = build.get('startTime', 'N/A')
            end_time = build.get('endTime', 'N/A')
            if start_time != 'N/A':
                start_time = start_time.strftime('%Y-%m-%d %H:%M:%S')
            if end_time != 'N/A':
                end_time = end_time.strftime('%Y-%m-%d %H:%M:%S')

            # Logs information
            logs = build.get('logs', {})
            log_group = logs.get('groupName', 'N/A')
            log_stream = logs.get('streamName', 'N/A')
            log_url = logs.get('deepLink', 'N/A')

            # Artifacts
            artifacts = build.get('artifacts', {})
            artifacts_location = artifacts.get('location', 'N/A')

            # Phases
            phases = build.get('phases', [])
            phases_summary = []
            for phase in phases:
                phase_type = phase.get('phaseType', 'N/A')
                phase_status = phase.get('phaseStatus', 'N/A')
                duration = phase.get('durationInSeconds', 0)
                phases_summary.append(f"    {phase_type}: {phase_status} ({duration}s)")

            result += f"""━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Build #{build_number} (ID: {build_id})
Status: {build_status}
Source Version: {source_version}
Start Time: {start_time}
End Time: {end_time}

Logs:
  Group: {log_group}
  Stream: {log_stream}
  URL: {log_url}

Artifacts:
  Location: {artifacts_location}

Build Phases:
{chr(10).join(phases_summary) if phases_summary else '    No phase information available'}

"""

        if builds_not_found:
            result += f"\n⚠️  Builds not found: {', '.join(builds_not_found)}"

        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        return result

    except Exception as e:
        return f"Error getting build details: {str(e)}"


@tool
def list_codebuild_builds_for_project(
    project_name: str,
    sort_order: str = "DESCENDING",
    region: str = "us-east-1"
) -> str:
    """
    List build IDs for a CodeBuild project (sorted by start time).

    Args:
        project_name: CodeBuild project name
        sort_order: Sort order - ASCENDING or DESCENDING (default: DESCENDING)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string listing build IDs.
    """
    try:
        codebuild_client = boto3.client('codebuild', region_name=region)

        # Validate sort order
        if sort_order not in ['ASCENDING', 'DESCENDING']:
            return f"Error: Invalid sort_order '{sort_order}'. Must be 'ASCENDING' or 'DESCENDING'."

        response = codebuild_client.list_builds_for_project(
            projectName=project_name,
            sortOrder=sort_order
        )

        build_ids = response.get('ids', [])

        if not build_ids:
            return f"No builds found for project {project_name}."

        result = f"Found {len(build_ids)} build(s) for project {project_name}:\n\n"

        for i, build_id in enumerate(build_ids[:20], 1):  # Show first 20
            result += f"{i}. {build_id}\n"

        if len(build_ids) > 20:
            result += f"\n... and {len(build_ids) - 20} more builds (showing first 20)"

        return result

    except Exception as e:
        return f"Error listing builds for project {project_name}: {str(e)}"


@tool
def stop_codebuild_build(build_id: str, region: str = "us-east-1") -> str:
    """
    Cancel running CodeBuild execution.

    Args:
        build_id: Build ID to stop
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string confirming the stop operation.
    """
    try:
        codebuild_client = boto3.client('codebuild', region_name=region)
        response = codebuild_client.stop_build(id=build_id)

        build = response.get('build', {})
        build_status = build.get('buildStatus', 'N/A')

        result = f"""CodeBuild Build Stopped:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Build ID: {build_id}
Status: {build_status}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except Exception as e:
        return f"Error stopping CodeBuild build {build_id}: {str(e)}"


@tool
def delete_codebuild_project(project_name: str, region: str = "us-east-1") -> str:
    """
    Delete a CodeBuild project (builds are retained).

    Args:
        project_name: Project name to delete
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string confirming deletion.
    """
    try:
        codebuild_client = boto3.client('codebuild', region_name=region)
        codebuild_client.delete_project(name=project_name)

        return f"Successfully deleted CodeBuild project: {project_name}"

    except Exception as e:
        return f"Error deleting CodeBuild project {project_name}: {str(e)}"
