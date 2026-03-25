---
title: Custom Domain Setup for Chimera
version: 1.0.0
status: canonical
last_updated: 2026-03-25
---

# Custom Domain Setup

This guide covers configuring a custom domain for a Chimera deployment. It addresses three DNS providers (Cloudflare, Namecheap, GoDaddy) plus domains registered directly in Route 53, SES email verification, CloudFront TLS, and API Gateway custom domains.

## Overview

A Chimera deployment exposes three endpoints. Each can be served under a custom domain:

| Endpoint | Default URL Pattern | Custom Domain Example |
|----------|--------------------|-----------------------|
| Chat Gateway (CloudFront) | `https://d1234abcdef.cloudfront.net` | `https://chat.example.com` |
| REST API (API Gateway) | `https://abc123.execute-api.us-east-1.amazonaws.com/dev` | `https://api.example.com` |
| WebSocket API | `wss://xyz789.execute-api.us-east-1.amazonaws.com/dev` | `wss://ws.example.com` |

All TLS certificates for CloudFront must be issued in `us-east-1`, regardless of your deployment region. API Gateway certificates are issued in the deployment region.

---

## Without a Custom Domain (Default)

A Chimera deployment is fully functional without a custom domain.

### What works out of the box

- Chat UI accessible at the CloudFront URL (`CloudFrontUrl` stack output)
- REST API accessible at the API Gateway URL (`ApiUrl` stack output)
- WebSocket API accessible at the WebSocket URL (`WebSocketUrl` stack output)
- Cognito-based authentication with the Cognito hosted UI domain

### What requires a custom domain

- SES outbound email — SES requires domain ownership verification to send email
- Branded endpoints for tenants and end users

### Adding a custom domain later

If you deploy without a custom domain and want to add one later, update `chimera.toml` and re-deploy:

```toml
[domain]
name = "example.com"
provider = "route53"       # route53 | cloudflare | namecheap | godaddy
hosted_zone_id = "Z0123456789ABCDEFGHIJ"
```

---

## Prerequisites

- A registered domain name
- AWS CLI configured with permissions for: `acm`, `route53`, `cloudfront`, `apigateway`, `apigatewayv2`, `ses`
- Chimera deployed at least once (`chimera deploy` completed successfully)
- Stack outputs available: `CloudFrontDistributionId`, `CloudFrontDomainName`, `WebSocketApiId`

---

## Route 53 (Domain Registered in AWS)

Use this path if your domain was registered in Route 53 or you want Route 53 to be authoritative.

### Step 1: Create a Hosted Zone

```bash
aws route53 create-hosted-zone \
  --name example.com \
  --caller-reference "$(date +%s)"
```

Note the `HostedZoneId` from the response (e.g., `Z0123456789ABCDEFGHIJ`) and the four `NS` records in `DelegationSet.NameServers`. If the domain is registered in Route 53, the NS records are already wired. For external registrars, delegate to these name servers first (see sections below).

### Step 2: Request ACM Certificate

ACM certificates for CloudFront must be requested in `us-east-1`:

```bash
aws acm request-certificate \
  --domain-name example.com \
  --subject-alternative-names "*.example.com" \
  --validation-method DNS \
  --region us-east-1
```

Note the certificate ARN from the response.

### Step 3: Validate the Certificate via DNS

Retrieve the validation CNAME records:

```bash
aws acm describe-certificate \
  --certificate-arn arn:aws:acm:us-east-1:123456789012:certificate/<ID> \
  --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord'
```

Add each CNAME to Route 53:

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id Z0123456789ABCDEFGHIJ \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "_<token>.example.com",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "_<token>.acm-validations.aws"}]
      }
    }]
  }'
```

Wait for validation:

```bash
aws acm wait certificate-validated \
  --certificate-arn arn:aws:acm:us-east-1:123456789012:certificate/<ID> \
  --region us-east-1
