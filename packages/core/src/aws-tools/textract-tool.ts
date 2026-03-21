/**
 * AWS Textract Tool - Document text extraction and analysis for agents (Strands format)
 *
 * Operations:
 * - textract_detect_text: Synchronous text extraction from documents
 * - textract_analyze_document: Synchronous document analysis with forms and tables
 * - textract_start_document_analysis: Asynchronous analysis for large/multi-page documents
 * - textract_get_document_analysis: Get results of asynchronous analysis job
 *
 * Reference: docs/research/aws-account-agent/01-AWS-API-First-Class-Tools.md
 */

import { tool } from './strands-agents';
import { z } from 'zod';
import {
  TextractClient,
  DetectDocumentTextCommand,
  AnalyzeDocumentCommand,
  StartDocumentAnalysisCommand,
  GetDocumentAnalysisCommand,
  type Document,
  type FeatureType,
} from '@aws-sdk/client-textract';
import type { AWSClientFactory } from './client-factory';
import { retryWithBackoff, formatToolError, TEXTRACT_RETRYABLE_ERRORS } from './tool-utils';

/**
 * Helper to build Document input from base64 or S3
 */
function buildDocumentInput(
  documentBytes?: string,
  s3Bucket?: string,
  s3Key?: string,
  s3Version?: string
): Document {
  if (documentBytes) {
    return {
      Bytes: Buffer.from(documentBytes, 'base64'),
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
  throw new Error('Either documentBytes or s3Bucket+s3Key must be provided');
}

/**
 * Create Textract Strands tools
 *
 * @param clientFactory - AWS client factory for credential management
 * @returns Array of Textract tools for Strands Agent
 */
export function createTextractTools(clientFactory: AWSClientFactory) {
  const detectDocumentText = tool({
    name: 'textract_detect_text',
    description: 'Synchronously extract text from document images (JPEG, PNG, PDF up to 1 page)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      documentBytes: z.string().optional().describe('Base64-encoded document bytes (JPEG, PNG, or single-page PDF)'),
      s3Bucket: z.string().optional().describe('S3 bucket containing document'),
      s3Key: z.string().optional().describe('S3 key of document'),
      s3Version: z.string().optional().describe('S3 object version'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const textract = await clientFactory.getTextractClient(context);

        const document = buildDocumentInput(input.documentBytes, input.s3Bucket, input.s3Key, input.s3Version);

        const command = new DetectDocumentTextCommand({
          Document: document,
        });

        const response = await retryWithBackoff(() => textract.send(command), TEXTRACT_RETRYABLE_ERRORS);

        const blocks = (response.Blocks ?? []).map((block) => ({
          blockType: block.BlockType,
          id: block.Id,
          text: block.Text,
          confidence: block.Confidence,
          geometry: block.Geometry,
          page: block.Page,
          relationships: block.Relationships,
        }));

        return JSON.stringify({
          success: true,
          data: {
            blocks,
            documentMetadata: response.DocumentMetadata,
            detectDocumentTextModelVersion: response.DetectDocumentTextModelVersion,
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

  const analyzeDocument = tool({
    name: 'textract_analyze_document',
    description: 'Synchronously analyze document with forms and tables extraction (PDF up to 1 page)',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      documentBytes: z.string().optional().describe('Base64-encoded document bytes (JPEG, PNG, or single-page PDF)'),
      s3Bucket: z.string().optional().describe('S3 bucket containing document'),
      s3Key: z.string().optional().describe('S3 key of document'),
      s3Version: z.string().optional().describe('S3 object version'),
      featureTypes: z.array(z.enum(['TABLES', 'FORMS', 'QUERIES', 'SIGNATURES', 'LAYOUT'])).describe('Analysis features to extract'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const textract = await clientFactory.getTextractClient(context);

        const document = buildDocumentInput(input.documentBytes, input.s3Bucket, input.s3Key, input.s3Version);

        const command = new AnalyzeDocumentCommand({
          Document: document,
          FeatureTypes: input.featureTypes as FeatureType[],
        });

        const response = await retryWithBackoff(() => textract.send(command), TEXTRACT_RETRYABLE_ERRORS);

        const blocks = (response.Blocks ?? []).map((block) => ({
          blockType: block.BlockType,
          id: block.Id,
          text: block.Text,
          confidence: block.Confidence,
          geometry: block.Geometry,
          page: block.Page,
          relationships: block.Relationships,
          entityTypes: block.EntityTypes,
          selectionStatus: block.SelectionStatus,
          rowIndex: block.RowIndex,
          columnIndex: block.ColumnIndex,
          rowSpan: block.RowSpan,
          columnSpan: block.ColumnSpan,
        }));

        return JSON.stringify({
          success: true,
          data: {
            blocks,
            documentMetadata: response.DocumentMetadata,
            analyzeDocumentModelVersion: response.AnalyzeDocumentModelVersion,
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

  const startDocumentAnalysis = tool({
    name: 'textract_start_document_analysis',
    description: 'Start asynchronous document analysis for multi-page PDFs or large documents in S3',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      s3Bucket: z.string().describe('S3 bucket containing document'),
      s3Key: z.string().describe('S3 key of document'),
      s3Version: z.string().optional().describe('S3 object version'),
      featureTypes: z.array(z.enum(['TABLES', 'FORMS', 'QUERIES', 'SIGNATURES', 'LAYOUT'])).describe('Analysis features to extract'),
      outputBucket: z.string().optional().describe('S3 bucket for output (optional)'),
      outputPrefix: z.string().optional().describe('S3 prefix for output (optional)'),
      snsTopicArn: z.string().optional().describe('SNS topic ARN for completion notification'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const textract = await clientFactory.getTextractClient(context);

        const command = new StartDocumentAnalysisCommand({
          DocumentLocation: {
            S3Object: {
              Bucket: input.s3Bucket,
              Name: input.s3Key,
              Version: input.s3Version,
            },
          },
          FeatureTypes: input.featureTypes as FeatureType[],
          OutputConfig: input.outputBucket
            ? {
                S3Bucket: input.outputBucket,
                S3Prefix: input.outputPrefix,
              }
            : undefined,
          NotificationChannel: input.snsTopicArn
            ? {
                SNSTopicArn: input.snsTopicArn,
                RoleArn: '', // Required but will be filled by IAM role
              }
            : undefined,
        });

        const response = await retryWithBackoff(() => textract.send(command), TEXTRACT_RETRYABLE_ERRORS);

        return JSON.stringify({
          success: true,
          data: {
            jobId: response.JobId,
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

  const getDocumentAnalysis = tool({
    name: 'textract_get_document_analysis',
    description: 'Get results of asynchronous document analysis job with pagination support',
    inputSchema: z.object({
      tenantId: z.string().describe('Tenant ID for IAM role assumption'),
      agentId: z.string().describe('Agent ID for audit trail'),
      region: z.string().optional().describe('AWS region (default: us-east-1)'),
      jobId: z.string().describe('Job ID from start_document_analysis'),
      maxResults: z.number().optional().describe('Maximum results per page (1-1000)'),
      nextToken: z.string().optional().describe('Pagination token from previous call'),
    }),
    callback: async (input) => {
      const startTime = Date.now();
      try {
        const context = { tenantId: input.tenantId, agentId: input.agentId, region: input.region };
        const textract = await clientFactory.getTextractClient(context);

        const command = new GetDocumentAnalysisCommand({
          JobId: input.jobId,
          MaxResults: input.maxResults,
          NextToken: input.nextToken,
        });

        const response = await retryWithBackoff(() => textract.send(command), TEXTRACT_RETRYABLE_ERRORS);

        const blocks = (response.Blocks ?? []).map((block) => ({
          blockType: block.BlockType,
          id: block.Id,
          text: block.Text,
          confidence: block.Confidence,
          geometry: block.Geometry,
          page: block.Page,
          relationships: block.Relationships,
          entityTypes: block.EntityTypes,
          selectionStatus: block.SelectionStatus,
          rowIndex: block.RowIndex,
          columnIndex: block.ColumnIndex,
          rowSpan: block.RowSpan,
          columnSpan: block.ColumnSpan,
        }));

        return JSON.stringify({
          success: true,
          data: {
            jobStatus: response.JobStatus,
            statusMessage: response.StatusMessage,
            blocks,
            nextToken: response.NextToken,
            documentMetadata: response.DocumentMetadata,
            analyzeDocumentModelVersion: response.AnalyzeDocumentModelVersion,
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
    detectDocumentText,
    analyzeDocument,
    startDocumentAnalysis,
    getDocumentAnalysis,
  ];
}
