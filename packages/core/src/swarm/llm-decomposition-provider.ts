/**
 * LLM-backed decomposition provider
 *
 * Uses Bedrock Claude to break vague user requests into concrete, dependency-aware
 * subtasks. Plugs into `TaskDecomposer` via the `DecompositionProvider` interface
 * (see task-decomposer.ts), so tests and offline callers can swap in the
 * heuristic provider without any SDK dependency.
 *
 * Design notes:
 *   - Uses Bedrock `Converse` API (not `InvokeModel`) so the prompt shape is
 *     provider-agnostic and works unchanged across Nova / Claude / other
 *     Bedrock chat models.
 *   - Returns rigid JSON (not free text). Claude produces structured output
 *     well; the deterministic parser shields callers from hallucinated
 *     schema drift and lets us fall back safely on malformed replies.
 *   - Tier-aware model selection: basic tier gets Nova Lite (cheap), others
 *     get Claude Sonnet. Routes through `enforceTierCeiling` so a basic
 *     tenant cannot accidentally invoke Opus at this surface.
 *   - Failure-tolerant: any Bedrock error or unparseable reply throws a
 *     well-typed `LlmDecompositionError` that the caller can catch and
 *     fall back to the heuristic path — never surface LLM failures as
 *     runtime task failures.
 *
 * Wave 24 — closes chimera-76b9.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { TenantTier } from '@chimera/shared';
import { enforceTierCeiling } from '../evolution/model-router';
import type {
  DecompositionContext,
  DecompositionStrategy,
  Subtask,
  TaskPriority,
} from './types';
import type {
  DecompositionProvider,
  DecompositionProviderResult,
} from './decomposition-provider';

/**
 * Raised when Bedrock returns an error or produces output the JSON parser
 * cannot coerce into the internal Subtask shape. Callers should catch and
 * fall back to the heuristic provider; never surface to agent users.
 */
export class LlmDecompositionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmDecompositionError';
  }
}

export interface LlmDecompositionProviderConfig {
  /** Bedrock runtime client (injectable for tests). */
  client: BedrockRuntimeClient;

  /**
   * Model ID. Passed through `enforceTierCeiling` before invocation so a
   * mis-pinned model cannot bypass the per-tier guardrails.
   */
  modelId?: string;

  /**
   * Tenant tier. Gates model selection; `basic` is pinned to Nova Lite for
   * cost; other tiers use Claude Sonnet 4.6 by default.
   */
  tier: TenantTier;

  /**
   * Maximum tokens in the decomposition reply. Claude's Converse API counts
   * output tokens; 1500 is enough for ~15 subtasks with full descriptions.
   */
  maxOutputTokens?: number;
}

/** Default cheap model for basic tenants. */
const DEFAULT_MODEL_BASIC = 'us.amazon.nova-lite-v1:0';

/** Default model for advanced+ tenants. */
const DEFAULT_MODEL_ADVANCED = 'us.anthropic.claude-sonnet-4-6-v1:0';

/**
 * Raw JSON shape emitted by the LLM. Kept permissive; we coerce into
 * `Subtask` below. Unknown fields are ignored (not passed through).
 */
interface LlmSubtask {
  id: string;
  description: string;
  dependencies?: string[];
  priority?: string;
  validation?: string;
  rollback?: string;
  estimatedDurationMs?: number;
}

export class LlmDecompositionProvider implements DecompositionProvider {
  readonly kind = 'llm' as const;

  constructor(private readonly config: LlmDecompositionProviderConfig) {}

  async decompose(
    request: string,
    context: DecompositionContext,
    strategy: DecompositionStrategy,
  ): Promise<DecompositionProviderResult> {
    const requestedModel =
      this.config.modelId ??
      (this.config.tier === 'basic' ? DEFAULT_MODEL_BASIC : DEFAULT_MODEL_ADVANCED);

    // Ceiling-check every call even when the explicit modelId looks safe —
    // prevents a caller from routing a basic tenant through Opus via a
    // stale config without triggering the alarm-backed enforcement path.
    const modelId = enforceTierCeiling(
      requestedModel,
      this.config.tier,
      context.tenantId,
    );

    const prompt = buildPrompt(request, context, strategy);

    let response;
    try {
      response = await this.config.client.send(
        new ConverseCommand({
          modelId,
          messages: [
            {
              role: 'user',
              content: [{ text: prompt }],
            },
          ],
          inferenceConfig: {
            maxTokens: this.config.maxOutputTokens ?? 1500,
            temperature: 0.1, // low; we want reproducible structure
          },
        }),
      );
    } catch (err) {
      throw new LlmDecompositionError(
        `Bedrock Converse failed for model=${modelId}`,
        err,
      );
    }

    const rawText = extractText(response.output?.message?.content ?? []);
    if (!rawText) {
      throw new LlmDecompositionError(
        `Bedrock returned empty content for model=${modelId}`,
      );
    }

    const subtasks = parseSubtasks(rawText);
    if (subtasks.length === 0) {
      throw new LlmDecompositionError(
        `Parsed 0 subtasks from LLM reply (${rawText.length} chars)`,
      );
    }

    return {
      subtasks,
      modelId,
      usage: response.usage
        ? {
            inputTokens: response.usage.inputTokens ?? 0,
            outputTokens: response.usage.outputTokens ?? 0,
          }
        : undefined,
    };
  }
}

