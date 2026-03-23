/**
 * ML Experiment Runner
 *
 * Orchestrates ML experiments, hyperparameter tuning, and autoresearch patterns.
 * Integrates with Step Functions for long-running experiment workflows.
 */

import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
  StopExecutionCommand,
} from '@aws-sdk/client-sfn';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// Module-level singleton clients
const sfnClient = new SFNClient({});
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});

/**
 * Experiment configuration
 */
export interface ExperimentConfig {
  experimentId: string;
  tenantId: string;
  experimentType: 'prompt_tuning' | 'model_selection' | 'hyperparameter_search' | 'architecture_search';
  parameters: Record<string, unknown>;
  searchSpace?: Record<string, { min: number; max: number } | string[]>;
  maxTrials?: number;
  timeout?: number; // seconds
}

/**
 * Experiment trial result
 */
export interface ExperimentTrial {
  trialId: string;
  experimentId: string;
  parameters: Record<string, unknown>;
  metrics: Record<string, number>;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  error?: string;
}

/**
 * Experiment status
 */
export interface ExperimentStatus {
  experimentId: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  trialsCompleted: number;
  trialsTotal: number;
  bestTrial?: ExperimentTrial;
  currentBestMetric?: number;
  startedAt: string;
  completedAt?: string;
}

/**
 * ML experiment orchestrator
 */
export class ExperimentRunner {
  private sfn: SFNClient;
  private ddb: DynamoDBDocumentClient;
  private s3: S3Client;
  private evolutionTable: string;
  private artifactsBucket: string;
  private stateMachineArn: string;

  constructor(params: {
    evolutionTable: string;
    artifactsBucket: string;
    stateMachineArn: string;
  }) {
    this.evolutionTable = params.evolutionTable;
    this.artifactsBucket = params.artifactsBucket;
    this.stateMachineArn = params.stateMachineArn;
    this.sfn = sfnClient;
    this.ddb = ddbDocClient;
    this.s3 = s3Client;
  }

  /**
   * Start a new ML experiment
   */
  async startExperiment(config: ExperimentConfig): Promise<{ executionArn: string }> {
    // Store experiment config
    await this.ddb.send(
      new PutCommand({
        TableName: this.evolutionTable,
        Item: {
          PK: `TENANT#${config.tenantId}`,
          SK: `EXPERIMENT#${config.experimentId}`,
          ...config,
          status: 'running',
          trialsCompleted: 0,
          trialsTotal: config.maxTrials || 10,
          startedAt: new Date().toISOString(),
        },
      })
    );

    // Start Step Functions execution
    const execution = await this.sfn.send(
      new StartExecutionCommand({
        stateMachineArn: this.stateMachineArn,
        name: `experiment-${config.experimentId}`,
        input: JSON.stringify(config),
      })
    );

    return { executionArn: execution.executionArn! };
  }

