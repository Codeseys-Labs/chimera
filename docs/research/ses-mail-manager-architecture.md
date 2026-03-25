---
title: "SES v2 + Mail Manager Architecture for Agent Email Ingestion"
version: 1.0.0
status: research
last_updated: 2026-03-25
---

# SES v2 + Mail Manager Architecture for Agent Email Ingestion

## 1. Domain Requirements

### What SES Needs

SES email receiving **requires a custom domain you control** — it cannot receive email on AWS-managed domains like CloudFront distributions (`.cloudfront.net`) or API Gateway domains. The domain must be:

1. **Verified** with SES (proves ownership)
2. **Pointed** at SES via an MX DNS record

### Subdomains Work Fine

You do not need a naked/apex domain. A subdomain like `mail.chimera.example.com` works perfectly:

```
MX record:  mail.chimera.example.com  →  10 inbound-smtp.us-east-1.amazonaws.com
```

This means if you own a real domain (e.g., `chimera.dev`, `chimera.io`, or any custom domain), you can dedicate a subdomain entirely to agent email ingestion without interfering with other DNS records.

### Domain Verification

SES requires DNS-based proof of ownership. Two verification paths:

| Method | DNS Record Type | Notes |
|--------|----------------|-------|
| **Easy DKIM** (recommended) | 3 x CNAME records | AWS manages key rotation automatically |
| **BYODKIM** | TXT record | You supply and rotate your own 2048-bit RSA key pair |
| **TXT verification** (legacy) | 1 x TXT record | Required for v1 API; Easy DKIM covers this in v2 |

The Easy DKIM CNAMEs look like:

```
<token1>._domainkey.mail.chimera.example.com  CNAME  <token1>.dkim.amazonses.com
<token2>._domainkey.mail.chimera.example.com  CNAME  <token2>.dkim.amazonses.com
<token3>._domainkey.mail.chimera.example.com  CNAME  <token3>.dkim.amazonses.com
```

SES verifies within minutes of publishing these records.

---

## 2. DNS Records Required

Full DNS setup for `mail.chimera.example.com` (receiving only):

| Record | Type | Value | Purpose |
|--------|------|-------|---------|
| `mail.chimera.example.com` | MX | `10 inbound-smtp.us-east-1.amazonaws.com` | Route inbound email to SES |
| `<token1>._domainkey.mail.chimera.example.com` | CNAME | `<token1>.dkim.amazonses.com` | Easy DKIM signing (key 1 of 3) |
| `<token2>._domainkey.mail.chimera.example.com` | CNAME | `<token2>.dkim.amazonses.com` | Easy DKIM signing (key 2 of 3) |
| `<token3>._domainkey.mail.chimera.example.com` | CNAME | `<token3>.dkim.amazonses.com` | Easy DKIM signing (key 3 of 3) |
| `mail.chimera.example.com` | TXT | `v=spf1 include:amazonses.com ~all` | SPF — authorise SES to send on behalf of the domain |
| `_dmarc.mail.chimera.example.com` | TXT | `v=DMARC1; p=quarantine; rua=mailto:dmarc@chimera.example.com` | DMARC policy for alignment |

### Notes

- **MX record** — priority value (`10`) is conventional; use a lower number (higher priority) if you add redundant inbound endpoints.
- **SPF** — only needed if agents will also *send* email using this domain. For receive-only, SPF is optional but improves deliverability of replies.
- **DMARC** — recommended for production. Start with `p=none` (monitor mode), graduate to `p=quarantine` or `p=reject`.
- **Route 53** — if the domain is in Route 53, the SES console can create all DNS records automatically via the "Use Route 53" option.

---

## 3. SES v2 Classic Receiving (Receipt Rules)

The legacy email-receiving path uses **Receipt Rule Sets** with **Receipt Rules**.

### How It Works

```
Internet  ->  inbound-smtp.<region>.amazonaws.com  ->  Active Receipt Rule Set
                                                             |
                                                       Receipt Rule(s)
                                                             |
                                                       Actions (ordered list)
```

### Available Actions

