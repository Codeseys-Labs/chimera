/**
 * Runbook Generator
 *
 * Auto-generates operational runbooks from decision logs and action logs
 * Implements structured operations documentation from research/aws-account-agent/05-Runbook-Auto-Generation.md
 */

import { DecisionLog, ADR } from './adr-generator';

/**
 * Action log structure from activity logging system
 */
export interface ActionLog {
  activityId: string;
  tenantId: string;
  agentId: string;
  timestamp: string;
  actionCategory: 'create' | 'read' | 'update' | 'delete' | 'query';
  resource: ResourceInfo;
  success: boolean;
  duration: number; // milliseconds
  cost?: number; // USD
  error?: string;
}

export interface ResourceInfo {
  type: string; // e.g., 'dynamodb-table', 'lambda-function', 'rds-instance'
  name: string;
  arn?: string;
  region?: string;
  configuration?: Record<string, any>;
}

/**
 * Runbook structure
 */
export interface Runbook {
  title: string;
  generatedAt: string;
  agentId: string;
  decisionId: string;
  tenantId: string;
  whatWasBuilt: WhatWasBuilt;
  operations: Operation[];
  troubleshooting: TroubleshootingIssue[];
  monitoring: MonitoringSection;
  costManagement: CostManagementSection;
  rollback: RollbackReference;
  relatedResources: RelatedResources;
  markdown: string;
}

export interface WhatWasBuilt {
  description: string;
  resources: ResourceSummary[];
  dependencies: DependencyInfo;
  configuration: Record<string, any>;
}

export interface ResourceSummary {
  type: string;
  name: string;
  arn?: string;
  created: string;
}

export interface DependencyInfo {
  dependsOn: string[];
  requiredBy: string[];
}

export interface Operation {
  title: string;
  command: string;
  expectedOutput?: string;
  unhealthyIndicators?: string[];
  example?: string;
}

export interface TroubleshootingIssue {
  issue: string;
  symptoms: string[];
  cause: string;
  fix: string;
  verification: string;
}

export interface MonitoringSection {
  dashboardUrl?: string;
  keyMetrics: MetricInfo[];
  alarms: AlarmInfo[];
}

export interface MetricInfo {
  name: string;
  description: string;
  namespace: string;
  threshold?: number;
  unit?: string;
}

export interface AlarmInfo {
  name: string;
  description: string;
  metric: string;
  threshold: number;
}

export interface CostManagementSection {
  monthlyEstimate: number;
  costDrivers: CostDriver[];
  optimizationTips: string[];
}

export interface CostDriver {
  service: string;
  estimatedMonthlyCost: number;
  percentage: number;
}

export interface RollbackReference {
  adrId: string;
  summary: string;
}

export interface RelatedResources {
  decisionLog: string;
  adr: string;
  stack?: string;
  dashboard?: string;
}

/**
 * Storage interface for runbook persistence
 */
export interface RunbookStorage {
  saveMarkdown(key: string, markdown: string, contentType: string): Promise<void>;
  saveMetadata(runbook: Runbook): Promise<void>;
  getRunbook(decisionId: string): Promise<Runbook | null>;
}

/**
 * Runbook generator configuration
 */
export interface RunbookGeneratorConfig {
  storage: RunbookStorage;
  /** ADR storage for loading related ADRs */
  adrStorage: {
    getADR(decisionId: string): Promise<ADR | null>;
  };
  /** Action log storage for loading related actions */
  actionLogStorage: {
    getActionsByDecision(decisionId: string): Promise<ActionLog[]>;
  };
}

/**
 * Runbook Generator
 *
 * Generates operational runbooks from decision logs with:
 * - Resource inventory and dependencies
 * - Operational procedures and commands
 * - Troubleshooting guides
 * - Monitoring and alerting
 * - Cost management
 */
export class RunbookGenerator {
  private config: RunbookGeneratorConfig;

  constructor(config: RunbookGeneratorConfig) {
    this.config = config;
  }

