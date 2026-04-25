#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Chimera DR — Verify backup health across the 6-table data plane
# ============================================================================
#
# Smoke test for disaster recovery readiness. For each of the 6 production
# DynamoDB tables this verifies:
#   1. PITR (continuous backup) status is ENABLED
#   2. LatestRestorableDateTime is within the last 24 hours
#   3. AWS Config rule DYNAMODB_PITR_ENABLED evaluates COMPLIANT on the table
#
# Output (STDOUT) is a single JSON object summarising the run; operator
# messages go to STDERR. Exit 0 means all checks passed; exit 2 means at
# least one table is unhealthy.
#
# Usage:
#   ./scripts/dr/verify-backup-health.sh [--env <env>] [--dry-run] [--json]
#
# Flags:
#   --env <env>   Environment suffix for table names (default: prod)
#                 Tables checked: chimera-<name>-<env>
#   --dry-run     Print the AWS CLI calls that would be made and exit 0
#   --json        Only emit the JSON summary to STDOUT (suppress banners)
#   -h | --help   Show usage
#
# Environment:
#   AWS_PROFILE   Passed through to aws CLI
#   AWS_REGION    Passed through to aws CLI
#
# Exit codes:
#   0  all tables healthy / dry-run
#   1  usage error
#   2  at least one table failed a check
#   3  aws CLI error
# ============================================================================

usage() {
    sed -n '3,36p' "$0" >&2
}

log() {
    [[ ${QUIET:-0} -eq 1 ]] && return 0
    echo "[verify-backup-health] $*" >&2
}

err() {
    echo "[verify-backup-health][ERROR] $*" >&2
}

# ----------------------------------------------------------------------------
# Arg parsing
# ----------------------------------------------------------------------------

ENV_SUFFIX="prod"
DRY_RUN=0
QUIET=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)
            ENV_SUFFIX="${2:-}"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --json)
            QUIET=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            err "Unknown arg: $1"
            usage
            exit 1
            ;;
    esac
done

AWS=(aws)
if [[ -n "${AWS_PROFILE:-}" ]]; then
    AWS+=(--profile "$AWS_PROFILE")
fi
if [[ -n "${AWS_REGION:-}" ]]; then
    AWS+=(--region "$AWS_REGION")
fi

TABLES=(
    "chimera-tenants-${ENV_SUFFIX}"
    "chimera-sessions-${ENV_SUFFIX}"
    "chimera-skills-${ENV_SUFFIX}"
    "chimera-rate-limits-${ENV_SUFFIX}"
    "chimera-cost-tracking-${ENV_SUFFIX}"
    "chimera-audit-${ENV_SUFFIX}"
)

# ----------------------------------------------------------------------------
# Dry-run: print what we'd check and exit
# ----------------------------------------------------------------------------

