"""
CodeCommit Tools - AWS CodeCommit operations for Chimera agent

Provides Git repository operations through CodeCommit for agent self-evolution.
All operations respect IAM policies enforced at the tenant level.
"""
import boto3
import os
import subprocess
from botocore.config import Config
from typing import Optional
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def list_codecommit_repos(region: str = "us-east-1") -> str:
    """
    List all CodeCommit repositories in the specified region.

    Args:
        region: AWS region to query (default: us-east-1)

    Returns:
        A formatted string listing all CodeCommit repositories with their details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codecommit_client = boto3.client('codecommit', region_name=region, config=_BOTO_CONFIG)
        response = codecommit_client.list_repositories()

        repos = response.get('repositories', [])
        if not repos:
            return f"No CodeCommit repositories found in region {region}."

        result = f"Found {len(repos)} CodeCommit repository(ies) in {region}:\n\n"

        for repo in repos:
            repo_name = repo['repositoryName']
            repo_id = repo['repositoryId']
            result += f"• {repo_name} (ID: {repo_id})\n"

        return result

    except Exception as e:
        return f"Error listing CodeCommit repositories in {region}: {str(e)}"


@tool
def get_repo_info(repo_name: str, region: str = "us-east-1") -> str:
    """
    Get detailed information about a specific CodeCommit repository.

    Args:
        repo_name: The name of the CodeCommit repository
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with repository metadata and branch information.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codecommit_client = boto3.client('codecommit', region_name=region, config=_BOTO_CONFIG)

        # Get repository metadata
        repo_response = codecommit_client.get_repository(repositoryName=repo_name)
        repo_metadata = repo_response['repositoryMetadata']

        # Get branch list
        branches_response = codecommit_client.list_branches(repositoryName=repo_name)
        branches = branches_response.get('branches', [])

        # Get default branch
        default_branch = repo_metadata.get('defaultBranch', 'N/A')

        # Format creation date
        created = repo_metadata['creationDate'].strftime('%Y-%m-%d %H:%M:%S')
        last_modified = repo_metadata.get('lastModifiedDate')
        last_modified_str = last_modified.strftime('%Y-%m-%d %H:%M:%S') if last_modified else 'N/A'

        result = f"""Repository: {repo_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Repository ID: {repo_metadata['repositoryId']}
ARN: {repo_metadata['Arn']}
Clone URL (HTTPS): {repo_metadata['cloneUrlHttp']}
Clone URL (SSH): {repo_metadata['cloneUrlSsh']}

Default Branch: {default_branch}
Branch Count: {len(branches)}
Branches: {', '.join(branches) if branches else 'None'}

Created: {created}
Last Modified: {last_modified_str}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except Exception as e:
        return f"Error getting repository info for {repo_name}: {str(e)}"


@tool
def git_clone_repo(
    repo_name: str,
    target_dir: str,
    branch: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    Clone a CodeCommit repository to a local directory.

    Args:
        repo_name: The name of the CodeCommit repository
        target_dir: Local directory path to clone into
        branch: Specific branch to clone (default: repository's default branch)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with clone operation status.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codecommit_client = boto3.client('codecommit', region_name=region, config=_BOTO_CONFIG)

        # Get repository info
        repo_response = codecommit_client.get_repository(repositoryName=repo_name)
        clone_url = repo_response['repositoryMetadata']['cloneUrlHttp']

        # Build git clone command
        cmd = ['git', 'clone']
        if branch:
            cmd.extend(['--branch', branch])
        cmd.extend([clone_url, target_dir])

        # Execute git clone
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300  # 5 minute timeout
        )

        if result.returncode == 0:
            branch_info = f" (branch: {branch})" if branch else ""
            return f"Successfully cloned {repo_name}{branch_info} to {target_dir}"
        else:
            return f"Error cloning repository: {result.stderr}"

    except subprocess.TimeoutExpired:
        return f"Error: Clone operation timed out after 5 minutes"
    except Exception as e:
        return f"Error cloning repository {repo_name}: {str(e)}"


@tool
def git_commit_push(
    repo_path: str,
    commit_message: str,
    files: Optional[list[str]] = None,
    branch: Optional[str] = None
) -> str:
    """
    Commit changes and push to CodeCommit repository.

    Args:
        repo_path: Local path to the git repository
        commit_message: Commit message describing the changes
        files: List of specific files to commit (default: all modified files)
        branch: Branch to push to (default: current branch)

    Returns:
        A formatted string with commit and push operation status.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        # Change to repo directory
        original_dir = os.getcwd()
        os.chdir(repo_path)

        try:
            # Stage files
            if files:
                for file in files:
                    result = subprocess.run(
                        ['git', 'add', file],
                        capture_output=True,
                        text=True
                    )
                    if result.returncode != 0:
                        return f"Error staging file {file}: {result.stderr}"
            else:
                # Stage all changes
                result = subprocess.run(
                    ['git', 'add', '-A'],
                    capture_output=True,
                    text=True
                )
                if result.returncode != 0:
                    return f"Error staging files: {result.stderr}"

            # Commit changes
            result = subprocess.run(
                ['git', 'commit', '-m', commit_message],
                capture_output=True,
                text=True
            )
            if result.returncode != 0:
                # Check if there are no changes to commit
                if "nothing to commit" in result.stdout:
                    return "No changes to commit"
                return f"Error committing changes: {result.stderr}"

            # Get current branch if not specified
            if not branch:
                result = subprocess.run(
                    ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
                    capture_output=True,
                    text=True
                )
                if result.returncode == 0:
                    branch = result.stdout.strip()
                else:
                    return f"Error getting current branch: {result.stderr}"

            # Push to remote
            result = subprocess.run(
                ['git', 'push', 'origin', branch],
                capture_output=True,
                text=True,
                timeout=60  # 1 minute timeout for push
            )

            if result.returncode == 0:
                return f"Successfully committed and pushed changes to branch '{branch}'\nCommit: {commit_message}"
            else:
                return f"Error pushing to remote: {result.stderr}"

        finally:
            # Always restore original directory
            os.chdir(original_dir)

    except subprocess.TimeoutExpired:
        os.chdir(original_dir)
        return "Error: Push operation timed out after 1 minute"
    except Exception as e:
        if original_dir:
            os.chdir(original_dir)
        return f"Error committing and pushing changes: {str(e)}"


