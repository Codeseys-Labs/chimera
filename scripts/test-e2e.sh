#!/usr/bin/env bash
# scripts/test-e2e.sh
#
# End-to-end validation against a deployed Chimera environment.
#
# Sequence:
#   1. AWS credential sanity check
#   2. CloudFormation — confirm all 14 stacks CREATE_COMPLETE/UPDATE_COMPLETE
#   3. Frontend — confirm SPA returns 200 (not 403)
#   4. Chat gateway — confirm /health returns 200 with expected shape
#   5. Cognito — provision a test tenant + user (idempotent)
#   6. Auth — obtain a Cognito ID token via USER_PASSWORD_AUTH
#   7. Chat gateway — POST /chat/stream with v5 AI SDK shape, parse SSE,
#      verify we receive at least one `text-delta` + a `finish` event
#   8. Exit 0 if all pass, non-zero with failure banner otherwise
#
# Gated behind CHIMERA_E2E=1 so CI doesn't run it accidentally — the suite
# hits REAL Bedrock (spends money) and writes DDB rows.
#
# Usage:
#   CHIMERA_E2E=1 AWS_PROFILE=baladita+Bedrock-Admin ENV=dev scripts/test-e2e.sh
#
# History:
#   - Closes chimera-9035 + chimera-2087 (both open-ended "make an E2E script").
#   - Recipe extracted from Wave-21 live validation
#     (docs/reviews/wave21-live-validation.md).
set -euo pipefail

if [ "${CHIMERA_E2E:-0}" != "1" ]; then
  echo "ERROR: set CHIMERA_E2E=1 to run this test. It hits real Bedrock + DDB." >&2
  exit 2
fi

ENV="${ENV:-dev}"
: "${AWS_REGION:=us-west-2}"
export AWS_REGION

