/**
 * MediaProcessor Tests
 *
 * Tests for multi-modal media processing with AWS services
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { MediaProcessor, createMediaProcessor } from '../media-processor';
import type { MediaProcessorConfig, MediaInput } from '../types';

// Mock AWS SDK clients
const mockTranscribeClient = {
  send: mock(() => Promise.resolve({})),
} as any;

const mockRekognitionClient = {
  send: mock(() => Promise.resolve({})),
} as any;

const mockTextractClient = {
  send: mock(() => Promise.resolve({})),
} as any;

const mockConfig: MediaProcessorConfig = {
  transcribeClient: mockTranscribeClient,
  rekognitionClient: mockRekognitionClient,
  textractClient: mockTextractClient,
  s3Bucket: 'test-bucket',
  s3Prefix: 'media-test',
  region: 'us-east-1',
};

describe('MediaProcessor', () => {
  let processor: MediaProcessor;

  beforeEach(() => {
    processor = createMediaProcessor(mockConfig);
    mockTranscribeClient.send.mockReset();
    mockRekognitionClient.send.mockReset();
    mockTextractClient.send.mockReset();
  });

  describe('detectMediaType', () => {
    it('should use explicit mediaType if provided', () => {
      const input: MediaInput = {
        uri: 's3://bucket/file.unknown',
        mediaType: 'audio',
      };

      const result = processor.detectMediaType(input);

      expect(result.mediaType).toBe('audio');
      expect(result.confidence).toBe('high');
    });

    it('should detect from MIME type', () => {
      const input: MediaInput = {
        uri: 's3://bucket/file',
        mimeType: 'video/mp4',
      };

      const result = processor.detectMediaType(input);

      expect(result.mediaType).toBe('video');
      expect(result.confidence).toBe('high');
      expect(result.mimeType).toBe('video/mp4');
    });

    it('should detect from file extension', () => {
      const input: MediaInput = {
        uri: 's3://bucket/photo.jpg',
      };

      const result = processor.detectMediaType(input);

      expect(result.mediaType).toBe('image');
      expect(result.confidence).toBe('medium');
      expect(result.extension).toBe('jpg');
    });

    it('should default to document for unknown types', () => {
      const input: MediaInput = {
        uri: 's3://bucket/file.unknown',
      };

      const result = processor.detectMediaType(input);

      expect(result.mediaType).toBe('document');
      expect(result.confidence).toBe('low');
    });

    describe('audio detection', () => {
      it.each([
        ['audio.mp3', 'audio'],
        ['audio.wav', 'audio'],
        ['audio.flac', 'audio'],
        ['audio.ogg', 'audio'],
      ])('should detect %s as audio', (uri, expected) => {
        const result = processor.detectMediaType({ uri: `s3://bucket/${uri}` });
        expect(result.mediaType).toBe(expected);
      });
    });

    describe('video detection', () => {
      it.each([
        ['video.mp4', 'video'],
        ['video.avi', 'video'],
        ['video.mov', 'video'],
        ['video.webm', 'video'],
      ])('should detect %s as video', (uri, expected) => {
        const result = processor.detectMediaType({ uri: `s3://bucket/${uri}` });
        expect(result.mediaType).toBe(expected);
      });
    });

    describe('image detection', () => {
      it.each([
        ['photo.jpg', 'image'],
        ['photo.png', 'image'],
        ['photo.gif', 'image'],
        ['photo.webp', 'image'],
      ])('should detect %s as image', (uri, expected) => {
        const result = processor.detectMediaType({ uri: `s3://bucket/${uri}` });
        expect(result.mediaType).toBe(expected);
      });
    });

    describe('document detection', () => {
      it.each([
        ['doc.pdf', 'document'],
        ['doc.docx', 'document'],
        ['doc.txt', 'document'],
        ['data.csv', 'document'],
      ])('should detect %s as document', (uri, expected) => {
        const result = processor.detectMediaType({ uri: `s3://bucket/${uri}` });
        expect(result.mediaType).toBe(expected);
      });
    });
  });

  describe('processMedia', () => {
    it('should route audio to Transcribe', async () => {
      const input: MediaInput = {
        uri: 's3://bucket/audio.mp3',
      };

      // Mock Transcribe responses
      mockTranscribeClient.send
        .mockResolvedValueOnce({}) // StartTranscriptionJob
        .mockResolvedValueOnce({
          // GetTranscriptionJob
          TranscriptionJob: {
            TranscriptionJobStatus: 'COMPLETED',
            TranscriptionJobName: 'test-job',
            LanguageCode: 'en-US',
            Transcript: {
              TranscriptFileUri: 's3://bucket/transcript.json',
            },
            Media: {
              DurationInSeconds: 120,
            },
          },
        });

      const result = await processor.processMedia(input);

      expect(result.type).toBe('transcription');
      expect(mockTranscribeClient.send).toHaveBeenCalledTimes(2);
    });

    it('should route images to Rekognition', async () => {
      const input: MediaInput = {
        uri: 's3://bucket/photo.jpg',
      };

      // Mock Rekognition response
      mockRekognitionClient.send.mockResolvedValueOnce({
        Labels: [
          { Name: 'Person', Confidence: 99.5 },
          { Name: 'Outdoors', Confidence: 95.2 },
        ],
        ImageProperties: {
          Width: 1920,
          Height: 1080,
        },
      });

      const result = await processor.processMedia(input);

      expect(result.type).toBe('image-analysis');
      if (result.type === 'image-analysis') {
        expect(result.labels).toHaveLength(2);
        expect(result.labels[0].Name).toBe('Person');
        expect(result.confidence).toBe(99.5);
      }
      expect(mockRekognitionClient.send).toHaveBeenCalledTimes(1);
    });

    it('should route documents to Textract', async () => {
      const input: MediaInput = {
        uri: 's3://bucket/document.pdf',
      };

      // Mock Textract responses
      mockTextractClient.send
        .mockResolvedValueOnce({
          // StartDocumentAnalysis
          JobId: 'job-123',
        })
        .mockResolvedValueOnce({
          // GetDocumentAnalysis
          JobStatus: 'SUCCEEDED',
          DocumentMetadata: {
            Pages: 5,
          },
          Blocks: [
            { BlockType: 'LINE', Text: 'First line' },
            { BlockType: 'LINE', Text: 'Second line' },
          ],
        });

      const result = await processor.processMedia(input);

      expect(result.type).toBe('document-analysis');
      if (result.type === 'document-analysis') {
        expect(result.pages).toBe(5);
        expect(result.text).toContain('First line');
        expect(result.text).toContain('Second line');
      }
      expect(mockTextractClient.send).toHaveBeenCalledTimes(2);
    });

    it('should pass options to Rekognition', async () => {
      const input: MediaInput = {
        uri: 's3://bucket/photo.jpg',
      };

      mockRekognitionClient.send
        .mockResolvedValueOnce({
          Labels: [],
        })
        .mockResolvedValueOnce({
          TextDetections: [{ DetectedText: 'Hello' }],
        })
        .mockResolvedValueOnce({
          FaceDetails: [{ Confidence: 99 }],
        });

      await processor.processMedia(input, {
        rekognition: {
          maxLabels: 20,
          minConfidence: 80,
          detectText: true,
          detectFaces: true,
        },
      });

      // Should call DetectLabels, DetectText, DetectFaces
      expect(mockRekognitionClient.send).toHaveBeenCalledTimes(3);
    });
  });

  describe('S3 URI handling', () => {
    it('should parse valid S3 URIs', async () => {
      const input: MediaInput = {
        uri: 's3://test-bucket/path/to/image.jpg',
      };

      mockRekognitionClient.send.mockResolvedValueOnce({
        Labels: [],
      });

      await processor.processMedia(input);

      // Verify S3Object was constructed correctly
      const callArgs = mockRekognitionClient.send.mock.calls[0][0];
      expect(callArgs.input.Image.S3Object.Bucket).toBe('test-bucket');
      expect(callArgs.input.Image.S3Object.Name).toBe('path/to/image.jpg');
    });

    it('should reject non-S3 URIs for Transcribe', async () => {
      const input: MediaInput = {
        uri: '/local/path/audio.mp3',
      };

      await expect(processor.processMedia(input)).rejects.toThrow(
        'AWS Transcribe requires S3 URI'
      );
    });

    it('should reject invalid S3 URIs', async () => {
      const input: MediaInput = {
        uri: 's3://bucket-without-key',
      };

      mockRekognitionClient.send.mockResolvedValueOnce({
        Labels: [],
      });

      await expect(processor.processMedia(input)).rejects.toThrow(
        'Invalid S3 URI'
      );
    });
  });

  describe('error handling', () => {
    it('should handle Transcribe job failure', async () => {
      const input: MediaInput = {
        uri: 's3://bucket/audio.mp3',
      };

      mockTranscribeClient.send
        .mockResolvedValueOnce({}) // Start job
        .mockResolvedValueOnce({
          // Job failed
          TranscriptionJob: {
            TranscriptionJobStatus: 'FAILED',
            FailureReason: 'Invalid audio format',
          },
        });

      await expect(processor.processMedia(input)).rejects.toThrow(
        'Transcription job failed: Invalid audio format'
      );
    });

    it('should handle Textract job failure', async () => {
      const input: MediaInput = {
        uri: 's3://bucket/doc.pdf',
      };

      mockTextractClient.send
        .mockResolvedValueOnce({ JobId: 'job-123' }) // Start job
        .mockResolvedValueOnce({
          // Job failed
          JobStatus: 'FAILED',
          StatusMessage: 'Document corrupted',
        });

      await expect(processor.processMedia(input)).rejects.toThrow(
        'Document analysis failed: Document corrupted'
      );
    });
  });

  describe('createMediaProcessor', () => {
    it('should create MediaProcessor instance', () => {
      const processor = createMediaProcessor(mockConfig);
      expect(processor).toBeInstanceOf(MediaProcessor);
    });
  });
});
