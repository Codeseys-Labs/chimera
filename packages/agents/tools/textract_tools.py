"""
AWS Textract Tools - Document text extraction and analysis for Chimera agents

Provides document analysis operations including text extraction, form/table
analysis, and asynchronous processing for large multi-page documents.

Operations:
- textract_detect_text: Synchronous text extraction (single-page documents)
- textract_analyze_document: Synchronous analysis with forms and tables
- textract_start_document_analysis: Start async analysis for large documents
- textract_get_document_analysis: Get async analysis results
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


def _build_document_input(
    document_bytes: Optional[str] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
    s3_version: Optional[str] = None
) -> Dict[str, Any]:
    """Helper to build Document parameter from base64 or S3."""
    if document_bytes:
        return {'Bytes': base64.b64decode(document_bytes)}
    elif s3_bucket and s3_key:
        s3_object = {'Bucket': s3_bucket, 'Name': s3_key}
        if s3_version:
            s3_object['Version'] = s3_version
        return {'S3Object': s3_object}
    else:
        raise ValueError('Either document_bytes or s3_bucket+s3_key must be provided')


@tool
def textract_detect_text(
    region: str = "us-east-1",
    document_bytes: Optional[str] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
    s3_version: Optional[str] = None,
) -> str:
    """
    Synchronously extract text from document images (JPEG, PNG, PDF up to 1 page).

    Args:
        region: AWS region (default: us-east-1)
        document_bytes: Base64-encoded document bytes
        s3_bucket: S3 bucket containing document
        s3_key: S3 key of document
        s3_version: S3 object version (optional)

    Returns:
        JSON string with extracted text blocks
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        textract = boto3.client('textract', region_name=region, config=_BOTO_CONFIG)

        document = _build_document_input(document_bytes, s3_bucket, s3_key, s3_version)

        response = textract.detect_document_text(Document=document)

        blocks = []
        for block in response.get('Blocks', []):
            blocks.append({
                "block_type": block.get('BlockType'),
                "id": block.get('Id'),
                "text": block.get('Text'),
                "confidence": block.get('Confidence'),
                "geometry": block.get('Geometry'),
                "page": block.get('Page'),
                "relationships": block.get('Relationships', [])
            })

        return json.dumps({
            "success": True,
            "data": {
                "blocks": blocks,
                "document_metadata": response.get('DocumentMetadata'),
                "detect_document_text_model_version": response.get('DetectDocumentTextModelVersion')
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
def textract_analyze_document(
    feature_types: List[str],
    region: str = "us-east-1",
    document_bytes: Optional[str] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
    s3_version: Optional[str] = None,
) -> str:
    """
    Synchronously analyze document with forms and tables extraction.

    Args:
        feature_types: Analysis features (TABLES, FORMS, QUERIES, SIGNATURES, LAYOUT)
        region: AWS region (default: us-east-1)
        document_bytes: Base64-encoded document bytes
        s3_bucket: S3 bucket containing document
        s3_key: S3 key of document
        s3_version: S3 object version (optional)

    Returns:
        JSON string with analyzed blocks including forms and tables
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        textract = boto3.client('textract', region_name=region, config=_BOTO_CONFIG)

        document = _build_document_input(document_bytes, s3_bucket, s3_key, s3_version)

        response = textract.analyze_document(
            Document=document,
            FeatureTypes=feature_types
        )

        blocks = []
        for block in response.get('Blocks', []):
            blocks.append({
                "block_type": block.get('BlockType'),
                "id": block.get('Id'),
                "text": block.get('Text'),
                "confidence": block.get('Confidence'),
                "geometry": block.get('Geometry'),
                "page": block.get('Page'),
                "relationships": block.get('Relationships', []),
                "entity_types": block.get('EntityTypes', []),
                "selection_status": block.get('SelectionStatus'),
                "row_index": block.get('RowIndex'),
                "column_index": block.get('ColumnIndex'),
                "row_span": block.get('RowSpan'),
                "column_span": block.get('ColumnSpan')
            })

        return json.dumps({
            "success": True,
            "data": {
                "blocks": blocks,
                "document_metadata": response.get('DocumentMetadata'),
                "analyze_document_model_version": response.get('AnalyzeDocumentModelVersion')
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
def textract_start_document_analysis(
    s3_bucket: str,
    s3_key: str,
    feature_types: List[str],
    region: str = "us-east-1",
    s3_version: Optional[str] = None,
    output_bucket: Optional[str] = None,
    output_prefix: Optional[str] = None,
    sns_topic_arn: Optional[str] = None,
) -> str:
    """
    Start asynchronous document analysis for multi-page PDFs or large documents.

    Args:
        s3_bucket: S3 bucket containing document
        s3_key: S3 key of document
        feature_types: Analysis features (TABLES, FORMS, QUERIES, SIGNATURES, LAYOUT)
        region: AWS region (default: us-east-1)
        s3_version: S3 object version (optional)
        output_bucket: S3 bucket for output (optional)
        output_prefix: S3 prefix for output (optional)
        sns_topic_arn: SNS topic for completion notification (optional)

    Returns:
        JSON string with job ID for polling
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        textract = boto3.client('textract', region_name=region, config=_BOTO_CONFIG)

        document_location = {
            'S3Object': {
                'Bucket': s3_bucket,
                'Name': s3_key
            }
        }
        if s3_version:
            document_location['S3Object']['Version'] = s3_version

        params = {
            'DocumentLocation': document_location,
            'FeatureTypes': feature_types
        }

        if output_bucket:
            params['OutputConfig'] = {
                'S3Bucket': output_bucket
            }
            if output_prefix:
                params['OutputConfig']['S3Prefix'] = output_prefix

        if sns_topic_arn:
            # Note: RoleArn is required but typically set via IAM permissions
            params['NotificationChannel'] = {
                'SNSTopicArn': sns_topic_arn,
                'RoleArn': ''  # Filled by IAM role
            }

        response = textract.start_document_analysis(**params)

        return json.dumps({
            "success": True,
            "data": {
                "job_id": response.get('JobId')
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
def textract_get_document_analysis(
    job_id: str,
    region: str = "us-east-1",
    max_results: Optional[int] = None,
    next_token: Optional[str] = None,
) -> str:
    """
    Get results of asynchronous document analysis job.

    Args:
        job_id: Job ID from start_document_analysis
        region: AWS region (default: us-east-1)
        max_results: Maximum results per page (1-1000)
        next_token: Pagination token from previous call

    Returns:
        JSON string with job status and results
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        textract = boto3.client('textract', region_name=region, config=_BOTO_CONFIG)

        params = {'JobId': job_id}
        if max_results:
            params['MaxResults'] = max_results
        if next_token:
            params['NextToken'] = next_token

        response = textract.get_document_analysis(**params)

        blocks = []
        for block in response.get('Blocks', []):
            blocks.append({
                "block_type": block.get('BlockType'),
                "id": block.get('Id'),
                "text": block.get('Text'),
                "confidence": block.get('Confidence'),
                "geometry": block.get('Geometry'),
                "page": block.get('Page'),
                "relationships": block.get('Relationships', []),
                "entity_types": block.get('EntityTypes', []),
                "selection_status": block.get('SelectionStatus'),
                "row_index": block.get('RowIndex'),
                "column_index": block.get('ColumnIndex'),
                "row_span": block.get('RowSpan'),
                "column_span": block.get('ColumnSpan')
            })

        return json.dumps({
            "success": True,
            "data": {
                "job_status": response.get('JobStatus'),
                "status_message": response.get('StatusMessage'),
                "blocks": blocks,
                "next_token": response.get('NextToken'),
                "document_metadata": response.get('DocumentMetadata'),
                "analyze_document_model_version": response.get('AnalyzeDocumentModelVersion')
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
