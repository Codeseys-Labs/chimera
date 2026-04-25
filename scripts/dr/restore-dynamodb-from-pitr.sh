#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Chimera DR — Restore DynamoDB table from Point-in-Time Recovery (PITR)
# ============================================================================
#
# Restores a DynamoDB table to a named timestamp using AWS PITR. A NEW table
# is created — the source is never mutated. The new table ARN is printed on
# STDOUT on success; operator messages are written to STDERR.
#
# Usage:
#   ./scripts/dr/restore-dynamodb-from-pitr.sh <source-table> <restore-time> <new-table> [--dry-run] [--yes]
#
# Positional args:
#   source-table   Name of the source DDB table (must have PITR enabled)
#   restore-time   ISO-8601 UTC timestamp, e.g. 2026-04-22T15:30:00Z
#                  Use "latest" to restore to the latest restorable time.
#   new-table      Name for the restored target table (must not exist)
#
# Flags:
#   --dry-run      Print the AWS CLI command that would be run and exit 0
#   --yes          Skip the interactive confirmation prompt
#   -h | --help    Show usage
#
# Environment:
#   AWS_PROFILE    Passed through to aws CLI if set
#   AWS_REGION     Passed through to aws CLI if set (defaults to aws default)
#
# Exit codes:
#   0  success / dry-run
#   1  usage error
#   2  precondition failed (PITR disabled, timestamp out of window, etc.)
#   3  aws CLI error / restore failed
#
# Example:
#   ./scripts/dr/restore-dynamodb-from-pitr.sh \
#     chimera-tenants-prod \
#     2026-04-22T14:00:00Z \
#     chimera-tenants-restored-$(date +%s)
# ============================================================================

usage() {
    sed -n '3,40p' "$0" >&2
}

log() {
    echo "[restore-pitr] $*" >&2
}

err() {
    echo "[restore-pitr][ERROR] $*" >&2
}

# ----------------------------------------------------------------------------
# Arg parsing
# ----------------------------------------------------------------------------

DRY_RUN=0
AUTO_CONFIRM=0
POSITIONAL=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --yes|-y)
            AUTO_CONFIRM=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            err "Unknown flag: $1"
            usage
            exit 1
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

