/**
 * AWS Well-Architected Tool API Integration
 *
 * Provides programmatic access to the AWS Well-Architected Tool for:
 * - Creating and managing workloads
 * - Answering pillar questions
 * - Generating Well-Architected reviews
 * - Tracking improvement milestones
 *
 * @module well-architected/wa-tool-api
 */

import {
  WellArchitectedClient,
  CreateWorkloadCommand,
  UpdateWorkloadCommand,
  GetWorkloadCommand,
  ListWorkloadsCommand,
  DeleteWorkloadCommand,
  UpdateAnswerCommand,
  GetAnswerCommand,
  GetLensReviewCommand,
  CreateMilestoneCommand,
  ListMilestonesCommand,
  type WorkloadEnvironment,
  type WorkloadSummary,
  type Workload,
  type Answer,
  type LensReview,
  type MilestoneSummary,
  type PillarReviewSummary,
  type CreateWorkloadCommandInput,
  type UpdateAnswerCommandInput,
} from '@aws-sdk/client-wellarchitected';

/**
 * Configuration for the Well-Architected Tool API client
 */
export interface WellArchitectedToolConfig {
  /** AWS region for Well-Architected Tool API */
  region?: string;
  /** AWS credentials (optional, uses default credential chain) */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

/**
 * Parameters for creating a new workload
 */
export interface CreateWorkloadParams {
  /** Workload name (e.g., "Chimera Multi-Tenant Platform") */
  workloadName: string;
  /** Detailed workload description */
  description: string;
  /** Environment type */
  environment: WorkloadEnvironment;
  /** AWS account IDs associated with this workload */
  accountIds?: string[];
  /** AWS regions where workload is deployed */
  awsRegions?: string[];
  /** Well-Architected lens to apply (defaults to 'wellarchitected') */
  lenses?: string[];
  /** Review owner (email or ARN) */
  reviewOwner?: string;
  /** Industry type */
  industryType?: string;
  /** Industry (e.g., "Technology", "Healthcare") */
  industry?: string;
  /** Architectural design URL */
  architecturalDesign?: string;
  /** Tags for the workload */
  tags?: Record<string, string>;
}

/**
 * Parameters for updating an answer to a Well-Architected question
 */
export interface UpdateAnswerParams {
  /** Workload ID */
  workloadId: string;
  /** Lens alias (e.g., 'wellarchitected') */
  lensAlias: string;
  /** Question ID (e.g., 'sec-1') */
  questionId: string;
  /** Selected answer choices */
  selectedChoices?: string[];
  /** Answer notes explaining the choices */
  notes?: string;
  /** Whether this answer is not applicable */
  isApplicable?: boolean;
  /** Risk reason for not following best practice */
  reason?: 'NONE' | 'OUT_OF_SCOPE' | 'BUSINESS_PRIORITIES' | 'ARCHITECTURE_CONSTRAINTS' | 'OTHER';
}

/**
 * Parameters for creating a milestone (snapshot of current state)
 */
export interface CreateMilestoneParams {
  /** Workload ID */
  workloadId: string;
  /** Milestone name (e.g., "Q1 2026 Review") */
  milestoneName: string;
}

/**
 * Risk levels for Well-Architected findings
 */
export type RiskLevel = 'UNANSWERED' | 'HIGH' | 'MEDIUM' | 'NONE';

/**
 * Pillar summary with risk counts
 */
export interface PillarSummary {
  /** Pillar ID */
  pillarId: string;
  /** Pillar name */
  pillarName: string;
  /** Risk counts by level */
  riskCounts: Record<RiskLevel, number>;
  /** Number of answered questions */
  answeredQuestions: number;
  /** Total number of questions */
  totalQuestions: number;
}

/**
 * Well-Architected review summary
 */
export interface ReviewSummary {
  /** Workload ID */
  workloadId: string;
  /** Workload name */
  workloadName: string;
  /** Lens alias */
  lensAlias: string;
  /** Overall risk counts */
  riskCounts: Record<RiskLevel, number>;
  /** Pillar summaries */
  pillars: PillarSummary[];
  /** Review timestamp */
  updatedAt?: Date;
}

/**
 * AWS Well-Architected Tool API Client
 *
 * Provides methods for interacting with the AWS Well-Architected Tool API
 * to conduct automated workload reviews and track improvements.
 */
export class WellArchitectedToolAPI {
  private client: WellArchitectedClient;

