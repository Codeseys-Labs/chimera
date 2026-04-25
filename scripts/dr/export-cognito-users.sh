#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Chimera DR — Export Cognito user pool users to S3 (backup)
# ============================================================================
#
# Cognito does not expose a native backup/export API, so this script pages
# through cognito-idp:list-users and writes each user's attributes as a
# JSONL record to:
#
#   s3://chimera-backups-<account>-<region>/cognito/<timestamp>/users.jsonl
#
# One user per line. The record includes Username, UserStatus, Enabled,
# UserCreateDate, UserLastModifiedDate, and all Attributes (including
# the custom:tenant_id attribute used for tenant binding).
#
# The script is IDEMPOTENT with respect to the timestamp directory — two
# runs at different seconds produce two independent snapshots; two runs
# within the same second will overwrite each other (intentional, keeps
# the prefix stable per drill).
#
# Passwords and refresh tokens CANNOT be exported (Cognito never returns
# them). Recovery requires users to re-auth via email-based password reset
# — see docs/runbooks/cognito-recovery.md.
#
# Usage:
#   ./scripts/dr/export-cognito-users.sh --user-pool-id <pool-id> --bucket <bucket> [--prefix <p>] [--dry-run]
#
# Flags:
#   --user-pool-id <id>   Cognito user pool ID (required unless --dry-run)
#   --bucket <name>       S3 bucket name (required). Default naming:
#                         chimera-backups-<account>-<region>
#   --prefix <path>       Optional prefix inside the bucket (default: cognito)
#   --timestamp <ts>      Override timestamp directory (default: $(date -u +%Y%m%dT%H%M%SZ))
#   --dry-run             Do not call aws; print the plan and exit
#   -h | --help           Show usage
#
# Environment:
#   AWS_PROFILE, AWS_REGION   Passed through to aws CLI
#
# Exit codes:
#   0  success / dry-run
#   1  usage error
#   2  precondition failed (bucket missing, pool missing, etc.)
#   3  aws CLI error
# ============================================================================

usage() {
    sed -n '3,46p' "$0" >&2
}

log() {
    echo "[export-cognito] $*" >&2
}

err() {
    echo "[export-cognito][ERROR] $*" >&2
}

# ----------------------------------------------------------------------------
# Arg parsing
# ----------------------------------------------------------------------------

USER_POOL_ID=""
BUCKET=""
PREFIX="cognito"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --user-pool-id)
            USER_POOL_ID="${2:-}"
            shift 2
            ;;
        --bucket)
            BUCKET="${2:-}"
            shift 2
            ;;
        --prefix)
            PREFIX="${2:-}"
            shift 2
            ;;
        --timestamp)
            TIMESTAMP="${2:-}"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
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

# ----------------------------------------------------------------------------
# Resolve default bucket name if caller didn't pass --bucket
# ----------------------------------------------------------------------------

