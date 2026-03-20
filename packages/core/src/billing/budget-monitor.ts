/**
 * Budget Monitor
 *
 * Monitors tenant spending against budget limits and triggers alerts
 * Works with CostTracker and TenantService to enforce budget policies
 */

import { CostAlert, TenantModelConfig } from '@chimera/shared';
import { CostTracker, CostTrackerConfig } from './cost-tracker';

/**
 * Budget monitor configuration
 */
export interface BudgetMonitorConfig extends CostTrackerConfig {
  /** Function to send alert notifications (email, SNS, etc.) */
  sendAlert?: (alert: CostAlert) => Promise<void>;

  /** Function to get tenant model config (for budget limits) */
  getTenantBudget: (tenantId: string) => Promise<{ budgetUsd: number; threshold: number }>;
}

/**
 * Budget check result
 */
export interface BudgetCheckResult {
  withinBudget: boolean;
  currentSpend: number;
  budgetLimit: number;
  percentUsed: number;
  thresholdExceeded: boolean;
  thresholdPercent: number;
  projectedOverage?: number;
}

/**
 * Budget enforcement action
 */
export type BudgetAction = 'allow' | 'warn' | 'block';

/**
 * Budget Monitor
 *
 * Monitors monthly spending and enforces budget policies:
 * - Alerts when threshold is reached (e.g., 80% of budget)
 * - Blocks requests when budget is fully exceeded (100%)
 * - Provides spending projections for proactive management
 *
 * Integrates with CostTracker for spend data and TenantService for budget limits
 */
export class BudgetMonitor {
  private config: BudgetMonitorConfig;
  private costTracker: CostTracker;

  constructor(config: BudgetMonitorConfig) {
    this.config = config;
    this.costTracker = new CostTracker({
      costTrackingTableName: config.costTrackingTableName,
      dynamodb: config.dynamodb,
    });
  }

  /**
   * Check if tenant is within budget
   *
   * @param tenantId - Tenant ID
   * @param period - Optional period (defaults to current month)
   * @returns Budget check result
   */
  async checkBudget(tenantId: string, period?: string): Promise<BudgetCheckResult> {
    // Get tenant budget configuration
    const { budgetUsd, threshold } = await this.config.getTenantBudget(tenantId);

    // Get current spending
    const summary = await this.costTracker.getCostSummary(tenantId, budgetUsd, period);

    const percentUsed = summary.percentUsed;
    const thresholdExceeded = percentUsed >= threshold * 100;
    const withinBudget = summary.totalCostUsd < budgetUsd;

    const result: BudgetCheckResult = {
      withinBudget,
      currentSpend: summary.totalCostUsd,
      budgetLimit: budgetUsd,
      percentUsed,
      thresholdExceeded,
      thresholdPercent: threshold * 100,
    };

    // Calculate projected overage if spending is above budget
    if (!withinBudget) {
      result.projectedOverage = summary.projectedMonthlySpend - budgetUsd;
    }

    return result;
  }

  /**
   * Determine budget enforcement action
   *
   * @param tenantId - Tenant ID
   * @returns Action to take: allow, warn, or block
   */
  async getBudgetAction(tenantId: string): Promise<BudgetAction> {
    const check = await this.checkBudget(tenantId);

    if (!check.withinBudget) {
      // Budget exceeded = block requests
      return 'block';
    }

    if (check.thresholdExceeded) {
      // Threshold exceeded = warn but allow
      return 'warn';
    }

    // Within budget and threshold = allow
    return 'allow';
  }

  /**
   * Check budget and send alert if threshold exceeded
   *
   * Called periodically (e.g., after each cost recording) to monitor spending
   *
   * @param tenantId - Tenant ID
   * @returns Alert sent status
   */
  async checkAndAlert(tenantId: string): Promise<boolean> {
    const check = await this.checkBudget(tenantId);

    // Only alert if threshold exceeded and we have alert handler
    if (!check.thresholdExceeded || !this.config.sendAlert) {
      return false;
    }

    // Check if we've already sent an alert this period
    const cost = await this.costTracker.getMonthlyCost(tenantId);
    if (cost?.budgetExceeded) {
      // Already alerted this period, don't spam
      return false;
    }

    // Create alert
    const alert: CostAlert = {
      tenantId,
      period: cost?.period || new Date().toISOString().substring(0, 7),
      currentSpend: check.currentSpend,
      budgetLimit: check.budgetLimit,
      thresholdPercent: check.thresholdPercent / 100,
      triggeredAt: new Date().toISOString(),
      notificationSent: false,
    };

    try {
      // Send alert notification
      await this.config.sendAlert(alert);
      alert.notificationSent = true;

      // Mark budget as exceeded to prevent duplicate alerts
      await this.costTracker.markBudgetExceeded(tenantId);

      return true;
    } catch (error) {
      console.error(`Failed to send budget alert for tenant ${tenantId}:`, error);
      return false;
    }
  }