| Action | Description | Max Email Size |
|--------|-------------|---------------|
| **Lambda** | Invoke a Lambda synchronously; email metadata in event payload | 30 MB |
| **S3** | Write raw MIME email to an S3 bucket (with optional KMS encryption) | 30 MB |
| **SNS** | Publish notification to SNS topic (full MIME body if <= 150 KB; metadata only if larger) | 150 KB (body) |
| **Add header** | Inject custom headers before processing | — |
| **Bounce** | Return a 550 bounce to sender | — |
| **Stop rule set** | Halt further rule evaluation | — |
| **WorkMail** | Forward to Amazon WorkMail mailbox | — |

**Key constraint:** Receipt rule sets are region-scoped. Only **one rule set can be active at a time** per region. All downstream resources (Lambda, SNS topics, KMS keys) must be in the **same region** as SES. S3 buckets are the exception — they can be cross-region.

### Triggering Patterns

**Pattern A: Lambda Direct**
```
SES  ->  Lambda action (synchronous)  ->  parse email  ->  DynamoDB  ->  agent dispatch
```
- Simplest path. Lambda receives a JSON event with mail metadata + S3 pointer (for large bodies).
- SES allows up to 30 seconds for Lambda to complete the synchronous invocation.
- Suitable for low-to-medium volume.

**Pattern B: S3 -> S3 Event -> Lambda**
```
SES  ->  S3 action (store MIME)  ->  S3 EventBridge notification  ->  Lambda  ->  parse  ->  DDB
```
- Decoupled; Lambda processes asynchronously.
- Supports arbitrary email sizes up to 30 MB.
- More resilient: S3 retains email if Lambda fails, enabling replay.

**Pattern C: SNS Fan-out**
```
SES  ->  SNS action  ->  SQS queue  ->  Lambda  ->  parse  ->  DDB
SES  ->  SNS action  ->  (additional subscribers)
```
- Fan-out to multiple consumers (e.g., one for indexing, one for agent dispatch).
- 150 KB body limit — for larger emails, combine with S3 action to store body first.

---

## 4. Mail Manager (Recommended Path)

**Mail Manager** is an SES v2 layer built for enterprise email workflow automation. It supersedes classic receipt rules for complex routing and is the recommended approach for Chimera.

### Components

```
Internet  ->  Ingress Endpoint
                  |
             Traffic Policy  (allow / block: spam filters, IP allowlists, TLS enforcement)
                  |
             Rule Set  (conditions + ordered actions on allowed mail)
                  |
             Actions: S3 | SNS | Archive | SMTP Relay | WorkMail | Q Business | Drop
```

### Ingress Endpoints

An **ingress endpoint** is the SMTP entry point managed by Mail Manager. Two types:

| Type | Access | Notes |
|------|--------|-------|
| **Public** | Internet-facing | AWS generates an A-record hostname for MX use |
| **VPC** | Private networking only | DNS names provided by VPC endpoint; no public exposure |

The public ingress endpoint hostname (e.g., `<id>.ingresspoint.ses.amazonaws.com`) is what goes in your MX record when using Mail Manager — it differs from the classic `inbound-smtp.<region>.amazonaws.com` endpoint.

### Traffic Policies

Traffic policies are evaluated **before** rule sets. They allow or block email based on:

- Sender IP address or CIDR range
- Sender email address / domain
- Recipient email address / domain
- TLS requirement enforcement
- Message size limits

Policy statements are evaluated in order: **block statements first**, then **allow statements**. Emails not matching any statement fall through to the default action (allow or block).

**Example policy for Chimera:**
```
Block if: sender IP in known spam list
Allow if: sender domain in trusted-partners list
Default: ALLOW (accept all non-blocked email)
```

### Rule Sets

Rule sets contain ordered rules. Each rule has:
- **Conditions** — properties the email must match (From, To, Subject, headers, size, spam score via Add Ons)
- **Exceptions** — conditions that negate the rule
- **Actions** — what to do when conditions are met (executed in defined order)

Multiple ingress endpoints can share a single rule set. Rules within a set belong exclusively to that set.

### Mail Manager Rule Actions