```

### Step 4: Create DNS Records

Add an `A` alias record for the Chat UI pointing to CloudFront. CloudFront's hosted zone ID is always `Z2FDTNDATAQYW2`:

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id Z0123456789ABCDEFGHIJ \
  --change-batch '{
    "Changes": [
      {
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "chat.example.com",
          "Type": "A",
          "AliasTarget": {
            "HostedZoneId": "Z2FDTNDATAQYW2",
            "DNSName": "d1234abcdef.cloudfront.net",
            "EvaluateTargetHealth": false
          }
        }
      },
      {
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "api.example.com",
          "Type": "CNAME",
          "TTL": 300,
          "ResourceRecords": [{"Value": "abc123.execute-api.us-east-1.amazonaws.com"}]
        }
      },
      {
        "Action": "UPSERT",
        "ResourceRecordSet": {
          "Name": "ws.example.com",
          "Type": "CNAME",
          "TTL": 300,
          "ResourceRecords": [{"Value": "xyz789.execute-api.us-east-1.amazonaws.com"}]
        }
      }
    ]
  }'
```

Replace `d1234abcdef.cloudfront.net`, `abc123.execute-api.us-east-1.amazonaws.com`, and `xyz789.execute-api.us-east-1.amazonaws.com` with the values from your stack outputs.

