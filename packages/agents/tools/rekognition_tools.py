"""
AWS Rekognition Tools - Image and video analysis for Chimera agents

Provides image analysis operations including object/scene detection, face
analysis, text extraction (OCR), content moderation, and face comparison.

Operations:
- rekognition_detect_labels: Detect objects, scenes, and activities
- rekognition_detect_faces: Detect faces with attributes
- rekognition_detect_text: OCR text extraction from images
- rekognition_detect_moderation_labels: Content moderation
- rekognition_compare_faces: Compare face similarity
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


def _build_image_input(
    image_bytes: Optional[str] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
    s3_version: Optional[str] = None
) -> Dict[str, Any]:
    """Helper to build Image parameter from base64 or S3."""
    if image_bytes:
        return {'Bytes': base64.b64decode(image_bytes)}
    elif s3_bucket and s3_key:
        s3_object = {'Bucket': s3_bucket, 'Name': s3_key}
        if s3_version:
            s3_object['Version'] = s3_version
        return {'S3Object': s3_object}
    else:
        raise ValueError('Either image_bytes or s3_bucket+s3_key must be provided')


@tool
def rekognition_detect_labels(
    region: str = "us-east-1",
    image_bytes: Optional[str] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
    s3_version: Optional[str] = None,
    max_labels: int = 1000,
    min_confidence: float = 55.0,
) -> str:
    """
    Detect objects, scenes, activities, and concepts in an image.

    Args:
        region: AWS region (default: us-east-1)
        image_bytes: Base64-encoded image bytes (JPEG or PNG)
        s3_bucket: S3 bucket containing image
        s3_key: S3 key of image
        s3_version: S3 object version (optional)
        max_labels: Maximum labels to return (1-1000)
        min_confidence: Minimum confidence threshold (0-100)

    Returns:
        JSON string with detected labels and confidence scores
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rekognition = boto3.client('rekognition', region_name=region, config=_BOTO_CONFIG)

        image = _build_image_input(image_bytes, s3_bucket, s3_key, s3_version)

        response = rekognition.detect_labels(
            Image=image,
            MaxLabels=max_labels,
            MinConfidence=min_confidence
        )

        labels = []
        for label in response.get('Labels', []):
            labels.append({
                "name": label.get('Name'),
                "confidence": label.get('Confidence'),
                "instances": [
                    {
                        "bounding_box": inst.get('BoundingBox'),
                        "confidence": inst.get('Confidence')
                    }
                    for inst in label.get('Instances', [])
                ],
                "parents": [p.get('Name') for p in label.get('Parents', [])]
            })

        return json.dumps({
            "success": True,
            "data": {
                "labels": labels,
                "label_model_version": response.get('LabelModelVersion')
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
def rekognition_detect_faces(
    region: str = "us-east-1",
    image_bytes: Optional[str] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
    s3_version: Optional[str] = None,
    attributes: List[str] = None,
) -> str:
    """
    Detect faces in an image with attributes like age, emotion, gender.

    Args:
        region: AWS region (default: us-east-1)
        image_bytes: Base64-encoded image bytes (JPEG or PNG)
        s3_bucket: S3 bucket containing image
        s3_key: S3 key of image
        s3_version: S3 object version (optional)
        attributes: Attributes to return (ALL or DEFAULT)

    Returns:
        JSON string with face details and attributes
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rekognition = boto3.client('rekognition', region_name=region, config=_BOTO_CONFIG)

        image = _build_image_input(image_bytes, s3_bucket, s3_key, s3_version)

        # Default to ALL attributes if not specified
        if attributes is None:
            attributes = ['ALL']

        response = rekognition.detect_faces(
            Image=image,
            Attributes=attributes
        )

        faces = []
        for face in response.get('FaceDetails', []):
            faces.append({
                "bounding_box": face.get('BoundingBox'),
                "confidence": face.get('Confidence'),
                "landmarks": face.get('Landmarks'),
                "pose": face.get('Pose'),
                "quality": face.get('Quality'),
                "age_range": face.get('AgeRange'),
                "smile": face.get('Smile'),
                "eyeglasses": face.get('Eyeglasses'),
                "sunglasses": face.get('Sunglasses'),
                "gender": face.get('Gender'),
                "beard": face.get('Beard'),
                "mustache": face.get('Mustache'),
                "eyes_open": face.get('EyesOpen'),
                "mouth_open": face.get('MouthOpen'),
                "emotions": face.get('Emotions', [])
            })

        return json.dumps({
            "success": True,
            "data": {
                "faces": faces,
                "face_count": len(faces)
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
def rekognition_detect_text(
    region: str = "us-east-1",
    image_bytes: Optional[str] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
    s3_version: Optional[str] = None,
) -> str:
    """
    Detect and extract text from images (OCR).

    Args:
        region: AWS region (default: us-east-1)
        image_bytes: Base64-encoded image bytes (JPEG or PNG)
        s3_bucket: S3 bucket containing image
        s3_key: S3 key of image
        s3_version: S3 object version (optional)

    Returns:
        JSON string with detected text and bounding boxes
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rekognition = boto3.client('rekognition', region_name=region, config=_BOTO_CONFIG)

        image = _build_image_input(image_bytes, s3_bucket, s3_key, s3_version)

        response = rekognition.detect_text(Image=image)

        text_detections = []
        for text in response.get('TextDetections', []):
            text_detections.append({
                "detected_text": text.get('DetectedText'),
                "type": text.get('Type'),
                "id": text.get('Id'),
                "parent_id": text.get('ParentId'),
                "confidence": text.get('Confidence'),
                "geometry": text.get('Geometry')
            })

        return json.dumps({
            "success": True,
            "data": {
                "text_detections": text_detections,
                "text_model_version": response.get('TextModelVersion')
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
def rekognition_detect_moderation_labels(
    region: str = "us-east-1",
    image_bytes: Optional[str] = None,
    s3_bucket: Optional[str] = None,
    s3_key: Optional[str] = None,
    s3_version: Optional[str] = None,
    min_confidence: float = 50.0,
) -> str:
    """
    Detect inappropriate, unwanted, or offensive content for moderation.

    Args:
        region: AWS region (default: us-east-1)
        image_bytes: Base64-encoded image bytes (JPEG or PNG)
        s3_bucket: S3 bucket containing image
        s3_key: S3 key of image
        s3_version: S3 object version (optional)
        min_confidence: Minimum confidence threshold (0-100)

    Returns:
        JSON string with moderation labels
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rekognition = boto3.client('rekognition', region_name=region, config=_BOTO_CONFIG)

        image = _build_image_input(image_bytes, s3_bucket, s3_key, s3_version)

        response = rekognition.detect_moderation_labels(
            Image=image,
            MinConfidence=min_confidence
        )

        moderation_labels = []
        for label in response.get('ModerationLabels', []):
            moderation_labels.append({
                "name": label.get('Name'),
                "confidence": label.get('Confidence'),
                "parent_name": label.get('ParentName')
            })

        return json.dumps({
            "success": True,
            "data": {
                "moderation_labels": moderation_labels,
                "moderation_model_version": response.get('ModerationModelVersion')
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
def rekognition_compare_faces(
    region: str = "us-east-1",
    source_image_bytes: Optional[str] = None,
    source_s3_bucket: Optional[str] = None,
    source_s3_key: Optional[str] = None,
    target_image_bytes: Optional[str] = None,
    target_s3_bucket: Optional[str] = None,
    target_s3_key: Optional[str] = None,
    similarity_threshold: float = 80.0,
) -> str:
    """
    Compare two faces to determine similarity.

    Args:
        region: AWS region (default: us-east-1)
        source_image_bytes: Base64-encoded source image
        source_s3_bucket: S3 bucket for source image
        source_s3_key: S3 key for source image
        target_image_bytes: Base64-encoded target image
        target_s3_bucket: S3 bucket for target image
        target_s3_key: S3 key for target image
        similarity_threshold: Minimum similarity (0-100)

    Returns:
        JSON string with face match results
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        rekognition = boto3.client('rekognition', region_name=region, config=_BOTO_CONFIG)

        source_image = _build_image_input(
            source_image_bytes, source_s3_bucket, source_s3_key
        )
        target_image = _build_image_input(
            target_image_bytes, target_s3_bucket, target_s3_key
        )

        response = rekognition.compare_faces(
            SourceImage=source_image,
            TargetImage=target_image,
            SimilarityThreshold=similarity_threshold
        )

        face_matches = []
        for match in response.get('FaceMatches', []):
            face_matches.append({
                "similarity": match.get('Similarity'),
                "face": {
                    "bounding_box": match.get('Face', {}).get('BoundingBox'),
                    "confidence": match.get('Face', {}).get('Confidence'),
                    "landmarks": match.get('Face', {}).get('Landmarks'),
                    "pose": match.get('Face', {}).get('Pose'),
                    "quality": match.get('Face', {}).get('Quality')
                }
            })

        return json.dumps({
            "success": True,
            "data": {
                "source_face": {
                    "bounding_box": response.get('SourceImageFace', {}).get('BoundingBox'),
                    "confidence": response.get('SourceImageFace', {}).get('Confidence')
                },
                "face_matches": face_matches,
                "match_count": len(face_matches),
                "unmatched_faces": response.get('UnmatchedFaces', [])
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
