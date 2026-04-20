# Boundary Leak Sweep — Post-Phase-3

**Date:** 2026-04-17  
**Scope:** Phase 3 removal of `tenant_id` parameter from tool function signatures  
**Thoroughness:** Medium

## Summary

Phase 3 changed 10 public tool functions across three modules to read `tenant_id` from `tools.tenant_context.require_tenant_id()` instead of accepting it as a parameter. **CRITICAL: 17 call sites in production test code still pass `tenant_id=...` as a keyword argument, causing runtime failures.**

---

## Changed Function Signatures

| Module | Function | Old Signature | New Signature |
|--------|----------|---------------|---------------|
| swarm_tools.py | `decompose_and_execute` | `(request, strategy, max_subtasks, session_id)` | Same (no tenant_id) |
| swarm_tools.py | `check_swarm_status` | `(execution_id)` | Same (no tenant_id) |
| swarm_tools.py | `wait_for_swarm` | `(execution_id, max_wait_seconds, poll_interval_seconds)` | Same (no tenant_id) |
| swarm_tools.py | `delegate_subtask` | `(instruction, agent_role, priority, parent_task_id)` | Same (no tenant_id) |
| code_interpreter_tools.py | `validate_cdk_in_sandbox` | `(cdk_code, capability_name)` | Same (no tenant_id) |
| code_interpreter_tools.py | `execute_in_sandbox` | `(code, language, session_name)` | Same (no tenant_id) |
| code_interpreter_tools.py | `fetch_url_content` | `(url, extract_text)` | Same (no tenant_id) |
| evolution_tools.py | `trigger_infra_evolution` | `(capability_name, cdk_stack_code, tenant_id=..., rationale, ...)` | **REMOVED `tenant_id=...` parameter** |
| evolution_tools.py | `register_capability` | `(capability_name, tool_module, tool_names, tier, description, tenant_id=..., region)` | **REMOVED `tenant_id=...` parameter** |
| evolution_tools.py | `list_evolution_history` | `(tenant_id=..., limit, region)` | **REMOVED `tenant_id=...` parameter** |

---

## Caller Sites That Still Pass `tenant_id=` (BREAKING)

**SEVERITY: CRITICAL** — These tests will fail at runtime with `TypeError: unexpected keyword argument 'tenant_id'`.

### Test File: `packages/agents/tests/test_evolution_tools.py`

| Line(s) | Function Called | Snippet | Impact |
|---------|-----------------|---------|--------|
| 308-313 | `trigger_infra_evolution` | `trigger_infra_evolution(..., tenant_id="tenant-abc", ...)` | **9 test cases** |
| 325 | `trigger_infra_evolution` | `trigger_infra_evolution(..., tenant_id="tenant-abc", ...)` | test_kill_switch_blocks |
| 345 | `trigger_infra_evolution` | `trigger_infra_evolution(..., tenant_id="tenant-abc", ...)` | test_cedar_denial_blocks |
| 369 | `trigger_infra_evolution` | `trigger_infra_evolution(..., tenant_id="tenant-abc", ...)` | test_rate_limit_blocks |
| 393 | `trigger_infra_evolution` | `trigger_infra_evolution(..., tenant_id="tenant-abc", ...)` | test_invalid_cdk_blocks |
| 409-413 | `trigger_infra_evolution` | `trigger_infra_evolution(..., tenant_id="tenant-abc", ...)` | test_codecommit_error_propagates |
| 423-427 | `trigger_infra_evolution` | `trigger_infra_evolution(..., tenant_id="tenant-abc", ...)` | test_records_audit_trail_on_success |
| 521-527 | `register_capability` | `register_capability(..., tenant_id="tenant-abc")` | **5 test cases** |
| 536-542 | `register_capability` | `register_capability(..., tenant_id="tenant-abc")` | test_invalid_tier_rejected |
| 547-553 | `register_capability` | `register_capability(..., tenant_id="tenant-abc")` | test_empty_tool_names_rejected |
| 564-570 | `register_capability` | `register_capability(..., tenant_id="tenant-abc")` | test_ddb_error_reported |
| 587-593 | `register_capability` | `register_capability(..., tier=tier, description="test", tenant_id="tenant-abc")` | test_tier_label_in_output (parameterized) |
| 611 | `list_evolution_history` | `list_evolution_history(tenant_id="tenant-abc")` | **3 test cases** |
| 632 | `list_evolution_history` | `list_evolution_history(tenant_id="tenant-abc")` | test_returns_formatted_items |
| 646 | `list_evolution_history` | `list_evolution_history(tenant_id="tenant-abc", limit=200)` | test_caps_limit_at_50 |
| 658 | `list_evolution_history` | `list_evolution_history(tenant_id="tenant-abc")` | test_reports_error_on_ddb_failure |