# Colors (only if output is a TTY).
if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[36m'; RESET=$'\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' RESET=''
fi

fail()  { echo "${RED}FAIL${RESET} $1" >&2; exit 1; }
pass()  { echo "${GREEN}PASS${RESET} $1"; }
info()  { echo "${BLUE}→${RESET} $1"; }
warn()  { echo "${YELLOW}WARN${RESET} $1" >&2; }

PREFIX="Chimera-${ENV}"

# Capture tokens etc. in a tmpdir we clean up on exit.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# 1. AWS credential sanity
# ---------------------------------------------------------------------------
info "Checking AWS credentials..."
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
pass "AWS account: ${ACCOUNT}"

# ---------------------------------------------------------------------------
# 2. Stacks are live
# ---------------------------------------------------------------------------
info "Checking CloudFormation stacks under ${PREFIX}-*..."
STACK_COUNT=$(aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query "length(StackSummaries[?starts_with(StackName, '${PREFIX}-')])" \
  --output text)
if [ "$STACK_COUNT" -lt 14 ]; then
  fail "Only ${STACK_COUNT}/14 stacks live for ${PREFIX}"
fi
pass "${STACK_COUNT} stacks live"

# Helper: fetch a single stack output.
get_output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey==\`$2\`].OutputValue" \
    --output text
}

FRONTEND_URL=$(get_output "${PREFIX}-Frontend" FrontendUrl)
CHAT_URL=$(get_output "${PREFIX}-Chat" CloudFrontUrl)
USER_POOL_ID=$(get_output "${PREFIX}-Security" UserPoolId)
CLIENT_ID=$(get_output "${PREFIX}-Security" WebClientId)
TENANTS_TABLE="chimera-tenants-${ENV}"

for var in FRONTEND_URL CHAT_URL USER_POOL_ID CLIENT_ID; do
  if [ -z "${!var}" ] || [ "${!var}" = "None" ]; then
    fail "CloudFormation output missing: ${var}"
  fi
done
info "Frontend: ${FRONTEND_URL}"
info "Chat:     ${CHAT_URL}"
info "Cognito:  ${USER_POOL_ID} / ${CLIENT_ID}"

# ---------------------------------------------------------------------------
# 3. Frontend HTTP 200
# ---------------------------------------------------------------------------
info "Checking frontend returns 200..."
FE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$FRONTEND_URL/")
if [ "$FE_STATUS" != "200" ]; then
  fail "Frontend returned HTTP ${FE_STATUS} — bucket may be empty; run Frontend_Deploy pipeline stage"
fi
pass "Frontend HTTP ${FE_STATUS}"

# ---------------------------------------------------------------------------
# 4. Chat gateway /health
# ---------------------------------------------------------------------------
info "Checking chat-gateway /health..."
HEALTH=$(curl -sS "$CHAT_URL/health")
if ! echo "$HEALTH" | grep -q '"status":"healthy"'; then
  fail "Chat gateway /health unhealthy: $HEALTH"
fi
pass "Chat gateway healthy"

# ---------------------------------------------------------------------------
# 5. Provision tenant + user (idempotent)
# ---------------------------------------------------------------------------
TENANT_ID="e2e-test-tenant"
TEST_EMAIL="e2e-test@chimera.test"
TEST_PASSWORD="E2e-$(openssl rand -hex 6)!"

info "Seeding tenant PROFILE into DDB..."
aws dynamodb put-item --table-name "$TENANTS_TABLE" \
  --item "{
    \"PK\": {\"S\": \"TENANT#${TENANT_ID}\"},
    \"SK\": {\"S\": \"PROFILE\"},
    \"tenantId\": {\"S\": \"${TENANT_ID}\"},
    \"tier\": {\"S\": \"basic\"},
    \"status\": {\"S\": \"ACTIVE\"},
    \"name\": {\"S\": \"E2E Test Tenant\"},
    \"createdAt\": {\"S\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}
  }" >/dev/null
pass "Tenant ${TENANT_ID} seeded"

# Cognito `custom:tenant_id` is Mutable:false — to (re)bind a user to a tenant
# we must delete + recreate. This is idempotent for repeated test runs.
info "Provisioning Cognito test user (delete + recreate)..."
aws cognito-idp admin-delete-user \
  --user-pool-id "$USER_POOL_ID" --username "$TEST_EMAIL" 2>/dev/null || true
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$TEST_EMAIL" \
  --user-attributes "Name=email,Value=${TEST_EMAIL}" Name=email_verified,Value=true \
                     "Name=custom:tenant_id,Value=${TENANT_ID}" \
                     Name=custom:tenant_tier,Value=basic \
  --message-action SUPPRESS >/dev/null
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$TEST_EMAIL" \
  --password "$TEST_PASSWORD" --permanent >/dev/null
pass "Cognito user ${TEST_EMAIL} ready"

# ---------------------------------------------------------------------------
# 6. Auth — USER_PASSWORD_AUTH (not admin-initiate; ADMIN flow is not enabled)
# ---------------------------------------------------------------------------
info "Authenticating..."
AUTH_JSON=$(aws cognito-idp initiate-auth \
  --client-id "$CLIENT_ID" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters "USERNAME=${TEST_EMAIL},PASSWORD=${TEST_PASSWORD}")
ID_TOKEN=$(echo "$AUTH_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['AuthenticationResult']['IdToken'])")
if [ -z "$ID_TOKEN" ]; then
  fail "Could not obtain ID token"
fi
pass "ID token obtained (${#ID_TOKEN} chars)"

# ---------------------------------------------------------------------------
# 7. Chat stream — send an AI SDK v5 shaped message, verify SSE
# ---------------------------------------------------------------------------
info "POST /chat/stream with AI SDK v5 parts shape..."
STREAM_FILE="$TMP/stream.txt"
curl -sS -X POST "$CHAT_URL/chat/stream" \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  --max-time 60 \
  -d "{
    \"tenantId\": \"${TENANT_ID}\",
    \"platform\": \"web\",
    \"id\": \"e2e-$(date +%s)\",
    \"messages\": [{
      \"id\": \"e2e-user-1\",
      \"role\": \"user\",
      \"parts\": [{\"type\": \"text\", \"text\": \"Say hello in exactly 3 words.\"}]
    }]
  }" > "$STREAM_FILE" 2>&1

# SSE sanity: must contain at least one text-delta and a finish event.
if ! grep -q '"type":"text-delta"' "$STREAM_FILE"; then
  echo "--- stream body ---" >&2
  cat "$STREAM_FILE" >&2
  fail "No text-delta events in SSE stream"
fi
if ! grep -q '"type":"finish"' "$STREAM_FILE"; then
  echo "--- stream body ---" >&2
  cat "$STREAM_FILE" >&2
  fail "Stream did not reach finish event"
fi
if ! grep -q '\[DONE\]' "$STREAM_FILE"; then
  warn "Stream finished but no [DONE] terminator — some SSE clients will hang"
fi
DELTA_COUNT=$(grep -c '"type":"text-delta"' "$STREAM_FILE")
pass "SSE stream delivered ${DELTA_COUNT} text-delta events + finish"

# ---------------------------------------------------------------------------
# 8. Tenant profile fetch (Wave-22 regression test: /tenants/:id used a
#    hardcoded mock DDB client that always returned 404).
# ---------------------------------------------------------------------------
info "GET /tenants/${TENANT_ID} (Wave-22 regression)..."
TENANT_STATUS=$(curl -sS -o "$TMP/tenant.json" -w '%{http_code}' \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  "$CHAT_URL/tenants/${TENANT_ID}")
if [ "$TENANT_STATUS" != "200" ]; then
  echo "--- tenant response ---" >&2
  cat "$TMP/tenant.json" >&2
  fail "Tenant fetch returned HTTP ${TENANT_STATUS} (expected 200; was Wave-22's mock-DDB regression)"
fi
pass "Tenant profile fetch HTTP 200"

echo ""
echo "${GREEN}╔════════════════════════════════╗"
echo "║  E2E validation: ALL CHECKS OK ║"
echo "╚════════════════════════════════╝${RESET}"