Then proceed to [CloudFront Custom Domain](#cloudfront-custom-domain), [API Gateway Custom Domain](#api-gateway-custom-domain), and [SES Domain Verification](#ses-domain-verification).

---

## Cloudflare

### Option A: NS Delegation to Route 53 (Recommended)

Delegates full DNS control to Route 53. Chimera CDK can manage all records automatically.

**Pros:** Simplest long-term setup; CDK manages all records.
**Cons:** Lose Cloudflare proxy features (DDoS, page rules).

1. Complete [Route 53: Steps 1–3](#route-53-domain-registered-in-aws) to get your hosted zone NS records.

2. In the Cloudflare dashboard, go to **DNS -> Records** for your domain.

3. Replace the existing `NS` records at the apex (`@`) with the four Route 53 name servers. Set each to **DNS only** (grey cloud) — NS records cannot be proxied.

4. Continue with [Route 53: Step 4](#step-4-create-dns-records) to add endpoint records inside Route 53.

DNS propagation takes up to 48 hours. Verify:

```bash
dig NS example.com @8.8.8.8 +short
# Should return *.awsdns-* servers
```

---

### Option B: CNAME Records in Cloudflare (Keep DNS at Cloudflare)

Keep DNS in Cloudflare but point only the Chimera subdomains to AWS.

**Pros:** Keep Cloudflare for other domains/subdomains.
**Cons:** Must add records manually; ACM and SES records must be DNS-only.

> **CRITICAL:** All records pointing to AWS (ACM validation, CloudFront, API Gateway, SES) **must** be set to **DNS only (grey cloud)**. Cloudflare proxying breaks ACM validation and CloudFront SNI.

Request the ACM certificate and retrieve the validation CNAME (see [Route 53: Steps 2–3](#route-53-domain-registered-in-aws)).

Add the following records in Cloudflare **DNS -> Records**:

**ACM Validation:**

| Type  | Name                    | Content                           | Proxy       |
|-------|-------------------------|-----------------------------------|-------------|
| CNAME | `_<token>` | `_<token>.acm-validations.aws` | DNS only |

**Endpoints:**

| Type  | Name   | Content                                             | Proxy       |
|-------|--------|-----------------------------------------------------|-------------|
| CNAME | `chat` | `d1234abcdef.cloudfront.net`                        | DNS only |
| CNAME | `api`  | `abc123.execute-api.us-east-1.amazonaws.com`        | DNS only |
| CNAME | `ws`   | `xyz789.execute-api.us-east-1.amazonaws.com`        | DNS only |

**SES Records** (add after [SES Domain Verification](#ses-domain-verification)):

| Type  | Name                        | Content                                      | Proxy       |
|-------|-----------------------------|----------------------------------------------|-------------|
| CNAME | `<token1>._domainkey`       | `<token1>.dkim.amazonses.com`                | DNS only |
| CNAME | `<token2>._domainkey`       | `<token2>.dkim.amazonses.com`                | DNS only |
| CNAME | `<token3>._domainkey`       | `<token3>.dkim.amazonses.com`                | DNS only |
| TXT   | `@`                         | `v=spf1 include:amazonses.com ~all`          | DNS only |
| TXT   | `_dmarc`                    | `v=DMARC1; p=none; rua=mailto:dmarc@example.com` | DNS only |

---

### Option C: Cloudflare Tunnel (Private Origin)

Use a `cloudflared` tunnel when Chimera's ALB or API Gateway is not publicly accessible.

**Pros:** No public ingress; zero firewall rules needed.
**Cons:** Adds a daemon dependency; latency via Cloudflare edge.

```bash
# Install
brew install cloudflare/cloudflare/cloudflared

# Authenticate with your Cloudflare account
cloudflared tunnel login

# Create the tunnel
cloudflared tunnel create chimera-dev
# Note the tunnel ID from the output

# Create routing config
cat > ~/.cloudflared/config.yml <<EOF
tunnel: <TUNNEL_ID>
credentials-file: /Users/<you>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: chat.example.com
    service: https://d1234abcdef.cloudfront.net
    originRequest:
      noTLSVerify: false
  - hostname: api.example.com
    service: https://abc123.execute-api.us-east-1.amazonaws.com
  - hostname: ws.example.com
    service: https://xyz789.execute-api.us-east-1.amazonaws.com
  - service: http_status:404
EOF

# Create Cloudflare DNS records pointing to tunnel
cloudflared tunnel route dns chimera-dev chat.example.com
cloudflared tunnel route dns chimera-dev api.example.com
cloudflared tunnel route dns chimera-dev ws.example.com

# Run the tunnel
cloudflared tunnel run chimera-dev
```

For production, run `cloudflared` as a persistent service:

```bash
sudo cloudflared service install
sudo launchctl start com.cloudflare.cloudflared   # macOS
# or: sudo systemctl start cloudflared            # Linux
```

---

## Namecheap

### Step 1: Request ACM Certificate

```bash
aws acm request-certificate \
  --domain-name example.com \
  --subject-alternative-names "*.example.com" \
  --validation-method DNS \
  --region us-east-1
```

### Step 2: Add ACM Validation CNAME

Retrieve the CNAME name and value from:

```bash
aws acm describe-certificate \
  --certificate-arn arn:aws:acm:us-east-1:123456789012:certificate/<ID> \
  --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord'
```

In Namecheap: **Domain List -> Manage -> Advanced DNS -> Add New Record**

> **Note:** In the **Host** field, do not include the domain name. If the full CNAME name is `_abc123.example.com`, enter only `_abc123`.

| Type  | Host       | Value                             | TTL  |
|-------|------------|-----------------------------------|------|
| CNAME | `_<token>` | `_<token>.acm-validations.aws`    | Auto |

### Step 3: Add Endpoint CNAMEs

| Type  | Host   | Value                                             | TTL  |
|-------|--------|---------------------------------------------------|------|
| CNAME | `chat` | `d1234abcdef.cloudfront.net`                      | Auto |
| CNAME | `api`  | `abc123.execute-api.us-east-1.amazonaws.com`      | Auto |
| CNAME | `ws`   | `xyz789.execute-api.us-east-1.amazonaws.com`      | Auto |

### Step 4: Add SES Records

After running [SES Domain Verification](#ses-domain-verification), add these records:

| Type  | Host                      | Value                                        | TTL  |
|-------|---------------------------|----------------------------------------------|------|
| CNAME | `<token1>._domainkey`     | `<token1>.dkim.amazonses.com`                | Auto |
| CNAME | `<token2>._domainkey`     | `<token2>.dkim.amazonses.com`                | Auto |
| CNAME | `<token3>._domainkey`     | `<token3>.dkim.amazonses.com`                | Auto |
| TXT   | `@`                       | `v=spf1 include:amazonses.com ~all`          | Auto |
| TXT   | `_dmarc`                  | `v=DMARC1; p=none; rua=mailto:dmarc@example.com` | Auto |
| MX    | `@`                       | `10 inbound-smtp.us-east-1.amazonaws.com`    | Auto |

> The MX record is optional and only needed for SES inbound email. SES inbound is available in `us-east-1`, `us-west-2`, and `eu-west-1` only.

---

## GoDaddy

The process mirrors Namecheap with one difference: GoDaddy automatically appends the domain to DNS record names. If the full ACM validation CNAME is `_abc123.example.com`, enter only `_abc123` in the **Name** field.

### Step 1: Request ACM Certificate

Same as Namecheap Step 1.

### Step 2: Add ACM Validation CNAME

In GoDaddy: **My Products -> DNS -> Add** for your domain.

| Type  | Name       | Value                             | TTL    |
|-------|------------|-----------------------------------|--------|
| CNAME | `_<token>` | `_<token>.acm-validations.aws`    | 1 hour |

### Step 3: Add Endpoint CNAMEs

| Type  | Name   | Value                                             | TTL    |
|-------|--------|---------------------------------------------------|--------|
| CNAME | `chat` | `d1234abcdef.cloudfront.net`                      | 1 hour |
| CNAME | `api`  | `abc123.execute-api.us-east-1.amazonaws.com`      | 1 hour |
| CNAME | `ws`   | `xyz789.execute-api.us-east-1.amazonaws.com`      | 1 hour |

> **Note:** GoDaddy strips trailing dots from CNAME values. Do not add trailing dots — GoDaddy adds them automatically.

### Step 4: Add SES Records

| Type  | Name                      | Value                                        | TTL    |
|-------|---------------------------|----------------------------------------------|--------|
| CNAME | `<token1>._domainkey`     | `<token1>.dkim.amazonses.com`                | 1 hour |
| CNAME | `<token2>._domainkey`     | `<token2>.dkim.amazonses.com`                | 1 hour |
| CNAME | `<token3>._domainkey`     | `<token3>.dkim.amazonses.com`                | 1 hour |
| TXT   | `@`                       | `v=spf1 include:amazonses.com ~all`          | 1 hour |
| TXT   | `_dmarc`                  | `v=DMARC1; p=none; rua=mailto:dmarc@example.com` | 1 hour |
| MX    | `@`                       | `10 inbound-smtp.us-east-1.amazonaws.com`    | 1 hour |

---

## SES Domain Verification

These steps are provider-independent. Run them once DNS is delegated or records are added at your registrar.

### Step 1: Initiate Domain Verification

```bash
aws ses verify-domain-identity --domain example.com
```

This returns a verification token. Add it as a TXT record at `_amazonses.example.com` with the value `"<token>"`. The Chimera CDK `SecurityStack` will handle this automatically once a `[domain]` section is present in `chimera.toml`.

### Step 2: Enable DKIM Signing

```bash
aws ses verify-domain-dkim --domain example.com
```

This returns three DKIM tokens. Retrieve them:

```bash
aws ses get-identity-dkim-attributes \
  --identities example.com \
  --query 'DkimAttributes."example.com".DkimTokens'
```

For each token, add a CNAME record: `<token>._domainkey.example.com` -> `<token>.dkim.amazonses.com`.

### Step 3: Add SPF Record

Add a TXT record at `@` (the domain root):

```
v=spf1 include:amazonses.com ~all
```

If an existing SPF record is present (e.g., `v=spf1 include:other.com ~all`), merge it into one record:

```
v=spf1 include:other.com include:amazonses.com ~all
```

> There must be exactly one SPF TXT record per domain. Multiple records cause validation failures.

### Step 4: Add DMARC Policy

Add a TXT record at `_dmarc.example.com`:

```
v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com
```

DMARC policy options:
- `p=none` — monitor only, no enforcement (good starting point)
- `p=quarantine` — failing mail goes to spam
- `p=reject` — failing mail is rejected

### Step 5: Optional MX for Inbound Email

If you want SES to receive inbound email, add an MX record (only supported in `us-east-1`, `us-west-2`, `eu-west-1`):

```
10 inbound-smtp.<region>.amazonaws.com
```

### Step 6: Request SES Production Access

New AWS accounts start in the SES sandbox and can only send to verified addresses. To send to any address:

```bash
aws sesv2 put-account-details \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://example.com \
  --use-case-description "Transactional emails for Chimera tenant notifications and authentication"
```

### Verify SES Status

```bash
# Domain verification
aws ses get-identity-verification-attributes \
  --identities example.com \
  --query 'VerificationAttributes."example.com".VerificationStatus'
# Expected: "Success"

# DKIM verification
aws ses get-identity-dkim-attributes \
  --identities example.com \
  --query 'DkimAttributes."example.com".DkimVerificationStatus'
# Expected: "Success"
```

Both take up to 72 hours after DNS propagation.

---

## CloudFront Custom Domain

### Step 1: Get Distribution ID

```bash
aws cloudformation describe-stacks \
  --stack-name Chimera-dev-Chat \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' \
  --output text
```

### Step 2: Update the Distribution

Fetch the current config and ETag:

```bash
aws cloudfront get-distribution-config \
  --id <DISTRIBUTION_ID> \
  > dist-config.json

# Extract ETag for later
ETAG=$(jq -r '.ETag' dist-config.json)

# Edit the DistributionConfig section (not the top-level object)
jq '.DistributionConfig' dist-config.json > dist-config-only.json
```

Modify `dist-config-only.json` to add the alias and certificate:

```json
{
  "Aliases": {
    "Quantity": 1,
    "Items": ["chat.example.com"]
  },
  "ViewerCertificate": {
    "ACMCertificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/<ID>",
    "SSLSupportMethod": "sni-only",
    "MinimumProtocolVersion": "TLSv1.2_2021",
    "CertificateSource": "acm"
  }
}
```

Apply the update:

```bash
aws cloudfront update-distribution \
  --id <DISTRIBUTION_ID> \
  --if-match "$ETAG" \
  --distribution-config file://dist-config-only.json
```

### Step 3: Create DNS Record

Add an `A` alias record (Route 53) or CNAME (external DNS) pointing `chat.example.com` to the CloudFront domain name. See [Route 53: Step 4](#step-4-create-dns-records) or the appropriate registrar section.

### Step 4: Update chimera.toml

```toml
[endpoints]
cloudfront_url = "https://chat.example.com"
api_url        = "https://api.example.com"
websocket_url  = "wss://ws.example.com"
```

---

## API Gateway Custom Domain

### REST API

```bash
# Create custom domain (certificate must be in the deployment region)
aws apigateway create-domain-name \
  --domain-name api.example.com \
  --regional-certificate-arn arn:aws:acm:us-east-1:123456789012:certificate/<ID> \
  --endpoint-configuration types=REGIONAL \
  --security-policy TLS_1_2

# Note the regionalDomainName from the response — use it for your CNAME record

# Map the domain to your stage
aws apigateway create-base-path-mapping \
  --domain-name api.example.com \
  --rest-api-id <REST_API_ID> \
  --stage dev
```

Get `<REST_API_ID>` from the `ApiUrl` stack output or:

```bash
aws apigateway get-rest-apis \
  --query 'items[?name==`chimera-api-dev`].id' \
  --output text
```

### WebSocket API

```bash
# Create custom domain
aws apigatewayv2 create-domain-name \
  --domain-name ws.example.com \
  --domain-name-configurations \
    CertificateArn=arn:aws:acm:us-east-1:123456789012:certificate/<ID>,EndpointType=REGIONAL,SecurityPolicy=TLS_1_2

# Note the ApiGatewayDomainName from the response — use it for your CNAME record

# Get WebSocket API ID
WS_API_ID=$(aws cloudformation describe-stacks \
  --stack-name Chimera-dev-Api \
  --query 'Stacks[0].Outputs[?OutputKey==`WebSocketApiId`].OutputValue' \
  --output text)

# Map the domain to the stage
aws apigatewayv2 create-api-mapping \
  --domain-name ws.example.com \
  --api-id "$WS_API_ID" \
  --stage dev
```

Create a CNAME record pointing `ws.example.com` to the `ApiGatewayDomainName` returned above.

---

## chimera.toml Configuration

Below is a complete `chimera.toml` example with all sections. The `[domain]` section is new and not yet generated by `chimera deploy` — add it manually after initial deployment.

```toml
[aws]
region   = "us-east-1"
account  = "123456789012"
profile  = "default"

[workspace]
name = "my-chimera"
env  = "dev"

[domain]
# Proposed section — add manually after initial deployment
name           = "example.com"
provider       = "route53"          # route53 | cloudflare | namecheap | godaddy
hosted_zone_id = "Z0123456789ABCDEFGHIJ"

[endpoints]
cloudfront_url    = "https://chat.example.com"
api_url           = "https://api.example.com"
websocket_url     = "wss://ws.example.com"
cognito_domain    = "https://my-chimera-dev.auth.us-east-1.amazoncognito.com"
cognito_client_id = "abc123clientid"
```

---

## Verification Checklist

```bash
# 1. SSL and HTTP response
curl -I https://chat.example.com
# Expect: HTTP/2 200 or 301, certificate issued by Amazon

curl https://api.example.com/health
# Expect: {"status":"ok"} or similar

# 2. WebSocket connectivity
npx wscat -c wss://ws.example.com
# Expect: Connected (press Ctrl+C to exit)

# 3. SES domain verification
aws ses get-identity-verification-attributes \
  --identities example.com \
  --query 'VerificationAttributes."example.com".VerificationStatus'
# Expect: "Success"

aws ses get-identity-dkim-attributes \
  --identities example.com \
  --query 'DkimAttributes."example.com".DkimVerificationStatus'
# Expect: "Success"

# 4. DNS resolution
dig A chat.example.com +short
dig CNAME api.example.com +short
dig CNAME ws.example.com +short
```

---

## Troubleshooting

### ACM certificate stuck in PENDING_VALIDATION

Check that the validation CNAME exists:

```bash
dig CNAME _<token>.example.com +short
```

If empty:
- Confirm the record was added without the domain suffix (Namecheap, GoDaddy)
- Confirm the record is **DNS only** (grey cloud) in Cloudflare — orange cloud breaks ACM polling
- Confirm the certificate was requested in `us-east-1` (CloudFront requirement)

ACM polls every 30 minutes. Changes validate within one polling cycle after DNS propagation.

### CloudFront returns 403 on custom domain

```bash
aws cloudfront get-distribution-config --id <DIST_ID> \
  --query 'DistributionConfig.{Aliases:Aliases,Cert:ViewerCertificate}'
```

Verify:
- `Aliases.Items` includes `chat.example.com`
- `ViewerCertificate.ACMCertificateArn` matches your `us-east-1` certificate
- `ViewerCertificate.SSLSupportMethod` is `sni-only`
- The DNS record points to `<dist>.cloudfront.net`, not to an ALB

### Certificate not found for API Gateway

API Gateway REST and WebSocket use **regional** certificates, not the `us-east-1` certificate used by CloudFront. Request a separate ACM certificate in your deployment region:

```bash
aws acm request-certificate \
  --domain-name "*.example.com" \
  --validation-method DNS \
  --region us-east-1   # change to your deployment region
```

### SES emails go to spam / sandbox rejection

```bash
# Check if still in sandbox
aws sesv2 get-account --query 'ProductionAccessEnabled'
# false = sandbox

# Request production access
aws sesv2 put-account-details \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://example.com \
  --use-case-description "Transactional authentication emails"
```

### WebSocket connection fails on custom domain

WebSocket custom domains require the API mapping to use the regional domain name (ending in `.execute-api.<region>.amazonaws.com`), not the CloudFront domain. Verify:

```bash
aws apigatewayv2 get-domain-names \
  --query 'Items[?DomainName==`ws.example.com`].DomainNameConfigurations'
```

The CNAME record must point to `ApiGatewayDomainName` from that response, not to the CloudFront distribution. Also verify clients use `wss://` not `https://` for the WebSocket endpoint.
