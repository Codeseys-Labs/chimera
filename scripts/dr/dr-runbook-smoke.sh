#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Chimera DR — Quarterly drill smoke test
# ============================================================================
#
# Runs the three DR operator scripts in sequence and emits a single-line
# summary that a quarterly drill report can capture verbatim:
#
#   1. verify-backup-health.sh       (checks PITR + Config on all 6 tables)
#   2. restore-dynamodb-from-pitr.sh --dry-run (against a dev table)
#   3. export-cognito-users.sh       (writes JSONL backup to S3)
#
# STDOUT: one JSON line (drill record)
# STDERR: human-readable per-step status for operators
#
# This is the script that should be wired to EventBridge for weekly
# automation — see docs/guides/disaster-recovery.md "Drill Schedule".
#
# Usage:
#   ./scripts/dr/dr-runbook-smoke.sh [--env <env>] [--user-pool-id <id>] \
#       [--dev-table <name>] [--bucket <name>] [--dry-run]
#
# Flags:
#   --env <env>             Environment suffix for table checks (default: prod)
#   --user-pool-id <id>     Cognito pool for export step (default: skip export)
#   --dev-table <name>      Source table for PITR dry-run (default: chimera-tenants-dev)
#   --bucket <name>         Target bucket for Cognito export
#   --dry-run               Pass --dry-run to every child script
#   -h | --help             Show usage
#
# Environment:
#   AWS_PROFILE, AWS_REGION   Passed through to child scripts
# ============================================================================

usage() {
    sed -n '3,32p' "$0" >&2
}

log() {
    echo "[dr-smoke] $*" >&2
}

err() {
    echo "[dr-smoke][ERROR] $*" >&2
}

ENV_SUFFIX="prod"
USER_POOL_ID=""
DEV_TABLE="chimera-tenants-dev"
BUCKET=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)            ENV_SUFFIX="${2:-}"; shift 2 ;;
        --user-pool-id)   USER_POOL_ID="${2:-}"; shift 2 ;;
        --dev-table)      DEV_TABLE="${2:-}"; shift 2 ;;
        --bucket)         BUCKET="${2:-}"; shift 2 ;;
        --dry-run)        DRY_RUN=1; shift ;;
        -h|--help)        usage; exit 0 ;;
        *) err "Unknown arg: $1"; usage; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

START_EPOCH=$(date -u +%s)
RUN_ID="dr-smoke-$(date -u +%Y%m%dT%H%M%SZ)"

# Track per-step outcomes
STEP_VERIFY="skip"
STEP_RESTORE="skip"
STEP_COGNITO="skip"
OVERALL="ok"
FAILURES=""

# ----------------------------------------------------------------------------
# Step 1 — verify-backup-health
# ----------------------------------------------------------------------------

log "STEP 1/3 — verify-backup-health.sh --env $ENV_SUFFIX"
set +e
VERIFY_ARGS=(--env "$ENV_SUFFIX" --json)
[[ $DRY_RUN -eq 1 ]] && VERIFY_ARGS+=(--dry-run)

"${SCRIPT_DIR}/verify-backup-health.sh" "${VERIFY_ARGS[@]}" >/tmp/${RUN_ID}.verify.json 2>&2
VERIFY_RC=$?
set -e

if [[ $VERIFY_RC -eq 0 ]]; then
    STEP_VERIFY="ok"
    log "  -> ok"
else
    STEP_VERIFY="fail"
    OVERALL="fail"
    FAILURES="${FAILURES}verify(rc=${VERIFY_RC});"
    err "  -> fail (rc=$VERIFY_RC)"
fi

# ----------------------------------------------------------------------------
# Step 2 — restore-dynamodb-from-pitr (ALWAYS --dry-run in the smoke test)
# ----------------------------------------------------------------------------

log "STEP 2/3 — restore-dynamodb-from-pitr.sh --dry-run (source=$DEV_TABLE)"
TARGET_TABLE="chimera-drill-restore-$(date -u +%s)"

set +e
"${SCRIPT_DIR}/restore-dynamodb-from-pitr.sh" \
    "$DEV_TABLE" \
    "latest" \
    "$TARGET_TABLE" \
    --dry-run --yes >/tmp/${RUN_ID}.restore.json 2>&2
RESTORE_RC=$?
set -e

if [[ $RESTORE_RC -eq 0 ]]; then
    STEP_RESTORE="ok"
    log "  -> ok"
else
    STEP_RESTORE="fail"
    OVERALL="fail"
    FAILURES="${FAILURES}restore(rc=${RESTORE_RC});"
    err "  -> fail (rc=$RESTORE_RC)"
fi

# ----------------------------------------------------------------------------
# Step 3 — export-cognito-users (if pool id provided)
# ----------------------------------------------------------------------------

if [[ -n "$USER_POOL_ID" ]]; then
    log "STEP 3/3 — export-cognito-users.sh --user-pool-id $USER_POOL_ID"
    COGNITO_ARGS=(--user-pool-id "$USER_POOL_ID")
    [[ -n "$BUCKET" ]] && COGNITO_ARGS+=(--bucket "$BUCKET")
    [[ $DRY_RUN -eq 1 ]] && COGNITO_ARGS+=(--dry-run)

    set +e
    "${SCRIPT_DIR}/export-cognito-users.sh" "${COGNITO_ARGS[@]}" >/tmp/${RUN_ID}.cognito.json 2>&2
    COGNITO_RC=$?
    set -e

    if [[ $COGNITO_RC -eq 0 ]]; then
        STEP_COGNITO="ok"
        log "  -> ok"
    else
        STEP_COGNITO="fail"
        OVERALL="fail"
        FAILURES="${FAILURES}cognito(rc=${COGNITO_RC});"
        err "  -> fail (rc=$COGNITO_RC)"
    fi
else
    log "STEP 3/3 — skipped (no --user-pool-id provided)"
    STEP_COGNITO="skip"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------

END_EPOCH=$(date -u +%s)
DURATION=$((END_EPOCH - START_EPOCH))

# Single-line summary for drill reports
printf '{"run_id":"%s","status":"%s","env":"%s","duration_sec":%d,"verify":"%s","restore_dry_run":"%s","cognito_export":"%s","failures":"%s","timestamp":"%s"}\n' \
    "$RUN_ID" "$OVERALL" "$ENV_SUFFIX" "$DURATION" \
    "$STEP_VERIFY" "$STEP_RESTORE" "$STEP_COGNITO" \
    "${FAILURES%;}" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ "$OVERALL" == "ok" ]]; then
    exit 0
else
    exit 2
fi