  /**
   * Generate runbook from decision log
   *
   * Creates a complete operational runbook including:
   * - What was built (resources, dependencies, config)
   * - How to operate (health checks, queries)
   * - Troubleshooting (common issues, fixes)
   * - Monitoring (metrics, alarms)
   * - Cost management (estimates, optimization)
   * - Rollback reference (link to ADR)
   *
   * @param decision - Decision log from activity logging system
   * @returns Generated runbook
   */
  async generateRunbook(decision: DecisionLog): Promise<Runbook> {
    // 1. Load related actions
    const actions = await this.config.actionLogStorage.getActionsByDecision(decision.activityId);

    // 2. Load related ADR
    const adr = await this.config.adrStorage.getADR(decision.activityId);
    if (!adr) {
      throw new Error(`ADR not found for decision ${decision.activityId}`);
    }

    // 3. Build runbook sections
    const whatWasBuilt = this.buildWhatWasBuilt(decision, actions);
    const operations = this.generateOperations(actions);
    const troubleshooting = this.generateTroubleshooting(actions);
    const monitoring = this.generateMonitoring(actions);
    const costManagement = this.generateCostManagement(decision, actions);
    const rollback: RollbackReference = {
      adrId: adr.adrId,
      summary: adr.rollbackPlan.summary,
    };
    const relatedResources: RelatedResources = {
      decisionLog: decision.activityId,
      adr: adr.adrId,
      stack: decision.tags['cloudformation-stack'],
      dashboard: decision.tags['dashboard-url'],
    };

    // 4. Create runbook
    const title = `Runbook: ${decision.selectedOption} (${this.extractServiceType(decision)})`;
    const runbook: Runbook = {
      title,
      generatedAt: new Date().toISOString(),
      agentId: decision.agentId,
      decisionId: decision.activityId,
      tenantId: decision.tenantId,
      whatWasBuilt,
      operations,
      troubleshooting,
      monitoring,
      costManagement,
      rollback,
      relatedResources,
      markdown: '', // Populated below
    };

    // 5. Render markdown
    runbook.markdown = this.renderRunbookTemplate(runbook, decision);

    // 6. Save to storage
    await this.saveRunbook(runbook);

    return runbook;
  }

  /**
   * Build "What Was Built" section
   */
  private buildWhatWasBuilt(decision: DecisionLog, actions: ActionLog[]): WhatWasBuilt {
    // Extract created resources
    const resources: ResourceSummary[] = actions
      .filter((a) => a.actionCategory === 'create' && a.success)
      .map((a) => ({
        type: a.resource.type,
        name: a.resource.name,
        arn: a.resource.arn,
        created: a.timestamp,
      }));

    // Discover dependencies (simplified - real implementation would analyze resource relationships)
    const dependencies: DependencyInfo = {
      dependsOn: [], // Would be populated by analyzing resource dependencies
      requiredBy: [], // Would be populated by analyzing what depends on these resources
    };

    // Extract key configuration from first created resource
    const configuration = actions.find((a) => a.actionCategory === 'create')?.resource.configuration || {};

    return {
      description: decision.justification,
      resources,
      dependencies,
      configuration,
    };
  }

  /**
   * Generate operations section
   */
  private generateOperations(actions: ActionLog[]): Operation[] {
    const operations: Operation[] = [];

    // Group actions by resource
    const resourceMap = new Map<string, ActionLog[]>();
    for (const action of actions) {
      const key = `${action.resource.type}:${action.resource.name}`;
      if (!resourceMap.has(key)) {
        resourceMap.set(key, []);
      }
      resourceMap.get(key)!.push(action);
    }

    // Generate operations for each resource
    for (const [key, resourceActions] of Array.from(resourceMap.entries())) {
      const firstAction = resourceActions[0];
      const resourceType = firstAction.resource.type;
      const resourceName = firstAction.resource.name;

      // Health check
      operations.push({
        title: `Check ${resourceName} Health`,
        command: this.generateHealthCheckCommand(resourceType, resourceName),
        expectedOutput: this.getExpectedHealthOutput(resourceType),
        unhealthyIndicators: this.getUnhealthyIndicators(resourceType),
      });

      // Query/list operations for data stores
      if (this.isDataStore(resourceType)) {
        operations.push({
          title: `Query ${resourceName}`,
          command: this.generateQueryCommand(resourceType, resourceName),
          example: this.getQueryExample(resourceType),
        });
      }

      // Manual operations if needed
      operations.push(...this.generateManualOperations(resourceType, resourceName));
    }

    return operations;
  }