@tool
def get_commit_history(
    repo_name: str,
    branch: str = "main",
    max_count: int = 10,
    region: str = "us-east-1"
) -> str:
    """
    Get recent commit history for a CodeCommit repository branch.

    Args:
        repo_name: The name of the CodeCommit repository
        branch: Branch name to query (default: main)
        max_count: Maximum number of commits to retrieve (default: 10)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with commit history details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        codecommit_client = boto3.client('codecommit', region_name=region, config=_BOTO_CONFIG)

        # Get branch info
        branch_response = codecommit_client.get_branch(
            repositoryName=repo_name,
            branchName=branch
        )
        commit_id = branch_response['branch']['commitId']

        # Get commit history
        commits_response = codecommit_client.get_differences(
            repositoryName=repo_name,
            afterCommitSpecifier=commit_id
        )

        # Use batch_get_commits for detailed commit info
        commits = codecommit_client.batch_get_commits(
            repositoryName=repo_name,
            commitIds=[commit_id]
        )

        if not commits.get('commits'):
            return f"No commits found for branch {branch} in repository {repo_name}"

        result = f"Recent commits on branch '{branch}' in {repo_name}:\n\n"

        for commit in commits['commits'][:max_count]:
            commit_id_short = commit['commitId'][:8]
            author = commit.get('author', {}).get('name', 'Unknown')
            date = commit.get('author', {}).get('date', '')
            if date:
                date = date.strftime('%Y-%m-%d %H:%M:%S')
            message = commit.get('message', 'No message').strip()

            result += f"• {commit_id_short} - {message}\n"
            result += f"  Author: {author}\n"
            result += f"  Date: {date}\n\n"

        return result

    except Exception as e:
        return f"Error getting commit history for {repo_name}: {str(e)}"
