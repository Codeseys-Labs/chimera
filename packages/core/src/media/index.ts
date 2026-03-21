/**
 * Media Processing Module
 *
 * Multi-modal media processing with AWS Transcribe, Rekognition, and Textract.
 * Auto-detects input media type and routes to appropriate service.
 *
 * @example
 * ```typescript
 * import { MediaProcessor, createMediaProcessor } from '@chimera/core';
 * import { TranscribeClient } from '@aws-sdk/client-transcribe';
 * import { RekognitionClient } from '@aws-sdk/client-rekognition';
 * import { TextractClient } from '@aws-sdk/client-textract';
 *
 * const processor = createMediaProcessor({
 *   transcribeClient: new TranscribeClient({ region: 'us-east-1' }),
 *   rekognitionClient: new RekognitionClient({ region: 'us-east-1' }),
 *   textractClient: new TextractClient({ region: 'us-east-1' }),
 *   s3Bucket: 'my-media-bucket',
 *   s3Prefix: 'media-processing',
 * });
 *
 * // Auto-detect and process
 * const result = await processor.processMedia({
 *   uri: 's3://my-bucket/video.mp4',
 * });
 *
 * if (result.type === 'transcription') {
 *   console.log('Transcript:', result.transcript);
 * }
 * ```
 *
 * @packageDocumentation
 */

export { MediaProcessor, createMediaProcessor } from './media-processor';
export type {
  MediaType,
  MediaInput,
  MediaTypeDetection,
  MediaProcessingResult,
  TranscriptionResult,
  ImageAnalysisResult,
  DocumentAnalysisResult,
  MediaProcessorConfig,
  MediaProcessingOptions,
  TranscribeOptions,
  RekognitionOptions,
  TextractOptions,
} from './types';