  /**
   * Generate troubleshooting section
   */
  private generateTroubleshooting(actions: ActionLog[]): TroubleshootingIssue[] {
    const issues: TroubleshootingIssue[] = [];

    // Analyze failed actions for common issues
    const failedActions = actions.filter((a) => !a.success);
    const resourceTypes = new Set(actions.map((a) => a.resource.type));

    for (const resourceType of Array.from(resourceTypes)) {
      issues.push(...this.getCommonIssues(resourceType));
    }

    // Add issues specific to failed actions
    for (const failed of failedActions) {
      if (failed.error) {
        issues.push({
          issue: `${failed.resource.type} ${failed.actionCategory} failed`,
          symptoms: [failed.error],
          cause: 'See error message above',
          fix: this.generateFixForError(failed.error, failed.resource.type),
          verification: this.generateVerificationCommand(failed.resource.type, failed.resource.name),
        });
      }
    }

    return issues;
  }

  /**
   * Generate monitoring section
   */
  private generateMonitoring(actions: ActionLog[]): MonitoringSection {
    const keyMetrics: MetricInfo[] = [];
    const alarms: AlarmInfo[] = [];

    const resourceTypes = new Set(actions.map((a) => a.resource.type));

    for (const resourceType of Array.from(resourceTypes)) {
      keyMetrics.push(...this.getKeyMetrics(resourceType));
      alarms.push(...this.getRecommendedAlarms(resourceType));
    }

    return {
      keyMetrics,
      alarms,
    };
  }

  /**
   * Generate cost management section
   */
  private generateCostManagement(decision: DecisionLog, actions: ActionLog[]): CostManagementSection {
    const monthlyEstimate = decision.costEstimate.monthly;

    // Calculate cost by service
    const serviceCosts = new Map<string, number>();
    for (const action of actions) {
      if (action.cost && action.cost > 0) {
        const service = this.extractServiceFromResourceType(action.resource.type);
        serviceCosts.set(service, (serviceCosts.get(service) || 0) + action.cost);
      }
    }

    // Build cost drivers
    const costDrivers: CostDriver[] = Array.from(serviceCosts.entries())
      .map(([service, cost]) => ({
        service,
        estimatedMonthlyCost: cost,
        percentage: (cost / monthlyEstimate) * 100,
      }))
      .sort((a, b) => b.estimatedMonthlyCost - a.estimatedMonthlyCost);

    // Get optimization tips
    const optimizationTips = this.getOptimizationTips(decision, actions);

    return {
      monthlyEstimate,
      costDrivers,
      optimizationTips,
    };
  }

  /**
   * Extract service type from decision
   */
  private extractServiceType(decision: DecisionLog): string {
    // Extract from decision type (e.g., 'infrastructure.database' -> 'database')
    const parts = decision.decisionType.split('.');
    return parts[parts.length - 1] || 'service';
  }

  /**
   * Generate health check command for resource type
   */
  private generateHealthCheckCommand(resourceType: string, resourceName: string): string {
    const type = resourceType.toLowerCase();

    if (type.includes('dynamodb')) {
      return `aws dynamodb describe-table --table-name ${resourceName} --query 'Table.TableStatus'`;
    }

    if (type.includes('lambda')) {
      return `aws lambda get-function --function-name ${resourceName} --query 'Configuration.State'`;
    }

    if (type.includes('rds')) {
      return `aws rds describe-db-instances --db-instance-identifier ${resourceName} --query 'DBInstances[0].DBInstanceStatus'`;
    }

    if (type.includes('ecs')) {
      return `aws ecs describe-services --cluster CLUSTER_NAME --services ${resourceName} --query 'services[0].status'`;
    }

    return `# Health check for ${resourceType}\necho "Resource-specific health check required"`;
  }

  /**
   * Get expected health output for resource type
   */
  private getExpectedHealthOutput(resourceType: string): string {
    const type = resourceType.toLowerCase();

    if (type.includes('dynamodb')) return '"ACTIVE"';
    if (type.includes('lambda')) return '"Active"';
    if (type.includes('rds')) return '"available"';
    if (type.includes('ecs')) return '"ACTIVE"';

    return '"HEALTHY" or "ACTIVE"';
  }

  /**
   * Get unhealthy indicators for resource type
   */
  private getUnhealthyIndicators(resourceType: string): string[] {
    const type = resourceType.toLowerCase();

    if (type.includes('dynamodb')) {
      return ['"CREATING"', '"UPDATING"', '"DELETING"', '"ARCHIVING"'];
    }

    if (type.includes('lambda')) {
      return ['"Pending"', '"Inactive"', '"Failed"'];
    }

    if (type.includes('rds')) {
      return ['"creating"', '"modifying"', '"failed"', '"inaccessible-encryption-credentials"'];
    }

    return ['"FAILED"', '"ERROR"', '"DEGRADED"'];
  }