  constructor(config: WellArchitectedToolConfig = {}) {
    this.client = new WellArchitectedClient({
      region: config.region || 'us-west-2',
      credentials: config.credentials,
    });
  }

  /**
   * Create a new workload in the Well-Architected Tool
   *
   * @param params Workload creation parameters
   * @returns Workload ID and ARN
   *
   * @example
   * ```typescript
   * const result = await api.createWorkload({
   *   workloadName: 'Chimera Platform',
   *   description: 'Multi-tenant agent platform',
   *   environment: 'PRODUCTION',
   *   accountIds: ['123456789012'],
   *   awsRegions: ['us-west-2'],
   * });
   * console.log('Created workload:', result.workloadId);
   * ```
   */
  async createWorkload(params: CreateWorkloadParams): Promise<{
    workloadId: string;
    workloadArn: string;
  }> {
    const input: CreateWorkloadCommandInput = {
      WorkloadName: params.workloadName,
      Description: params.description,
      Environment: params.environment,
      AccountIds: params.accountIds,
      AwsRegions: params.awsRegions,
      Lenses: params.lenses || ['wellarchitected'],
      ReviewOwner: params.reviewOwner,
      IndustryType: params.industryType,
      Industry: params.industry,
      ArchitecturalDesign: params.architecturalDesign,
      Tags: params.tags,
    };

    const command = new CreateWorkloadCommand(input);
    const response = await this.client.send(command);

    if (!response.WorkloadId || !response.WorkloadArn) {
      throw new Error('Failed to create workload: missing workloadId or workloadArn');
    }

    return {
      workloadId: response.WorkloadId,
      workloadArn: response.WorkloadArn,
    };
  }

  /**
   * Get workload details
   *
   * @param workloadId Workload ID
   * @returns Workload details
   */
  async getWorkload(workloadId: string): Promise<Workload> {
    const command = new GetWorkloadCommand({ WorkloadId: workloadId });
    const response = await this.client.send(command);

    if (!response.Workload) {
      throw new Error(`Workload not found: ${workloadId}`);
    }

    return response.Workload;
  }

  /**
   * List all workloads
   *
   * @param maxResults Maximum number of results to return
   * @returns List of workload summaries
   */
  async listWorkloads(maxResults?: number): Promise<WorkloadSummary[]> {
    const command = new ListWorkloadsCommand({
      MaxResults: maxResults,
    });
    const response = await this.client.send(command);

    return response.WorkloadSummaries || [];
  }

  /**
   * Update workload configuration
   *
   * @param workloadId Workload ID
   * @param updates Workload updates
   */
  async updateWorkload(
    workloadId: string,
    updates: Partial<Omit<CreateWorkloadParams, 'workloadName'>>
  ): Promise<void> {
    const command = new UpdateWorkloadCommand({
      WorkloadId: workloadId,
      Description: updates.description,
      Environment: updates.environment,
      AccountIds: updates.accountIds,
      AwsRegions: updates.awsRegions,
      ArchitecturalDesign: updates.architecturalDesign,
      ReviewOwner: updates.reviewOwner,
      IndustryType: updates.industryType,
      Industry: updates.industry,
    });

    await this.client.send(command);
  }

  /**
   * Delete a workload
   *
   * @param workloadId Workload ID
   */
  async deleteWorkload(workloadId: string): Promise<void> {
    const command = new DeleteWorkloadCommand({
      WorkloadId: workloadId,
    });

    await this.client.send(command);
  }

  /**
   * Answer a Well-Architected question
   *
   * @param params Answer parameters
   *
   * @example
   * ```typescript
   * await api.updateAnswer({
   *   workloadId: 'abc123',
   *   lensAlias: 'wellarchitected',
   *   questionId: 'sec-1',
   *   selectedChoices: ['sec_1_use_mfa'],
   *   notes: 'MFA enforced via Cognito',
   * });
   * ```
   */
  async updateAnswer(params: UpdateAnswerParams): Promise<void> {
    const input: UpdateAnswerCommandInput = {
      WorkloadId: params.workloadId,
      LensAlias: params.lensAlias,
      QuestionId: params.questionId,
      SelectedChoices: params.selectedChoices,
      Notes: params.notes,
      IsApplicable: params.isApplicable,
      Reason: params.reason,
    };

    const command = new UpdateAnswerCommand(input);
    await this.client.send(command);
  }