if [[ -z "$BUCKET" ]]; then
    if [[ $DRY_RUN -eq 0 ]]; then
        ACCOUNT_ID=$("${AWS[@]}" sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
        REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
        if [[ -z "$ACCOUNT_ID" ]]; then
            err "Could not resolve AWS account id; pass --bucket explicitly"
            exit 2
        fi
        BUCKET="chimera-backups-${ACCOUNT_ID}-${REGION}"
    else
        BUCKET="chimera-backups-<account>-<region>"
    fi
fi

S3_URI="s3://${BUCKET}/${PREFIX}/${TIMESTAMP}/users.jsonl"

# ----------------------------------------------------------------------------
# Dry-run: print the plan and exit
# ----------------------------------------------------------------------------

if [[ $DRY_RUN -eq 1 ]]; then
    log "DRY-RUN plan:"
    log "  user-pool-id = ${USER_POOL_ID:-<unset>}"
    log "  target       = $S3_URI"
    log "  region       = ${AWS_REGION:-<default>}"
    log "  profile      = ${AWS_PROFILE:-<default>}"
    printf '{"status":"dry-run","user_pool_id":"%s","target":"%s"}\n' \
        "$USER_POOL_ID" "$S3_URI"
    exit 0
fi

# ----------------------------------------------------------------------------
# Pre-flight
# ----------------------------------------------------------------------------

if [[ -z "$USER_POOL_ID" ]]; then
    err "--user-pool-id is required"
    usage
    exit 1
fi

log "Pre-flight: verifying user pool '$USER_POOL_ID' is reachable"
if ! "${AWS[@]}" cognito-idp describe-user-pool \
        --user-pool-id "$USER_POOL_ID" \
        --query 'UserPool.Id' \
        --output text >/dev/null 2>&1; then
    err "User pool '$USER_POOL_ID' not found or access denied"
    exit 2
fi

log "Pre-flight: verifying bucket '$BUCKET' exists and is writable"
if ! "${AWS[@]}" s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    err "Bucket '$BUCKET' does not exist or is not accessible"
    exit 2
fi

# ----------------------------------------------------------------------------
# Paginate and stream users to a temp file, then upload to S3
# ----------------------------------------------------------------------------

TMP_FILE="$(mktemp -t chimera-cognito-export.XXXXXX)"
trap 'rm -f "$TMP_FILE"' EXIT

log "Paginating cognito-idp:list-users into $TMP_FILE"

PAGINATION_TOKEN=""
USER_COUNT=0
PAGE_COUNT=0

while true; do
    PAGE_COUNT=$((PAGE_COUNT + 1))
    if [[ -z "$PAGINATION_TOKEN" ]]; then
        PAGE=$("${AWS[@]}" cognito-idp list-users \
            --user-pool-id "$USER_POOL_ID" \
            --limit 60 \
            --output json) || { err "list-users failed on page $PAGE_COUNT"; exit 3; }
    else
        PAGE=$("${AWS[@]}" cognito-idp list-users \
            --user-pool-id "$USER_POOL_ID" \
            --limit 60 \
            --pagination-token "$PAGINATION_TOKEN" \
            --output json) || { err "list-users failed on page $PAGE_COUNT"; exit 3; }
    fi

    # Flatten Users array to JSONL. Use python (always present on macos/linux).
    PAGE_COUNT_USERS=$(python3 - "$PAGE" >>"$TMP_FILE" <<'PYEOF'
import json, sys
page = json.loads(sys.argv[1])
users = page.get("Users", [])
for u in users:
    # Convert datetime strings already serialized; dump minimal record
    rec = {
        "Username": u.get("Username"),
        "UserStatus": u.get("UserStatus"),
        "Enabled": u.get("Enabled"),
        "UserCreateDate": u.get("UserCreateDate"),
        "UserLastModifiedDate": u.get("UserLastModifiedDate"),
        "Attributes": u.get("Attributes", []),
    }
    sys.stdout.write(json.dumps(rec, default=str) + "\n")
print(len(users), file=sys.stderr)
PYEOF
)

    # Count via wc — python print to stderr was for debugging only
    USER_COUNT=$(wc -l < "$TMP_FILE" | tr -d ' ')

    PAGINATION_TOKEN=$(echo "$PAGE" \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("PaginationToken",""))' \
        2>/dev/null || echo "")

    if [[ -z "$PAGINATION_TOKEN" ]]; then
        break
    fi
done

log "Paginated $PAGE_COUNT page(s), $USER_COUNT user(s)"

# ----------------------------------------------------------------------------
# Upload to S3 with server-side encryption
# ----------------------------------------------------------------------------

log "Uploading to $S3_URI"
"${AWS[@]}" s3 cp "$TMP_FILE" "$S3_URI" \
    --sse aws:kms \
    --metadata "exported-by=export-cognito-users.sh,user-pool-id=$USER_POOL_ID,user-count=$USER_COUNT" \
    >/dev/null 2>&1 || { err "S3 upload failed"; exit 3; }

log "Export complete"

# Structured output
printf '{"status":"ok","user_pool_id":"%s","target":"%s","user_count":%d,"pages":%d}\n' \
    "$USER_POOL_ID" "$S3_URI" "$USER_COUNT" "$PAGE_COUNT"