  /**
   * Check if resource type is a data store
   */
  private isDataStore(resourceType: string): boolean {
    const type = resourceType.toLowerCase();
    return (
      type.includes('dynamodb') ||
      type.includes('rds') ||
      type.includes('s3') ||
      type.includes('aurora') ||
      type.includes('elasticache')
    );
  }

  /**
   * Generate query command for data store
   */
  private generateQueryCommand(resourceType: string, resourceName: string): string {
    const type = resourceType.toLowerCase();

    if (type.includes('dynamodb')) {
      return `aws dynamodb query \\
  --table-name ${resourceName} \\
  --key-condition-expression 'PK = :pk' \\
  --expression-attribute-values '{":pk": {"S": "TENANT#example"}}'`;
    }

    if (type.includes('rds') || type.includes('aurora')) {
      return `psql -h DB_ENDPOINT -U admin -d chimera -c "SELECT * FROM table_name LIMIT 10;"`;
    }

    if (type.includes('s3')) {
      return `aws s3 ls s3://${resourceName}/ --recursive --human-readable --summarize`;
    }

    return `# Query command for ${resourceType}`;
  }

  /**
   * Get query example for data store
   */
  private getQueryExample(resourceType: string): string {
    const type = resourceType.toLowerCase();

    if (type.includes('dynamodb')) {
      return `{
  "Items": [
    {
      "PK": {"S": "TENANT#example"},
      "SK": {"S": "SESSION#sess-2026-03-20-abc"},
      "userId": {"S": "user-123"}
    }
  ],
  "Count": 1
}`;
    }

    return '# Example output varies by resource type';
  }

  /**
   * Generate manual operations for resource type
   */
  private generateManualOperations(resourceType: string, resourceName: string): Operation[] {
    const type = resourceType.toLowerCase();
    const operations: Operation[] = [];

    if (type.includes('dynamodb')) {
      operations.push({
        title: `Count Items in ${resourceName}`,
        command: `aws dynamodb scan --table-name ${resourceName} --select COUNT`,
        expectedOutput: '{"Count": N, "ScannedCount": N}',
      });

      operations.push({
        title: `Manually Delete Item from ${resourceName}`,
        command: `aws dynamodb delete-item \\
  --table-name ${resourceName} \\
  --key '{"PK": {"S": "TENANT#example"}, "SK": {"S": "ITEM#id"}}'`,
      });
    }

    if (type.includes('lambda')) {
      operations.push({
        title: `Invoke ${resourceName} Manually`,
        command: `aws lambda invoke \\
  --function-name ${resourceName} \\
  --payload '{"test": true}' \\
  response.json`,
      });
    }

    return operations;
  }

  /**
   * Get common issues for resource type
   */
  private getCommonIssues(resourceType: string): TroubleshootingIssue[] {
    const type = resourceType.toLowerCase();
    const issues: TroubleshootingIssue[] = [];

    if (type.includes('dynamodb')) {
      issues.push({
        issue: 'ProvisionedThroughputExceededException',
        symptoms: ['API returns 400 error', 'Throttling CloudWatch alarms firing'],
        cause: 'Table in provisioned mode hit read/write capacity limits',
        fix: `aws dynamodb update-table \\
  --table-name TABLE_NAME \\
  --billing-mode PAY_PER_REQUEST`,
        verification: `aws dynamodb describe-table \\
  --table-name TABLE_NAME \\
  --query 'Table.BillingModeSummary.BillingMode'`,
      });

      issues.push({
        issue: 'Item Not Found After Creation',
        symptoms: ['Session created successfully (200 OK)', 'Immediate read returns empty'],
        cause: 'DynamoDB eventual consistency',
        fix: 'Use ConsistentRead=true for reads immediately after writes',
        verification: 'Session returned immediately after creation',
      });
    }

    if (type.includes('lambda')) {
      issues.push({
        issue: 'Lambda Function Timeout',
        symptoms: ['Function execution exceeds timeout', 'Partial data processing'],
        cause: 'Function timeout set too low or inefficient code',
        fix: `aws lambda update-function-configuration \\
  --function-name FUNCTION_NAME \\
  --timeout 300`,
        verification: `aws lambda get-function-configuration \\
  --function-name FUNCTION_NAME \\
  --query 'Timeout'`,
      });
    }

    return issues;
  }