  /**
   * Get an answer to a specific question
   *
   * @param workloadId Workload ID
   * @param lensAlias Lens alias
   * @param questionId Question ID
   * @returns Answer details
   */
  async getAnswer(
    workloadId: string,
    lensAlias: string,
    questionId: string
  ): Promise<Answer> {
    const command = new GetAnswerCommand({
      WorkloadId: workloadId,
      LensAlias: lensAlias,
      QuestionId: questionId,
    });
    const response = await this.client.send(command);

    if (!response.Answer) {
      throw new Error(`Answer not found for question: ${questionId}`);
    }

    return response.Answer;
  }

  /**
   * Get lens review summary (risk assessment for a pillar)
   *
   * @param workloadId Workload ID
   * @param lensAlias Lens alias (defaults to 'wellarchitected')
   * @param milestoneNumber Optional milestone number for historical review
   * @returns Lens review with risk counts
   */
  async getLensReview(
    workloadId: string,
    lensAlias: string = 'wellarchitected',
    milestoneNumber?: number
  ): Promise<LensReview> {
    const command = new GetLensReviewCommand({
      WorkloadId: workloadId,
      LensAlias: lensAlias,
      MilestoneNumber: milestoneNumber,
    });
    const response = await this.client.send(command);

    if (!response.LensReview) {
      throw new Error(`Lens review not found for workload: ${workloadId}`);
    }

    return response.LensReview;
  }

  /**
   * Get a comprehensive review summary with all pillar risk counts
   *
   * @param workloadId Workload ID
   * @returns Review summary with pillar breakdowns
   */
  async getReviewSummary(workloadId: string): Promise<ReviewSummary> {
    const workload = await this.getWorkload(workloadId);
    const lensReview = await this.getLensReview(workloadId);

    const pillars: PillarSummary[] = (lensReview.PillarReviewSummaries || []).map((pillar: PillarReviewSummary) => ({
      pillarId: pillar.PillarId || '',
      pillarName: pillar.PillarName || '',
      riskCounts: {
        UNANSWERED: pillar.RiskCounts?.UNANSWERED || 0,
        HIGH: pillar.RiskCounts?.HIGH || 0,
        MEDIUM: pillar.RiskCounts?.MEDIUM || 0,
        NONE: pillar.RiskCounts?.NONE || 0,
      },
      answeredQuestions: pillar.RiskCounts?.NONE || 0,
      totalQuestions:
        (pillar.RiskCounts?.UNANSWERED || 0) +
        (pillar.RiskCounts?.HIGH || 0) +
        (pillar.RiskCounts?.MEDIUM || 0) +
        (pillar.RiskCounts?.NONE || 0),
    }));

    return {
      workloadId: workload.WorkloadId!,
      workloadName: workload.WorkloadName!,
      lensAlias: lensReview.LensAlias!,
      riskCounts: {
        UNANSWERED: lensReview.RiskCounts?.UNANSWERED || 0,
        HIGH: lensReview.RiskCounts?.HIGH || 0,
        MEDIUM: lensReview.RiskCounts?.MEDIUM || 0,
        NONE: lensReview.RiskCounts?.NONE || 0,
      },
      pillars,
      updatedAt: lensReview.UpdatedAt,
    };
  }

  /**
   * Create a milestone (snapshot current state for tracking improvements)
   *
   * @param params Milestone parameters
   * @returns Milestone number
   *
   * @example
   * ```typescript
   * const milestoneNumber = await api.createMilestone({
   *   workloadId: 'abc123',
   *   milestoneName: 'Q1 2026 Review',
   * });
   * ```
   */
  async createMilestone(params: CreateMilestoneParams): Promise<number> {
    const command = new CreateMilestoneCommand({
      WorkloadId: params.workloadId,
      MilestoneName: params.milestoneName,
    });
    const response = await this.client.send(command);

    if (response.MilestoneNumber === undefined) {
      throw new Error('Failed to create milestone: missing milestoneNumber');
    }

    return response.MilestoneNumber;
  }

  /**
   * List all milestones for a workload
   *
   * @param workloadId Workload ID
   * @returns List of milestone summaries
   */
  async listMilestones(workloadId: string): Promise<MilestoneSummary[]> {
    const command = new ListMilestonesCommand({
      WorkloadId: workloadId,
    });
    const response = await this.client.send(command);

    return response.MilestoneSummaries || [];
  }
}

/**
 * Create a Well-Architected Tool API client
 *
 * @param config Optional configuration
 * @returns API client instance
 */
export function createWellArchitectedToolAPI(
  config?: WellArchitectedToolConfig
): WellArchitectedToolAPI {
  return new WellArchitectedToolAPI(config);
}