**Total Breaking Call Sites: 17 across test_evolution_tools.py**

### Other Areas Checked

- **TypeScript/Core Orchestration** (`packages/core/src/`): No direct tool invocations found in source. TypeScript code does not call Python tools with parameters (tools are discovered via Gateway, not directly invoked).
- **System Prompt** (`packages/agents/system_prompt.py`): References tool names but not function signatures; only documentation of capabilities. No breaking code.
- **Gateway Config** (`packages/agents/gateway_config.py`): Tool module registry mirrors the discovery mechanism; no breaking references.
- **DynamoDB Tools** (`packages/agents/tools/dynamodb_tools.py`): No breaking changes; these tools never accepted `tenant_id` parameter (they enforce tenant context internally).

---

## Caller Sites That Reference the Tool But Are OK

- **Gateway configuration** (`gateway_config.py`, lines 264, 267): Lists tool names in registry for discovery. These are static module/function name references; no signature change affects them.
- **System prompt** (`system_prompt.py`, lines 58-111): Documents tool usage for agent instruction. No runtime code invocation; safe.

---

## Docs That Need Updating

1. **None identified** — The system prompt documents tool usage, not signatures. Tool discovery is handled by the Gateway configuration (module/function registry), which is stable.
2. No ADRs, READMEs, or example code in `docs/` directory reference the old signatures as of the grep scan.

---

## Recommended Follow-ups

**Priority 1 (Immediate — Blocking):**
- Fix all 17 test calls in `packages/agents/tests/test_evolution_tools.py`:
  - Remove `tenant_id=` keyword argument from all invocations of `trigger_infra_evolution`, `register_capability`, and `list_evolution_history`.
  - Tests should pass after removal since `tools.tenant_context.require_tenant_id()` will read from context automatically.
  - **Example fix:**
    ```python
    # BEFORE (line 308-313)
    result = trigger_infra_evolution(
        capability_name="media-ingestion",
        cdk_stack_code=VALID_CDK,
        tenant_id="tenant-abc",  # DELETE THIS LINE
        rationale="Users requested S3 media pipeline",
    )
    
    # AFTER
    result = trigger_infra_evolution(
        capability_name="media-ingestion",
        cdk_stack_code=VALID_CDK,
        rationale="Users requested S3 media pipeline",
    )
    ```
  - For test context setup, ensure `tools.tenant_context` is properly mocked/configured if the tests don't already set up the context.

**Priority 2 (Verification):**
- Run `pytest packages/agents/tests/test_evolution_tools.py -v` to confirm no runtime errors after edits.
- Verify Gateway discovery still works: `python -c "from gateway_config import _TOOL_TIER_REGISTRY; print(_TOOL_TIER_REGISTRY['tools.evolution_tools'])"` should return the tier and tool list without errors.

**Priority 3 (Future Prevention):**
- Add a lint check to detect calls passing `tenant_id=` to tools in `packages/agents/tools/`. This could catch similar issues early in code review.

---

## Conclusion

The Phase 3 refactor successfully moved tenant context to a centralized, implicit `require_tenant_id()` pattern. However, **17 test invocations still pass the old `tenant_id=...` keyword argument**, causing immediate test failures. All fixes are straightforward (remove the parameter from call sites); no logic changes needed.

