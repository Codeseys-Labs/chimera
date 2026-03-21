/**
 * AWS Transcribe Tool - Audio/video transcription for agents (Strands format)
 *
 * Operations:
 * - transcribe_start_job: Start transcription of audio/video file from S3
 * - transcribe_get_job: Get transcription job status and results
 * - transcribe_list_jobs: List transcription jobs with pagination
 * - transcribe_delete_job: Delete transcription job and results
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
  ListTranscriptionJobsCommand,
  DeleteTranscriptionJobCommand,
  type TranscriptionJob,
  type LanguageCode,
  type MediaFormat,
} from '@aws-sdk/client-transcribe';
import type { AWSClientFactory } from './client-factory';
import { retryWithBackoff, formatToolError, TRANSCRIBE_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Create Transcribe Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of Transcribe tools for Strands Agent
 */
export function createTranscribeTools(clientFactory: AWSClientFactory) {
  const startTranscriptionJob = tool({
    name: 'transcribe_start_job',
    description: 'Start transcription of audio or video file from S3, supports multiple languages and formats',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      jobName: z.string().describe('Unique job name (alphanumeric, hyphens, underscores)'),
      mediaFileUri: z.string().describe('S3 URI of media file (s3://bucket/key)'),
      mediaFormat: z.enum(['mp3', 'mp4', 'wav', 'flac', 'ogg', 'amr', 'webm']).describe('Media file format'),
      languageCode: z.enum(['en-US', 'es-US', 'en-GB', 'fr-FR', 'de-DE', 'pt-BR', 'ja-JP', 'ko-KR', 'zh-CN']).describe('Language code'),
      outputBucketName: z.string().optional().describe('S3 bucket for output (default: same as input)'),
      showSpeakerLabels: z.boolean().optional().describe('Enable speaker identification (default: false)'),
      maxSpeakerLabels: z.number().optional().describe('Maximum number of speakers (2-10, requires showSpeakerLabels)'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const transcribe = await clientFactory.getTranscribeClient(context);

        const command = new StartTranscriptionJobCommand({
          TranscriptionJobName: input.jobName,
          Media: {
            MediaFileUri: input.mediaFileUri,
          },
          MediaFormat: input.mediaFormat as MediaFormat,
          LanguageCode: input.languageCode as LanguageCode,
          OutputBucketName: input.outputBucketName,
          Settings: input.showSpeakerLabels
            ? {
                ShowSpeakerLabels: true,
                MaxSpeakerLabels: input.maxSpeakerLabels ?? 2,
              }
            : undefined,
        });

        const response = await retryWithBackoff(() => transcribe.send(command), TRANSCRIBE_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            jobName: response.TranscriptionJob?.TranscriptionJobName,
            status: response.TranscriptionJob?.TranscriptionJobStatus,
            languageCode: response.TranscriptionJob?.LanguageCode,
            mediaFormat: response.TranscriptionJob?.MediaFormat,
            creationTime: response.TranscriptionJob?.CreationTime?.toISOString(),
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

  const getTranscriptionJob = tool({
    name: 'transcribe_get_job',
    description: 'Get transcription job status and results, including transcript URI when complete',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      jobName: z.string().describe('Transcription job name'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const transcribe = await clientFactory.getTranscribeClient(context);

        const command = new GetTranscriptionJobCommand({
          TranscriptionJobName: input.jobName,
        });

        const response = await retryWithBackoff(() => transcribe.send(command), TRANSCRIBE_RETRYABLE_ERRORS);

        const job = response.TranscriptionJob;
        if (!job) {
          throw new Error(`Transcription job ${input.jobName} not found`);
        }

        return JSON.stringify({
          success: true,
          data: {
            jobName: job.TranscriptionJobName,
            status: job.TranscriptionJobStatus,
            languageCode: job.LanguageCode,
            mediaFormat: job.MediaFormat,
            mediaSampleRateHertz: job.MediaSampleRateHertz,
            mediaFileUri: job.Media?.MediaFileUri,
            transcriptFileUri: job.Transcript?.TranscriptFileUri,
            creationTime: job.CreationTime?.toISOString(),
            completionTime: job.CompletionTime?.toISOString(),
            failureReason: job.FailureReason,
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

  const listTranscriptionJobs = tool({
    name: 'transcribe_list_jobs',
    description: 'List transcription jobs with optional status filter and pagination',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      status: z.enum(['QUEUED', 'IN_PROGRESS', 'FAILED', 'COMPLETED']).optional().describe('Filter by job status'),
      jobNameContains: z.string().optional().describe('Filter jobs by name substring'),
      maxResults: z.number().optional().describe('Maximum number of results (1-100)'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const transcribe = await clientFactory.getTranscribeClient(context);

        const command = new ListTranscriptionJobsCommand({
          Status: input.status,
          JobNameContains: input.jobNameContains,
          MaxResults: input.maxResults,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => transcribe.send(command), TRANSCRIBE_RETRYABLE_ERRORS);

        const jobs = (response.TranscriptionJobSummaries ?? []).map((job) => ({
          jobName: job.TranscriptionJobName,
          status: job.TranscriptionJobStatus,
          languageCode: job.LanguageCode,
          outputLocationType: job.OutputLocationType,
          creationTime: job.CreationTime?.toISOString(),
          completionTime: job.CompletionTime?.toISOString(),
          failureReason: job.FailureReason,
        }));

        return JSON.stringify({
          success: true,
          data: {
            jobs,
            nextToken: response.NextToken,
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

  const deleteTranscriptionJob = tool({
    name: 'transcribe_delete_job',
    description: 'Delete transcription job and its results',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      jobName: z.string().describe('Transcription job name to delete'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const transcribe = await clientFactory.getTranscribeClient(context);

        const command = new DeleteTranscriptionJobCommand({
          TranscriptionJobName: input.jobName,
        });

        await retryWithBackoff(() => transcribe.send(command), TRANSCRIBE_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            jobName: input.jobName,
            deleted: true,
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
    startTranscriptionJob,
    getTranscriptionJob,
    listTranscriptionJobs,
    deleteTranscriptionJob,
  ];
}
