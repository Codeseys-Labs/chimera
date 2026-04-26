/**
 * Tests for system prompt template rendering.
 *
 * Wave-25: two behavioral bugs drove a prompt rewrite
 * (see chimera-cd16 + chimera-5d66). These tests encode the fix as
 * regression traps so the prompt can't drift back.
 */

import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_SYSTEM_PROMPT,
  SystemPromptTemplate,
  createDefaultSystemPrompt,
  createSystemPrompt,
} from '../prompt';

describe('SystemPromptTemplate', () => {
  it('extracts {{variable}} names from the template', () => {
    const tpl = createSystemPrompt('hello {{name}}, you are {{role}}');
    expect(tpl.getVariables().sort()).toEqual(['name', 'role']);
  });

  it('renders with a full context', () => {
    const tpl = createSystemPrompt('tenant={{tenantId}} session={{sessionId}}');
    const out = tpl.render({ tenantId: 't1', sessionId: 's1' });
    expect(out).toBe('tenant=t1 session=s1');
  });

  it('throws when a required variable is missing', () => {
    const tpl = createSystemPrompt('hello {{name}}');
    // @ts-expect-error — intentionally missing
    expect(() => tpl.render({})).toThrow(/Missing required template variable: name/);
  });
});

describe('DEFAULT_SYSTEM_PROMPT — Wave-25 regression traps', () => {
  it('requires exactly tenantId + sessionId (no accidental new variables)', () => {
    // If we introduce a new {{variable}} here, the rest of the stack
    // probably doesn't pass it, and render() will throw at runtime.
    // Force contributors to update this test + every render() call site.
    const tpl = createDefaultSystemPrompt();
    expect(tpl.getVariables().sort()).toEqual(['sessionId', 'tenantId']);
  });

  it('does NOT put tenant_id in conversational prose (chimera-cd16)', () => {
    // The bug: model echoed tenant_id when user asked "what's my name?"
    // Root cause was `Current context: Tenant: {{tenantId}}` which reads
    // as a conversational fact. Guard: the tenant variable must appear
    // ONLY inside the <operator-metadata> block.
    const rendered = createDefaultSystemPrompt().render({
      tenantId: 't1',
      sessionId: 's1',
    });

    // The only two occurrences of 't1' must be between the metadata tags.
    const metadataStart = rendered.indexOf('<operator-metadata>');
    const metadataEnd = rendered.indexOf('</operator-metadata>');
    expect(metadataStart).toBeGreaterThan(0);
    expect(metadataEnd).toBeGreaterThan(metadataStart);
    const metadataBlock = rendered.slice(metadataStart, metadataEnd);
    const proseBlock = rendered.slice(0, metadataStart) + rendered.slice(metadataEnd);
    expect(metadataBlock).toContain('t1');
    expect(proseBlock).not.toContain('t1');
  });

  it('explicitly instructs the model to invoke tools instead of describing (chimera-5d66)', () => {
    // The other bug: old prompt enumerated tool categories without a "use
    // them" directive, so the model said "I'll query..." 10 times without
    // emitting a tool_use block. Guard: the prompt must carry an explicit
    // invocation directive.
    const raw = DEFAULT_SYSTEM_PROMPT;
    // Must say "invoke" AND must tell the model NOT to describe hypothetically.
    expect(raw.toLowerCase()).toMatch(/invoke/);
    expect(raw.toLowerCase()).toMatch(/do not describe|don't describe|DO NOT describe/i);
  });

  it('instructs the agent not to echo operator metadata', () => {
    // Complementary to the leak test above: the prompt body must tell the
    // model that the metadata block is operator-only.
    expect(DEFAULT_SYSTEM_PROMPT.toLowerCase()).toMatch(/never echo/);
    expect(DEFAULT_SYSTEM_PROMPT.toLowerCase()).toMatch(/operator metadata/);
  });
});
