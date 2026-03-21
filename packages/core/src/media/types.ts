/**
 * Media Processing Module - Types
 *
 * Multi-modal media processing with AWS Transcribe, Rekognition, and Textract.
 * Auto-detects input type (audio, video, image, document) and routes to appropriate service.
 */

import type {
  TranscribeClient,
  TranscriptionJob,
} from '@aws-sdk/client-transcribe';
import type {
  RekognitionClient,
  Label,
  TextDetection,
  FaceDetail,
} from '@aws-sdk/client-rekognition';
import type {
  TextractClient,
  DocumentMetadata,
  Block,
} from '@aws-sdk/client-textract';

/**
 * Supported media types for processing
 */
export type MediaType = 'audio' | 'video' | 'image' | 'document';

/**
 * Media input - can be S3 URI or local file path
 */
export interface MediaInput {
  /**
   * S3 URI (s3://bucket/key) or local file path
   */
  uri: string;

  /**
   * Optional MIME type (helps with detection)
   */
  mimeType?: string;

  /**
   * Optional explicit media type (skips auto-detection)
   */
  mediaType?: MediaType;
}

/**
 * Transcription result from audio/video
 */
export interface TranscriptionResult {
  type: 'transcription';
  jobName: string;
  jobStatus: string;
  transcript?: string;
  languageCode?: string;
  confidence?: number;
  metadata: {
    durationSeconds?: number;
    speakerLabels?: boolean;
  };
  raw: TranscriptionJob;
}

/**
 * Image analysis result from Rekognition
 */
export interface ImageAnalysisResult {
  type: 'image-analysis';
  labels: Label[];
  text?: TextDetection[];
  faces?: FaceDetail[];
  confidence: number;
  metadata: {
    width?: number;
    height?: number;
  };
  raw: {
    labels: any;
    text?: any;
    faces?: any;
  };
}

/**
 * Document extraction result from Textract
 */
export interface DocumentAnalysisResult {
  type: 'document-analysis';
  jobId: string;
  jobStatus: string;
  pages: number;
  blocks: Block[];
  text: string;
  metadata: DocumentMetadata;
  raw: {
    documentMetadata: DocumentMetadata;
    blocks: Block[];
  };
}

/**
 * Union type for all media processing results
 */
export type MediaProcessingResult =
  | TranscriptionResult
  | ImageAnalysisResult
  | DocumentAnalysisResult;

/**
 * AWS client configuration for media processor
 */
export interface MediaProcessorConfig {
  /**
   * AWS Transcribe client for audio/video transcription
   */
  transcribeClient: TranscribeClient;

  /**
   * AWS Rekognition client for image analysis
   */
  rekognitionClient: RekognitionClient;

  /**
   * AWS Textract client for document extraction
   */
  textractClient: TextractClient;

  /**
   * S3 bucket for temporary storage (required for Transcribe/Textract)
   */
  s3Bucket: string;

  /**
   * Optional S3 prefix for organized storage
   */
  s3Prefix?: string;

  /**
   * Optional region override
   */
  region?: string;
}

/**
 * Media type detection result
 */
export interface MediaTypeDetection {
  mediaType: MediaType;
  confidence: 'high' | 'medium' | 'low';
  mimeType?: string;
  extension?: string;
}

/**
 * Processing options for each service
 */
export interface TranscribeOptions {
  languageCode?: string;
  enableSpeakerLabels?: boolean;
  maxSpeakerLabels?: number;
}

export interface RekognitionOptions {
  maxLabels?: number;
  minConfidence?: number;
  detectText?: boolean;
  detectFaces?: boolean;
}

export interface TextractOptions {
  featureTypes?: ('TABLES' | 'FORMS' | 'SIGNATURES')[];
}

/**
 * Combined processing options
 */
export interface MediaProcessingOptions {
  transcribe?: TranscribeOptions;
  rekognition?: RekognitionOptions;
  textract?: TextractOptions;
}
