/**
 * ADR Generator
 *
 * Auto-generates Architecture Decision Records from decision logs
 * Implements structured documentation from research/aws-account-agent/04-Auto-Generated-ADRs.md
 */

/**
 * Decision log structure from activity logging system
 */
export interface DecisionLog {
  activityId: string;
  tenantId: string;
  agentId: string;
  timestamp: string;
  question: string;
  selectedOption: string;
  alternatives: Alternative[];
  justification: string;
  context: DecisionContext;
  wellArchitectedPillars: WellArchitectedScore;
  costEstimate: CostEstimate;
  decisionType: string; // e.g., 'infrastructure.database', 'security.encryption'
  confidence: number; // 0-1 score
  tags: Record<string, string>;
}

export interface Alternative {
  option: string;
  score: number; // 0-10
  pros: string[];
  cons: string[];
  wellArchitectedPillars: WellArchitectedScore;
  costEstimate?: CostEstimate;
}

export interface DecisionContext {
  requirements: string[];
  constraints: string[];
  assumptions: string[];
}

export interface WellArchitectedScore {
  operationalExcellence: number;
  security: number;
  reliability: number;
  performanceEfficiency: number;
  costOptimization: number;
  sustainability: number;
}

export interface CostEstimate {
  oneTime: number;
  monthly: number;
  annual: number;
}

/**
 * ADR metadata structure
 */
export interface ADR {
  adrId: string; // e.g., 'ADR-0042'
  number: number;
  title: string;
  status: 'proposed' | 'accepted' | 'deprecated' | 'superseded';
  date: string; // ISO 8601
  decisionId: string;
  agentId: string;
  tenantId: string;
  markdown: string;
  rollbackPlan: RollbackPlan;
  supersedes?: string[]; // ADR IDs
  supersededBy?: string; // ADR ID
}

export interface RollbackPlan {
  summary: string;
  trigger: RollbackTrigger;
  steps: RollbackStep[];
  cost: CostEstimate;
  testingStatus: 'not-tested' | 'tested' | 'failed';
  testDetails?: RollbackTestDetails;
}

export interface RollbackTrigger {
  conditions: string[];
  metrics: string[];
  thresholds: Record<string, number>;
}

export interface RollbackStep {
  step: number;
  description: string;
  code: string;
  estimatedDuration?: string;
}

export interface RollbackTestDetails {
  testDate: string;
  testEnvironment: string;
  testResult: 'success' | 'failure';
  testDuration: string;
  testNotes: string;
}

/**
 * Storage interface for ADR persistence
 */
export interface ADRStorage {
  saveMarkdown(key: string, markdown: string, contentType: string): Promise<void>;
  saveMetadata(adr: ADR): Promise<void>;
  getNextADRNumber(tenantId: string): Promise<number>;
  getADR(decisionId: string): Promise<ADR | null>;
}

/**
 * ADR generator configuration
 */
export interface ADRGeneratorConfig {
  storage: ADRStorage;
  /** Optional git integration for committing ADRs */
  gitEnabled?: boolean;
}

/**
 * ADR Generator
 *
 * Generates Architecture Decision Records from decision logs with:
 * - Consistent markdown formatting
 * - Automated rollback plans
 * - Well-Architected Framework analysis
 * - Cost impact documentation
 */
export class ADRGenerator {
  private config: ADRGeneratorConfig;

  constructor(config: ADRGeneratorConfig) {
    this.config = config;
  }

