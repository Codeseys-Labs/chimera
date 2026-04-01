/**
 * System prompt template management for Chimera agents
 *
 * Strands agents are defined by Model + Tools + Prompt. This module handles
 * the Prompt component with support for templating and dynamic injection.
 */

/**
 * Template variable substitution context
 */
export interface PromptContext {
  /** Tenant identifier for multi-tenant isolation */
  tenantId: string;
  /** User identifier within the tenant */
  userId?: string;
  /** Session identifier for conversation continuity */
  sessionId?: string;
  /** Agent role/personality configuration */
  role?: string;
  /** Additional context variables */
  [key: string]: string | undefined;
}

/**
 * System prompt template with variable substitution
 */
export class SystemPromptTemplate {
  private template: string;
  private variables: Set<string>;

  constructor(template: string) {
    this.template = template;
    this.variables = this.extractVariables(template);
  }

  /**
   * Extract variable names from template ({{variableName}} syntax)
   */
  private extractVariables(template: string): Set<string> {
    const regex = /\{\{(\w+)\}\}/g;
    const variables = new Set<string>();
    let match;

    while ((match = regex.exec(template)) !== null) {
      variables.add(match[1]);
    }

    return variables;
  }

  /**
   * Render template with context values
   */
  render(context: PromptContext): string {
    let rendered = this.template;

    for (const variable of this.variables) {
      const value = context[variable];
      if (value === undefined) {
        throw new Error(`Missing required template variable: ${variable}`);
      }
      rendered = rendered.replace(new RegExp(`\\{\\{${variable}\\}\\}`, 'g'), value);
    }

    return rendered;
  }

  /**
   * Get list of required variables
   */
  getVariables(): string[] {
    return Array.from(this.variables);
  }

  /**
   * Get raw template string
   */
  getRawTemplate(): string {
    return this.template;
  }
}

/**
 * Default system prompt for Chimera agents
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Chimera, an AWS agent with access to cloud infrastructure tools.

You can query, manage, and monitor AWS resources including:
- **Compute**: EC2 instances, Lambda functions
- **Storage**: S3 buckets, DynamoDB tables
- **Monitoring**: CloudWatch metrics and alarms
- **Messaging**: SQS queues

Advanced tier tenants also have access to databases (RDS, Redshift, Athena, Glue, OpenSearch).
Premium tier tenants add orchestration and ML tools (Step Functions, Bedrock, SageMaker, Rekognition, Textract, Transcribe, CodeBuild, CodeCommit, CodePipeline).

When using tools:
- Explain what you are doing before invoking tools
- Handle errors gracefully and provide helpful feedback
- Prefer read operations before making changes
- Only access resources that belong to your tenant

Current context:
- Tenant: {{tenantId}}
- Session: {{sessionId}}

You operate in a secure multi-tenant environment. Never access resources from other tenants.`;

/**
 * Create a system prompt template from string
 */
export function createSystemPrompt(template: string): SystemPromptTemplate {
  return new SystemPromptTemplate(template);
}

/**
 * Create default system prompt template
 */
export function createDefaultSystemPrompt(): SystemPromptTemplate {
  return new SystemPromptTemplate(DEFAULT_SYSTEM_PROMPT);
}