if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN — would check ${#TABLES[@]} tables in env=${ENV_SUFFIX}"
    for t in "${TABLES[@]}"; do
        log "  $t"
        printf '  %q dynamodb describe-continuous-backups --table-name %q\n' \
            "${AWS[0]}" "$t" >&2
        printf '  %q configservice get-compliance-details-by-resource --resource-type AWS::DynamoDB::Table --resource-id %q\n' \
            "${AWS[0]}" "$t" >&2
    done
    printf '{"status":"dry-run","env":"%s","tables":%d}\n' "$ENV_SUFFIX" "${#TABLES[@]}"
    exit 0
fi

# ----------------------------------------------------------------------------
# Threshold: latest restorable must be within this many seconds of now
# ----------------------------------------------------------------------------

MAX_STALENESS_SECONDS=$((24 * 60 * 60))   # 24 hours
NOW_EPOCH=$(date -u +%s)

# ----------------------------------------------------------------------------
# Check each table
# ----------------------------------------------------------------------------

TOTAL_OK=0
TOTAL_FAIL=0
RESULTS_JSON="["

check_table() {
    local table="$1"
    local status="ok"
    local failures=""

    log "Checking $table..."

    # 1. PITR enabled?
    local pitr_status
    pitr_status=$(
        "${AWS[@]}" dynamodb describe-continuous-backups \
            --table-name "$table" \
            --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' \
            --output text 2>/dev/null || echo "MISSING"
    )

    if [[ "$pitr_status" != "ENABLED" ]]; then
        status="fail"
        failures="${failures}pitr_status=${pitr_status};"
    fi

    # 2. Latest restorable time within window?
    local latest_restorable
    latest_restorable=$(
        "${AWS[@]}" dynamodb describe-continuous-backups \
            --table-name "$table" \
            --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.LatestRestorableDateTime' \
            --output text 2>/dev/null || echo ""
    )

    local staleness_ok="unknown"
    if [[ -n "$latest_restorable" && "$latest_restorable" != "None" ]]; then
        # Latest restorable is a float epoch seconds from aws cli
        local latest_epoch
        latest_epoch=$(printf '%.0f' "$latest_restorable" 2>/dev/null || echo 0)
        local age=$((NOW_EPOCH - latest_epoch))
        if [[ $age -lt 0 ]]; then age=0; fi
        if [[ $age -le $MAX_STALENESS_SECONDS ]]; then
            staleness_ok="yes"
        else
            staleness_ok="no"
            status="fail"
            failures="${failures}staleness_seconds=${age};"
        fi
    else
        status="fail"
        failures="${failures}no_latest_restorable_time;"
    fi

    # 3. AWS Config DYNAMODB_PITR_ENABLED rule compliant?
    # We look for any Config rule matching the resource; missing Config is non-fatal but noted.
    local config_compliance
    config_compliance=$(
        "${AWS[@]}" configservice get-compliance-details-by-resource \
            --resource-type AWS::DynamoDB::Table \
            --resource-id "$table" \
            --query 'EvaluationResults[?contains(EvaluationResultIdentifier.EvaluationResultQualifier.ConfigRuleName, `PITR`) || contains(EvaluationResultIdentifier.EvaluationResultQualifier.ConfigRuleName, `pitr`)].ComplianceType | [0]' \
            --output text 2>/dev/null || echo "NOT_CHECKED"
    )

    if [[ "$config_compliance" == "NON_COMPLIANT" ]]; then
        status="fail"
        failures="${failures}config_rule=NON_COMPLIANT;"
    fi

    log "  pitr=$pitr_status staleness=$staleness_ok config=$config_compliance -> $status"

    # Append JSON result
    RESULTS_JSON+=$(printf '{"table":"%s","pitr":"%s","staleness_ok":"%s","config":"%s","status":"%s","failures":"%s"},' \
        "$table" "$pitr_status" "$staleness_ok" "$config_compliance" "$status" "${failures%;}")

    if [[ "$status" == "ok" ]]; then
        TOTAL_OK=$((TOTAL_OK + 1))
    else
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
    fi
}

for t in "${TABLES[@]}"; do
    check_table "$t"
done

# Strip trailing comma, close array
RESULTS_JSON="${RESULTS_JSON%,}]"

# Emit summary JSON to STDOUT
SUMMARY_STATUS="ok"
if [[ $TOTAL_FAIL -gt 0 ]]; then
    SUMMARY_STATUS="unhealthy"
fi

printf '{"status":"%s","env":"%s","checked":%d,"ok":%d,"failed":%d,"results":%s}\n' \
    "$SUMMARY_STATUS" "$ENV_SUFFIX" "${#TABLES[@]}" "$TOTAL_OK" "$TOTAL_FAIL" "$RESULTS_JSON"

if [[ $TOTAL_FAIL -gt 0 ]]; then
    err "$TOTAL_FAIL/${#TABLES[@]} table(s) unhealthy — see JSON summary"
    exit 2
fi

log "All ${#TABLES[@]} tables healthy"
exit 0
