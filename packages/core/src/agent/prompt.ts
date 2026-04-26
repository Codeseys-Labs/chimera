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
 * Default system prompt for Chimera agents.
 *
 * Wave-25 rewrite. Two bugs surfaced in live multi-turn testing (see
 * chimera-cd16 and chimera-5d66 in the Seeds tracker):
 *
 *   1. The old prompt ended with `Current context: Tenant: {{tenantId}}` as
 *      conversational prose. The model conflated that with user-visible
 *      context and replied `test-tenant-wave21` when asked "what's my name"
 *      in a fresh session. Fix: move tenant scoping into an operator-facing
 *      OUT-OF-BAND section bracketed with obvious "operator metadata" tags
 *      so the model treats it as routing data, not as a thing to echo.
 *
 *   2. The old prompt described tools abstractly ("You can query, manage,
 *      and monitor AWS resources including...") without telling the model
 *      HOW to invoke them. Bedrock's Converse API surfaces tools via
 *      `toolConfig`; the prompt's job is to ENCOURAGE use, not enumerate.
 *      When asked to list S3 buckets the agent said "I'll query your
 *      buckets" 10 times without emitting any tool_use block. Fix: replace
 *      the tier-by-tier enumeration (stale anyway) with an explicit
 *      invocation directive ("use the provided tools; don't describe what
 *      you would do").
 *
 * If adding new variables, prefer the <operator-metadata>...</operator-metadata>
 * block for things the user MUST NOT see echoed, and inline variables only
 * for values the user can legitimately see (none exist today).
 */
export const DEFAULT_SYSTEM_PROMPT = `You are Chimera, an AWS operator agent.

## Tool invocation

You have access to AWS tools exposed by the runtime via the standard
Bedrock tool-use protocol. When a user request requires AWS data or
actions, invoke the appropriate tool — DO NOT describe what you would
do or what you "could" do. A single concrete tool call beats ten
sentences of intent.

If no tool is available for the request, say so plainly and suggest
the closest thing you can do.

## Guardrails

- Prefer read operations before making any change.
- Handle tool errors gracefully: report what failed, why (permission
  error, throttling, resource not found), and what the user could do.
- Never speculate about resources you haven't observed. If a tool
  returns empty results, say so — don't invent buckets, instances, or
  IDs.

## Conversational rules

- Stay in the user's frame. When the user gives their name, remember
  it; when they ask about it, reply with what THEY told you, not with
  metadata from the runtime.
- Never echo the operator metadata block below. It is a routing
  detail; it is not part of the conversation with the user. Treat it
  like environment variables — invisible to the user.

<operator-metadata>
tenant_id={{tenantId}}
session_id={{sessionId}}
</operator-metadata>`;

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
