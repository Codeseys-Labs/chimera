/**
 * AWS Well-Architected Framework trade-off presentation
 *
 * This module formats Well-Architected evaluations into human-readable
 * presentations that clearly communicate benefits and trade-offs to users.
 *
 * Agents use this to:
 * - Present infrastructure decisions transparently
 * - Show which pillars benefit and which are impacted
 * - Provide actionable recommendations
 * - Enable informed user decision-making
 *
 * @see docs/research/aws-account-agent/01-well-architected-framework.md
 */

import {
  PILLAR_NAMES,
  type InfrastructureChange,
  type TradeoffPresentation,
  type WellArchitectedEvaluation,
  type PillarEvaluation,
  type ImpactSeverity,
} from './types.js';
import { evaluateChange, getPillarsByScore } from './pillar-evaluator.js';

/**
 * Create a complete trade-off presentation from an infrastructure change
 *
 * @param change - The infrastructure change to evaluate and present
 * @returns Formatted trade-off presentation ready for user display
 *
 * @example
 * ```typescript
 * const change: InfrastructureChange = {
 *   type: 'CAPACITY_INCREASE',
 *   description: 'Increase DynamoDB from 100 RCU to 200 RCU',
 *   affectedResources: ['arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions'],
 *   currentState: { capacity: 100, throttlingRate: 0.15 },
 *   desiredState: { capacity: 200, throttlingRate: 0 },
 *   costImpact: 50,
 *   impactedTiers: ['enterprise'],
 * };
 *
 * const presentation = presentTradeoffs(change);
 * console.log(presentation.presentation); // Formatted markdown
 * ```
 */
export function presentTradeoffs(change: InfrastructureChange): TradeoffPresentation {
  // Evaluate the change against all six pillars
  const evaluation = evaluateChange(change);

  // Extract benefits (POSITIVE pillars)
  const positivePillars = getPillarsByScore(evaluation, 'POSITIVE');
  const benefits = positivePillars.map((p) => ({
    pillar: p.pillar,
    pillarName: PILLAR_NAMES[p.pillar],
    description: p.rationale,
  }));

  // Extract trade-offs (NEGATIVE pillars)
  const negativePillars = getPillarsByScore(evaluation, 'NEGATIVE');
  const tradeoffs = negativePillars.map((p) => ({
    pillar: p.pillar,
    pillarName: PILLAR_NAMES[p.pillar],
    severity: p.severity || 'MINOR',
    description: p.rationale,
  }));

  // Format the presentation text
  const presentation = formatPresentation(change, evaluation, benefits, tradeoffs);

  // Build recommendation
  const recommendation = {
    decision: evaluation.recommendation,
    reasoning: generateRecommendationReasoning(
      evaluation,
      benefits,
      tradeoffs,
      change
    ),
  };

  return {
    change,
    evaluation,
    presentation,
    benefits,
    tradeoffs,
    recommendation,
  };
}

/**
 * Format the complete presentation as markdown text
 */
function formatPresentation(
  change: InfrastructureChange,
  evaluation: WellArchitectedEvaluation,
  benefits: TradeoffPresentation['benefits'],
  tradeoffs: TradeoffPresentation['tradeoffs']
): string {
  const lines: string[] = [];

  // Header
  lines.push(`## Well-Architected Analysis\n`);
  lines.push(`**Proposed Change:** ${change.description}\n`);

  // Benefits section
  if (benefits.length > 0) {
    lines.push(`### ✅ Benefits\n`);
    for (const benefit of benefits) {
      lines.push(`- **${benefit.pillarName}** — ${benefit.description}`);
    }
    lines.push('');
  }

  // Trade-offs section
  if (tradeoffs.length > 0) {
    lines.push(`### ${getTradeoffSectionEmoji(tradeoffs)} Trade-offs\n`);
    for (const tradeoff of tradeoffs) {
      const emoji = getSeverityEmoji(tradeoff.severity);
      lines.push(`- ${emoji} **${tradeoff.pillarName}** — ${tradeoff.description}`);
    }
    lines.push('');
  }

  // Neutral pillars (optional, can be verbose)
  const neutralPillars = getPillarsByScore(evaluation, 'NEUTRAL');
  if (neutralPillars.length > 0 && neutralPillars.length <= 3) {
    lines.push(`### ✔️ No Impact\n`);
    for (const pillar of neutralPillars) {
      lines.push(`- **${PILLAR_NAMES[pillar.pillar]}** — ${pillar.rationale}`);
    }
    lines.push('');
  }

  // Recommendations section
  const hasRecommendations = Object.values(evaluation.pillars).some(
    (p) => p.recommendations && p.recommendations.length > 0
  );

  if (hasRecommendations) {
    lines.push(`### 💡 Recommendations\n`);
    for (const pillar of Object.values(evaluation.pillars)) {
      if (pillar.recommendations && pillar.recommendations.length > 0) {
        lines.push(`**${PILLAR_NAMES[pillar.pillar]}:**`);
        for (const rec of pillar.recommendations) {
          lines.push(`- ${rec}`);
        }
        lines.push('');
      }
    }
  }

  // Cost impact (if applicable)
  if (change.costImpact !== undefined && change.costImpact !== 0) {
    const costChange =
      change.costImpact > 0
        ? `+$${change.costImpact.toFixed(2)}/month`
        : `-$${Math.abs(change.costImpact).toFixed(2)}/month`;
    lines.push(`**Estimated Cost Impact:** ${costChange}\n`);
  }

  // Impacted tiers (if applicable)
  if (change.impactedTiers && change.impactedTiers.length > 0) {
    lines.push(
      `**Impacted Tiers:** ${change.impactedTiers.join(', ')}\n`
    );
  }

  return lines.join('\n');
}