  /**
   * Generate fix for specific error
   */
  private generateFixForError(error: string, resourceType: string): string {
    if (error.includes('AccessDenied') || error.includes('Unauthorized')) {
      return 'Check IAM policies and resource-based policies. Verify the role has necessary permissions.';
    }

    if (error.includes('ResourceNotFound')) {
      return 'Verify resource exists and name/ARN is correct. Check region.';
    }

    if (error.includes('Throttling')) {
      return 'Implement exponential backoff. Consider increasing rate limits or switching to on-demand billing.';
    }

    return 'Review error message and consult AWS documentation for specific error code.';
  }

  /**
   * Generate verification command
   */
  private generateVerificationCommand(resourceType: string, resourceName: string): string {
    return this.generateHealthCheckCommand(resourceType, resourceName);
  }

  /**
   * Get key metrics for resource type
   */
  private getKeyMetrics(resourceType: string): MetricInfo[] {
    const type = resourceType.toLowerCase();
    const metrics: MetricInfo[] = [];

    if (type.includes('dynamodb')) {
      metrics.push(
        {
          name: 'ConsumedReadCapacityUnits',
          description: 'Read capacity consumed',
          namespace: 'AWS/DynamoDB',
          unit: 'Count',
        },
        {
          name: 'ConsumedWriteCapacityUnits',
          description: 'Write capacity consumed',
          namespace: 'AWS/DynamoDB',
          unit: 'Count',
        },
        {
          name: 'UserErrors',
          description: 'User errors (4xx)',
          namespace: 'AWS/DynamoDB',
          threshold: 10,
          unit: 'Count',
        }
      );
    }

    if (type.includes('lambda')) {
      metrics.push(
        {
          name: 'Invocations',
          description: 'Number of invocations',
          namespace: 'AWS/Lambda',
          unit: 'Count',
        },
        {
          name: 'Duration',
          description: 'Execution duration',
          namespace: 'AWS/Lambda',
          unit: 'Milliseconds',
        },
        {
          name: 'Errors',
          description: 'Function errors',
          namespace: 'AWS/Lambda',
          threshold: 5,
          unit: 'Count',
        }
      );
    }

    return metrics;
  }

  /**
   * Get recommended alarms for resource type
   */
  private getRecommendedAlarms(resourceType: string): AlarmInfo[] {
    const type = resourceType.toLowerCase();
    const alarms: AlarmInfo[] = [];

    if (type.includes('dynamodb')) {
      alarms.push({
        name: 'HighUserErrors',
        description: 'Alert when user errors exceed threshold',
        metric: 'UserErrors',
        threshold: 100,
      });
    }

    if (type.includes('lambda')) {
      alarms.push({
        name: 'HighErrorRate',
        description: 'Alert when error rate > 5%',
        metric: 'Errors',
        threshold: 5,
      });
    }

    return alarms;
  }

  /**
   * Extract service name from resource type
   */
  private extractServiceFromResourceType(resourceType: string): string {
    const parts = resourceType.split('-');
    return parts[0] || resourceType;
  }

  /**
   * Get cost optimization tips
   */
  private getOptimizationTips(decision: DecisionLog, actions: ActionLog[]): string[] {
    const tips: string[] = [];
    const resourceTypes = new Set(actions.map((a) => a.resource.type));

    for (const resourceType of Array.from(resourceTypes)) {
      const type = resourceType.toLowerCase();

      if (type.includes('dynamodb')) {
        tips.push(
          'Enable DynamoDB auto-scaling to match capacity with demand',
          'Use on-demand billing for unpredictable workloads',
          'Archive old data using TTL and S3 exports'
        );
      }

      if (type.includes('lambda')) {
        tips.push(
          'Right-size Lambda memory allocation based on profiling',
          'Use Lambda ARM (Graviton2) for 20% cost reduction',
          'Reduce cold starts with provisioned concurrency (if critical)'
        );
      }

      if (type.includes('rds')) {
        tips.push(
          'Use RDS Reserved Instances for predictable workloads (up to 60% savings)',
          'Enable automatic backups with retention < 7 days',
          'Use Aurora Serverless v2 for variable workloads'
        );
      }
    }

    // Generic tips
    tips.push(
      'Review AWS Cost Explorer monthly for anomalies',
      'Tag all resources with cost-center for attribution',
      'Set up billing alarms at 50%, 80%, 100% of budget'
    );

    return tips;
  }

