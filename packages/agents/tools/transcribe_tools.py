"""
AWS Transcribe Tools - Audio/video transcription for Chimera agents

Provides audio and video transcription operations with support for multiple
languages, speaker identification, and job management.

Operations:
- transcribe_start_job: Start transcription of audio/video from S3
- transcribe_get_job: Get transcription job status and results
- transcribe_list_jobs: List transcription jobs with filtering
- transcribe_delete_job: Delete transcription job and results
"""
import boto3
import json
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from typing import Optional, List
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def transcribe_start_job(
    job_name: str,
    media_file_uri: str,
    media_format: str,
    language_code: str,
    region: str = "us-east-1",
    output_bucket_name: Optional[str] = None,
    show_speaker_labels: bool = False,
    max_speaker_labels: Optional[int] = None,
) -> str:
    """
    Start transcription of audio or video file from S3.

    Args:
        job_name: Unique job name (alphanumeric, hyphens, underscores)
        media_file_uri: S3 URI of media file (s3://bucket/key)
        media_format: Media format (mp3, mp4, wav, flac, ogg, amr, webm)
        language_code: Language code (en-US, es-US, en-GB, fr-FR, de-DE, pt-BR, ja-JP, ko-KR, zh-CN)
        region: AWS region (default: us-east-1)
        output_bucket_name: S3 bucket for output (optional, defaults to input bucket)
        show_speaker_labels: Enable speaker identification
        max_speaker_labels: Maximum number of speakers (2-10, requires show_speaker_labels)

    Returns:
        JSON string with job details
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        transcribe = boto3.client('transcribe', region_name=region, config=_BOTO_CONFIG)

        params = {
            'TranscriptionJobName': job_name,
            'Media': {'MediaFileUri': media_file_uri},
            'MediaFormat': media_format,
            'LanguageCode': language_code
        }

        if output_bucket_name:
            params['OutputBucketName'] = output_bucket_name

        if show_speaker_labels:
            params['Settings'] = {
                'ShowSpeakerLabels': True,
                'MaxSpeakerLabels': max_speaker_labels or 2
            }

        response = transcribe.start_transcription_job(**params)

        job = response.get('TranscriptionJob', {})

        return json.dumps({
            "success": True,
            "data": {
                "job_name": job.get('TranscriptionJobName'),
                "status": job.get('TranscriptionJobStatus'),
                "language_code": job.get('LanguageCode'),
                "media_format": job.get('MediaFormat'),
                "creation_time": job.get('CreationTime').isoformat() if job.get('CreationTime') else None
            },
            "metadata": {
                "region": region
            }
        })

    except (ClientError, BotoCoreError) as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })


@tool
def transcribe_get_job(
    job_name: str,
    region: str = "us-east-1"
) -> str:
    """
    Get transcription job status and results.

    Args:
        job_name: Transcription job name
        region: AWS region (default: us-east-1)

    Returns:
        JSON string with job status and transcript URI when complete
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        transcribe = boto3.client('transcribe', region_name=region, config=_BOTO_CONFIG)

        response = transcribe.get_transcription_job(TranscriptionJobName=job_name)

        job = response.get('TranscriptionJob')
        if not job:
            raise ValueError(f"Transcription job {job_name} not found")

        return json.dumps({
            "success": True,
            "data": {
                "job_name": job.get('TranscriptionJobName'),
                "status": job.get('TranscriptionJobStatus'),
                "language_code": job.get('LanguageCode'),
                "media_format": job.get('MediaFormat'),
                "media_sample_rate_hertz": job.get('MediaSampleRateHertz'),
                "media_file_uri": job.get('Media', {}).get('MediaFileUri'),
                "transcript_file_uri": job.get('Transcript', {}).get('TranscriptFileUri'),
                "creation_time": job.get('CreationTime').isoformat() if job.get('CreationTime') else None,
                "completion_time": job.get('CompletionTime').isoformat() if job.get('CompletionTime') else None,
                "failure_reason": job.get('FailureReason')
            },
            "metadata": {
                "region": region
            }
        })

    except (ClientError, BotoCoreError) as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })


@tool
def transcribe_list_jobs(
    region: str = "us-east-1",
    status: Optional[str] = None,
    job_name_contains: Optional[str] = None,
    max_results: Optional[int] = None,
    next_token: Optional[str] = None,
) -> str:
    """
    List transcription jobs with optional filtering.

    Args:
        region: AWS region (default: us-east-1)
        status: Filter by status (QUEUED, IN_PROGRESS, FAILED, COMPLETED)
        job_name_contains: Filter jobs by name substring
        max_results: Maximum number of results (1-100)
        next_token: Pagination token from previous call

    Returns:
        JSON string with job summaries
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        transcribe = boto3.client('transcribe', region_name=region, config=_BOTO_CONFIG)

        params = {}
        if status:
            params['Status'] = status
        if job_name_contains:
            params['JobNameContains'] = job_name_contains
        if max_results:
            params['MaxResults'] = max_results
        if next_token:
            params['NextToken'] = next_token

        response = transcribe.list_transcription_jobs(**params)

        jobs = []
        for job in response.get('TranscriptionJobSummaries', []):
            jobs.append({
                "job_name": job.get('TranscriptionJobName'),
                "status": job.get('TranscriptionJobStatus'),
                "language_code": job.get('LanguageCode'),
                "output_location_type": job.get('OutputLocationType'),
                "creation_time": job.get('CreationTime').isoformat() if job.get('CreationTime') else None,
                "completion_time": job.get('CompletionTime').isoformat() if job.get('CompletionTime') else None,
                "failure_reason": job.get('FailureReason')
            })

        return json.dumps({
            "success": True,
            "data": {
                "jobs": jobs,
                "next_token": response.get('NextToken')
            },
            "metadata": {
                "region": region
            }
        })

    except (ClientError, BotoCoreError) as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })


@tool
def transcribe_delete_job(
    job_name: str,
    region: str = "us-east-1"
) -> str:
    """
    Delete transcription job and its results.

    Args:
        job_name: Transcription job name to delete
        region: AWS region (default: us-east-1)

    Returns:
        JSON string confirming deletion
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        transcribe = boto3.client('transcribe', region_name=region, config=_BOTO_CONFIG)

        transcribe.delete_transcription_job(TranscriptionJobName=job_name)

        return json.dumps({
            "success": True,
            "data": {
                "job_name": job_name,
                "deleted": True
            },
            "metadata": {
                "region": region
            }
        })

    except (ClientError, BotoCoreError) as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "error_type": type(e).__name__
        })