  /**
   * Generate ADR from decision log
   *
   * Creates a complete Architecture Decision Record including:
   * - Context and requirements
   * - Decision and alternatives
   * - Justification and consequences
   * - Cost impact and compliance
   * - Automated rollback plan
   *
   * @param decision - Decision log from activity logging system
   * @returns Generated ADR with metadata
   */
  async generateADR(decision: DecisionLog): Promise<ADR> {
    // 1. Get next ADR number
    const number = await this.config.storage.getNextADRNumber(decision.tenantId);
    const adrId = `ADR-${number.toString().padStart(4, '0')}`;

    // 2. Generate rollback plan from alternatives
    const rollbackPlan = this.generateRollbackPlan(decision);

    // 3. Generate title from question
    const title = this.generateTitle(decision.question, decision.selectedOption);

    // 4. Render ADR markdown
    const markdown = this.renderADRTemplate({
      adrId,
      number,
      title,
      status: 'accepted',
      date: new Date().toISOString(),
      decisionId: decision.activityId,
      agentId: decision.agentId,
      tenantId: decision.tenantId,
      decision,
      rollbackPlan,
    });

    // 5. Create ADR object
    const adr: ADR = {
      adrId,
      number,
      title,
      status: 'accepted',
      date: new Date().toISOString(),
      decisionId: decision.activityId,
      agentId: decision.agentId,
      tenantId: decision.tenantId,
      markdown,
      rollbackPlan,
    };

    // 6. Save to storage
    await this.saveADR(adr, decision.tenantId);

    return adr;
  }

  /**
   * Generate rollback plan from decision alternatives
   *
   * Analyzes runner-up alternative to create executable rollback procedure
   *
   * @param decision - Decision log
   * @returns Rollback plan with steps and code
   */
  private generateRollbackPlan(decision: DecisionLog): RollbackPlan {
    // Find runner-up alternative (highest score excluding selected)
    const runnerUp = decision.alternatives
      .filter((a) => a.option !== decision.selectedOption)
      .sort((a, b) => b.score - a.score)[0];

    if (!runnerUp) {
      // No alternatives - basic rollback
      return {
        summary: 'No alternative available - manual rollback required',
        trigger: {
          conditions: ['Critical failure', 'Performance degradation > 50%'],
          metrics: ['ErrorRate', 'Latency'],
          thresholds: { ErrorRate: 0.05, Latency: 1000 },
        },
        steps: [
          {
            step: 1,
            description: 'Assess impact and gather requirements',
            code: '# Manual assessment required',
          },
          {
            step: 2,
            description: 'Develop rollback strategy',
            code: '# Contact architecture team',
          },
        ],
        cost: { oneTime: 0, monthly: 0, annual: 0 },
        testingStatus: 'not-tested',
      };
    }

    // Generate rollback plan based on runner-up
    return {
      summary: `Rollback to ${runnerUp.option} (runner-up alternative, score: ${runnerUp.score}/10)`,
      trigger: this.generateRollbackTriggers(decision, runnerUp),
      steps: this.generateRollbackSteps(decision.selectedOption, runnerUp),
      cost: runnerUp.costEstimate || { oneTime: 0, monthly: 0, annual: 0 },
      testingStatus: 'not-tested',
    };
  }

  /**
   * Generate rollback trigger conditions
   */
  private generateRollbackTriggers(decision: DecisionLog, runnerUp: Alternative): RollbackTrigger {
    const conditions: string[] = [];
    const metrics: string[] = [];
    const thresholds: Record<string, number> = {};

    // Cost-based triggers
    if (decision.costEstimate.monthly > (runnerUp.costEstimate?.monthly || 0)) {
      conditions.push(`Actual monthly cost exceeds estimate by > 50%`);
      metrics.push('MonthlyCost');
      thresholds.MonthlyCost = decision.costEstimate.monthly * 1.5;
    }

    // Performance triggers
    conditions.push('Latency exceeds SLA (> 1000ms)');
    metrics.push('P99Latency');
    thresholds.P99Latency = 1000;

    // Reliability triggers
    conditions.push('Error rate > 5%');
    metrics.push('ErrorRate');
    thresholds.ErrorRate = 0.05;

    // Security triggers
    if (decision.decisionType.includes('security')) {
      conditions.push('Security vulnerability discovered (CVSS > 7.0)');
      metrics.push('CVSSScore');
      thresholds.CVSSScore = 7.0;
    }

    return { conditions, metrics, thresholds };
  }

