/**
 * Media Processing Module - Core Implementation
 *
 * Auto-detects media type and routes to appropriate AWS service:
 * - Audio/Video → Transcribe
 * - Images → Rekognition
 * - Documents → Textract
 */

import {
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  LanguageCode,
} from '@aws-sdk/client-transcribe';
import {
  DetectLabelsCommand,
  DetectTextCommand,
  DetectFacesCommand,
} from '@aws-sdk/client-rekognition';
import {
  StartDocumentAnalysisCommand,
  GetDocumentAnalysisCommand,
  Block,
} from '@aws-sdk/client-textract';
import type {
  MediaInput,
  MediaType,
  MediaTypeDetection,
  MediaProcessingResult,
  MediaProcessorConfig,
  MediaProcessingOptions,
  TranscriptionResult,
  ImageAnalysisResult,
  DocumentAnalysisResult,
} from './types';

/**
 * MIME type to media type mapping
 */
const MIME_TYPE_MAP: Record<string, MediaType> = {
  // Audio
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/wav': 'audio',
  'audio/flac': 'audio',
  'audio/ogg': 'audio',
  'audio/webm': 'audio',
  // Video
  'video/mp4': 'video',
  'video/mpeg': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'video/x-msvideo': 'video',
  // Image
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/bmp': 'image',
  // Document
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    'document',
  'text/plain': 'document',
  'text/csv': 'document',
};

/**
 * File extension to media type mapping
 */
const EXTENSION_MAP: Record<string, MediaType> = {
  // Audio
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  // Video
  mp4: 'video',
  avi: 'video',
  mov: 'video',
  wmv: 'video',
  flv: 'video',
  webm: 'video',
  // Image
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  bmp: 'image',
  webp: 'image',
  // Document
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  txt: 'document',
  csv: 'document',
};

/**
 * MediaProcessor - Auto-routing media processing
 *
 * Detects media type and routes to appropriate AWS service.
 * Handles both S3 URIs and local file paths.
 */
export class MediaProcessor {
  constructor(private readonly config: MediaProcessorConfig) {}

  /**
   * Detect media type from input
   *
   * Priority: explicit mediaType > MIME type > file extension
   */
  detectMediaType(input: MediaInput): MediaTypeDetection {
    // 1. Explicit media type (highest confidence)
    if (input.mediaType) {
      return {
        mediaType: input.mediaType,
        confidence: 'high',
      };
    }

    // 2. MIME type detection
    if (input.mimeType && MIME_TYPE_MAP[input.mimeType]) {
      return {
        mediaType: MIME_TYPE_MAP[input.mimeType],
        confidence: 'high',
        mimeType: input.mimeType,
      };
    }

    // 3. File extension detection
    const extension = input.uri.split('.').pop()?.toLowerCase();
    if (extension && EXTENSION_MAP[extension]) {
      return {
        mediaType: EXTENSION_MAP[extension],
        confidence: 'medium',
        extension,
      };
    }

    // Default to document if unknown (Textract is most permissive)
    return {
      mediaType: 'document',
      confidence: 'low',
    };
  }

  /**
   * Process media input - auto-detects type and routes to appropriate service
   */
  async processMedia(
    input: MediaInput,
    options?: MediaProcessingOptions
  ): Promise<MediaProcessingResult> {
    const detection = this.detectMediaType(input);

    switch (detection.mediaType) {
      case 'audio':
      case 'video':
        return this.transcribeAudio(input, options?.transcribe);

      case 'image':
        return this.analyzeImage(input, options?.rekognition);

      case 'document':
        return this.extractDocument(input, options?.textract);

      default:
        throw new Error(
          `Unsupported media type: ${detection.mediaType}`
        );
    }
  }