| Action | API Name | Description |
|--------|----------|-------------|
| **Write to S3** | `S3Action` | Write MIME email to S3 bucket |
| **Publish to SNS** | `SnsAction` | Publish email content to SNS topic |
| **Archive** | `ArchiveAction` | Store in SES-managed long-term archive (searchable, exportable) |
| **Add header** | `AddHeaderAction` | Inject custom headers |
| **Email recipients rewrite** | `ReplaceRecipientAction` | Replace envelope recipients |
| **SMTP relay** | `RelayAction` | Forward via SMTP to another server |
| **Deliver to WorkMail mailbox** | `DeliverToMailboxAction` | Route to WorkMail |
| **Deliver to Q Business** | `DeliverToQBusinessAction` | Ingest into Amazon Q Business knowledge base |
| **Send to internet** | `SendAction` | Re-send via SES SMTP |
| **Drop** | `DropAction` | Silently discard |

> **Note:** Mail Manager rule sets do **not** have a native Lambda action (unlike classic receipt rules). The recommended path is **Write to S3** + S3 event -> Lambda, or **Publish to SNS** -> SQS -> Lambda.

### Email Archiving

Mail Manager archives provide:
- Configurable retention (30 days to indefinite)
- KMS encryption at rest
- Full-text search across archived messages
- Export to S3
- Audit trail for compliance

Archiving all inbound email is recommended for debugging and compliance.

---

## 5. Regional Availability

SES email receiving is **not available in all AWS regions**. Key supported regions:

| Region | Classic Inbound Endpoint |
|--------|-------------------------|
| US East (N. Virginia) | `inbound-smtp.us-east-1.amazonaws.com` |
| US West (Oregon) | `inbound-smtp.us-west-2.amazonaws.com` |
| EU (Ireland) | `inbound-smtp.eu-west-1.amazonaws.com` |
| EU (Frankfurt) | `inbound-smtp.eu-central-1.amazonaws.com` |
| AP (Sydney) | `inbound-smtp.ap-southeast-2.amazonaws.com` |
| AP (Tokyo) | `inbound-smtp.ap-northeast-1.amazonaws.com` |

**Regional co-location constraint:** Lambda functions, SNS topics, KMS keys, and SQS queues for email processing must be in the **same region** as the SES receiving endpoint. S3 buckets are exempt (can be cross-region).

**Chimera recommendation:** Deploy in `us-east-1` — this is where Chimera's primary stack lives and SES email receiving has the longest feature history.

---

## 6. Recommended Architecture: Agent Email Ingestion

### High-Level Flow

```
External Sender
      |
      | SMTP
      v
[Mail Manager Ingress Endpoint]  <-- MX: mail.chimera.example.com
      |
      v  Traffic Policy
[Allow/Block Filter]
      |
      v  Rule Set
[Rule: Archive + Write to S3]
      |
      +---> SES Archive (long-term storage, searchable, KMS-encrypted)
      |
      +---> S3: chimera-inbound-email/<year>/<month>/<day>/<message-id>
                  |
                  | S3 Event Notification -> EventBridge
                  v
          [EmailParserLambda]
                  |
                  +---> DynamoDB: chimera-sessions (email thread record)
                  |
                  +---> EventBridge: chimera-orchestration bus
                              |
                              v
                       [Agent Dispatcher]
                              |
                              v
                       [Chimera Agent]  (processes email content)
                              |
                              | SES v2 SendEmail API
                              v
                       Reply to sender
```

### DynamoDB Schema for Email Threads

Store email threads in the existing `chimera-sessions` table:

```
PK:  AGENT#<agent-id>
SK:  EMAIL#<message-id>

threadId:    <in-reply-to header, or message-id if new thread>
from:        <sender address>
to:          <recipient address>
subject:     <email subject>
bodyKey:     <s3-key to raw MIME>
receivedAt:  <ISO8601 timestamp>
status:      PENDING | PROCESSING | REPLIED | ERROR
replyMessageId: <message-id of agent reply, if sent>
```

**GSI for thread lookup:**
```
GSI:  threadId-index
PK:   threadId
SK:   receivedAt
```

Always include `FilterExpression='agentId = :aid'` on GSI queries (per multi-tenant isolation convention).

### Email Parser Lambda

The Lambda triggered by S3 events should:

1. Fetch raw MIME email from S3 using `GetObject`
2. Parse headers: `From`, `To`, `Subject`, `Message-ID`, `In-Reply-To`, `References`
3. Parse body: prefer `text/plain`, fall back to stripping HTML from `text/html`
4. Extract attachments — store to S3 if needed, record S3 keys in DDB
5. Write email record to `chimera-sessions` DynamoDB table
6. Emit `email.received` event to `chimera-orchestration` EventBridge bus

