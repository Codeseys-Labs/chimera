/**
 * AWS Rekognition Tool - Image and video analysis for agents (Strands format)
 *
 * Operations:
 * - rekognition_detect_labels: Detect objects, scenes, activities, and concepts
 * - rekognition_detect_faces: Detect faces with attributes (age, emotion, etc.)
 * - rekognition_detect_text: Detect and extract text from images (OCR)
 * - rekognition_detect_moderation_labels: Content moderation (explicit, suggestive, violence)
 * - rekognition_compare_faces: Compare two faces for similarity
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  RekognitionClient,
  DetectLabelsCommand,
  DetectFacesCommand,
  DetectTextCommand,
  DetectModerationLabelsCommand,
  CompareFacesCommand,
  type Image,
  type Attribute,
} from '@aws-sdk/client-rekognition';
import type { AWSClientFactory } from './client-factory';
import { retryWithBackoff, formatToolError, REKOGNITION_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Helper to build Image input from base64 or S3
 */
function buildImageInput(
  imageBytes?: string,
  s3Bucket?: string,
  s3Key?: string,
  s3Version?: string
): Image {
  if (imageBytes) {
    return {
      Bytes: Buffer.from(imageBytes, 'base64'),
    };
  } else if (s3Bucket && s3Key) {
    return {
      S3Object: {
        Bucket: s3Bucket,
        Name: s3Key,
        Version: s3Version,
      },
    };
  }
  throw new Error('Either imageBytes or s3Bucket+s3Key must be provided');
}

/**
 * Create Rekognition Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of Rekognition tools for Strands Agent
 */