  /**
   * Generate rollback steps
   */
  private generateRollbackSteps(selected: string, runnerUp: Alternative): RollbackStep[] {
    return [
      {
        step: 1,
        description: `Export data from current solution (${selected})`,
        code: this.generateExportCode(selected),
        estimatedDuration: '30 minutes',
      },
      {
        step: 2,
        description: `Deploy ${runnerUp.option}`,
        code: this.generateDeployCode(runnerUp.option),
        estimatedDuration: '45 minutes',
      },
      {
        step: 3,
        description: 'Migrate data to new solution',
        code: this.generateMigrationCode(selected, runnerUp.option),
        estimatedDuration: '1-2 hours (depends on data volume)',
      },
      {
        step: 4,
        description: 'Update application configuration',
        code: this.generateApplicationUpdateCode(selected, runnerUp.option),
        estimatedDuration: '15 minutes',
      },
      {
        step: 5,
        description: 'Verify rollback success',
        code: this.generateVerificationCode(runnerUp.option),
        estimatedDuration: '30 minutes',
      },
      {
        step: 6,
        description: `Delete original resources (${selected})`,
        code: this.generateCleanupCode(selected),
        estimatedDuration: '15 minutes',
      },
    ];
  }

  /**
   * Generate data export code snippet
   */
  private generateExportCode(service: string): string {
    const normalized = service.toLowerCase();

    if (normalized.includes('dynamodb')) {
      return `# Export DynamoDB table to S3
aws dynamodb export-table-to-point-in-time \\
  --table-arn arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE_NAME \\
  --s3-bucket chimera-backups \\
  --s3-prefix exports/$(date +%Y-%m-%d)/`;
    }

    if (normalized.includes('rds') || normalized.includes('aurora')) {
      return `# Create RDS snapshot
aws rds create-db-snapshot \\
  --db-instance-identifier DB_INSTANCE \\
  --db-snapshot-identifier rollback-$(date +%Y%m%d-%H%M%S)`;
    }

    if (normalized.includes('s3')) {
      return `# Sync S3 bucket to backup location
aws s3 sync s3://SOURCE_BUCKET s3://chimera-backups/rollback-$(date +%Y-%m-%d)/`;
    }

    return `# Export data (service-specific implementation required)
echo "Manual data export required for ${service}"`;
  }

  /**
   * Generate deployment code snippet
   */
  private generateDeployCode(service: string): string {
    return `# Deploy ${service} using CDK
cd infra
cdk deploy --context rollbackTarget=${service}

# Or using CloudFormation directly
aws cloudformation create-stack \\
  --stack-name chimera-${service.toLowerCase().replace(/\\s+/g, '-')}-rollback \\
  --template-body file://rollback-template.yaml \\
  --parameters ParameterKey=Service,ParameterValue=${service}`;
  }

  /**
   * Generate data migration code snippet
   */
  private generateMigrationCode(from: string, to: string): string {
    return `# Migrate data from ${from} to ${to}
# 1. Read export from S3
# 2. Transform to target format
# 3. Load into ${to}

# Example: DynamoDB -> RDS
python scripts/migrate-data.py \\
  --source dynamodb \\
  --target rds \\
  --export-path s3://chimera-backups/exports/latest/ \\
  --target-connection $RDS_CONNECTION_STRING`;
  }

  /**
   * Generate application update code snippet
   */
  private generateApplicationUpdateCode(from: string, to: string): string {
    return `# Update environment variables
aws ssm put-parameter \\
  --name /chimera/data-store-type \\
  --value "${to}" \\
  --overwrite

# Restart application (ECS)
aws ecs update-service \\
  --cluster chimera-cluster \\
  --service chimera-api \\
  --force-new-deployment`;
  }

  /**
   * Generate verification code snippet
   */
  private generateVerificationCode(service: string): string {
    return `# Verify ${service} is operational
# 1. Check resource status
# 2. Run smoke tests
# 3. Verify data integrity

# Health check
curl https://api.chimera.example.com/health
# Expected: {"status": "healthy", "dataStore": "${service}"}

# Run integration tests
bun test:integration`;
  }