  /**
   * Render runbook markdown template
   */
  private renderRunbookTemplate(runbook: Runbook, decision: DecisionLog): string {
    return `# ${runbook.title}

**Generated:** ${runbook.generatedAt}
**Agent:** ${runbook.agentId}
**Decision ID:** ${runbook.decisionId}
**Last Updated:** ${runbook.generatedAt}

---

## What Was Built

${runbook.whatWasBuilt.description}

### Resources
| Resource Type | Name | ARN | Created |
|--------------|------|-----|---------|
${runbook.whatWasBuilt.resources
  .map((r) => `| ${r.type} | ${r.name} | ${r.arn || 'N/A'} | ${r.created} |`)
  .join('\n')}

${runbook.whatWasBuilt.dependencies.dependsOn.length > 0 ? `### Dependencies\n**Depends on:**\n${runbook.whatWasBuilt.dependencies.dependsOn.map((d) => `- ${d}`).join('\n')}` : ''}

${runbook.whatWasBuilt.dependencies.requiredBy.length > 0 ? `\n**Required by:**\n${runbook.whatWasBuilt.dependencies.requiredBy.map((r) => `- ${r}`).join('\n')}` : ''}

### Configuration
\`\`\`json
${JSON.stringify(runbook.whatWasBuilt.configuration, null, 2)}
\`\`\`

---

## How to Operate

${runbook.operations
  .map(
    (op) => `
### ${op.title}

\`\`\`bash
${op.command}
\`\`\`
${op.expectedOutput ? `**Expected output:** ${op.expectedOutput}` : ''}
${op.unhealthyIndicators ? `**Unhealthy indicators:** ${op.unhealthyIndicators.join(', ')}` : ''}
${op.example ? `\n**Example:**\n\`\`\`\n${op.example}\n\`\`\`` : ''}`
  )
  .join('\n\n')}

---

## Troubleshooting

${runbook.troubleshooting
  .map(
    (issue) => `
### Issue: ${issue.issue}

**Symptoms:**
${issue.symptoms.map((s) => `- ${s}`).join('\n')}

**Cause:** ${issue.cause}

**Fix:**
\`\`\`bash
${issue.fix}
\`\`\`

**Verification:**
\`\`\`bash
${issue.verification}
\`\`\`
`
  )
  .join('\n---\n')}

---

## Monitoring

${runbook.monitoring.dashboardUrl ? `**Dashboard:** ${runbook.monitoring.dashboardUrl}\n\n` : ''}

### Key Metrics
${runbook.monitoring.keyMetrics
  .map(
    (m) =>
      `- **${m.name}** (${m.namespace}): ${m.description}${m.threshold ? ` - Threshold: ${m.threshold}${m.unit || ''}` : ''}`
  )
  .join('\n')}

### Recommended Alarms
${runbook.monitoring.alarms
  .map((a) => `- **${a.name}**: ${a.description} (${a.metric} > ${a.threshold})`)
  .join('\n')}

---

## Cost Management

**Monthly Estimate:** $${runbook.costManagement.monthlyEstimate.toFixed(2)}

### Cost Drivers
${runbook.costManagement.costDrivers
  .map(
    (d) =>
      `- **${d.service}:** $${d.estimatedMonthlyCost.toFixed(2)}/month (${d.percentage.toFixed(1)}%)`
  )
  .join('\n')}

### Optimization Tips
${runbook.costManagement.optimizationTips.map((tip, idx) => `${idx + 1}. ${tip}`).join('\n')}

---

## Rollback

See: [[${runbook.rollback.adrId}]] Section "Rollback Plan"

**Summary:** ${runbook.rollback.summary}

---

## Related Resources
- **Decision Log:** ${runbook.relatedResources.decisionLog}
- **ADR:** [[${runbook.relatedResources.adr}]]
${runbook.relatedResources.stack ? `- **CloudFormation Stack:** ${runbook.relatedResources.stack}` : ''}
${runbook.relatedResources.dashboard ? `- **Monitoring Dashboard:** ${runbook.relatedResources.dashboard}` : ''}
`;
  }

  /**
   * Save runbook to storage
   */
  private async saveRunbook(runbook: Runbook): Promise<void> {
    // Save markdown to S3 (or equivalent storage)
    const markdownKey = `runbooks/${runbook.tenantId}/${runbook.decisionId}.md`;
    await this.config.storage.saveMarkdown(markdownKey, runbook.markdown, 'text/markdown');

    // Save metadata
    await this.config.storage.saveMetadata(runbook);
  }

  /**
   * Get runbook by decision ID
   */
  async getRunbook(decisionId: string): Promise<Runbook | null> {
    return this.config.storage.getRunbook(decisionId);
  }
}
