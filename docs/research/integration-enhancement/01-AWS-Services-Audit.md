# AWS Services Comprehensive Audit for Chimera Enhancement

---
**Date:** 2026-03-19
**Purpose:** Identify ALL AWS services beyond current documentation that could enhance the Chimera multi-tenant agent platform
**Scope:** Services not covered or minimally covered in [[06-AWS-Services-Agent-Infrastructure]]
---

## Executive Summary

This audit identifies **89 AWS services** across 12 categories that could enhance Chimera beyond the baseline infrastructure documented in the AgentCore/Strands research. The existing documentation covers core agent infrastructure (ECS, Lambda, S3, DynamoDB, etc.). This audit focuses on:

1. **AI/ML services** for agent enhancement (Bedrock, SageMaker, Comprehend, etc.)
2. **Advanced security services** for multi-tenant isolation (KMS, WAF, Shield, GuardDuty, etc.)
3. **Data services** beyond DynamoDB (RDS, Aurora, ElastiCache, OpenSearch, etc.)
4. **Networking services** for performance and isolation (CloudFront, PrivateLink, Transit Gateway, etc.)
5. **Operational services** for governance and compliance (Control Tower, Config, CloudTrail, etc.)
6. **Specialized compute** for unique workloads (Batch, EKS, Parallel Cluster)
7. **Analytics and data processing** (Athena, Glue, Kinesis, Lake Formation)
8. **Edge and hybrid** services (Outposts, Wavelength, Local Zones)

### Priority Tiers for Chimera Integration

**Tier 1 (Immediate Impact):** Amazon Bedrock, AWS KMS, AWS WAF, Amazon CloudFront, Amazon RDS/Aurora, Amazon ElastiCache, AWS Systems Manager, Amazon OpenSearch, AWS CloudTrail, AWS Config

**Tier 2 (Strategic Value):** Amazon SageMaker, AWS AppSync, Amazon Kinesis, AWS Glue, VPC Lattice, AWS PrivateLink, AWS Organizations, AWS Control Tower, Amazon GuardDuty, AWS Security Hub

**Tier 3 (Specialized Use Cases):** Amazon Comprehend, Amazon Textract, Amazon Rekognition, Amazon Neptune, Amazon Timestream, AWS Transfer Family, AWS Direct Connect, Amazon EKS

**Tier 4 (Long-term/Niche):** AWS Ground Truth, Amazon Personalize, AWS Fraud Detector, AWS Managed Blockchain, AWS Snow Family, AWS IoT Core

---

## Current AWS Service Coverage

Based on [[06-AWS-Services-Agent-Infrastructure]], Chimera's baseline infrastructure already covers:

| Category | Services Documented |
|----------|---------------------|
| **Compute** | Lambda, ECS/Fargate, Step Functions, CodeBuild, App Runner |
| **Storage** | S3, EFS |
| **Database** | DynamoDB |
| **Messaging** | SQS, SNS, EventBridge |
| **API** | API Gateway (WebSocket + REST) |
| **Security** | Cognito (auth), Secrets Manager (credentials) |
| **Observability** | CloudWatch (metrics/logs/alarms) |
| **Code Execution** | AgentCore Code Interpreter (OpenSandbox) |

**Gap:** Missing 89+ services across security, AI/ML, data, networking, analytics, governance, and specialized compute.

---

## 1. AI & Machine Learning Services

### 1.1 Amazon Bedrock — Unified LLM API

**Purpose for Chimera:** Foundation model API for Claude, Llama, Mistral, Cohere, AI21, Stability AI, and Amazon Titan models. Multi-provider LLM support with unified API, cross-region inference, guardrails, and model evaluation.

**Current Status:** Mentioned in [[09-Multi-Provider-LLM-Support]] but not architecturally integrated into Chimera design.

**Integration Opportunities:**
- **Multi-tenant model access** with resource-based policies per tenant
- **Bedrock Guardrails** for content filtering, PII redaction, topic blocking per tenant
- **Bedrock Agents** as alternative to AgentCore for simpler use cases
- **Bedrock Knowledge Bases** for RAG with built-in chunking, embeddings, vector search
- **Bedrock Model Evaluation** for A/B testing agent prompts across tenants
- **Cross-region inference profiles** for global low-latency agent deployment

**Architecture Pattern:**
```python
# Multi-tenant Bedrock with guardrails per tenant
import boto3

bedrock = boto3.client("bedrock-runtime")

def invoke_agent_llm(tenant_id: str, prompt: str, context: dict):
    guardrail_id = get_tenant_guardrail(tenant_id)  # Per-tenant content policy

    response = bedrock.invoke_model(
        modelId="us.anthropic.claude-sonnet-4-20250514",
        contentType="application/json",
        accept="application/json",
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 4096,
            "temperature": 0.7
        }),
        guardrailIdentifier=guardrail_id,
        guardrailVersion="DRAFT"
    )

    return json.loads(response["body"].read())
```

**Cost Model:**
- Pay-per-token pricing varies by model (Claude Sonnet ~$0.003/1K input, $0.015/1K output)
- Provisioned throughput for committed workloads (50%+ savings)
- No infrastructure costs — fully managed

**Priority:** **Tier 1** — Essential for multi-provider LLM support and built-in safety features.

---

### 1.2 Amazon SageMaker — Custom Model Training & Hosting

**Purpose for Chimera:** Train, fine-tune, and deploy custom models for agent-specific tasks. Host fine-tuned LLMs, embeddings models, classification models, or agentic policy models.

**Integration Opportunities:**
- **SageMaker Endpoints** for custom model inference (e.g., tenant-specific fine-tuned models)
- **SageMaker Training Jobs** for continuous model improvement from agent interactions
- **SageMaker Feature Store** for agent behavior features and user embeddings
- **SageMaker Pipelines** for MLOps workflows (training -> evaluation -> deployment)
- **SageMaker Clarify** for model bias detection in agent responses
- **SageMaker Model Monitor** for drift detection in agent performance