export function createRekognitionTools(clientFactory: AWSClientFactory) {
  const detectLabels = tool({
    name: 'rekognition_detect_labels',
    description: 'Detect objects, scenes, activities, and concepts in an image with confidence scores',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      imageBytes: z.string().optional().describe('Base64-encoded image bytes (JPEG or PNG)'),
      s3Bucket: z.string().optional().describe('S3 bucket containing image'),
      s3Key: z.string().optional().describe('S3 key of image'),
      s3Version: z.string().optional().describe('S3 object version'),
      maxLabels: z.number().optional().describe('Maximum labels to return (1-1000, default: 1000)'),
      minConfidence: z.number().optional().describe('Minimum confidence threshold (0-100, default: 55)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rekognition = await clientFactory.getRekognitionClient(context);

        const image = buildImageInput(input.imageBytes, input.s3Bucket, input.s3Key, input.s3Version);

        const command = new DetectLabelsCommand({
          Image: image,
          MaxLabels: input.maxLabels ?? 1000,
          MinConfidence: input.minConfidence ?? 55,
        });

        const response = await retryWithBackoff(() => rekognition.send(command), REKOGNITION_RETRYABLE_ERRORS);

        const labels = (response.Labels ?? []).map((label) => ({
          name: label.Name,
          confidence: label.Confidence,
          instances: (label.Instances ?? []).map((inst) => ({
            boundingBox: inst.BoundingBox,
            confidence: inst.Confidence,
          })),
          parents: (label.Parents ?? []).map((p) => p.Name),
        }));

        return JSON.stringify({
          success: true,
          data: {
            labels,
            labelModelVersion: response.LabelModelVersion,
          },
          metadata: {
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const detectFaces = tool({
    name: 'rekognition_detect_faces',
    description: 'Detect faces in an image with attributes like age range, emotion, gender, and facial features',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      imageBytes: z.string().optional().describe('Base64-encoded image bytes (JPEG or PNG)'),
      s3Bucket: z.string().optional().describe('S3 bucket containing image'),
      s3Key: z.string().optional().describe('S3 key of image'),
      s3Version: z.string().optional().describe('S3 object version'),
      attributes: z.array(z.enum(['ALL', 'DEFAULT'])).optional().describe('Attributes to return (ALL includes age, emotion, etc.)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rekognition = await clientFactory.getRekognitionClient(context);

        const image = buildImageInput(input.imageBytes, input.s3Bucket, input.s3Key, input.s3Version);

        const command = new DetectFacesCommand({
          Image: image,
          Attributes: (input.attributes ?? ['ALL']) as Attribute[],
        });

        const response = await retryWithBackoff(() => rekognition.send(command), REKOGNITION_RETRYABLE_ERRORS);

        const faces = (response.FaceDetails ?? []).map((face) => ({
          boundingBox: face.BoundingBox,
          confidence: face.Confidence,
          landmarks: face.Landmarks,
          pose: face.Pose,
          quality: face.Quality,
          ageRange: face.AgeRange,
          smile: face.Smile,
          eyeglasses: face.Eyeglasses,
          sunglasses: face.Sunglasses,
          gender: face.Gender,
          beard: face.Beard,
          mustache: face.Mustache,
          eyesOpen: face.EyesOpen,
          mouthOpen: face.MouthOpen,
          emotions: face.Emotions,
        }));

        return JSON.stringify({
          success: true,
          data: {
            faces,
            faceCount: faces.length,
          },
          metadata: {
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const detectText = tool({
    name: 'rekognition_detect_text',
    description: 'Detect and extract text from images (OCR) with bounding box coordinates',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      imageBytes: z.string().optional().describe('Base64-encoded image bytes (JPEG or PNG)'),
      s3Bucket: z.string().optional().describe('S3 bucket containing image'),
      s3Key: z.string().optional().describe('S3 key of image'),
      s3Version: z.string().optional().describe('S3 object version'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rekognition = await clientFactory.getRekognitionClient(context);

        const image = buildImageInput(input.imageBytes, input.s3Bucket, input.s3Key, input.s3Version);

        const command = new DetectTextCommand({
          Image: image,
        });

        const response = await retryWithBackoff(() => rekognition.send(command), REKOGNITION_RETRYABLE_ERRORS);

        const textDetections = (response.TextDetections ?? []).map((text) => ({
          detectedText: text.DetectedText,
          type: text.Type,
          id: text.Id,
          parentId: text.ParentId,
          confidence: text.Confidence,
          geometry: text.Geometry,
        }));

        return JSON.stringify({
          success: true,
          data: {
            textDetections,
            textModelVersion: response.TextModelVersion,
          },
          metadata: {
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const detectModerationLabels = tool({
    name: 'rekognition_detect_moderation_labels',
    description: 'Detect inappropriate, unwanted, or offensive content in images for content moderation',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      imageBytes: z.string().optional().describe('Base64-encoded image bytes (JPEG or PNG)'),
      s3Bucket: z.string().optional().describe('S3 bucket containing image'),
      s3Key: z.string().optional().describe('S3 key of image'),
      s3Version: z.string().optional().describe('S3 object version'),
      minConfidence: z.number().optional().describe('Minimum confidence threshold (0-100, default: 50)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rekognition = await clientFactory.getRekognitionClient(context);

        const image = buildImageInput(input.imageBytes, input.s3Bucket, input.s3Key, input.s3Version);

        const command = new DetectModerationLabelsCommand({
          Image: image,
          MinConfidence: input.minConfidence ?? 50,
        });

        const response = await retryWithBackoff(() => rekognition.send(command), REKOGNITION_RETRYABLE_ERRORS);

        const moderationLabels = (response.ModerationLabels ?? []).map((label) => ({
          name: label.Name,
          confidence: label.Confidence,
          parentName: label.ParentName,
        }));

        return JSON.stringify({
          success: true,
          data: {
            moderationLabels,
            moderationModelVersion: response.ModerationModelVersion,
          },
          metadata: {
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  const compareFaces = tool({
    name: 'rekognition_compare_faces',
    description: 'Compare two faces to determine similarity, returns confidence score and matched face details',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      sourceImageBytes: z.string().optional().describe('Base64-encoded source image bytes'),
      sourceS3Bucket: z.string().optional().describe('S3 bucket containing source image'),
      sourceS3Key: z.string().optional().describe('S3 key of source image'),
      targetImageBytes: z.string().optional().describe('Base64-encoded target image bytes'),
      targetS3Bucket: z.string().optional().describe('S3 bucket containing target image'),
      targetS3Key: z.string().optional().describe('S3 key of target image'),
      similarityThreshold: z.number().optional().describe('Minimum similarity threshold (0-100, default: 80)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const rekognition = await clientFactory.getRekognitionClient(context);

        const sourceImage = buildImageInput(input.sourceImageBytes, input.sourceS3Bucket, input.sourceS3Key);
        const targetImage = buildImageInput(input.targetImageBytes, input.targetS3Bucket, input.targetS3Key);

        const command = new CompareFacesCommand({
          SourceImage: sourceImage,
          TargetImage: targetImage,
          SimilarityThreshold: input.similarityThreshold ?? 80,
        });

        const response = await retryWithBackoff(() => rekognition.send(command), REKOGNITION_RETRYABLE_ERRORS);

        const faceMatches = (response.FaceMatches ?? []).map((match) => ({
          similarity: match.Similarity,
          face: {
            boundingBox: match.Face?.BoundingBox,
            confidence: match.Face?.Confidence,
            landmarks: match.Face?.Landmarks,
            pose: match.Face?.Pose,
            quality: match.Face?.Quality,
          },
        }));

        return JSON.stringify({
          success: true,
          data: {
            sourceFace: {
              boundingBox: response.SourceImageFace?.BoundingBox,
              confidence: response.SourceImageFace?.Confidence,
            },
            faceMatches,
            matchCount: faceMatches.length,
            unmatchedFaces: response.UnmatchedFaces,
          },
          metadata: {
            region: input.region ?? 'us-east-1',
            durationMs: Date.now() - startTime,
          },
        });
      } catch (error: any) {
        return formatToolError(error, input.region ?? 'us-east-1', startTime);
      }
    },
  });

  return [
    detectLabels,
    detectFaces,
    detectText,
    detectModerationLabels,
    compareFaces,
  ];
}
