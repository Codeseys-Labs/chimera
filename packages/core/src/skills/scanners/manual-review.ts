/**
 * Manual Review Scanner
 *
 * Stage 6 of 7-stage skill security pipeline
 * Queues skills for human approval and tracks review status
 *
 * Reference: docs/research/architecture-reviews/Chimera-Skill-Ecosystem-Design.md § 4.2
 *
 * Manual review is required for:
 * - Community skills (trust_level: 'community')
 * - Skills with high-privilege permissions (shell, network, secrets)
 * - Skills flagged by automated scanners (warnings but not failures)
 * - First-time authors
 *
 * Platform and verified skills skip manual review.
 */

/**
 * Review status
 */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'skipped';

/**
 * Review priority
 */
export type ReviewPriority = 'urgent' | 'high' | 'normal' | 'low';

/**
 * Review decision
 */
export interface ReviewDecision {
  status: ReviewStatus;
  reviewer?: string; // Admin user ID
  reviewed_at?: string; // ISO 8601
  reason?: string;
  notes?: string;
}

/**
 * Review criteria evaluation
 */
export interface ReviewCriteria {
  requires_review: boolean;
  reasons: string[];
  priority: ReviewPriority;
  auto_approve?: boolean;
}

/**
 * Manual review result
 */
export interface ManualReviewResult {
  passed: boolean; // true if approved or skipped, false if rejected or pending
  status: ReviewStatus;
  criteria: ReviewCriteria;
  decision?: ReviewDecision;
  queue_position?: number; // Position in review queue
  estimated_wait_minutes?: number; // Estimated review time
  scannedAt: string;
}

/**
 * Manual review configuration
 */
export interface ManualReviewConfig {
  /** Auto-approve platform/verified skills */
  autoApproveVerified?: boolean;
  /** Require review for community skills */
  requireCommunityReview?: boolean;
  /** Skip review (for testing) */
  skipReview?: boolean;
  /** Admin notification endpoint (SNS topic ARN) */
  notificationTopicArn?: string;
  /** Review queue URL (SQS) */
  queueUrl?: string;
}

/**
 * Skill metadata for review
 */
export interface SkillReviewMetadata {
  name: string;
  version: string;
  author: string;
  trust_level: 'platform' | 'verified' | 'community' | 'private' | 'experimental';
  category: string;
  description: string;
  permissions?: {
    filesystem?: { read?: string[]; write?: string[] };
    network?: boolean | { endpoints?: string[] };
    shell?: { allowed?: string[]; denied?: string[] };
    secrets?: string[];
  };
  scan_result?: {
    static_analysis?: { passed: boolean; findings?: string[] };
    dependency_audit?: { passed: boolean; vulnerabilities?: string[] };
    sandbox_run?: { passed: boolean; violations?: string[] };
  };
  is_first_time_author?: boolean;
}

/**
 * Manual Review Scanner
 *
 * Evaluates whether a skill requires manual review and queues it for admin approval.
 *
 * Review criteria:
 * 1. Platform/verified skills → auto-approve (skip review)
 * 2. Community skills → require review
 * 3. High-privilege permissions → require review (shell, network, secrets)
 * 4. Scanner warnings (non-fatal) → flag for review
 * 5. First-time authors → require review
 *
 * Review queue:
 * - Priority: urgent (security issues) > high (privileged) > normal (community) > low (updates)
 * - SQS queue stores pending reviews
 * - SNS notification sent to admins when new skill queued
 */
export class ManualReviewScanner {
  private config: ManualReviewConfig;

  constructor(config: ManualReviewConfig = {}) {
    this.config = {
      autoApproveVerified: config.autoApproveVerified ?? true,
      requireCommunityReview: config.requireCommunityReview ?? true,
      skipReview: config.skipReview ?? false,
      notificationTopicArn: config.notificationTopicArn,
      queueUrl: config.queueUrl,
    };
  }