**Use Case:** Enterprise tenant wants fine-tuned Claude on their internal docs — train embeddings model + fine-tune via SageMaker, deploy as SageMaker endpoint, integrate with Chimera's agent routing layer.

**Cost Model:**
- Training: $0.05-$32/hour depending on instance type (ml.t3.medium to ml.p4d.24xlarge)
- Inference: $0.05-$8/hour for real-time endpoints, $0.02-$4/hour for serverless
- Provisioned throughput reduces costs for high-volume workloads

**Priority:** **Tier 2** — Strategic for enterprise tenants requiring custom models.

---

### 1.3 Amazon Comprehend — NLP for Agent Enhancement

**Purpose for Chimera:** Pre-trained and custom NLP for sentiment analysis, entity extraction, key phrase detection, PII detection, and language detection. Enhances agent reasoning without custom ML pipelines.

**Integration Opportunities:**
- **PII detection** in agent prompts and responses for GDPR/HIPAA compliance
- **Sentiment analysis** on user feedback to trigger escalation or agent coaching
- **Entity extraction** to populate agent context (detect companies, products, people in prompts)
- **Custom classification** for tenant-specific intent recognition (e.g., "support ticket" vs "sales inquiry")
- **Topic modeling** across tenant conversations for trend analysis

**Architecture Pattern:**
```python
# PII redaction in agent prompts
import boto3

comprehend = boto3.client("comprehend")

def sanitize_prompt(tenant_id: str, prompt: str) -> dict:
    # Detect PII entities
    response = comprehend.detect_pii_entities(
        Text=prompt,
        LanguageCode="en"
    )

    # Redact PII if tenant policy requires it
    if requires_pii_redaction(tenant_id):
        for entity in sorted(response["Entities"], key=lambda e: e["BeginOffset"], reverse=True):
            start, end = entity["BeginOffset"], entity["EndOffset"]
            prompt = prompt[:start] + "[REDACTED]" + prompt[end:]

    return {"sanitized_prompt": prompt, "pii_detected": len(response["Entities"]) > 0}
```

**Cost Model:**
- Per-unit pricing: $0.0001/unit (100 chars = 1 unit)
- PII detection: $0.0001/unit
- Custom classification: $3.00/model/month + $0.005/unit inference

**Priority:** **Tier 3** — Valuable for compliance-heavy tenants (healthcare, finance).

---

### 1.4 Amazon Textract — Document Intelligence

**Purpose for Chimera:** Extract text, tables, forms, and key-value pairs from documents (PDFs, images, scanned docs). Enables agents to process unstructured documents without manual parsing.

**Integration Opportunities:**
- **Agent tool: `extract_document`** — agents upload PDFs/images, Textract extracts structured data
- **Form extraction** for invoice processing, contract analysis, application forms
- **Table extraction** for financial statements, spreadsheets embedded in PDFs
- **Signature detection** and document classification for workflow automation
- **Integration with S3 + EventBridge** — auto-trigger Textract on document upload

**Use Case:** Financial services tenant uploads loan applications (PDFs) — agent extracts applicant data, income tables, and signatures, then routes to underwriting agent.

**Cost Model:**
- Document analysis: $0.0015/page (text extraction)
- Forms/tables: $0.050/page
- Queries: $0.015/page

**Priority:** **Tier 3** — High value for document-heavy industries (legal, finance, insurance).

---

### 1.5 Amazon Rekognition — Image & Video Analysis

**Purpose for Chimera:** Detect objects, scenes, text, faces, celebrities, unsafe content, and custom labels in images and videos. Enables visual AI for agent workflows.

**Integration Opportunities:**
- **Content moderation** for user-uploaded images (detect unsafe content before agent processes)
- **OCR in images** — extract text from screenshots, photos of documents
- **Face comparison** for identity verification workflows
- **Custom labels** — train tenant-specific image classifiers (e.g., product defect detection)
- **Video analysis** — detect objects/scenes in video content for summarization

**Cost Model:**
- Image analysis: $0.001/image (first 1M), $0.0008/image (1M-10M)
- Video analysis: $0.10/minute
- Custom labels training: $1.00/hour

**Priority:** **Tier 3** — Niche but high-value for visual workflows (e-commerce, manufacturing).

---

### 1.6 Additional AI/ML Services

| Service | Purpose | Priority |
|---------|---------|----------|
| **AWS Polly** | Text-to-speech for agent voice responses | Tier 3 |
| **AWS Transcribe** | Speech-to-text for voice-based agent input | Tier 3 |
| **AWS Translate** | Real-time translation for multi-language agents | Tier 3 |
| **AWS Lex** | Conversational AI building blocks (intent recognition) | Tier 4 |
| **Amazon Personalize** | Recommendation engine for agent suggestions | Tier 4 |
| **AWS Forecast** | Time-series forecasting for predictive agents | Tier 4 |
| **AWS Fraud Detector** | Real-time fraud prediction for transaction agents | Tier 4 |
| **AWS Ground Truth** | Data labeling for custom model training | Tier 4 |

---

## 2. Security & Compliance Services

### 2.1 AWS KMS — Encryption Key Management

**Purpose for Chimera:** Centralized encryption key management for data-at-rest and data-in-transit. Multi-tenant key isolation, automatic key rotation, and audit trails.

**Current Status:** **Missing** — no documented encryption strategy for tenant data.