  /**
   * Transcribe audio/video using AWS Transcribe
   *
   * Note: Transcribe requires S3 URI, not direct file upload
   */
  private async transcribeAudio(
    input: MediaInput,
    options?: { languageCode?: string; enableSpeakerLabels?: boolean; maxSpeakerLabels?: number }
  ): Promise<TranscriptionResult> {
    // Ensure S3 URI format
    const s3Uri = this.ensureS3Uri(input.uri);

    const jobName = `transcribe-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const command = new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      LanguageCode: (options?.languageCode as LanguageCode) || LanguageCode.EN_US,
      Media: {
        MediaFileUri: s3Uri,
      },
      OutputBucketName: this.config.s3Bucket,
      OutputKey: this.config.s3Prefix
        ? `${this.config.s3Prefix}/${jobName}.json`
        : `${jobName}.json`,
      Settings: options?.enableSpeakerLabels
        ? {
            ShowSpeakerLabels: true,
            MaxSpeakerLabels: options.maxSpeakerLabels || 2,
          }
        : undefined,
    });

    await this.config.transcribeClient.send(command);

    // Poll for completion (in production, use EventBridge + Step Functions)
    const job = await this.waitForTranscriptionJob(jobName);

    return {
      type: 'transcription',
      jobName,
      jobStatus: job.TranscriptionJobStatus || 'UNKNOWN',
      transcript: job.Transcript?.TranscriptFileUri
        ? await this.fetchTranscript(job.Transcript.TranscriptFileUri)
        : undefined,
      languageCode: job.LanguageCode,
      metadata: {
        durationSeconds: job.Media?.DurationInSeconds,
        speakerLabels: options?.enableSpeakerLabels,
      },
      raw: job,
    };
  }

  /**
   * Analyze image using AWS Rekognition
   *
   * Rekognition supports both S3 and direct bytes
   */
  private async analyzeImage(
    input: MediaInput,
    options?: { maxLabels?: number; minConfidence?: number; detectText?: boolean; detectFaces?: boolean }
  ): Promise<ImageAnalysisResult> {
    const s3Uri = this.parseS3Uri(input.uri);

    // Detect labels (objects, scenes, concepts)
    const labelsCommand = new DetectLabelsCommand({
      Image: {
        S3Object: {
          Bucket: s3Uri.bucket,
          Name: s3Uri.key,
        },
      },
      MaxLabels: options?.maxLabels || 10,
      MinConfidence: options?.minConfidence || 70,
    });

    const labelsResponse = await this.config.rekognitionClient.send(
      labelsCommand
    );

    let textResponse;
    let facesResponse;

    // Optionally detect text in image
    if (options?.detectText) {
      const textCommand = new DetectTextCommand({
        Image: {
          S3Object: {
            Bucket: s3Uri.bucket,
            Name: s3Uri.key,
          },
        },
      });
      textResponse = await this.config.rekognitionClient.send(textCommand);
    }

    // Optionally detect faces
    if (options?.detectFaces) {
      const facesCommand = new DetectFacesCommand({
        Image: {
          S3Object: {
            Bucket: s3Uri.bucket,
            Name: s3Uri.key,
          },
        },
        Attributes: ['ALL'],
      });
      facesResponse = await this.config.rekognitionClient.send(facesCommand);
    }

    return {
      type: 'image-analysis',
      labels: labelsResponse.Labels || [],
      text: textResponse?.TextDetections,
      faces: facesResponse?.FaceDetails,
      confidence:
        labelsResponse.Labels?.[0]?.Confidence || 0,
      metadata: {
        // ImageProperties structure varies by SDK version
        width: undefined,
        height: undefined,
      },
      raw: {
        labels: labelsResponse,
        text: textResponse,
        faces: facesResponse,
      },
    };
  }

  /**
   * Extract text and structure from document using AWS Textract
   *
   * Note: Textract requires S3 URI for multi-page documents
   */
  private async extractDocument(
    input: MediaInput,
    options?: { featureTypes?: ('TABLES' | 'FORMS' | 'SIGNATURES')[] }
  ): Promise<DocumentAnalysisResult> {
    const s3Uri = this.parseS3Uri(input.uri);

    const command = new StartDocumentAnalysisCommand({
      DocumentLocation: {
        S3Object: {
          Bucket: s3Uri.bucket,
          Name: s3Uri.key,
        },
      },
      FeatureTypes: options?.featureTypes || ['TABLES', 'FORMS'],
      OutputConfig: {
        S3Bucket: this.config.s3Bucket,
        S3Prefix: this.config.s3Prefix || 'textract-output',
      },
    });

    const startResponse = await this.config.textractClient.send(command);

    if (!startResponse.JobId) {
      throw new Error('Textract failed to return JobId');
    }

    const jobId = startResponse.JobId;

    // Poll for completion
    const result = await this.waitForDocumentAnalysis(jobId);

    // Extract text from blocks
    const textBlocks = result.Blocks?.filter((block: Block) => block.BlockType === 'LINE') || [];
    const text = textBlocks.map((block: Block) => block.Text).join('\n');

    return {
      type: 'document-analysis',
      jobId,
      jobStatus: result.JobStatus || 'UNKNOWN',
      pages: result.DocumentMetadata?.Pages || 0,
      blocks: result.Blocks || [],
      text,
      metadata: result.DocumentMetadata || {},
      raw: {
        documentMetadata: result.DocumentMetadata || {},
        blocks: result.Blocks || [],
      },
    };
  }

  /**
   * Ensure URI is S3 format (s3://bucket/key)
   *
   * If local path provided, caller must upload to S3 first
   */
  private ensureS3Uri(uri: string): string {
    if (uri.startsWith('s3://')) {
      return uri;
    }

    throw new Error(
      'AWS Transcribe requires S3 URI. Upload file to S3 first or provide s3:// URI.'
    );
  }

  /**
   * Parse S3 URI into bucket and key
   */
  private parseS3Uri(uri: string): { bucket: string; key: string } {
    if (!uri.startsWith('s3://')) {
      throw new Error(
        `Invalid S3 URI: ${uri}. Expected format: s3://bucket/key`
      );
    }

    const withoutProtocol = uri.substring(5); // Remove 's3://'
    const firstSlash = withoutProtocol.indexOf('/');

    if (firstSlash === -1) {
      throw new Error(`Invalid S3 URI: ${uri}. Missing key.`);
    }

    const bucket = withoutProtocol.substring(0, firstSlash);
    const key = withoutProtocol.substring(firstSlash + 1);

    return { bucket, key };
  }

  /**
   * Poll for transcription job completion
   *
   * In production, use EventBridge + Step Functions instead
   */
  private async waitForTranscriptionJob(
    jobName: string,
    maxAttempts = 60,
    delayMs = 5000
  ): Promise<any> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const command = new GetTranscriptionJobCommand({
        TranscriptionJobName: jobName,
      });

      const response = await this.config.transcribeClient.send(command);
      const status = response.TranscriptionJob?.TranscriptionJobStatus;

      if (status === 'COMPLETED') {
        return response.TranscriptionJob;
      }

      if (status === 'FAILED') {
        throw new Error(
          `Transcription job failed: ${response.TranscriptionJob?.FailureReason}`
        );
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(
      `Transcription job timeout after ${maxAttempts * delayMs}ms`
    );
  }

  /**
   * Poll for document analysis completion
   */
  private async waitForDocumentAnalysis(
    jobId: string,
    maxAttempts = 60,
    delayMs = 5000
  ): Promise<any> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const command = new GetDocumentAnalysisCommand({ JobId: jobId });
      const response = await this.config.textractClient.send(command);
      const status = response.JobStatus;

      if (status === 'SUCCEEDED') {
        return response;
      }

      if (status === 'FAILED') {
        throw new Error(`Document analysis failed: ${response.StatusMessage}`);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(`Document analysis timeout after ${maxAttempts * delayMs}ms`);
  }

  /**
   * Fetch transcript text from S3 URI
   *
   * In production, use S3 SDK to download
   */
  private async fetchTranscript(uri: string): Promise<string> {
    // TODO: Implement S3 download using @aws-sdk/client-s3
    // For now, return the URI as placeholder
    return `Transcript available at: ${uri}`;
  }
}

/**
 * Factory function for creating MediaProcessor
 */
export function createMediaProcessor(
  config: MediaProcessorConfig
): MediaProcessor {
  return new MediaProcessor(config);
}