/**
 * Generate reasoning for the overall recommendation
 */
function generateRecommendationReasoning(
  evaluation: WellArchitectedEvaluation,
  benefits: TradeoffPresentation['benefits'],
  tradeoffs: TradeoffPresentation['tradeoffs'],
  change: InfrastructureChange
): string {
  const { recommendation } = evaluation;

  if (recommendation === 'REJECT') {
    const majorTradeoffs = tradeoffs.filter((t) => t.severity === 'MAJOR');
    return `This change has major negative impacts on ${majorTradeoffs.map((t) => t.pillarName).join(', ')}. Alternative approaches should be considered before proceeding.`;
  }

  if (recommendation === 'APPROVE_WITH_CAUTION') {
    const benefitCount = benefits.length;
    const tradeoffCount = tradeoffs.length;

    if (benefitCount > tradeoffCount) {
      return `The benefits (${benefitCount} pillars improved) outweigh the trade-offs (${tradeoffCount} pillars impacted). Proceed with awareness of the documented trade-offs.`;
    }

    if (change.impactedTiers?.includes('enterprise')) {
      return `While there are trade-offs, the impact on enterprise tier tenants justifies this change. Monitor the affected pillars closely.`;
    }

    return `This change involves trade-offs across ${tradeoffCount} pillar(s). Review the specific impacts and ensure they align with your priorities before proceeding.`;
  }

  // APPROVE
  if (benefits.length === 0) {
    return 'This change has no significant impact on any Well-Architected pillar. It is safe to proceed.';
  }

  return `This change positively impacts ${benefits.length} pillar(s) with no negative trade-offs. It is recommended to proceed.`;
}

/**
 * Get emoji for trade-off section header based on severity
 */
function getTradeoffSectionEmoji(
  tradeoffs: TradeoffPresentation['tradeoffs']
): string {
  const hasMajor = tradeoffs.some((t) => t.severity === 'MAJOR');
  if (hasMajor) return '❌';

  const hasModerate = tradeoffs.some((t) => t.severity === 'MODERATE');
  if (hasModerate) return '⚠️';

  return '⚠️';
}

/**
 * Get emoji for a specific severity level
 */
function getSeverityEmoji(severity: ImpactSeverity): string {
  switch (severity) {
    case 'MAJOR':
      return '❌';
    case 'MODERATE':
      return '⚠️';
    case 'MINOR':
      return '⚠️';
  }
}

/**
 * Create a compact one-line summary of the trade-off
 *
 * Useful for notifications or quick summaries
 */
export function createCompactSummary(presentation: TradeoffPresentation): string {
  const benefitCount = presentation.benefits.length;
  const tradeoffCount = presentation.tradeoffs.length;

  if (benefitCount === 0 && tradeoffCount === 0) {
    return `${presentation.change.description} (no significant impact)`;
  }

  if (tradeoffCount === 0) {
    return `${presentation.change.description} (✅ ${benefitCount} pillars improved)`;
  }

  if (benefitCount === 0) {
    return `${presentation.change.description} (⚠️ ${tradeoffCount} pillars impacted)`;
  }

  return `${presentation.change.description} (✅ ${benefitCount} improved, ⚠️ ${tradeoffCount} impacted)`;
}

/**
 * Format a detailed comparison table (markdown)
 *
 * Shows all six pillars with their scores side-by-side
 */
export function createPillarComparisonTable(
  evaluation: WellArchitectedEvaluation
): string {
  const lines: string[] = [];

  lines.push('| Pillar | Score | Impact |');
  lines.push('|--------|-------|--------|');

  for (const pillar of Object.values(evaluation.pillars)) {
    const emoji =
      pillar.score === 'POSITIVE'
        ? '✅'
        : pillar.score === 'NEGATIVE'
          ? getSeverityEmoji(pillar.severity || 'MINOR')
          : '✔️';

    lines.push(
      `| ${PILLAR_NAMES[pillar.pillar]} | ${emoji} ${pillar.score} | ${pillar.rationale} |`
    );
  }

  return lines.join('\n');
}