  /**
   * Evaluate whether skill requires manual review
   *
   * @param metadata - Skill metadata including trust level, permissions, and scan results
   * @returns Manual review result
   */
  async evaluateSkill(metadata: SkillReviewMetadata): Promise<ManualReviewResult> {
    const criteria = this.evaluateCriteria(metadata);

    // If review is skipped (testing mode), auto-approve
    if (this.config.skipReview) {
      return {
        passed: true,
        status: 'skipped',
        criteria,
        decision: {
          status: 'skipped',
          reason: 'Review skipped (testing mode)',
        },
        scannedAt: new Date().toISOString(),
      };
    }

    // Auto-approve if criteria allows
    if (criteria.auto_approve) {
      return {
        passed: true,
        status: 'approved',
        criteria,
        decision: {
          status: 'approved',
          reviewed_at: new Date().toISOString(),
          reason: 'Auto-approved (platform/verified skill)',
        },
        scannedAt: new Date().toISOString(),
      };
    }

    // Queue for manual review
    if (criteria.requires_review) {
      const queueResult = await this.queueForReview(metadata, criteria);

      return {
        passed: false, // Blocking on review
        status: 'pending',
        criteria,
        queue_position: queueResult.position,
        estimated_wait_minutes: queueResult.estimated_wait_minutes,
        scannedAt: new Date().toISOString(),
      };
    }

    // No review required
    return {
      passed: true,
      status: 'approved',
      criteria,
      decision: {
        status: 'approved',
        reviewed_at: new Date().toISOString(),
        reason: 'No review required',
      },
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Approve a skill (admin action)
   *
   * @param skillName - Skill name
   * @param version - Skill version
   * @param reviewer - Admin user ID
   * @param notes - Optional review notes
   * @returns Review decision
   */
  async approveSkill(
    skillName: string,
    version: string,
    reviewer: string,
    notes?: string
  ): Promise<ReviewDecision> {
    // In production, this would:
    // 1. Update DynamoDB skill record with approval
    // 2. Remove from SQS review queue
    // 3. Trigger deployment Lambda

    return {
      status: 'approved',
      reviewer,
      reviewed_at: new Date().toISOString(),
      notes,
      reason: 'Manually approved by admin',
    };
  }

  /**
   * Reject a skill (admin action)
   *
   * @param skillName - Skill name
   * @param version - Skill version
   * @param reviewer - Admin user ID
   * @param reason - Rejection reason
   * @returns Review decision
   */
  async rejectSkill(
    skillName: string,
    version: string,
    reviewer: string,
    reason: string
  ): Promise<ReviewDecision> {
    // In production, this would:
    // 1. Update DynamoDB skill record with rejection
    // 2. Remove from SQS review queue
    // 3. Notify author via SNS

    return {
      status: 'rejected',
      reviewer,
      reviewed_at: new Date().toISOString(),
      reason,
    };
  }

  /**
   * Get pending review queue
   *
   * @returns List of skills pending review
   */
  async getPendingReviews(): Promise<
    Array<{
      skillName: string;
      version: string;
      author: string;
      priority: ReviewPriority;
      queued_at: string;
    }>
  > {
    // In production, this would:
    // 1. Query SQS review queue
    // 2. Parse message bodies
    // 3. Sort by priority and timestamp

    // Mock: empty queue
    return [];
  }

  /**
   * Evaluate review criteria
   */
  private evaluateCriteria(metadata: SkillReviewMetadata): ReviewCriteria {
    const reasons: string[] = [];
    let priority: ReviewPriority = 'normal';
    let auto_approve = false;

    // 1. Platform/verified skills auto-approve
    if (
      this.config.autoApproveVerified &&
      (metadata.trust_level === 'platform' || metadata.trust_level === 'verified')
    ) {
      auto_approve = true;
      reasons.push(`Trust level: ${metadata.trust_level} (auto-approve)`);
    }

    // 2. Community skills require review
    if (this.config.requireCommunityReview && metadata.trust_level === 'community') {
      reasons.push('Community skill requires review');
    }

    // 3. High-privilege permissions
    if (metadata.permissions) {
      if (metadata.permissions.shell) {
        reasons.push('Shell access requested');
        priority = 'high';
      }

      if (
        metadata.permissions.network === true ||
        (typeof metadata.permissions.network === 'object' && metadata.permissions.network.endpoints)
      ) {
        reasons.push('Network access requested');
        priority = priority === 'high' ? 'high' : 'normal';
      }

      if (metadata.permissions.secrets && metadata.permissions.secrets.length > 0) {
        reasons.push(`Secrets access requested (${metadata.permissions.secrets.length} secrets)`);
        priority = 'high';
      }

      if (metadata.permissions.filesystem?.write && metadata.permissions.filesystem.write.length > 0) {
        reasons.push('Filesystem write access requested');
      }
    }

    // 4. Scanner warnings (non-fatal findings)
    if (metadata.scan_result) {
      if (
        metadata.scan_result.static_analysis?.findings &&
        metadata.scan_result.static_analysis.findings.length > 0
      ) {
        reasons.push(
          `Static analysis findings: ${metadata.scan_result.static_analysis.findings.length}`
        );
        priority = 'high';
      }

      if (
        metadata.scan_result.dependency_audit?.vulnerabilities &&
        metadata.scan_result.dependency_audit.vulnerabilities.length > 0
      ) {
        reasons.push(
          `Dependency vulnerabilities: ${metadata.scan_result.dependency_audit.vulnerabilities.length}`
        );
        priority = 'urgent';
      }

      if (
        metadata.scan_result.sandbox_run?.violations &&
        metadata.scan_result.sandbox_run.violations.length > 0
      ) {
        reasons.push(
          `Sandbox violations: ${metadata.scan_result.sandbox_run.violations.length}`
        );
        priority = 'urgent';
      }
    }

    // 5. First-time author
    if (metadata.is_first_time_author) {
      reasons.push('First-time author');
      priority = priority === 'urgent' ? 'urgent' : 'high';
    }

    const requires_review = !auto_approve && reasons.length > 0;

    return {
      requires_review,
      reasons,
      priority,
      auto_approve,
    };
  }

  /**
   * Queue skill for manual review
   *
   * In production, this would:
   * 1. Send message to SQS review queue
   * 2. Publish SNS notification to admins
   * 3. Return queue position and estimated wait time
   */
  private async queueForReview(
    metadata: SkillReviewMetadata,
    criteria: ReviewCriteria
  ): Promise<{ position: number; estimated_wait_minutes: number }> {
    // Mock implementation
    // In production:
    // - Use AWS SDK to send SQS message with skill metadata + criteria
    // - Publish SNS notification with priority and reasons
    // - Query queue depth for position estimate

    const position = 1; // Mock: first in queue
    const estimated_wait_minutes = this.estimateWaitTime(criteria.priority, position);

    return { position, estimated_wait_minutes };
  }

  /**
   * Estimate review wait time based on priority and queue position
   */
  private estimateWaitTime(priority: ReviewPriority, position: number): number {
    // Simple heuristic: higher priority = faster review
    const baseMinutes: Record<ReviewPriority, number> = {
      urgent: 15,
      high: 60,
      normal: 240, // 4 hours
      low: 1440, // 24 hours
    };

    return baseMinutes[priority] * position;
  }
}