  /**
   * Generate cleanup code snippet
   */
  private generateCleanupCode(service: string): string {
    return `# Delete original ${service} resources
# WARNING: This is destructive. Ensure rollback is verified first.

aws cloudformation delete-stack \\
  --stack-name chimera-${service.toLowerCase().replace(/\\s+/g, '-')}

# Or manually delete resources with retention
# (keeps final snapshot/backup)`;
  }

  /**
   * Generate ADR title from question and selected option
   */
  private generateTitle(question: string, selectedOption: string): string {
    // Transform question into imperative title
    // "Which database for sessions?" -> "Use DynamoDB for session storage"
    const cleaned = question.replace(/^(which|what|how)\s+/i, '').replace(/\?$/, '');
    return `Use ${selectedOption} for ${cleaned}`;
  }

  /**
   * Render ADR markdown template
   */
  private renderADRTemplate(params: {
    adrId: string;
    number: number;
    title: string;
    status: string;
    date: string;
    decisionId: string;
    agentId: string;
    tenantId: string;
    decision: DecisionLog;
    rollbackPlan: RollbackPlan;
  }): string {
    const { adrId, number, title, status, date, decisionId, agentId, tenantId, decision, rollbackPlan } = params;

    // Format Well-Architected pillars
    const formatPillars = (pillars: WellArchitectedScore): string => {
      return `
- **Operational Excellence:** ${pillars.operationalExcellence}/10
- **Security:** ${pillars.security}/10
- **Reliability:** ${pillars.reliability}/10
- **Performance Efficiency:** ${pillars.performanceEfficiency}/10
- **Cost Optimization:** ${pillars.costOptimization}/10
- **Sustainability:** ${pillars.sustainability}/10`.trim();
    };

    // Format alternatives
    const formatAlternatives = (): string => {
      return decision.alternatives
        .map((alt, idx) => {
          const isSelected = alt.option === decision.selectedOption;
          return `
### ${idx + 1}. ${alt.option} (Score: ${alt.score}/10) ${isSelected ? '✓ SELECTED' : ''}

**Pros:**
${alt.pros.map((p) => `- ${p}`).join('\n')}

**Cons:**
${alt.cons.map((c) => `- ${c}`).join('\n')}

**Well-Architected Pillars:**
${formatPillars(alt.wellArchitectedPillars)}
${alt.costEstimate ? `\n**Estimated Cost:** $${alt.costEstimate.monthly}/month` : ''}`;
        })
        .join('\n\n');
    };

    // Format rollback steps
    const formatRollbackSteps = (): string => {
      return rollbackPlan.steps
        .map(
          (step) => `
#### Step ${step.step}: ${step.description}

\`\`\`bash
${step.code}
\`\`\`
${step.estimatedDuration ? `**Estimated Duration:** ${step.estimatedDuration}` : ''}`
        )
        .join('\n\n');
    };

    return `# ${adrId}: ${title}

**Status:** ${status}
**Date:** ${date}
**Decision ID:** ${decisionId}
**Agent:** ${agentId}
**Tenant:** ${tenantId}

---

## Context

${decision.context.requirements.length > 0 ? `### Requirements\n${decision.context.requirements.map((r) => `- ${r}`).join('\n')}` : ''}

${decision.context.constraints.length > 0 ? `\n### Constraints\n${decision.context.constraints.map((c) => `- ${c}`).join('\n')}` : ''}

${decision.context.assumptions.length > 0 ? `\n### Assumptions\n${decision.context.assumptions.map((a) => `- ${a}`).join('\n')}` : ''}

---

## Decision

**Selected:** ${decision.selectedOption}

${decision.justification}

---

## Alternatives Considered

${formatAlternatives()}

---

## Justification

${decision.justification}

**Confidence Level:** ${(decision.confidence * 100).toFixed(0)}%

---

## Consequences

### Positive
${decision.alternatives
  .find((a) => a.option === decision.selectedOption)
  ?.pros.map((p) => `- ${p}`)
  .join('\n') || '- (none specified)'}

### Negative
${decision.alternatives
  .find((a) => a.option === decision.selectedOption)
  ?.cons.map((c) => `- ${c}`)
  .join('\n') || '- (none specified)'}

---

## Cost Impact

- **One-time:** $${decision.costEstimate.oneTime.toFixed(2)}
- **Monthly:** $${decision.costEstimate.monthly.toFixed(2)}
- **Annual:** $${decision.costEstimate.annual.toFixed(2)}

---

## Compliance

### Well-Architected Framework
${formatPillars(decision.wellArchitectedPillars)}

---

## Implementation

\`\`\`typescript
// Implementation details tracked via decision log: ${decisionId}
// See activity logs for resource creation details
\`\`\`

**Tags:**
${Object.entries(decision.tags)
  .map(([k, v]) => `- \`${k}\`: ${v}`)
  .join('\n')}

