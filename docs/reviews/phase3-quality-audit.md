# Phase 3 Quality Audit

**Review date:** 2026-04-17
**Scope:** All files modified or added during Phase 3a/3b.

## Status of findings as of this write-up

The audit agent ran mid-wave while some Phase 3b work was still in flight, so two of its five findings are **already resolved** by later-landing work. Status below is current as of the moment the entrypoint cleanup landed.

## Top 5 findings (by severity)

1. **~~CRITICAL: `evolution_tools.py` still exposed `tenant_id` as a tool argument.~~** ✅ **Resolved** — the parallel evolution-sweep agent removed `tenant_id` from `trigger_infra_evolution`, `register_capability`, and `list_evolution_history`; test file updated via autouse `_tenant_context` fixture.
2. **~~CRITICAL: `chimera_agent.py` never clears tenant context.~~** ✅ **Resolved** — `agent_handler` now wraps the agent run in `try/…/finally: clear_tenant_context()`.
3. **HIGH: No grep-based anti-pattern test.** Open. ADR-033 describes a test that would fail if any file under `packages/agents/tools/` imports `boto3`/`dynamodb_tools` without importing `tenant_context`. Worth adding.
4. **MEDIUM: `ensure_tenant_filter` idempotency uses substring match.** Open. A filter containing `myField_tenantId = :__chimera_tid` would technically false-match. The reserved-placeholder name (`:__chimera_tid`) makes a real-world collision implausible but not impossible. Safer to parse or use regex word-boundary.
5. **MEDIUM: `_max_dict_depth` off-by-one.** Open. Root dict is counted as depth 1, so a payload is rejected at depth 33, not 32. Either adjust init to `0` or document that the limit means "33+".

## Critical issues

- **(Resolved)** evolution-tools regression.
- **(Resolved)** Missing context cleanup.

## High-priority fixes

- **Grep-based anti-pattern guard test** — add to `tests/test_tenant_context.py`:

  ```python
  def test_no_tool_imports_boto3_without_tenant_context():
      tools_dir = Path(__file__).parent.parent / "tools"
      offenders = []
      for py in tools_dir.glob("*.py"):
          text = py.read_text()
          if ("import boto3" in text) and ("tenant_context" not in text):
              offenders.append(py.name)
      assert not offenders, (
          f"These tool files import boto3 but not tenant_context: {offenders}. "
          "Every tool that touches AWS must either require_tenant_id() "
          "or document why it's tenant-independent."
      )
  ```

  This prevents the next new tool from silently reintroducing the regression.

## Medium-priority nits

- **Harden `ensure_tenant_filter` idempotency check** — switch to regex with `\b` word boundaries, or parse the FilterExpression to check for the exact clause. Add a test case for `myField_tenantId` to pin the invariant.
- **Fix `_max_dict_depth` semantics** — either initialize `stack = [(obj, 0)]` with a `>= limit` comparison, or rename the constant to `_MAX_NESTING_DEPTH_INCLUSIVE = 33`. Whichever, make the docstring match.
- **Clarify `tenantId` casing** — JWT claim is `tenantId`, DDB PK uses `TENANT#…`, Cedar uses `tenantId`. Document the canonical form in a short note in ADR-033 so future readers don't accidentally introduce a mismatch.

## Test coverage gaps

- No integration tests that actually exercise a `@tool` function with the new context. `test_tenant_context.py` tests the primitive well but doesn't verify each tool wires it correctly. Worth one per tool family (swarm / code-interpreter / ddb / evolution).
- No test that a `ContextVar` set in a parent task propagates to a child `asyncio.create_task()` invocation. `ContextVar` does copy by default, but the project's assumption should be pinned by a test.

## Documentation issues

- ADR-033 references a grep-based test that doesn't exist yet (see above).
- `gateway_proxy.py` comment overstates what gets injected — reads "tenant_id is injected into every Lambda invocation" but the actual payload also includes tool_name, action, and tool_input. Minor; clarify.

## Overall assessment

With the two CRITICAL findings already closed by later-landing Phase 3b work (evolution sweep + entrypoint cleanup), **the Phase 3 implementation is ready to commit.** The remaining HIGH/MEDIUM items are worth scheduling as a follow-up PR but do not block shipping the tenant-context foundation.