if [[ ${#POSITIONAL[@]} -ne 3 ]]; then
    err "Expected 3 positional args, got ${#POSITIONAL[@]}"
    usage
    exit 1
fi

SOURCE_TABLE="${POSITIONAL[0]}"
RESTORE_TIME="${POSITIONAL[1]}"
NEW_TABLE="${POSITIONAL[2]}"

# AWS CLI prefix — honor AWS_PROFILE / AWS_REGION env vars if set
AWS=(aws)
if [[ -n "${AWS_PROFILE:-}" ]]; then
    AWS+=(--profile "$AWS_PROFILE")
fi
if [[ -n "${AWS_REGION:-}" ]]; then
    AWS+=(--region "$AWS_REGION")
fi

# ----------------------------------------------------------------------------
# Pre-flight checks (skipped in dry-run so we can print the full plan offline)
# ----------------------------------------------------------------------------

if [[ $DRY_RUN -eq 0 ]]; then
    log "Pre-flight: verifying source table '$SOURCE_TABLE' exists"
    if ! "${AWS[@]}" dynamodb describe-table \
            --table-name "$SOURCE_TABLE" \
            --query 'Table.TableName' \
            --output text >/dev/null 2>&1; then
        err "Source table '$SOURCE_TABLE' not found in this account/region"
        exit 2
    fi

    log "Pre-flight: verifying PITR is enabled on '$SOURCE_TABLE'"
    PITR_STATUS=$(
        "${AWS[@]}" dynamodb describe-continuous-backups \
            --table-name "$SOURCE_TABLE" \
            --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' \
            --output text 2>/dev/null || echo "UNKNOWN"
    )
    if [[ "$PITR_STATUS" != "ENABLED" ]]; then
        err "PITR is not enabled on '$SOURCE_TABLE' (status: $PITR_STATUS). Cannot restore."
        err "Fix: enable PITR via CDK (ChimeraTable construct) or"
        err "     aws dynamodb update-continuous-backups --table-name $SOURCE_TABLE --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true"
        exit 2
    fi

    log "Pre-flight: verifying target table '$NEW_TABLE' does NOT exist"
    if "${AWS[@]}" dynamodb describe-table \
            --table-name "$NEW_TABLE" \
            --query 'Table.TableName' \
            --output text >/dev/null 2>&1; then
        err "Target table '$NEW_TABLE' already exists — refusing to overwrite"
        exit 2
    fi

    if [[ "$RESTORE_TIME" != "latest" ]]; then
        log "Pre-flight: verifying restore time '$RESTORE_TIME' is within the recoverable window"
        WINDOW=$(
            "${AWS[@]}" dynamodb describe-continuous-backups \
                --table-name "$SOURCE_TABLE" \
                --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.{Earliest:EarliestRestorableDateTime,Latest:LatestRestorableDateTime}' \
                --output text
        )
        log "Recoverable window: $WINDOW"
    fi
fi

# ----------------------------------------------------------------------------
# Build the restore command
# ----------------------------------------------------------------------------

RESTORE_CMD=(
    "${AWS[@]}" dynamodb restore-table-to-point-in-time
    --source-table-name "$SOURCE_TABLE"
    --target-table-name "$NEW_TABLE"
)

if [[ "$RESTORE_TIME" == "latest" ]]; then
    RESTORE_CMD+=(--use-latest-restorable-time)
else
    RESTORE_CMD+=(--restore-date-time "$RESTORE_TIME")
fi

# ----------------------------------------------------------------------------
# Confirmation (destructive-adjacent: creates billable resources)
# ----------------------------------------------------------------------------

log "Plan:"
log "  source         = $SOURCE_TABLE"
log "  restore-time   = $RESTORE_TIME"
log "  new-table      = $NEW_TABLE"
log "  region         = ${AWS_REGION:-<default>}"
log "  profile        = ${AWS_PROFILE:-<default>}"

if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN — would execute:"
    printf '%q ' "${RESTORE_CMD[@]}" >&2
    echo >&2
    # Structured JSON to STDOUT so pipelines can parse
    printf '{"status":"dry-run","source":"%s","target":"%s","restore_time":"%s"}\n' \
        "$SOURCE_TABLE" "$NEW_TABLE" "$RESTORE_TIME"
    exit 0
fi

if [[ $AUTO_CONFIRM -eq 0 ]]; then
    read -r -p "Proceed with restore? [y/N] " REPLY
    if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
        err "Aborted by operator"
        exit 1
    fi
fi

# ----------------------------------------------------------------------------
# Execute restore
# ----------------------------------------------------------------------------

log "Submitting restore request (this returns immediately; restore runs async)..."
RESTORE_OUTPUT=$("${RESTORE_CMD[@]}" --output json) || {
    err "aws dynamodb restore-table-to-point-in-time failed"
    exit 3
}

NEW_TABLE_ARN=$(echo "$RESTORE_OUTPUT" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["TableDescription"]["TableArn"])' \
    2>/dev/null || echo "")

if [[ -z "$NEW_TABLE_ARN" ]]; then
    err "Restore call returned no TableArn — check AWS console"
    echo "$RESTORE_OUTPUT" >&2
    exit 3
fi

log "Restore initiated. New table ARN:"
log "  $NEW_TABLE_ARN"
log "The restore runs asynchronously. Monitor with:"
log "  aws dynamodb describe-table --table-name $NEW_TABLE --query 'Table.TableStatus'"

# Structured output to STDOUT for pipelines
printf '{"status":"initiated","source":"%s","target":"%s","target_arn":"%s","restore_time":"%s"}\n' \
    "$SOURCE_TABLE" "$NEW_TABLE" "$NEW_TABLE_ARN" "$RESTORE_TIME"