---

## Rollback Plan

### Summary
${rollbackPlan.summary}

### Rollback Triggers

**Conditions:**
${rollbackPlan.trigger.conditions.map((c) => `- ${c}`).join('\n')}

**Metrics to Monitor:**
${rollbackPlan.trigger.metrics.map((m) => `- ${m}`).join('\n')}

**Thresholds:**
${Object.entries(rollbackPlan.trigger.thresholds)
  .map(([metric, value]) => `- ${metric}: ${value}`)
  .join('\n')}

### Rollback Steps

${formatRollbackSteps()}

### Rollback Cost
- **One-time:** $${rollbackPlan.cost.oneTime.toFixed(2)}
- **Monthly:** $${rollbackPlan.cost.monthly.toFixed(2)}
- **Annual:** $${rollbackPlan.cost.annual.toFixed(2)}

### Testing Status
**Status:** ${rollbackPlan.testingStatus}
${rollbackPlan.testDetails ? `\n**Test Date:** ${rollbackPlan.testDetails.testDate}\n**Environment:** ${rollbackPlan.testDetails.testEnvironment}\n**Result:** ${rollbackPlan.testDetails.testResult}\n**Duration:** ${rollbackPlan.testDetails.testDuration}\n**Notes:** ${rollbackPlan.testDetails.testNotes}` : ''}

---

## Related Resources

- **Decision Log:** ${decisionId}
${Object.entries(decision.tags)
  .filter(([k]) => k.includes('stack') || k.includes('dashboard'))
  .map(([k, v]) => `- **${k}:** ${v}`)
  .join('\n')}

---

**Generated by:** ${agentId}
**Generation Time:** ${date}
**Last Updated:** ${date}
`;
  }

  /**
   * Save ADR to storage
   */
  private async saveADR(adr: ADR, tenantId: string): Promise<void> {
    // Save markdown to S3 (or equivalent storage)
    const markdownKey = `adrs/${tenantId}/by-number/${adr.adrId}.md`;
    await this.config.storage.saveMarkdown(markdownKey, adr.markdown, 'text/markdown');

    // Save metadata to DynamoDB (or equivalent)
    await this.config.storage.saveMetadata(adr);
  }

  /**
   * Get ADR by decision ID
   */
  async getADR(decisionId: string): Promise<ADR | null> {
    return this.config.storage.getADR(decisionId);
  }

  /**
   * Update ADR status
   *
   * Use when an ADR is deprecated or superseded by a newer decision
   */
  async updateADRStatus(
    decisionId: string,
    status: 'deprecated' | 'superseded',
    supersededBy?: string
  ): Promise<void> {
    const adr = await this.getADR(decisionId);
    if (!adr) {
      throw new Error(`ADR not found for decision ${decisionId}`);
    }

    adr.status = status;
    if (supersededBy) {
      adr.supersededBy = supersededBy;
    }

    await this.config.storage.saveMetadata(adr);
  }
}