**Integration Opportunities:**
- **Customer Managed Keys (CMK) per tenant** for silo encryption model
- **S3 bucket encryption** with tenant-specific KMS keys
- **DynamoDB encryption** with tenant-specific keys
- **EBS volume encryption** for ECS/Fargate task storage
- **Secrets Manager integration** — encrypt tenant secrets with tenant CMKs
- **Envelope encryption** for large data (encrypt data key with CMK, encrypt data with data key)
- **Key policies** to enforce tenant isolation (tenant A cannot use tenant B's key)

**Architecture Pattern:**
```python
# Per-tenant KMS key for S3 encryption
import boto3

kms = boto3.client("kms")
s3 = boto3.client("s3")

def create_tenant_key(tenant_id: str) -> str:
    """Create dedicated KMS key for tenant"""
    response = kms.create_key(
        Description=f"Encryption key for tenant {tenant_id}",
        KeyPolicy=json.dumps({
            "Version": "2012-10-17",
            "Statement": [{
                "Sid": "Enable IAM policies",
                "Effect": "Allow",
                "Principal": {"AWS": f"arn:aws:iam::{account_id}:root"},
                "Action": "kms:*",
                "Resource": "*"
            }, {
                "Sid": "Allow tenant role only",
                "Effect": "Allow",
                "Principal": {"AWS": f"arn:aws:iam::{account_id}:role/tenant-{tenant_id}-role"},
                "Action": ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"],
                "Resource": "*"
            }]
        }),
        Tags=[{"TagKey": "tenant_id", "TagValue": tenant_id}]
    )

    kms_key_id = response["KeyMetadata"]["KeyId"]

    # Alias for easy reference
    kms.create_alias(
        AliasName=f"alias/tenant-{tenant_id}",
        TargetKeyId=kms_key_id
    )

    return kms_key_id

# Upload encrypted object to S3 with tenant key
def store_tenant_artifact(tenant_id: str, data: bytes, key: str):
    kms_key_id = get_tenant_kms_key(tenant_id)
    s3.put_object(
        Bucket="agent-artifacts",
        Key=f"tenants/{tenant_id}/{key}",
        Body=data,
        ServerSideEncryption="aws:kms",
        SSEKMSKeyId=kms_key_id
    )
```

**Cost Model:**
- Customer managed keys: $1.00/key/month
- API requests: $0.03/10K requests
- Key rotation: automatic, no additional cost

**Priority:** **Tier 1** — Critical for enterprise multi-tenancy and compliance (HIPAA, PCI-DSS, GDPR).

---

### 2.2 AWS WAF — Web Application Firewall

**Purpose for Chimera:** Protect agent API endpoints from common web exploits, DDoS, bot traffic, and malicious requests. Rate limiting, IP blocking, geo-blocking, and custom rules.

**Integration Opportunities:**
- **Attach WAF to ALB or CloudFront** in front of agent APIs
- **Rate limiting per tenant** (e.g., 1000 req/min for standard tier, 10K for enterprise)
- **Bot detection** to block scraping of agent endpoints
- **IP reputation lists** to block known malicious IPs
- **Custom rules** for SQL injection, XSS, path traversal detection
- **Geo-blocking** for compliance (e.g., block China/Russia for ITAR compliance)
- **WAF logs to CloudWatch** for security monitoring and threat detection

**Architecture Pattern:**
```python
# CDK: WAF attached to ALB with rate limiting
from aws_cdk import aws_wafv2 as waf

web_acl = waf.CfnWebACL(self, "AgentWAF",
    scope="REGIONAL",
    default_action=waf.CfnWebACL.DefaultActionProperty(allow={}),
    visibility_config=waf.CfnWebACL.VisibilityConfigProperty(
        cloud_watch_metrics_enabled=True,
        metric_name="AgentWAFMetrics",
        sampled_requests_enabled=True
    ),
    rules=[
        # Rate limiting: 1000 req per 5 min per IP
        waf.CfnWebACL.RuleProperty(
            name="RateLimitRule",
            priority=1,
            statement=waf.CfnWebACL.StatementProperty(
                rate_based_statement=waf.CfnWebACL.RateBasedStatementProperty(
                    limit=1000,
                    aggregate_key_type="IP"
                )
            ),
            action=waf.CfnWebACL.RuleActionProperty(block={}),
            visibility_config=waf.CfnWebACL.VisibilityConfigProperty(
                cloud_watch_metrics_enabled=True,
                metric_name="RateLimitBlocks",
                sampled_requests_enabled=True
            )
        ),
        # AWS Managed Rules: Core rule set (OWASP Top 10)
        waf.CfnWebACL.RuleProperty(
            name="AWSManagedRulesCore",
            priority=2,
            statement=waf.CfnWebACL.StatementProperty(
                managed_rule_group_statement=waf.CfnWebACL.ManagedRuleGroupStatementProperty(
                    vendor_name="AWS",
                    name="AWSManagedRulesCommonRuleSet"
                )
            ),
            override_action=waf.CfnWebACL.OverrideActionProperty(none={}),
            visibility_config=waf.CfnWebACL.VisibilityConfigProperty(
                cloud_watch_metrics_enabled=True,
                metric_name="AWSCoreRules",
                sampled_requests_enabled=True
            )
        )
    ]
)

# Associate with ALB
waf.CfnWebACLAssociation(self, "ALBWAFAssoc",
    resource_arn=alb.load_balancer_arn,
    web_acl_arn=web_acl.attr_arn
)
```

**Cost Model:**
- Web ACL: $5.00/month
- Rules: $1.00/rule/month
- Requests: $0.60/million requests
- Bot Control (if used): $10.00/month + $1.00/million requests

**Priority:** **Tier 1** — Essential for production agent platforms exposed to internet.

---

### 2.3 AWS Shield — DDoS Protection

**Purpose for Chimera:** Automatic DDoS protection for agent endpoints. Shield Standard (free) provides network/transport layer protection. Shield Advanced ($3K/month) adds application layer protection and cost protection.

**Integration Opportunities:**
- **Shield Standard** (automatic) — protects ALB, CloudFront, Route 53 from SYN floods, UDP reflection attacks
- **Shield Advanced** (optional for enterprise) — L7 DDoS protection, real-time attack notifications, DDoS Response Team (DRT) support, cost protection during attacks

**Cost Model:**
- Shield Standard: Free (automatic for all AWS customers)
- Shield Advanced: $3,000/month + $0.60/million requests (CloudFront/API Gateway)

**Priority:** **Tier 2** — Standard is automatic; Advanced only for high-value enterprise deployments.

---

### 2.4 Amazon GuardDuty — Threat Detection

**Purpose for Chimera:** Continuous threat detection using ML to analyze CloudTrail, VPC Flow Logs, DNS logs, and Kubernetes audit logs. Detects compromised instances, malicious IPs, cryptocurrency mining, data exfiltration.

**Integration Opportunities:**
- **Enable GuardDuty** at organization level for all tenant accounts
- **EventBridge integration** — route findings to Lambda for automated response (e.g., isolate compromised EC2, revoke IAM keys)
- **Findings by tenant** — tag resources with tenant_id, route GuardDuty findings to per-tenant SNS topics
- **Suppression rules** for known false positives (e.g., agent scanning public repos)

**Cost Model:**
- CloudTrail analysis: $4.16/million events
- VPC Flow Logs: $1.00/GB analyzed
- DNS logs: $0.40/million queries

**Priority:** **Tier 2** — High value for detecting compromised agent infrastructure.

---

### 2.5 AWS Security Hub — Centralized Security Findings

**Purpose for Chimera:** Aggregates findings from GuardDuty, Inspector, Macie, IAM Access Analyzer, Firewall Manager, and third-party tools (Splunk, Palo Alto). Central dashboard for multi-tenant security posture.

**Integration Opportunities:**
- **Multi-account aggregation** — roll up findings from all tenant accounts to central security account
- **Custom insights** per tenant (e.g., "show all critical findings for tenant X")
- **Automated remediation** with EventBridge + Lambda (e.g., auto-revoke overly permissive IAM policies)
- **Compliance standards** — CIS AWS Foundations, PCI-DSS, HIPAA benchmarks per tenant

**Cost Model:**
- Security checks: $0.0010/check
- Finding ingestion: $0.00003/finding
- Free tier: 10K security checks/month

**Priority:** **Tier 2** — Essential for enterprise multi-tenant governance.

---

### 2.6 Additional Security Services

| Service | Purpose | Priority |
|---------|---------|----------|
| **AWS CloudTrail** | Audit logging for all API calls (governance, forensics) | Tier 1 |
| **AWS Config** | Resource configuration tracking and compliance rules | Tier 1 |
| **AWS Systems Manager** | Patch management, session access, parameter store | Tier 1 |
| **Amazon Macie** | Discover and protect sensitive data (PII) in S3 | Tier 2 |
| **Amazon Detective** | Security investigation with ML-powered root cause analysis | Tier 2 |
| **IAM Identity Center** | SSO for multi-tenant workforce access | Tier 2 |
| **AWS Network Firewall** | Managed firewall for VPC traffic inspection | Tier 2 |
| **AWS Certificate Manager** | Free SSL/TLS certificates for HTTPS endpoints | Tier 1 |
| **AWS Firewall Manager** | Centrally manage WAF, Shield, Security Groups across accounts | Tier 2 |
| **AWS Audit Manager** | Automated audit evidence collection for compliance | Tier 3 |

---

## 3. Data & Database Services

### 3.1 Amazon RDS / Aurora — Relational Databases

**Purpose for Chimera:** Managed PostgreSQL/MySQL for relational data that doesn't fit DynamoDB's key-value model. Aurora Serverless v2 offers auto-scaling with per-second billing.

**Current Status:** **Not documented** — DynamoDB is the only database mentioned.

**Integration Opportunities:**
- **Agent workflow state** with complex queries (e.g., "find all sessions where user X interacted with agent Y in last 30 days")
- **Tenant metadata and configuration** — hierarchical data (org -> teams -> users)
- **Audit logs** with full-text search and time-series queries
- **Multi-tenant schema patterns:**
  - **Pool:** All tenants in one DB with `tenant_id` column + Row-Level Security (RLS)
  - **Bridge:** One DB per tenant tier (free/standard/enterprise)
  - **Silo:** One Aurora cluster per enterprise tenant (strict isolation)
- **Aurora Global Database** for multi-region read replicas (cross-region agent deployment)
- **Aurora Serverless v2** — auto-scales from 0.5 to 128 ACUs based on load, pay-per-second

**Architecture Pattern:**
```python
# Pool model with PostgreSQL Row-Level Security (RLS)
import psycopg2

def setup_rls(conn):
    """Enable RLS to enforce tenant isolation at DB level"""
    with conn.cursor() as cur:
        # Enable RLS on sessions table
        cur.execute("""
            ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

            -- Policy: Users can only see their tenant's data
            CREATE POLICY tenant_isolation ON sessions
                USING (tenant_id = current_setting('app.tenant_id')::text);
        """)
        conn.commit()

def query_sessions(tenant_id: str, user_id: str):
    """Query sessions with automatic tenant isolation via RLS"""
    conn = psycopg2.connect(DATABASE_URL)

    # Set session variable for RLS
    with conn.cursor() as cur:
        cur.execute("SET app.tenant_id = %s", (tenant_id,))
        cur.execute("SELECT * FROM sessions WHERE user_id = %s", (user_id,))
        return cur.fetchall()
```

**Cost Model:**
- Aurora Serverless v2: $0.12/ACU-hour (PostgreSQL), $0.10/ACU-hour (MySQL)
- Aurora Provisioned: $0.29/hour (db.r6g.large, 2 vCPU, 16 GB)
- Storage: $0.10/GB/month + $0.20/million I/O requests
- Backups: Free up to 100% of DB size, then $0.021/GB/month

**Priority:** **Tier 1** — Critical for agent platforms with relational data needs.

---

### 3.2 Amazon ElastiCache — In-Memory Caching

**Purpose for Chimera:** Sub-millisecond caching for session state, tenant config, frequently accessed data. Redis or Memcached. Reduces DynamoDB costs and latency.

**Integration Opportunities:**
- **Session caching** — cache active agent sessions in Redis (TTL = session expiry)
- **Tenant config caching** — avoid DynamoDB reads for every request
- **Rate limiting counters** — Redis INCR for per-tenant rate limits (faster than DynamoDB)
- **Leaderboards** — Redis sorted sets for tenant usage rankings
- **Pub/Sub** — Redis Pub/Sub for inter-agent messaging (real-time coordination)
- **Session locking** — Redis distributed locks for concurrent agent access to sessions

**Architecture Pattern:**
```python
# ElastiCache (Redis) for session caching
import redis
import json

r = redis.Redis(host="agent-cache.xyz.ng.0001.use1.cache.amazonaws.com", port=6379, decode_responses=True)

def get_session(tenant_id: str, session_id: str) -> dict:
    """Get session from cache, fallback to DynamoDB"""
    cache_key = f"session:{tenant_id}:{session_id}"

    # Try cache first
    cached = r.get(cache_key)
    if cached:
        return json.loads(cached)

    # Cache miss — fetch from DynamoDB
    session = dynamodb_get_session(tenant_id, session_id)

    # Populate cache (TTL = 1 hour)
    r.setex(cache_key, 3600, json.dumps(session))

    return session

def rate_limit(tenant_id: str, limit: int, window_seconds: int) -> bool:
    """Redis-based rate limiting"""
    key = f"ratelimit:{tenant_id}"
    pipe = r.pipeline()
    pipe.incr(key)
    pipe.expire(key, window_seconds)
    count, _ = pipe.execute()
    return count <= limit
```

**Cost Model:**
- On-demand: $0.034/GB-hour + $0.0464/ECU-hour (cache.t4g.micro: $0.016/hour)
- Reserved instances: 50-60% savings
- Data transfer: Free in same AZ, $0.01/GB cross-AZ

**Priority:** **Tier 1** — High ROI for reducing DynamoDB costs and latency.

---

### 3.3 Amazon OpenSearch — Search & Analytics

**Purpose for Chimera:** Full-text search, log analytics, and vector search for agent platforms. Elasticsearch-compatible with serverless option.

**Integration Opportunities:**
- **Agent conversation search** — index all messages, search by keywords, semantic similarity
- **Log analytics** — ingest CloudWatch Logs, query with Lucene syntax
- **Vector search for RAG** — store document embeddings, semantic search for agent knowledge bases
- **Tenant analytics dashboards** — Kibana/OpenSearch Dashboards per tenant
- **Anomaly detection** — ML-powered anomaly detection on agent metrics

**Architecture Pattern:**
```python
# OpenSearch for agent conversation search
from opensearchpy import OpenSearch

os_client = OpenSearch(
    hosts=[{"host": "search-agent-logs.us-east-1.es.amazonaws.com", "port": 443}],
    use_ssl=True
)

def index_message(tenant_id: str, session_id: str, message: dict):
    """Index agent message for full-text search"""
    os_client.index(
        index=f"agent-messages-{tenant_id}",
        body={
            "tenant_id": tenant_id,
            "session_id": session_id,
            "timestamp": message["timestamp"],
            "role": message["role"],
            "content": message["content"],
            "tokens_used": message["tokens_used"]
        }
    )

def search_conversations(tenant_id: str, query: str):
    """Search agent conversations"""
    response = os_client.search(
        index=f"agent-messages-{tenant_id}",
        body={
            "query": {
                "multi_match": {
                    "query": query,
                    "fields": ["content^2", "role"]
                }
            },
            "sort": [{"timestamp": "desc"}],
            "size": 50
        }
    )
    return response["hits"]["hits"]
```

**Cost Model:**
- Serverless: $0.24/OCU-hour (compute) + $0.024/GB-month (storage)
- Managed: $0.158/hour (t3.small.search) to $26.40/hour (r6g.16xlarge.search)
- UltraWarm storage: $0.024/GB-month (cold data tier)

**Priority:** **Tier 2** — High value for platforms with extensive search/analytics needs.

---

### 3.4 Additional Data Services

| Service | Purpose | Priority |
|---------|---------|----------|
| **Amazon Timestream** | Time-series database for agent metrics, telemetry | Tier 3 |
| **Amazon Neptune** | Graph database for agent relationships, skill dependencies | Tier 3 |
| **Amazon QLDB** | Immutable ledger for audit trails, compliance | Tier 3 |
| **Amazon DocumentDB** | MongoDB-compatible for document-heavy agent data | Tier 3 |
| **Amazon MemoryDB for Redis** | Redis-compatible with Multi-AZ durability | Tier 2 |
| **Amazon Athena** | Serverless SQL queries on S3 data (agent logs, artifacts) | Tier 2 |
| **AWS Glue** | ETL for agent data pipelines (S3 -> OpenSearch, etc.) | Tier 2 |
| **AWS Lake Formation** | Data lake governance and access control | Tier 3 |

---

## 4. Networking & Content Delivery

### 4.1 Amazon CloudFront — CDN for Agent Endpoints

**Purpose for Chimera:** Global content delivery network (CDN) for low-latency agent API access, static asset delivery (web UI), and DDoS protection.

**Current Status:** Mentioned in [[06-AWS-Services-Agent-Infrastructure]] but not detailed.

**Integration Opportunities:**
- **Global agent API acceleration** — CloudFront in front of ALB, edge caching for read-heavy endpoints
- **WebSocket support** — CloudFront + API Gateway WebSocket for real-time agent streaming
- **Lambda@Edge** for request routing per tenant (geo-based, A/B testing, canary deployments)
- **WAF integration** — CloudFront + WAF for edge-level DDoS protection
- **Signed URLs** for secure agent artifact download (pre-signed S3 via CloudFront)

**Cost Model:**
- Data transfer out: $0.085/GB (US/Europe), $0.12/GB (Asia), $0.17/GB (South America)
- HTTPS requests: $0.0100/10K requests
- Lambda@Edge: $0.60/million requests + $0.00005001/GB-second

**Priority:** **Tier 1** — Essential for global, low-latency agent platforms.

---

### 4.2 AWS PrivateLink — Private Service Access

**Purpose for Chimera:** Securely expose agent services to tenant VPCs without internet traversal. Ideal for enterprise tenants requiring private connectivity.

**Integration Opportunities:**
- **VPC Endpoint Service** — expose agent API via PrivateLink, tenants connect via VPC endpoint
- **No public IP exposure** — agents accessible only via private IPs in tenant VPCs
- **Cross-account access** — tenant accounts create VPC endpoints pointing to Chimera's endpoint service
- **Metered billing** — charge tenants per GB transferred via PrivateLink

**Cost Model:**
- VPC Endpoint Service: $0.01/AZ-hour
- Data processed: $0.01/GB

**Priority:** **Tier 2** — High value for enterprise tenants with strict network security requirements.

---

### 4.3 AWS Transit Gateway — Hub-and-Spoke Networking

**Purpose for Chimera:** Central network hub for multi-VPC agent deployments. Connect tenant VPCs, shared services VPC, and on-premises networks.

**Integration Opportunities:**
- **Hub-and-spoke** — Chimera platform VPC as hub, tenant VPCs as spokes
- **Centralized egress** — route all internet-bound traffic through inspection VPC (NAT Gateway + Network Firewall)
- **Cross-region peering** — connect Transit Gateways in multiple regions for global agent platform
- **Multicast support** — broadcast agent events to multiple tenants (rare use case)

**Cost Model:**
- Attachment: $0.05/hour per VPC
- Data processed: $0.02/GB

**Priority:** **Tier 2** — Valuable for complex multi-VPC, multi-account agent platforms.

---

### 4.4 Additional Networking Services

| Service | Purpose | Priority |
|---------|---------|----------|
| **AWS Direct Connect** | Dedicated 1-10 Gbps network connection to AWS (low latency, high bandwidth) | Tier 3 |
| **AWS VPN** | Site-to-Site VPN for hybrid agent deployments | Tier 2 |
| **AWS Client VPN** | Remote access VPN for admin access to agent infrastructure | Tier 2 |
| **Route 53** | DNS for agent endpoints with health checks and traffic routing | Tier 1 |
| **VPC Lattice** | Service mesh for multi-VPC agent-to-agent communication | Tier 2 |
| **AWS Global Accelerator** | Static Anycast IPs for global low-latency agent access | Tier 2 |
| **AWS App Mesh** | Service mesh for ECS-based agent microservices | Tier 3 |
| **AWS Cloud Map** | Service discovery for agent backends | Tier 2 |

---

## 5. Analytics & Data Processing

### 5.1 Amazon Kinesis — Streaming Data

**Purpose for Chimera:** Real-time streaming for agent events, logs, and telemetry. Ingest millions of events/sec, process with Lambda/Flink.

**Integration Opportunities:**
- **Kinesis Data Streams** — agent events (session start, tool call, error) streamed to Kinesis, processed by Lambda for real-time analytics
- **Kinesis Firehose** — batch agent logs to S3/OpenSearch with automatic buffering and compression
- **Kinesis Data Analytics** — SQL queries on streaming agent metrics (e.g., "alert if error rate > 5% for tenant X")

**Cost Model:**
- Data Streams: $0.015/shard-hour + $0.014/million PUT records
- Firehose: $0.029/GB ingested
- Data Analytics: $0.11/hour per KPU (Kinesis Processing Unit)

**Priority:** **Tier 2** — High value for real-time agent monitoring and event-driven architectures.

---

### 5.2 Additional Analytics Services

| Service | Purpose | Priority |
|---------|---------|----------|
| **Amazon Athena** | Serverless SQL on S3 (query agent logs, artifacts without ETL) | Tier 2 |
| **AWS Glue** | Serverless ETL for agent data pipelines | Tier 2 |
| **Amazon QuickSight** | BI dashboards for tenant usage, agent performance | Tier 2 |
| **Amazon EMR** | Big data processing (Spark, Hadoop) for large-scale agent analytics | Tier 3 |
| **AWS Data Pipeline** | Orchestrate data workflows (batch ETL for agent data) | Tier 3 |
| **Amazon Redshift** | Data warehouse for historical agent analytics | Tier 3 |

---

## 6. Operational & Governance Services

### 6.1 AWS Organizations — Multi-Account Management

**Purpose for Chimera:** Centrally manage tenant AWS accounts, apply Service Control Policies (SCPs), consolidate billing.

**Integration Opportunities:**
- **Account-per-tenant** (silo model) — create AWS account for each enterprise tenant
- **Organizational Units (OUs)** — group tenants by tier (free, standard, enterprise)
- **SCPs** — enforce security guardrails (e.g., deny regions, enforce encryption, block risky services)
- **Consolidated billing** — single bill across all tenant accounts
- **AWS Control Tower** integration — automated account provisioning with landing zone

**Priority:** **Tier 2** — Critical for enterprise multi-tenant platforms with account-per-tenant model.

---

### 6.2 AWS Control Tower — Landing Zone Automation

**Purpose for Chimera:** Automated provisioning of secure, compliant multi-account environments. Pre-configured landing zone with guardrails.

**Integration Opportunities:**
- **Account Factory** — provision new tenant accounts via API/CLI with pre-configured IAM, VPC, logging
- **Guardrails** — preventive (SCPs) and detective (Config rules) controls for tenant accounts
- **Centralized logging** — route CloudTrail, Config, CloudWatch Logs to security account
- **Self-service account creation** — tenants request accounts via portal, Control Tower provisions automatically

**Priority:** **Tier 2** — High value for platforms with 50+ tenant accounts.

---

### 6.3 Additional Operational Services

| Service | Purpose | Priority |
|---------|---------|----------|
| **AWS Systems Manager** | Patch management, session access, parameter store, OpsCenter | Tier 1 |
| **AWS CloudTrail** | API audit logging for governance and forensics | Tier 1 |
| **AWS Config** | Track resource configurations, compliance rules, change history | Tier 1 |
| **AWS Service Catalog** | Self-service provisioning of agent environments for tenants | Tier 2 |
| **AWS Proton** | Automated deployment of microservices with templates | Tier 3 |
| **AWS Resilience Hub** | Assess and improve application resilience | Tier 3 |
| **AWS Fault Injection Simulator** | Chaos engineering for agent platform resilience testing | Tier 3 |
| **AWS Managed Grafana** | Managed Grafana for agent observability dashboards | Tier 2 |
| **AWS Managed Prometheus** | Managed Prometheus for agent metrics | Tier 2 |

---

## 7. Specialized Compute Services

### 7.1 Amazon EKS — Kubernetes for Agents

**Purpose for Chimera:** Managed Kubernetes for container orchestration. Alternative to ECS/Fargate for complex agent deployments.

**Integration Opportunities:**
- **EKS clusters per tier** (free/standard/enterprise) or per tenant (silo)
- **Fargate for EKS** — serverless Kubernetes pods (no node management)
- **EKS Anywhere** — run Kubernetes on-premises for hybrid agent deployments
- **Istio/Linkerd service mesh** for advanced traffic management
- **Karpenter** for auto-scaling nodes based on pod resource requests

**Cost Model:**
- EKS cluster: $0.10/hour ($73/month)
- Nodes: EC2/Fargate pricing
- Fargate: $0.04048/vCPU-hour + $0.004445/GB-hour

**Priority:** **Tier 3** — Only if Chimera requires advanced Kubernetes features beyond ECS.

---

### 7.2 AWS Batch — Job Scheduling

**Purpose for Chimera:** Managed batch job execution for long-running agent tasks (research, data processing, ML training).

**Integration Opportunities:**
- **Batch job queues** for background agent tasks (e.g., "analyze 10K documents", "train embeddings model")
- **Spot instances** for cost-optimized batch processing (up to 90% savings)
- **Job dependencies** — define multi-step batch workflows
- **Array jobs** — parallelize agent tasks across N instances

**Cost Model:**
- No additional charge — pay only for underlying EC2/Fargate compute

**Priority:** **Tier 3** — Useful for batch-heavy agent workloads (data processing, ML).

---

### 7.3 Additional Compute Services

| Service | Purpose | Priority |
|---------|---------|----------|
| **AWS Parallel Cluster** | HPC clusters for compute-intensive agent workloads | Tier 4 |
| **AWS Elastic Beanstalk** | PaaS for deploying agent web services (simpler than ECS) | Tier 3 |
| **AWS App2Container** | Containerize legacy agent code | Tier 4 |

---

## 8. Edge & Hybrid Services

| Service | Purpose | Priority |
|---------|---------|----------|
| **AWS Outposts** | On-premises AWS infrastructure for hybrid agent deployments | Tier 4 |
| **AWS Wavelength** | 5G edge compute for ultra-low-latency agent apps | Tier 4 |
| **AWS Local Zones** | Low-latency compute in metro areas (e.g., LA, Miami) | Tier 3 |
| **AWS Snow Family** | Edge computing and data transfer (Snowball, Snowcone, Snowmobile) | Tier 4 |
| **AWS IoT Core** | IoT device connectivity for agent-driven IoT workflows | Tier 4 |
| **AWS Greengrass** | Edge ML inference for IoT agent deployments | Tier 4 |

---

## 9. Developer Tools & CI/CD

| Service | Purpose | Priority |
|---------|---------|----------|
| **AWS CodePipeline** | CI/CD pipelines for agent code deployment | Tier 2 |
| **AWS CodeDeploy** | Blue/green, canary deployments for agent services | Tier 2 |
| **AWS CodeCommit** | Git repositories for agent code (alternative to GitHub) | Tier 3 |
| **AWS CodeArtifact** | Package management (npm, pip, Maven) for agent dependencies | Tier 2 |
| **AWS Cloud9** | Cloud-based IDE for agent development | Tier 4 |
| **AWS X-Ray** | Distributed tracing for agent -> tool -> LLM call chains | Tier 1 |
| **AWS Distro for OpenTelemetry** | Open-source observability for agent platforms | Tier 2 |

---

## 10. Data Transfer & Migration

| Service | Purpose | Priority |
|---------|---------|----------|
| **AWS DataSync** | Automated data transfer to/from on-premises storage | Tier 3 |
| **AWS Transfer Family** | Managed SFTP/FTPS/FTP for agent data ingestion | Tier 3 |
| **AWS Database Migration Service** | Migrate databases to AWS for agent platform | Tier 3 |
| **AWS Application Migration Service** | Lift-and-shift migrations for agent infrastructure | Tier 4 |

---

## 11. Industry-Specific Services

| Service | Purpose | Priority |
|---------|---------|----------|
| **AWS HealthLake** | Healthcare data lake for FHIR data (medical agent workflows) | Tier 4 |
| **Amazon FinSpace** | Financial data management for finance agent workflows | Tier 4 |
| **AWS Mainframe Modernization** | Modernize mainframe apps (legacy system agent integration) | Tier 4 |

---

## 12. Experimental & Emerging Services

| Service | Purpose | Priority |
|---------|---------|----------|
| **Amazon Managed Blockchain** | Blockchain for distributed agent consensus (niche) | Tier 4 |
| **AWS RoboMaker** | Robot simulation for physical agent deployments | Tier 4 |
| **AWS Ground Station** | Satellite data for agent-driven space/geo workflows | Tier 4 |

---

## Service Selection Decision Tree

```
START: What capability does Chimera need?

├─ Multi-provider LLM support? → **Amazon Bedrock** (Tier 1)
├─ Encryption per tenant? → **AWS KMS** (Tier 1)
├─ DDoS/web exploit protection? → **AWS WAF + Shield** (Tier 1)
├─ Global low-latency access? → **Amazon CloudFront** (Tier 1)
├─ Relational data (complex queries)? → **Amazon RDS/Aurora** (Tier 1)
├─ Sub-ms caching? → **Amazon ElastiCache** (Tier 1)
├─ Full-text search? → **Amazon OpenSearch** (Tier 2)
├─ Real-time streaming? → **Amazon Kinesis** (Tier 2)
├─ Multi-account governance? → **AWS Organizations + Control Tower** (Tier 2)
├─ Threat detection? → **Amazon GuardDuty + Security Hub** (Tier 2)
├─ Private tenant connectivity? → **AWS PrivateLink** (Tier 2)
├─ Document processing? → **Amazon Textract** (Tier 3)
├─ Image/video analysis? → **Amazon Rekognition** (Tier 3)
├─ Custom ML models? → **Amazon SageMaker** (Tier 2)
├─ Kubernetes? → **Amazon EKS** (Tier 3)
├─ Batch processing? → **AWS Batch** (Tier 3)
└─ [Niche use case] → See specialized services (Tier 4)
```

---

## Recommended Integration Roadmap

### Phase 1 (Q1 2026): Foundational Security & Performance
- **Amazon Bedrock** — Multi-provider LLM support
- **AWS KMS** — Per-tenant encryption
- **AWS WAF** — API endpoint protection
- **Amazon CloudFront** — Global CDN
- **Amazon ElastiCache** — Session caching
- **AWS X-Ray** — Distributed tracing
- **AWS CloudTrail** — Audit logging
- **AWS Config** — Compliance tracking

### Phase 2 (Q2 2026): Data & Analytics
- **Amazon RDS/Aurora** — Relational data
- **Amazon OpenSearch** — Search & analytics
- **Amazon Kinesis** — Real-time streaming
- **Amazon Athena** — S3 query engine
- **AWS Glue** — ETL pipelines

### Phase 3 (Q3 2026): Advanced Security & Governance
- **Amazon GuardDuty** — Threat detection
- **AWS Security Hub** — Centralized findings
- **AWS Organizations** — Multi-account management
- **AWS Control Tower** — Landing zone automation
- **AWS PrivateLink** — Private service access

### Phase 4 (Q4 2026): AI/ML Enhancement
- **Amazon SageMaker** — Custom models
- **Amazon Comprehend** — NLP
- **Amazon Textract** — Document intelligence
- **Amazon Rekognition** — Image/video analysis

### Phase 5 (2027): Specialized Capabilities
- **Amazon EKS** — Kubernetes (if needed)
- **Amazon Neptune** — Graph database
- **Amazon Timestream** — Time-series data
- **AWS IoT Core** — IoT agent workflows (if applicable)

---

## Cost Impact Analysis

### Tier 1 Services (Immediate Integration)

| Service | Estimated Monthly Cost (100 tenants, moderate usage) |
|---------|------------------------------------------------------|
| Amazon Bedrock | $3,000 (1M tokens/day @ $0.003/1K input + $0.015/1K output) |
| AWS KMS | $100 (100 tenant keys @ $1/key) |
| AWS WAF | $50 (1 ACL + 10 rules + 100M requests) |
| CloudFront | $500 (5 TB transfer + 50M requests) |
| ElastiCache (Redis) | $150 (cache.r6g.large) |
| RDS Aurora Serverless | $400 (10 ACU average) |
| CloudTrail | $50 (5M events) |
| AWS Config | $20 (2K config items) |
| X-Ray | $25 (5M traces) |
| **Total Phase 1** | **~$4,300/month** |

### Tier 2 Services (Strategic Value)

| Service | Estimated Monthly Cost |
|---------|------------------------|
| Amazon SageMaker | $1,500 (training + endpoints) |
| OpenSearch | $300 (r6g.large.search) |
| Kinesis Data Streams | $150 (10 shards) |
| GuardDuty | $200 (CloudTrail + VPC Flow Logs) |
| Security Hub | $50 (findings ingestion) |
| Organizations | $0 (free) |
| Control Tower | $0 (free, pay for underlying services) |
| PrivateLink | $100 (endpoint service + data) |
| **Total Phase 2** | **~$2,300/month** |

### Total First-Year AWS Spend (Tier 1 + Tier 2)
**$6,600/month × 12 = $79,200/year**

**Per-tenant cost:** $66/month (for 100 tenants)

---

## References

1. [AWS Services Documentation](https://docs.aws.amazon.com/)
2. [AWS Pricing Calculator](https://calculator.aws/)
3. [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
4. [AWS Multi-Tenant SaaS Guidance](https://aws.amazon.com/solutions/multi-tenant-saas/)
5. [AWS Prescriptive Guidance: Agentic AI](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-serverless/)
6. [[06-AWS-Services-Agent-Infrastructure]] — Baseline services already documented

---

**Next Steps:**
1. Review with architecture team to prioritize Tier 1 integrations
2. Create proof-of-concept for Bedrock + KMS + WAF integration
3. Estimate TCO for selected services across tenant tiers
4. Define service adoption roadmap by quarter
5. Document integration patterns for each Tier 1 service
