/**
 * Progressive Refinement Engine
 *
 * Iterative development pattern: POC → Staging → Production
 * Each stage incorporates learnings from previous stage.
 *
 * Based on research: docs/research/aws-account-agent/01-Task-Decomposition.md
 * Section: "Progressive Refinement Approach"
 *
 * Principle: Start with minimal proof-of-concept, iterate toward production
 * based on learnings and validation feedback at each stage.
 */

import type { ISOTimestamp } from '../orchestration/types';

/**
 * Refinement stage in POC → Staging → Production pipeline
 */
export type RefinementStage =
  | 'poc'        // Proof of concept - validate approach
  | 'staging'    // Staging - add production concerns
  | 'production' // Production - full quality gates
  | 'complete';  // Deployment complete

/**
 * Stage status
 */
export type StageStatus =
  | 'pending'
  | 'in_progress'
  | 'passed'
  | 'failed';

/**
 * Learning captured from stage execution
 */
export interface StageLearning {
  stage: RefinementStage;
  approach: string;
  viable: boolean;
  assumptions: string[];
  wrongAssumptions: string[];
  missingComponents: string[];
  tradeoffs: string[];
  recommendations: string[];
  timestamp: ISOTimestamp;
}

/**
 * Task breakdown for a refinement stage
 */
export interface StageTask {
  id: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  validation: string;
  rollback?: string;
}

/**
 * Stage execution result
 */
export interface StageResult {
  stage: RefinementStage;
  status: StageStatus;
  tasks: StageTask[];
  testsRun: number;
  testsPassed: number;
  learnings: StageLearning;
  readyForNextStage: boolean;
  blockers: string[];
  completedAt?: ISOTimestamp;
}

/**
 * Production readiness checklist
 */
export interface ProductionReadinessChecklist {
  errorHandling: boolean;
  observability: boolean; // CloudWatch, X-Ray
  security: boolean;      // IAM, encryption
  integrationTests: boolean;
  loadTests: boolean;
  runbook: boolean;
  backups: boolean;
  alarms: boolean;
  canaryDeployment: boolean;
}

/**
 * Progressive refinement configuration
 */
export interface ProgressiveRefinerConfig {
  skipPOC?: boolean;         // Jump straight to staging
  skipStaging?: boolean;     // Jump straight to production (risky!)
  requireLoadTests?: boolean;
  requireCanary?: boolean;
  stagingTimeoutMs?: number;
}

/**
 * Progressive Refinement Engine
 *
 * Implements iterative development workflow:
 *
 * Stage 1: POC (Proof of Concept)
 * - Minimal viable implementation
 * - Single happy-path test
 * - No production concerns
 * - Goal: Validate approach quickly
 *
 * Stage 2: Staging
 * - Incorporate POC learnings
 * - Add error handling
 * - Add observability (CloudWatch, X-Ray)
 * - Add security (IAM, encryption)
 * - Add integration tests
 * - Goal: Production-ready implementation
 *
 * Stage 3: Production
 * - Full quality gates
 * - Load testing
 * - Canary deployment
 * - Runbook documentation
 * - Goal: Safe production deployment
 */
export class ProgressiveRefiner {
  private config: ProgressiveRefinerConfig;
  private currentStage: RefinementStage = 'poc';
  private stageResults: Map<RefinementStage, StageResult>;

  constructor(config: ProgressiveRefinerConfig = {}) {
    this.config = config;
    this.stageResults = new Map();

    if (config.skipPOC) {
      this.currentStage = 'staging';
    }
  }

  /**
   * Create POC task breakdown
   *
   * Minimal implementation to validate approach:
   * - Single happy-path test
   * - No error handling
   * - No production concerns
   */
  createPOCTasks(request: string): StageTask[] {
    return [
      {
        id: 'poc-1',
        description: `Create minimal implementation for: ${request}`,
        priority: 'high',
        validation: 'Basic functionality works in happy path'
      },
      {
        id: 'poc-2',
        description: 'Write single test for happy path',
        priority: 'high',
        validation: 'Test passes'
      },
      {
        id: 'poc-3',
        description: 'Document approach and assumptions',
        priority: 'medium',
        validation: 'README.md created'
      }
    ];
  }

  /**
   * Create staging task breakdown
   *
   * Refine POC into production-ready implementation based on learnings:
   * - Error handling
   * - Observability
   * - Security
   * - Integration tests
   */
  createStagingTasks(request: string, pocLearnings: StageLearning): StageTask[] {
    const tasks: StageTask[] = [
      {
        id: 'staging-1',
        description: 'Add comprehensive error handling',
        priority: 'high',
        validation: 'All error cases handled gracefully',
        rollback: 'Revert to POC version'
      },
      {
        id: 'staging-2',
        description: 'Add CloudWatch metrics and alarms',
        priority: 'high',
        validation: 'Metrics exported, alarms configured'
      },
      {
        id: 'staging-3',
        description: 'Add X-Ray distributed tracing',
        priority: 'medium',
        validation: 'Traces visible in X-Ray console'
      },
      {
        id: 'staging-4',
        description: 'Implement least-privilege IAM policies',
        priority: 'high',
        validation: 'IAM Access Analyzer shows no warnings'
      },
      {
        id: 'staging-5',
        description: 'Add encryption at rest and in transit',
        priority: 'high',
        validation: 'All data encrypted with KMS'
      },
      {
        id: 'staging-6',
        description: 'Write integration tests',
        priority: 'high',
        validation: 'Integration tests pass'
      }
    ];

    // Add tasks for missing components discovered in POC
    pocLearnings.missingComponents.forEach((component, index) => {
      tasks.push({
        id: `staging-missing-${index}`,
        description: `Add missing component: ${component}`,
        priority: 'high',
        validation: `${component} implemented and tested`
      });
    });

    return tasks;
  }