  /**
   * Record a trial result
   */
  async recordTrial(trial: ExperimentTrial): Promise<void> {
    // Get experiment to check if this is the best trial
    const experimentResult = await this.ddb.send(
      new GetCommand({
        TableName: this.evolutionTable,
        Key: {
          PK: `TENANT#${trial.experimentId.split('-')[0]}`,
          SK: `EXPERIMENT#${trial.experimentId}`,
        },
      })
    );

    const experiment = experimentResult.Item;
    if (!experiment) {
      throw new Error(`Experiment ${trial.experimentId} not found`);
    }

    // Store trial
    await this.ddb.send(
      new PutCommand({
        TableName: this.evolutionTable,
        Item: {
          PK: `EXPERIMENT#${trial.experimentId}`,
          SK: `TRIAL#${trial.trialId}`,
          ...trial,
        },
      })
    );

    // Update experiment if this is the best trial
    const primaryMetric = this.getPrimaryMetric(trial.metrics);
    const currentBest = experiment.currentBestMetric || -Infinity;

    if (primaryMetric > currentBest) {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.evolutionTable,
          Key: {
            PK: `TENANT#${experiment.tenantId}`,
            SK: `EXPERIMENT#${trial.experimentId}`,
          },
          UpdateExpression:
            'SET currentBestMetric = :metric, bestTrial = :trial, trialsCompleted = trialsCompleted + :one',
          ExpressionAttributeValues: {
            ':metric': primaryMetric,
            ':trial': trial,
            ':one': 1,
          },
        })
      );
    } else {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.evolutionTable,
          Key: {
            PK: `TENANT#${experiment.tenantId}`,
            SK: `EXPERIMENT#${trial.experimentId}`,
          },
          UpdateExpression: 'SET trialsCompleted = trialsCompleted + :one',
          ExpressionAttributeValues: {
            ':one': 1,
          },
        })
      );
    }
  }

  /**
   * Get experiment status
   */
  async getExperimentStatus(params: {
    tenantId: string;
    experimentId: string;
  }): Promise<ExperimentStatus | null> {
    const result = await this.ddb.send(
      new GetCommand({
        TableName: this.evolutionTable,
        Key: {
          PK: `TENANT#${params.tenantId}`,
          SK: `EXPERIMENT#${params.experimentId}`,
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return {
      experimentId: result.Item.experimentId,
      status: result.Item.status,
      trialsCompleted: result.Item.trialsCompleted || 0,
      trialsTotal: result.Item.trialsTotal || 10,
      bestTrial: result.Item.bestTrial,
      currentBestMetric: result.Item.currentBestMetric,
      startedAt: result.Item.startedAt,
      completedAt: result.Item.completedAt,
    };
  }

  /**
   * List all trials for an experiment
   */
  async listTrials(experimentId: string): Promise<ExperimentTrial[]> {
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.evolutionTable,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `EXPERIMENT#${experimentId}`,
          ':prefix': 'TRIAL#',
        },
      })
    );

    return (result.Items || []) as ExperimentTrial[];
  }

  /**
   * Stop a running experiment
   */
  async stopExperiment(params: {
    tenantId: string;
    experimentId: string;
    executionArn: string;
  }): Promise<void> {
    // Stop Step Functions execution
    await this.sfn.send(
      new StopExecutionCommand({
        executionArn: params.executionArn,
        cause: 'User requested stop',
      })
    );

    // Update experiment status
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.evolutionTable,
        Key: {
          PK: `TENANT#${params.tenantId}`,
          SK: `EXPERIMENT#${params.experimentId}`,
        },
        UpdateExpression: 'SET #status = :stopped, completedAt = :ts',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':stopped': 'stopped',
          ':ts': new Date().toISOString(),
        },
      })
    );
  }

  /**
   * Complete an experiment
   */
  async completeExperiment(params: {
    tenantId: string;
    experimentId: string;
  }): Promise<ExperimentTrial | null> {
    const status = await this.getExperimentStatus(params);
    if (!status) {
      return null;
    }

    // Mark as completed
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.evolutionTable,
        Key: {
          PK: `TENANT#${params.tenantId}`,
          SK: `EXPERIMENT#${params.experimentId}`,
        },
        UpdateExpression: 'SET #status = :completed, completedAt = :ts',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':completed': 'completed',
          ':ts': new Date().toISOString(),
        },
      })
    );

    return status.bestTrial || null;
  }

  /**
   * Generate next trial parameters using adaptive sampling
   *
   * Uses quasi-random sampling (Sobol-like) with best-point exploitation.
   * For first N trials, explores uniformly. After that, samples around
   * best performing parameters with decreasing variance.
   */
  async suggestNextTrial(params: {
    experimentId: string;
    searchSpace: Record<string, { min: number; max: number } | string[]>;
  }): Promise<Record<string, unknown>> {
    // Get all previous trials
    const trials = await this.listTrials(params.experimentId);
    const completedTrials = trials.filter(t => t.status === 'completed');

    const nextParams: Record<string, unknown> = {};

    // Exploration phase: first 30% of trials use random sampling
    const explorationThreshold = 0.3;
    const shouldExplore = completedTrials.length < Math.max(3, trials.length * explorationThreshold);

    if (shouldExplore || completedTrials.length === 0) {
      // Pure random exploration
      for (const [key, space] of Object.entries(params.searchSpace)) {
        if (Array.isArray(space)) {
          nextParams[key] = space[Math.floor(Math.random() * space.length)];
        } else {
          nextParams[key] = Math.random() * (space.max - space.min) + space.min;
        }
      }
    } else {
      // Exploitation phase: sample around best trial
      const bestTrial = completedTrials.reduce((best, trial) => {
        const bestMetric = this.getPrimaryMetric(best.metrics);
        const trialMetric = this.getPrimaryMetric(trial.metrics);
        return trialMetric > bestMetric ? trial : best;
      });

      // Decreasing variance as we get more trials
      const variance = Math.max(0.05, 0.3 * (1 - completedTrials.length / (trials.length || 1)));

      for (const [key, space] of Object.entries(params.searchSpace)) {
        if (Array.isArray(space)) {
          // Categorical: favor best, but explore occasionally
          if (Math.random() < 0.7 && bestTrial.parameters[key] !== undefined) {
            nextParams[key] = bestTrial.parameters[key];
          } else {
            nextParams[key] = space[Math.floor(Math.random() * space.length)];
          }
        } else {
          // Continuous: sample around best value with Gaussian noise
          const bestValue = (bestTrial.parameters[key] as number) || (space.min + space.max) / 2;
          const range = space.max - space.min;
          const noise = (Math.random() - 0.5) * 2 * variance * range;
          const candidate = bestValue + noise;

          // Clamp to bounds
          nextParams[key] = Math.max(space.min, Math.min(space.max, candidate));
        }
      }
    }

    return nextParams;
  }

  /**
   * Export experiment results to S3
   */
  async exportExperimentResults(params: {
    tenantId: string;
    experimentId: string;
  }): Promise<string> {
    const status = await this.getExperimentStatus(params);
    const trials = await this.listTrials(params.experimentId);

    const results = {
      experiment: status,
      trials,
      exportedAt: new Date().toISOString(),
    };

    const key = `experiments/${params.tenantId}/${params.experimentId}/results.json`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.artifactsBucket,
        Key: key,
        Body: JSON.stringify(results, null, 2),
        ContentType: 'application/json',
      })
    );

    return key;
  }

  // Private helper methods

  private getPrimaryMetric(metrics: Record<string, number>): number {
    // Use the first metric as primary (would be configurable in production)
    const values = Object.values(metrics);
    return values.length > 0 ? values[0] : 0;
  }
}

/**
 * Create an experiment runner instance
 */
export function createExperimentRunner(params: {
  evolutionTable: string;
  artifactsBucket: string;
  stateMachineArn: string;
}): ExperimentRunner {
  return new ExperimentRunner(params);
}