/**
 * Format presentation for Slack (using Slack markdown)
 */
export function formatForSlack(presentation: TradeoffPresentation): string {
  const lines: string[] = [];

  // Header with emoji indicator
  const emoji =
    presentation.recommendation.decision === 'APPROVE'
      ? ':white_check_mark:'
      : presentation.recommendation.decision === 'APPROVE_WITH_CAUTION'
        ? ':warning:'
        : ':x:';

  lines.push(`${emoji} *Well-Architected Analysis*\n`);
  lines.push(`*Proposed Change:* ${presentation.change.description}\n`);

  // Benefits
  if (presentation.benefits.length > 0) {
    lines.push(`*Benefits:*`);
    for (const benefit of presentation.benefits) {
      lines.push(`• :white_check_mark: *${benefit.pillarName}* — ${benefit.description}`);
    }
    lines.push('');
  }

  // Trade-offs
  if (presentation.tradeoffs.length > 0) {
    lines.push(`*Trade-offs:*`);
    for (const tradeoff of presentation.tradeoffs) {
      const emoji = tradeoff.severity === 'MAJOR' ? ':x:' : ':warning:';
      lines.push(`• ${emoji} *${tradeoff.pillarName}* — ${tradeoff.description}`);
    }
    lines.push('');
  }

  // Recommendation
  lines.push(`*Recommendation:* ${presentation.recommendation.reasoning}`);

  return lines.join('\n');
}

/**
 * Format presentation for email (plain text)
 */
export function formatForEmail(presentation: TradeoffPresentation): string {
  const lines: string[] = [];

  lines.push('AWS Well-Architected Analysis');
  lines.push('='.repeat(50));
  lines.push('');
  lines.push(`Proposed Change: ${presentation.change.description}`);
  lines.push('');

  // Benefits
  if (presentation.benefits.length > 0) {
    lines.push('BENEFITS:');
    for (const benefit of presentation.benefits) {
      lines.push(`  ✓ ${benefit.pillarName}: ${benefit.description}`);
    }
    lines.push('');
  }

  // Trade-offs
  if (presentation.tradeoffs.length > 0) {
    lines.push('TRADE-OFFS:');
    for (const tradeoff of presentation.tradeoffs) {
      const indicator = tradeoff.severity === 'MAJOR' ? '✗' : '⚠';
      lines.push(`  ${indicator} ${tradeoff.pillarName}: ${tradeoff.description}`);
    }
    lines.push('');
  }

  // Recommendation
  lines.push('RECOMMENDATION:');
  lines.push(`  ${presentation.recommendation.decision}`);
  lines.push(`  ${presentation.recommendation.reasoning}`);
  lines.push('');

  if (presentation.change.costImpact) {
    const costChange =
      presentation.change.costImpact > 0
        ? `+$${presentation.change.costImpact.toFixed(2)}/month`
        : `-$${Math.abs(presentation.change.costImpact).toFixed(2)}/month`;
    lines.push(`Estimated Cost Impact: ${costChange}`);
  }

  lines.push('');
  lines.push('='.repeat(50));

  return lines.join('\n');
}

/**
 * Generate a structured JSON representation for API responses
 */
export function formatForAPI(presentation: TradeoffPresentation): Record<string, unknown> {
  return {
    change: {
      type: presentation.change.type,
      description: presentation.change.description,
      affectedResources: presentation.change.affectedResources,
      costImpact: presentation.change.costImpact,
      impactedTiers: presentation.change.impactedTiers,
    },
    evaluation: {
      recommendation: presentation.evaluation.recommendation,
      evaluatedAt: presentation.evaluation.evaluatedAt,
      summary: presentation.evaluation.summary,
    },
    pillars: Object.fromEntries(
      Object.entries(presentation.evaluation.pillars).map(([key, pillar]) => [
        key,
        {
          score: pillar.score,
          severity: pillar.severity,
          rationale: pillar.rationale,
          metrics: pillar.metrics,
          recommendations: pillar.recommendations,
        },
      ])
    ),
    benefits: presentation.benefits.map((b) => ({
      pillar: b.pillar,
      pillarName: b.pillarName,
      description: b.description,
    })),
    tradeoffs: presentation.tradeoffs.map((t) => ({
      pillar: t.pillar,
      pillarName: t.pillarName,
      severity: t.severity,
      description: t.description,
    })),
    recommendation: {
      decision: presentation.recommendation.decision,
      reasoning: presentation.recommendation.reasoning,
    },
  };
}
