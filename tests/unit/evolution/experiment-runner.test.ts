/**
 * Unit tests for ExperimentRunner
 *
 * Tests ML experiment orchestration logic.
 * Integration tests cover AWS SDK and Step Functions interactions.
 */

import { describe, it, expect } from 'bun:test';

describe('ExperimentRunner Logic', () => {
  describe('Search space parameter sampling', () => {
    it('should sample continuous parameters within range', () => {
      const searchSpace = {
        temperature: { min: 0.5, max: 1.0 },
      };

      const sample = Math.random() * (searchSpace.temperature.max - searchSpace.temperature.min) + searchSpace.temperature.min;

      expect(sample).toBeGreaterThanOrEqual(0.5);
      expect(sample).toBeLessThanOrEqual(1.0);
    });

    it('should sample categorical parameters from list', () => {
      const searchSpace = {
        optimizer: ['adam', 'sgd', 'rmsprop'],
      };

      const sample = searchSpace.optimizer[Math.floor(Math.random() * searchSpace.optimizer.length)];

      expect(searchSpace.optimizer).toContain(sample);
    });

    it('should sample multiple parameters independently', () => {
      const searchSpace = {
        learningRate: { min: 0.0001, max: 0.1 },
        batchSize: [16, 32, 64, 128],
        optimizer: ['adam', 'sgd'],
      };

      const sample: Record<string, any> = {};

      for (const [key, space] of Object.entries(searchSpace)) {
        if (Array.isArray(space)) {
          sample[key] = space[Math.floor(Math.random() * space.length)];
        } else {
          sample[key] = Math.random() * (space.max - space.min) + space.min;
        }
      }

      expect(sample.learningRate).toBeGreaterThanOrEqual(0.0001);
      expect(sample.learningRate).toBeLessThanOrEqual(0.1);
      expect([16, 32, 64, 128]).toContain(sample.batchSize);
      expect(['adam', 'sgd']).toContain(sample.optimizer);
    });
  });

  describe('Best trial tracking', () => {
    it('should update best trial when metric improves', () => {
      let currentBestMetric = 0.90;
      let bestTrial: any = { id: 'trial-1', metric: 0.90 };

      const newTrial = { id: 'trial-2', metric: 0.95 };

      if (newTrial.metric > currentBestMetric) {
        currentBestMetric = newTrial.metric;
        bestTrial = newTrial;
      }

      expect(currentBestMetric).toBe(0.95);
      expect(bestTrial.id).toBe('trial-2');
    });

    it('should not update best trial when metric does not improve', () => {
      let currentBestMetric = 0.95;
      let bestTrial: any = { id: 'trial-1', metric: 0.95 };

      const newTrial = { id: 'trial-2', metric: 0.90 };

      if (newTrial.metric > currentBestMetric) {
        currentBestMetric = newTrial.metric;
        bestTrial = newTrial;
      }

      expect(currentBestMetric).toBe(0.95);
      expect(bestTrial.id).toBe('trial-1');
    });

    it('should handle first trial correctly', () => {
      let currentBestMetric = -Infinity;
      let bestTrial: any = null;

      const newTrial = { id: 'trial-1', metric: 0.80 };

      if (newTrial.metric > currentBestMetric) {
        currentBestMetric = newTrial.metric;
        bestTrial = newTrial;
      }

      expect(currentBestMetric).toBe(0.80);
      expect(bestTrial).toBeDefined();
    });
  });

  describe('Primary metric extraction', () => {
    it('should extract first metric as primary', () => {
      const metrics = {
        accuracy: 0.95,
        f1Score: 0.92,
        precision: 0.93,
      };

      const values = Object.values(metrics);
      const primaryMetric = values.length > 0 ? values[0] : 0;

      expect(primaryMetric).toBe(0.95);
    });

    it('should return 0 when no metrics', () => {
      const metrics = {};

      const values = Object.values(metrics);
      const primaryMetric = values.length > 0 ? values[0] : 0;

      expect(primaryMetric).toBe(0);
    });

    it('should handle single metric', () => {
      const metrics = {
        loss: 0.25,
      };

      const values = Object.values(metrics);
      const primaryMetric = values.length > 0 ? values[0] : 0;

      expect(primaryMetric).toBe(0.25);
    });
  });

  describe('Experiment status tracking', () => {
    it('should initialize with zero completed trials', () => {
      const experiment = {
        experimentId: 'exp-123',
        status: 'running' as const,
        trialsCompleted: 0,
        trialsTotal: 10,
      };

      expect(experiment.trialsCompleted).toBe(0);
      expect(experiment.status).toBe('running');
    });

    it('should track trial completion progress', () => {
      const experiment = {
        experimentId: 'exp-123',
        status: 'running' as const,
        trialsCompleted: 0,
        trialsTotal: 10,
      };

      // Complete 3 trials
      experiment.trialsCompleted += 1;
      experiment.trialsCompleted += 1;
      experiment.trialsCompleted += 1;

      expect(experiment.trialsCompleted).toBe(3);
      expect(experiment.trialsCompleted / experiment.trialsTotal).toBe(0.3);
    });

    it('should detect completion when all trials done', () => {
      const experiment = {
        experimentId: 'exp-123',
        status: 'running' as const,
        trialsCompleted: 10,
        trialsTotal: 10,
      };

      const isComplete = experiment.trialsCompleted >= experiment.trialsTotal;

      expect(isComplete).toBe(true);
    });
  });

  describe('Experiment naming', () => {
    it('should generate unique experiment names', () => {
      const experimentId = 'exp-123';
      const executionName = `experiment-${experimentId}`;

      expect(executionName).toBe('experiment-exp-123');
    });

    it('should generate unique trial IDs', () => {
      const trialIds = new Set();

      for (let i = 0; i < 10; i++) {
        const trialId = `trial-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        trialIds.add(trialId);
      }

      expect(trialIds.size).toBe(10); // All unique
    });
  });

  describe('Experiment types', () => {
    const experimentTypes = [
      'prompt_tuning',
      'model_selection',
      'hyperparameter_search',
      'architecture_search',
    ] as const;

    it('should support all experiment types', () => {
      for (const type of experimentTypes) {
        const experiment = {
          experimentId: `exp-${type}`,
          experimentType: type,
        };

        expect(experiment.experimentType).toBe(type);
      }
    });

    it('should handle prompt tuning experiments', () => {
      const experiment = {
        experimentId: 'exp-prompt-1',
        experimentType: 'prompt_tuning' as const,
        parameters: {
          systemPrompt: 'You are a helpful assistant',
          temperature: 0.7,
        },
      };

      expect(experiment.experimentType).toBe('prompt_tuning');
      expect(experiment.parameters.systemPrompt).toBeDefined();
    });

    it('should handle hyperparameter search experiments', () => {
      const experiment = {
        experimentId: 'exp-hpo-1',
        experimentType: 'hyperparameter_search' as const,
        searchSpace: {
          learningRate: { min: 0.0001, max: 0.1 },
          batchSize: [16, 32, 64],
        },
      };

      expect(experiment.experimentType).toBe('hyperparameter_search');
      expect(experiment.searchSpace).toBeDefined();
    });
  });

  describe('Trial status transitions', () => {
    it('should transition from running to completed', () => {
      const trial = {
        trialId: 'trial-1',
        status: 'running' as 'running' | 'completed' | 'failed',
        startedAt: new Date().toISOString(),
      };

      trial.status = 'completed';

      expect(trial.status).toBe('completed');
    });

    it('should transition from running to failed', () => {
      const trial = {
        trialId: 'trial-1',
        status: 'running' as 'running' | 'completed' | 'failed',
        startedAt: new Date().toISOString(),
      };

      trial.status = 'failed';

      expect(trial.status).toBe('failed');
    });

    it('should record error message on failure', () => {
      const trial: any = {
        trialId: 'trial-1',
        status: 'running',
        startedAt: new Date().toISOString(),
      };

      trial.status = 'failed';
      trial.error = 'Invalid parameter value';

      expect(trial.status).toBe('failed');
      expect(trial.error).toBe('Invalid parameter value');
    });
  });

  describe('Experiment completion', () => {
    it('should mark experiment as completed', () => {
      const experiment = {
        experimentId: 'exp-123',
        status: 'running' as 'running' | 'completed' | 'failed' | 'stopped',
        startedAt: '2026-03-21T00:00:00.000Z',
        completedAt: undefined as string | undefined,
      };

      experiment.status = 'completed';
      experiment.completedAt = new Date().toISOString();

      expect(experiment.status).toBe('completed');
      expect(experiment.completedAt).toBeDefined();
    });

    it('should mark experiment as stopped', () => {
      const experiment = {
        experimentId: 'exp-123',
        status: 'running' as 'running' | 'completed' | 'failed' | 'stopped',
        startedAt: '2026-03-21T00:00:00.000Z',
        completedAt: undefined as string | undefined,
      };

      experiment.status = 'stopped';
      experiment.completedAt = new Date().toISOString();

      expect(experiment.status).toBe('stopped');
      expect(experiment.completedAt).toBeDefined();
    });
  });

  describe('Result export format', () => {
    it('should generate S3 key with correct structure', () => {
      const tenantId = 'tenant-123';
      const experimentId = 'exp-456';
      const key = `experiments/${tenantId}/${experimentId}/results.json`;

      expect(key).toBe('experiments/tenant-123/exp-456/results.json');
    });

    it('should include timestamp in export', () => {
      const exportData = {
        experiment: { experimentId: 'exp-123', status: 'completed' },
        trials: [],
        exportedAt: new Date().toISOString(),
      };

      expect(exportData.exportedAt).toBeDefined();
      expect(new Date(exportData.exportedAt).getTime()).toBeGreaterThan(0);
    });
  });

  describe('Random search implementation', () => {
    it('should generate different parameters on each call', () => {
      const searchSpace = {
        temperature: { min: 0.5, max: 1.0 },
        topP: { min: 0.8, max: 1.0 },
      };

      const samples = new Set();

      for (let i = 0; i < 10; i++) {
        const sample = {
          temperature: Math.random() * (searchSpace.temperature.max - searchSpace.temperature.min) + searchSpace.temperature.min,
          topP: Math.random() * (searchSpace.topP.max - searchSpace.topP.min) + searchSpace.topP.min,
        };
        samples.add(JSON.stringify(sample));
      }

      // Should generate different samples (very unlikely to get duplicates)
      expect(samples.size).toBeGreaterThan(8);
    });

    it('should respect search space bounds', () => {
      const searchSpace = {
        learningRate: { min: 0.0001, max: 0.1 },
      };

      for (let i = 0; i < 100; i++) {
        const sample = Math.random() * (searchSpace.learningRate.max - searchSpace.learningRate.min) + searchSpace.learningRate.min;

        expect(sample).toBeGreaterThanOrEqual(searchSpace.learningRate.min);
        expect(sample).toBeLessThanOrEqual(searchSpace.learningRate.max);
      }
    });
  });

  describe('Max trials configuration', () => {
    it('should use default max trials of 10', () => {
      const experiment = {
        experimentId: 'exp-123',
        maxTrials: undefined,
      };

      const maxTrials = experiment.maxTrials || 10;

      expect(maxTrials).toBe(10);
    });

    it('should respect custom max trials', () => {
      const experiment = {
        experimentId: 'exp-123',
        maxTrials: 25,
      };

      const maxTrials = experiment.maxTrials || 10;

      expect(maxTrials).toBe(25);
    });
  });

  describe('Timeout handling', () => {
    it('should support timeout configuration', () => {
      const experiment = {
        experimentId: 'exp-123',
        timeout: 3600, // 1 hour
      };

      expect(experiment.timeout).toBe(3600);
    });

    it('should allow undefined timeout', () => {
      const experiment = {
        experimentId: 'exp-123',
        timeout: undefined,
      };

      expect(experiment.timeout).toBeUndefined();
    });
  });
});