/** Strategy description shown to the LLM in the prompt. */
function strategyHint(strategy: DecompositionStrategy): string {
  switch (strategy) {
    case 'tree-of-thought':
      return 'Explore 2-3 distinct approaches, evaluate each, and pick the strongest path. Subtasks should reflect that single chosen path.';
    case 'plan-and-execute':
      return 'Produce a comprehensive plan with discovery, design, implementation, and validation phases. Each subtask should have a validation criterion.';
    case 'recursive':
      return 'Break the request into 3-5 coarse-grained subtasks first; leave finer-grained refinement to later passes.';
    case 'goal-decomposition':
      return 'Frame subtasks as a goal hierarchy: top-level goal → subgoals → concrete tasks.';
    case 'dependency-aware':
      return 'Construct an explicit dependency graph — every subtask lists which prior subtask IDs it depends on.';
  }
}

function buildPrompt(
  request: string,
  context: DecompositionContext,
  strategy: DecompositionStrategy,
): string {
  const constraints = (context.constraints ?? []).join('\n- ') || '(none)';
  return [
    'You are a task decomposition engine for an agent orchestration system.',
    'Decompose the following request into 3-10 concrete, dependency-aware subtasks.',
    '',
    `# Strategy`,
    strategyHint(strategy),
    '',
    `# Request`,
    request,
    '',
    `# Constraints`,
    `- ${constraints}`,
    '',
    `# Output`,
    'Return ONLY a JSON object of the form:',
    '{"subtasks":[{',
    '  "id": "kebab-case-id",',
    '  "description": "One-sentence imperative description",',
    '  "dependencies": ["id-of-earlier-subtask", ...],',
    '  "priority": "low" | "normal" | "high" | "urgent",',
    '  "validation": "How success is verified",',
    '  "rollback": "How to undo if this subtask fails (optional)",',
    '  "estimatedDurationMs": 600000',
    '}]}',
    'No markdown, no prose, no code fences. Pure JSON.',
    '',
    'Subtask IDs MUST be unique. Dependencies MUST reference earlier IDs in the list.',
    'If the request is already atomic, return a single subtask.',
  ].join('\n');
}

function extractText(content: ContentBlock[]): string {
  for (const block of content) {
    if ('text' in block && typeof block.text === 'string') {
      return block.text;
    }
  }
  return '';
}

/**
 * Parse a Bedrock reply into Subtask[]. Forgiving about whitespace / code
 * fences / leading prose, but strict about shape: id and description are
 * mandatory, everything else has a default.
 */
function parseSubtasks(raw: string): Subtask[] {
  // Strip ```json ... ``` fences if the model ignored the "no code fences"
  // instruction; grab the first {...} balanced block as a fallback.
  let jsonText = raw.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    jsonText = fenceMatch[1].trim();
  } else {
    const braceStart = jsonText.indexOf('{');
    const braceEnd = jsonText.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      jsonText = jsonText.slice(braceStart, braceEnd + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new LlmDecompositionError(
      `Reply was not valid JSON after fence/brace extraction`,
      err,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new LlmDecompositionError('Reply JSON root was not an object');
  }

  const rawList = (parsed as { subtasks?: unknown }).subtasks;
  if (!Array.isArray(rawList)) {
    throw new LlmDecompositionError('Reply missing `subtasks` array');
  }

  const seenIds = new Set<string>();
  const results: Subtask[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const v = item as LlmSubtask;
    if (typeof v.id !== 'string' || !v.id.trim()) continue;
    if (typeof v.description !== 'string' || !v.description.trim()) continue;
    if (seenIds.has(v.id)) continue;
    seenIds.add(v.id);

    const priority = normalizePriority(v.priority);
    const dependencies = Array.isArray(v.dependencies)
      ? v.dependencies.filter((d) => typeof d === 'string' && seenIds.has(d))
      : [];

    const subtask: Subtask = {
      id: v.id,
      description: v.description,
      dependencies,
      status: 'pending',
      priority,
      estimatedDurationMs:
        typeof v.estimatedDurationMs === 'number' && v.estimatedDurationMs > 0
          ? v.estimatedDurationMs
          : 600_000,
    };
    if (typeof v.validation === 'string' && v.validation.trim()) {
      subtask.validation = v.validation;
    }
    if (typeof v.rollback === 'string' && v.rollback.trim()) {
      subtask.rollback = v.rollback;
    }
    results.push(subtask);
  }
  return results;
}

function normalizePriority(raw: unknown): TaskPriority {
  if (raw === 'low' || raw === 'normal' || raw === 'high' || raw === 'urgent') {
    return raw;
  }
  return 'normal';
}