Recommended MIME parsing library: [`postal-mime`](https://github.com/postalsys/postal-mime) (zero-dependency, works in Node.js Lambda).

### Agent Reply Path

When an agent sends a reply:

1. Fetch original email metadata from DDB (for threading headers)
2. Construct reply preserving threading:
   - `In-Reply-To: <original-message-id>`
   - `References: <original-message-id> [<prior-references>]`
3. Use SES v2 `SendEmail` API with `From` set to `mail.chimera.example.com` address
4. Update DDB record status to `REPLIED` with reply `Message-ID`

---

## 7. Classic Receipt Rules vs. Mail Manager — Comparison

| Feature | Classic Receipt Rules | Mail Manager |
|---------|-----------------------|--------------|
| **Lambda action** | Native (synchronous) | Not available; use S3->Lambda or SNS->Lambda |
| **Traffic filtering** | IP filters only | Rich: IP, sender, recipient, size, TLS |
| **Rule conditions** | Recipient address only | From, To, Subject, headers, spam score |
| **Archiving** | Manual (S3 + custom indexing) | Built-in with search and export |
| **SMTP relay** | No | Yes (native) |
| **Q Business integration** | No | Yes (native) |
| **VPC private endpoint** | No | Yes |
| **Active rule sets** | 1 per region | Multiple (1 per ingress endpoint) |
| **Email Add-Ons (spam/AV)** | No | Yes (paid third-party providers) |
| **CDK L2 support** | Partial (`CfnReceiptRule`) | L1 only (`CfnIngressPoint`, `CfnRuleSet`, etc.) |
| **Max email size** | 30 MB | 10 MB default (configurable in traffic policy) |

**Recommendation for Chimera:** Use **Mail Manager** for:
- Better traffic filtering before processing
- Built-in archiving for compliance and debugging
- Per-ingress-endpoint rule sets (enables multi-tenant isolation)
- Future extensibility (Q Business knowledge base ingestion, SMTP relay)

Use **Classic Receipt Rules** only if direct synchronous Lambda invocation is required without an S3 intermediary.

---

## 8. CDK Implementation Notes

Mail Manager CDK support is **L1 only** as of CDK v2 (no L2 constructs). Use:

- `aws_cdk.aws_ses.CfnIngressPoint` — ingress endpoint
- `aws_cdk.aws_ses.CfnTrafficPolicy` — traffic policy
- `aws_cdk.aws_ses.CfnRuleSet` — rule set with rules
- `aws_cdk.aws_ses.CfnArchive` — email archive

IAM roles are required for each action (Write to S3, Archive, Publish to SNS). Mail Manager uses service principal `mail-manager.ses.amazonaws.com` in trust policies.

Monitor `aws-cdk-lib/aws-ses` for L2 additions, or use `@aws-cdk/aws-ses-alpha` experimental constructs if available.

---

## 9. Open Questions / Next Steps

1. **Domain procurement**: A real custom domain is required — `.cloudfront.net` does not work. Decide on domain name (e.g., `chimera.dev`, subdomain of existing domain).

2. **SES sandbox removal**: New AWS accounts are in SES sandbox (can only send to verified addresses). Request **production access** before any real email ingestion.

3. **Thread management strategy**: Confirm `chimera-sessions` table is appropriate for email threads, or create a dedicated `chimera-email-threads` table.

4. **Multi-tenant routing**: Use `To` address patterns to route email to specific tenant agents (e.g., `agent-<tenant-id>@mail.chimera.example.com`). Mail Manager rule conditions can match recipient address prefixes.

5. **Bounce/complaint handling**: Configure a configuration set with SNS for bounce and complaint notifications. Update DDB to suppress future sends to hard-bounced addresses.

6. **Rate limiting**: Inbound email volume is unbounded. Add SQS between S3 events and Lambda for backpressure control and DLQ for failed processing.

7. **Attachment handling**: Define max attachment size and storage strategy. Store attachments in `chimera-inbound-attachments/` S3 prefix, record S3 keys in DDB.

8. **Spam/virus scanning**: Mail Manager Email Add-Ons (paid) provide spam scoring and AV scanning before rule set execution. Evaluate cost vs. benefit based on expected inbound volume.