  /**
   * Get spending trend (comparing current period to previous)
   *
   * @param tenantId - Tenant ID
   * @returns Trend data
   */
  async getSpendingTrend(tenantId: string): Promise<{
    currentPeriod: string;
    currentSpend: number;
    previousPeriod: string;
    previousSpend: number;
    percentChange: number;
    isIncreasing: boolean;
  }> {
    const history = await this.costTracker.getCostHistory(tenantId, 2);

    const current = history[0] || {
      period: new Date().toISOString().substring(0, 7),
      totalCostUsd: 0,
    };

    const previous = history[1] || {
      period: new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().substring(0, 7),
      totalCostUsd: 0,
    };

    const percentChange = previous.totalCostUsd > 0 ? ((current.totalCostUsd - previous.totalCostUsd) / previous.totalCostUsd) * 100 : 0;

    return {
      currentPeriod: current.period,
      currentSpend: current.totalCostUsd,
      previousPeriod: previous.period,
      previousSpend: previous.totalCostUsd,
      percentChange,
      isIncreasing: percentChange > 0,
    };
  }

  /**
   * Estimate remaining budget based on current burn rate
   *
   * @param tenantId - Tenant ID
   * @returns Estimated days until budget exhausted (null if within safe limits)
   */
  async estimateBudgetRunway(tenantId: string): Promise<number | null> {
    const { budgetUsd } = await this.config.getTenantBudget(tenantId);
    const summary = await this.costTracker.getCostSummary(tenantId, budgetUsd);

    if (summary.totalCostUsd === 0) {
      return null; // No spending yet
    }

    // Calculate daily burn rate
    const now = new Date();
    const daysElapsed = now.getUTCDate();
    const dailyBurnRate = summary.totalCostUsd / daysElapsed;

    // Remaining budget
    const remainingBudget = budgetUsd - summary.totalCostUsd;

    if (remainingBudget <= 0) {
      return 0; // Budget already exhausted
    }

    // Days until budget exhausted
    const daysRemaining = Math.floor(remainingBudget / dailyBurnRate);

    return daysRemaining;
  }

  /**
   * Get budget health score (0-100)
   *
   * 100 = healthy (low spend, well within budget)
   * 50 = caution (approaching threshold)
   * 0 = critical (exceeded budget)
   *
   * @param tenantId - Tenant ID
   * @returns Health score 0-100
   */
  async getBudgetHealth(tenantId: string): Promise<number> {
    const check = await this.checkBudget(tenantId);

    if (!check.withinBudget) {
      // Budget exceeded = 0 health
      return 0;
    }

    if (check.percentUsed >= 100) {
      return 0;
    }

    // Linear scale from 0-100 based on percent used
    // 0% used = 100 health
    // 100% used = 0 health
    return Math.max(0, Math.floor(100 - check.percentUsed));
  }

  /**
   * Check if tenant should be rate-limited due to budget
   *
   * @param tenantId - Tenant ID
   * @returns True if should rate limit
   */
  async shouldRateLimit(tenantId: string): Promise<boolean> {
    const action = await this.getBudgetAction(tenantId);
    return action === 'block';
  }

  /**
   * Get budget recommendations
   *
   * Provides actionable insights based on spending patterns
   *
   * @param tenantId - Tenant ID
   * @returns Array of recommendation strings
   */
  async getRecommendations(tenantId: string): Promise<string[]> {
    const recommendations: string[] = [];

    const check = await this.checkBudget(tenantId);
    const trend = await this.getSpendingTrend(tenantId);
    const runway = await this.estimateBudgetRunway(tenantId);

    // Budget exceeded
    if (!check.withinBudget) {
      recommendations.push(`Budget exceeded by $${(check.currentSpend - check.budgetLimit).toFixed(2)}. Consider increasing budget or reducing usage.`);
    }

    // Approaching budget
    if (check.thresholdExceeded && check.withinBudget) {
      recommendations.push(`Budget threshold reached (${check.percentUsed.toFixed(1)}%). Monitor usage closely.`);
    }

    // Rapid spending increase
    if (trend.isIncreasing && trend.percentChange > 50) {
      recommendations.push(`Spending increased ${trend.percentChange.toFixed(1)}% vs last month. Review cost drivers.`);
    }

    // Low runway
    if (runway !== null && runway < 7) {
      recommendations.push(`Budget will be exhausted in ~${runway} days at current rate. Take action now.`);
    }

    // Spending spike
    if (check.projectedOverage && check.projectedOverage > check.budgetLimit * 0.5) {
      recommendations.push(`Projected to exceed budget by $${check.projectedOverage.toFixed(2)} this month. Review high-cost services.`);
    }

    return recommendations;
  }
}
