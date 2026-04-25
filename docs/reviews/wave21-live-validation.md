---
title: "Wave-21 Live Validation — First End-to-End Chat Test"
status: retrospective
date: 2026-04-25
wave: 21
issue: chimera-0092
environment: baladita+Bedrock-Admin / us-west-2 / dev
---

# Wave-21 Live Validation

First true end-to-end verification of the deployed Chimera platform. All
14 stacks live in `111122223333` / us-west-2. CloudFront + ALB + ECS +
Cognito + Bedrock chain exercised successfully.

## Issues closed

| Seeds ID | Title | Status |
|----------|-------|--------|
| `chimera-0092` | Verify chimera chat works end-to-end with system prompt + tools | ✅ CLOSED |
| `chimera-d123` | Re-push to CodeCommit + retrigger pipeline | ⏳ Obsolete — FrontendStack was never the problem; S3 bucket was empty |

## Deployed endpoints

| Service | URL |
|---------|-----|
| Frontend (React SPA) | https://d30xc1vss60b97.cloudfront.net |
| Chat Gateway (ALB via CloudFront) | https://d162y8bdoodm2x.cloudfront.net |
| REST API Gateway | https://ts6bkpq5v3.execute-api.us-west-2.amazonaws.com/dev |
| WebSocket API | wss://0axarlku2i.execute-api.us-west-2.amazonaws.com/dev |
| Cognito User Pool | us-west-2_S1JRepE6G |
| Web Client ID | 6hm3u9vjq0ee8p1svg2eeaa2i3 |
| CloudFront (Frontend) Distribution | ENUXWMLNQEPKX |
| CloudFront (Chat) Distribution | E21V5YCH3IDIF8 |

## What we validated

### 1. Frontend 403 → 200 (root cause: empty S3 bucket)

The ROADMAP "Frontend 403" item (c3c6585 fix) was misdiagnosed. The code
fix had long since landed and was deployed. The real issue: the
`chimera-frontend-dev-111122223333` S3 bucket was empty — no SPA build
was ever uploaded.

Fix:
```bash
cd packages/web && VITE_... bun run build
aws s3 sync dist/ s3://chimera-frontend-dev-111122223333/ --exclude index.html --cache-control "public, max-age=31536000, immutable"
aws s3 cp dist/index.html s3://... --cache-control "no-cache, no-store, must-revalidate"
aws cloudfront create-invalidation --distribution-id ENUXWMLNQEPKX --paths "/*"
```

Result: `curl https://d30xc1vss60b97.cloudfront.net/` → 200 with proper
SPA shell HTML + hashed asset modulepreloads.

### 2. Cognito auth + tenant claims

The user pool schema has `custom:tenant_id` with `Mutable: false` — once
set, cannot be changed. To bind a test user to a tenant:

1. Delete the user
2. `admin-create-user` with `Name=custom:tenant_id,Value=...`
3. `admin-set-user-password --permanent` (avoids FORCE_CHANGE_PASSWORD)

`ALLOW_ADMIN_USER_PASSWORD_AUTH` is NOT in the client's allowed flows —
only `USER_PASSWORD_AUTH`, `USER_SRP_AUTH`, `REFRESH_TOKEN_AUTH`. Use
`aws cognito-idp initiate-auth` (not `admin-initiate-auth`).

### 3. Chat gateway auth + streaming

`POST /chat/stream` with the Cognito ID token as `Authorization: Bearer`:
- Returned HTTP 200 with `Content-Type: text/event-stream`
- Full SSE stream observed: `start` → `text-start` → N × `text-delta` →
  `text-end` → `finish{finishReason:stop}` → `[DONE]`
- First test: "Say hello in 5 words" → "Hello there! How are you? 😊"
- Second test: "What AWS tools can you use?" → multi-section tool
  inventory (EC2, Lambda, S3, RDS, IAM, CloudFormation, ...)

Total latency first-token: ~1.2s. Total stream duration: ~4-6s for short
responses.

### 4. Tenant provisioning required DDB seed

First attempt returned `MISSING_TENANT_CONTEXT` / `TenantNotFound`
because no tenant profile existed in `chimera-tenants-dev`. Created:

```json
{
  "PK": "TENANT#test-tenant-wave21",
  "SK": "PROFILE",
  "tenantId": "test-tenant-wave21",
  "tier": "basic",
  "status": "ACTIVE",
  "name": "Wave-21 E2E Test Tenant",
  "createdAt": "2026-04-25T06:30:00Z"
}
```

This is expected pre-GTM — the tenant-onboarding flow exists but was
not yet wired into self-serve signup (part of the strategic "close the
GTM loop" item).

## Follow-ups surfaced during validation

| Priority | Item | Notes |
|----------|------|-------|
| Low | `docs/runbooks/chimera-cli-deploy.md` — post-deploy SPA upload step | Currently an operator has to remember to sync S3 after deploy; should be a CLI command or CodeBuild post-deploy step |
| Low | Cognito `admin-initiate-auth` not enabled | Acceptable for production (SRP is preferred); tooling scripts should use `initiate-auth` directly |
| Medium | `custom:tenant_id` is `Mutable: false` | Means an admin cannot migrate a user between tenants without delete+recreate. Acceptable for strong tenant isolation; document in admin runbook |
| Info | Playwright MCP added but needs session restart | `~/.claude.json` updated with `@playwright/mcp` stdio server; user restart session to get browser-automation tools |

## Commands to reproduce

All commands shown assume `AWS_PROFILE=baladita+Bedrock-Admin` and
`AWS_REGION=us-west-2`.

```bash
# 1. Create tenant
aws dynamodb put-item --table-name chimera-tenants-dev \
  --item '{"PK":{"S":"TENANT#demo"}, "SK":{"S":"PROFILE"}, "tenantId":{"S":"demo"}, "tier":{"S":"basic"}, "status":{"S":"ACTIVE"}}'

# 2. Create user bound to tenant
aws cognito-idp admin-create-user \
  --user-pool-id us-west-2_S1JRepE6G \
  --username test@example.com \
  --user-attributes Name=email,Value=test@example.com Name=email_verified,Value=true 'Name=custom:tenant_id,Value=demo' 'Name=custom:tenant_tier,Value=basic' \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password \
  --user-pool-id us-west-2_S1JRepE6G \
  --username test@example.com --password 'StrongPass1!' --permanent

# 3. Get ID token
AUTH=$(aws cognito-idp initiate-auth \
  --client-id 6hm3u9vjq0ee8p1svg2eeaa2i3 \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=test@example.com,PASSWORD='StrongPass1!')
ID_TOKEN=$(echo "$AUTH" | jq -r '.AuthenticationResult.IdToken')

# 4. Chat!
curl -N -X POST https://d162y8bdoodm2x.cloudfront.net/chat/stream \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"tenantId":"demo","platform":"web"}'
```

## References

- Seeds `chimera-0092` (closed 2026-04-25)
- `docs/reviews/WAVE-RETROSPECTIVE-20.md`
- `docs/reviews/wave20-backlog-audit.md`
- AWS account: 111122223333, region us-west-2, profile baladita+Bedrock-Admin