  /**
   * Create production task breakdown
   *
   * Full production deployment with quality gates:
   * - Load testing
   * - Canary deployment
   * - Runbook
   * - Backup strategy
   */
  createProductionTasks(request: string, stagingResults: StageResult): StageTask[] {
    const tasks: StageTask[] = [
      {
        id: 'prod-1',
        description: 'Add WAF rules for API protection',
        priority: 'high',
        validation: 'WAF rules active and tested'
      },
      {
        id: 'prod-2',
        description: 'Configure automated backups',
        priority: 'high',
        validation: 'Backup schedule configured, tested restore'
      },
      {
        id: 'prod-3',
        description: 'Create operational runbook',
        priority: 'high',
        validation: 'Runbook covers common scenarios'
      }
    ];

    if (this.config.requireLoadTests) {
      tasks.push({
        id: 'prod-4',
        description: 'Run load tests at expected scale',
        priority: 'high',
        validation: 'Load tests pass at 2x expected traffic'
      });
    }

    if (this.config.requireCanary) {
      tasks.push({
        id: 'prod-5',
        description: 'Deploy canary (10% traffic)',
        priority: 'high',
        validation: 'Canary metrics healthy for 1 hour',
        rollback: 'Rollback canary to previous version'
      });
    }

    tasks.push({
      id: 'prod-6',
      description: 'Full production deployment',
      priority: 'high',
      validation: 'Deployment successful, no errors',
      rollback: 'Rollback to previous version'
    });

    return tasks;
  }

  /**
   * Evaluate POC results and extract learnings
   */
  evaluatePOC(results: Partial<StageResult>): StageLearning {
    const learning: StageLearning = {
      stage: 'poc',
      approach: results.tasks?.[0]?.description || 'Unknown approach',
      viable: results.status === 'passed',
      assumptions: [],
      wrongAssumptions: [],
      missingComponents: [],
      tradeoffs: [],
      recommendations: [],
      timestamp: new Date().toISOString() as ISOTimestamp
    };

    // Analyze results to extract learnings
    if (results.blockers && results.blockers.length > 0) {
      learning.wrongAssumptions = results.blockers.map(
        b => `Assumption: ${b} would work automatically`
      );
    }

    // If POC failed, note what's missing
    if (results.status === 'failed') {
      learning.viable = false;
      learning.recommendations.push('Try alternative approach');
      learning.recommendations.push('Investigate root cause of failure');
    } else if (results.status === 'passed') {
      learning.viable = true;
      learning.recommendations.push('Proceed to staging with error handling');
      learning.recommendations.push('Add observability before production');
    }

    return learning;
  }

  /**
   * Check production readiness
   */
  checkProductionReadiness(stagingResult: StageResult): ProductionReadinessChecklist {
    // In production, this would analyze actual artifacts
    // For now, return checklist based on tasks completed
    const completedTasks = stagingResult.tasks.filter(
      t => t.validation && stagingResult.status === 'passed'
    );

    return {
      errorHandling: completedTasks.some(t => t.id === 'staging-1'),
      observability: completedTasks.some(t => t.id === 'staging-2' || t.id === 'staging-3'),
      security: completedTasks.some(t => t.id === 'staging-4' || t.id === 'staging-5'),
      integrationTests: completedTasks.some(t => t.id === 'staging-6'),
      loadTests: false, // Not done in staging
      runbook: false,   // Not done in staging
      backups: false,   // Not done in staging
      alarms: completedTasks.some(t => t.id === 'staging-2'),
      canaryDeployment: false // Not done in staging
    };
  }

  /**
   * Advance to next refinement stage
   */
  advanceStage(currentStageResult: StageResult): RefinementStage | null {
    this.stageResults.set(currentStageResult.stage, currentStageResult);

    if (!currentStageResult.readyForNextStage) {
      return null; // Blocked, cannot advance
    }

    switch (currentStageResult.stage) {
      case 'poc':
        this.currentStage = this.config.skipStaging ? 'production' : 'staging';
        return this.currentStage;

      case 'staging':
        this.currentStage = 'production';
        return this.currentStage;

      case 'production':
        this.currentStage = 'complete';
        return this.currentStage;

      default:
        return null;
    }
  }

  /**
   * Get current refinement stage
   */
  getCurrentStage(): RefinementStage {
    return this.currentStage;
  }

  /**
   * Get results for a stage
   */
  getStageResult(stage: RefinementStage): StageResult | undefined {
    return this.stageResults.get(stage);
  }

  /**
   * Get all learnings across stages
   */
  getAllLearnings(): StageLearning[] {
    return Array.from(this.stageResults.values()).map(r => r.learnings);
  }
}

/**
 * Factory function to create Progressive Refiner with default config
 */
export function createProgressiveRefiner(
  config?: Partial<ProgressiveRefinerConfig>
): ProgressiveRefiner {
  const defaultConfig: ProgressiveRefinerConfig = {
    skipPOC: false,
    skipStaging: false,
    requireLoadTests: true,
    requireCanary: true,
    stagingTimeoutMs: 3600000 // 1 hour
  };

  return new ProgressiveRefiner({ ...defaultConfig, ...config });
}
