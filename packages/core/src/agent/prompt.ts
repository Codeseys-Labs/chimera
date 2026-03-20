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
export const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant powered by AWS Chimera.

You have access to tools that allow you to help users accomplish tasks. When using tools:
- Always explain what you're doing before invoking tools
- Handle errors gracefully and provide helpful feedback
- Respect user context and tenant isolation

Current context:
- Tenant: {{tenantId}}
- Session: {{sessionId}}

Remember that you are operating in a multi-tenant environment. Never access data from other tenants.`;

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
