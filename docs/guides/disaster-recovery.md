# Chimera Disaster Recovery Guide

> **Status: DRAFT** — This guide describes planned DR procedures. Referenced scripts (scripts/dr/*.sh) and DR stacks have not yet been created.

> Comprehensive disaster recovery procedures, RTO/RPO targets, and data protection strategies

**Last Updated:** 2026-03-21
**Audience:** SREs, platform engineers, disaster recovery coordinators
**Related:** [Incident Response Runbook](../runbooks/incident-response.md)

---

## Recovery Objectives

| Component | RTO (Recovery Time Objective) | RPO (Recovery Point Objective) | Backup Frequency | Criticality |
|-----------|-------------------------------|-------------------------------|------------------|-------------|
| **Platform API** | 15 minutes | 0 (stateless) | N/A | Critical |
| **Tenants Table** | 30 minutes | 5 minutes | PITR (continuous) | Critical |
| **Sessions Table** | 1 hour | 30 minutes | PITR (continuous) | High |
| **Skills Table** | 2 hours | 1 hour | PITR (continuous) | High |
| **Audit Table** | 4 hours | 0 (no data loss) | PITR + Cross-region replication | Critical (compliance) |
| **Cost Tracking Table** | 4 hours | 1 hour | PITR (continuous) | Medium |
| **Rate Limits Table** | 30 minutes | 30 minutes | None (ephemeral, 5-min TTL) | Medium |
| **ECS Tasks** | 10 minutes | 0 (stateless) | N/A | Critical |
| **Skill Assets (S3)** | 2 hours | 1 hour | Versioning + Cross-region replication | High |
| **Cedar Policies (S3)** | 15 minutes | 0 (no data loss) | Versioning + Cross-region replication | Critical |
| **CloudWatch Logs** | N/A | 0 (real-time stream) | S3 export (daily) | Medium |

---

## Disaster Scenarios

### Scenario 1: Regional Failure (AWS Region Down)

**Impact:** Complete platform outage in primary region (us-east-1)

**Detection:**
- All CloudWatch alarms in primary region firing
- API Gateway health checks failing
- Zero successful invocations for 10+ minutes

**Recovery Procedure:**

#### Step 1: Verify Regional Failure (5 min)

```bash
# Check AWS Service Health Dashboard
open "https://health.aws.amazon.com/health/status"

# Verify multiple services affected
aws cloudwatch describe-alarms \
  --state-value ALARM \
  --region us-east-1 \
  | jq '.MetricAlarms | length'

# Expected: >10 alarms (indicates regional issue, not service-specific)
```

#### Step 2: Activate DR Region (us-west-2) (10 min)

```bash
# Set DR region as target
export AWS_REGION=us-west-2

# Step 2a: Verify DR infrastructure exists
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query 'StackSummaries[?contains(StackName, `chimera`)].StackName'

# Expected stacks:
# - chimera-network-dr
# - chimera-data-dr
# - chimera-security-dr
# - chimera-observability-dr
# - chimera-platform-runtime-dr
# - chimera-chat-dr

# Step 2b: Restore DynamoDB tables from PITR backups
./scripts/dr/restore-dynamodb-from-pitr.sh us-west-2

# Step 2c: Promote DynamoDB global table replicas (if configured)
# Global tables automatically handle cross-region replication
aws dynamodb describe-global-table \
  --global-table-name chimera-tenants \
  --region us-west-2
```

#### Step 3: Update DNS to Point to DR Region (5 min)

```bash
# Update Route 53 health check to us-west-2
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch file://dr-dns-failover.json

# dr-dns-failover.json content:
{
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "api.chimera.example.com",
      "Type": "A",
      "AliasTarget": {
        "HostedZoneId": "Z2FDTNDATAQYW2",
        "DNSName": "d1234567890.cloudfront.net",
        "EvaluateTargetHealth": true
      }
    }
  }]
}

# Verify DNS propagation (TTL: 60 seconds)
dig api.chimera.example.com +short
```

#### Step 4: Verify DR Region Health (5 min)

```bash
# Test API Gateway endpoint
curl https://api-dr.chimera.example.com/health

# Expected: HTTP 200
# {"status": "healthy", "region": "us-west-2", "mode": "dr-active"}

# Check ECS task count
aws ecs describe-services \
  --cluster chimera-chat-dr \
  --services chat-sdk \
  --query 'services[0].{Running:runningCount,Desired:desiredCount}'

# Verify DynamoDB table accessibility
aws dynamodb describe-table \
  --table-name chimera-tenants-dr \
  --query 'Table.{Status:TableStatus,ItemCount:ItemCount}'
```

#### Step 5: Notify Stakeholders (Parallel)

```bash
# Post in #chimera-incidents
echo "🚨 PRIMARY REGION DOWN: Failover to us-west-2 complete. ETA for primary recovery: TBD"

# Send email to stakeholders
aws ses send-email \
  --from ops@chimera.example.com \
  --to platform-stakeholders@chimera.example.com \
  --subject "Chimera DR Activation: us-west-2 now active" \
  --text "Primary region (us-east-1) unavailable. DR region (us-west-2) activated. Current status: operational."
```

**Total RTO:** 25 minutes
**Data Loss (RPO):** 5 minutes (last PITR snapshot)

---

### Scenario 2: Data Corruption (Malicious or Accidental)

**Impact:** Critical data corruption in Tenants or Skills table

**Detection:**
- Unusual spike in Cedar policy denials
- Reports of tenant configurations reset
- Skill installation failures

**Recovery Procedure:**

#### Step 1: Identify Corruption Scope (10 min)

```bash
# Check recent DynamoDB write activity
aws logs filter-log-events \
  --log-group-name /chimera/prod/platform \
  --start-time $(($(date +%s) - 3600))000 \
  --filter-pattern '{ $.event_type = "dynamodb_write" && $.table_name = "chimera-tenants" }' \
  | jq -r '.events[].message | fromjson | {timestamp, user_id, operation}'

# Check for bulk deletions
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteItem \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
  --max-results 50
```

#### Step 2: Stop Further Writes (5 min)

```bash
# Emergency: Deny all writes to affected table via Cedar policy
cat > /tmp/emergency-freeze.cedar <<EOF
forbid (
  principal,
  action in [Action::"dynamodb:PutItem", Action::"dynamodb:UpdateItem", Action::"dynamodb:DeleteItem"],
  resource == Table::"chimera-tenants"
) when {
  true
};
EOF

aws s3 cp /tmp/emergency-freeze.cedar s3://chimera-cedar-policies-prod/emergency/

# Policy reloads automatically within 60 seconds
```

#### Step 3: Restore from Point-in-Time Backup (20 min)

```bash
# Identify last known-good time (e.g., 30 minutes ago)
RESTORE_TIME="$(date -u -v-30M +%Y-%m-%dT%H:%M:%S)"

# Restore to temporary table
aws dynamodb restore-table-to-point-in-time \
  --source-table-name chimera-tenants-prod \
  --target-table-name chimera-tenants-restored-$(date +%s) \
  --restore-date-time "$RESTORE_TIME" \
  --use-latest-restorable-time false

# Wait for restore to complete (~15 minutes for 100GB table)
aws dynamodb wait table-exists \
  --table-name chimera-tenants-restored-$(date +%s)

# Verify restored data integrity
aws dynamodb scan \
  --table-name chimera-tenants-restored-$(date +%s) \
  --select COUNT

# If integrity check passes, swap tables
# (Requires downtime — update stack parameter to point to restored table)
```

#### Step 4: Migrate Restored Data (15 min)

```bash
# Option A: Blue-green table swap (requires CDK stack update)
# Update CDK context variable to point to restored table
cdk deploy ChimeraDataStack --context tenantsTableName=chimera-tenants-restored-1234567890

# Option B: Data migration script (zero downtime)
# Copy restored data back to production table
# (Requires custom migration script — see scripts/dr/migrate-table.sh)
./scripts/dr/migrate-table.sh \
  chimera-tenants-restored-1234567890 \
  chimera-tenants-prod \
  --mode incremental \
  --verify
```

#### Step 5: Remove Emergency Freeze (5 min)

```bash
# Remove emergency Cedar policy
aws s3 rm s3://chimera-cedar-policies-prod/emergency/emergency-freeze.cedar

# Verify writes are flowing
aws logs tail /chimera/prod/platform --since 1m --follow \
  | grep "dynamodb_write.*chimera-tenants"
```

**Total RTO:** 55 minutes
**Data Loss (RPO):** 30 minutes (restore point selection)

---

### Scenario 3: Complete Account Compromise (Security Breach)

**Impact:** AWS credentials compromised, potential data exfiltration

**Detection:**
- Unusual CloudTrail activity (e.g., AssumeRole from unknown IP)
- GuardDuty high-severity findings
- Security team notification

**Recovery Procedure:**

#### Step 1: Immediate Containment (10 min)

```bash
# Revoke all IAM credentials
aws iam list-users --query 'Users[].UserName' --output text | while read user; do
  echo "Disabling access keys for: $user"
  aws iam list-access-keys --user-name "$user" --query 'AccessKeyMetadata[].AccessKeyId' --output text | while read key; do
    aws iam update-access-key --user-name "$user" --access-key-id "$key" --status Inactive
  done
done

# Revoke all IAM role sessions
aws iam list-roles --query 'Roles[].RoleName' --output text | while read role; do
  echo "Attaching deny-all policy to: $role"
  aws iam attach-role-policy --role-name "$role" --policy-arn arn:aws:iam::aws:policy/AWSDenyAll
done

# Enable MFA delete on S3 buckets (prevents data deletion)
aws s3api put-bucket-versioning \
  --bucket chimera-skill-assets-prod \
  --versioning-configuration Status=Enabled,MFADelete=Enabled \
  --mfa "arn:aws:iam::123456789012:mfa/root-account-mfa-device XXXXXX"
```

#### Step 2: Assess Damage (30 min)

```bash
# Check CloudTrail for unauthorized actions
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteBucket \
  --start-time "$(date -u -v-24H +%Y-%m-%dT%H:%M:%S)" \
  --max-results 100

# Check GuardDuty findings
aws guardduty list-findings \
  --detector-id 1234567890abcdef \
  --finding-criteria '{"Criterion": {"severity": {"Gte": 7}}}' \
  --max-results 50

# Check VPC Flow Logs for data exfiltration
aws logs filter-log-events \
  --log-group-name /chimera/prod/vpc-flow-logs \
  --start-time $(($(date +%s) - 86400))000 \
  --filter-pattern '[version, account, eni, source, destination!="10.*", srcport, destport, protocol, packets, bytes>1000000, start, end, action="ACCEPT"]' \
  | jq '.events[].message'

# Check S3 access logs for bulk downloads
aws s3api list-objects-v2 \
  --bucket chimera-access-logs-prod \
  --prefix "s3/$(date +%Y/%m/%d)/" \
  --query 'Contents[?Size > `1000000`].[Key,Size]' \
  --output table
```

#### Step 3: Forensic Snapshot (Parallel)

```bash
# Create snapshots of all EBS volumes for forensic analysis
aws ec2 describe-instances \
  --filters "Name=tag:Project,Values=chimera" \
  --query 'Reservations[].Instances[].BlockDeviceMappings[].Ebs.VolumeId' \
  --output text | while read vol; do
  echo "Creating forensic snapshot: $vol"
  aws ec2 create-snapshot \
    --volume-id "$vol" \
    --description "Forensic snapshot - security breach $(date +%Y-%m-%d)" \
    --tag-specifications "ResourceType=snapshot,Tags=[{Key=Type,Value=Forensic},{Key=Date,Value=$(date +%Y-%m-%d)}]"
done

# Export CloudTrail logs to S3 (tamper-proof)
aws cloudtrail lookup-events \
  --start-time "$(date -u -v-7d +%Y-%m-%dT%H:%M:%S)" \
  --max-results 10000 \
  --output json > /tmp/cloudtrail-forensic-$(date +%s).json

aws s3 cp /tmp/cloudtrail-forensic-$(date +%s).json \
  s3://chimera-forensics-prod/breach-$(date +%Y%m%d)/cloudtrail.json
```

#### Step 4: Rotate All Secrets (1 hour)

```bash
# Rotate all Secrets Manager secrets
aws secretsmanager list-secrets \
  --query 'SecretList[?contains(Name, `chimera`)].Name' \
  --output text | while read secret; do
  echo "Rotating secret: $secret"
  aws secretsmanager rotate-secret --secret-id "$secret" --rotation-lambda-arn arn:aws:lambda:us-east-1:123456789012:function:chimera-secret-rotation
done

# Rotate Cognito user pool client secrets
aws cognito-idp list-user-pool-clients \
  --user-pool-id us-east-1_ABCDEFGHI \
  --query 'UserPoolClients[].ClientId' \
  --output text | while read client; do
  echo "Rotating Cognito client: $client"
  aws cognito-idp update-user-pool-client \
    --user-pool-id us-east-1_ABCDEFGHI \
    --client-id "$client" \
    --generate-secret
done

# Rotate RDS credentials (if applicable)
# aws rds modify-db-instance --db-instance-identifier chimera-prod --master-user-password "NEW_SECURE_PASSWORD"

# Rotate KMS keys
aws kms list-keys --query 'Keys[].KeyId' --output text | while read key; do
  aws kms get-key-rotation-status --key-id "$key"
  # If rotation not enabled, enable it
  aws kms enable-key-rotation --key-id "$key"
done
```

#### Step 5: Rebuild from Known-Good State (4 hours)

```bash
# Tear down compromised infrastructure
cdk destroy ChimeraDataStack ChimeraSecurityStack --force

# Rebuild from version-controlled CDK code
git checkout tags/v1.2.3  # Last known-good release
cdk deploy --all --require-approval never

# Restore data from PITR backups
./scripts/dr/restore-all-tables.sh

# Re-deploy ECS tasks with fresh container images
aws ecs update-service \
  --cluster chimera-chat-prod \
  --service chat-sdk \
  --force-new-deployment \
  --task-definition chimera-chat-sdk:CLEAN_BUILD
```

**Total RTO:** 6 hours
**Data Loss (RPO):** 0 (audit logs preserved, data restored from PITR)

---

## Backup Strategy

### DynamoDB Point-in-Time Recovery (PITR)

**Configuration:**

All production DynamoDB tables have PITR enabled:

```typescript
// In CDK stack
const tenantsTable = new dynamodb.Table(this, 'TenantsTable', {
  tableName: 'chimera-tenants-prod',
  pointInTimeRecovery: true,  // Enables PITR
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
});
```

**Retention:** 35 days (AWS maximum)

**Verification:**

```bash
# Check PITR status for all tables
for table in chimera-tenants chimera-sessions chimera-skills chimera-rate-limits chimera-cost-tracking chimera-audit; do
  echo "--- $table ---"
  aws dynamodb describe-continuous-backups \
    --table-name $table-prod \
    --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.{Status:PointInTimeRecoveryStatus,EarliestRestorableDateTime:EarliestRestorableDateTime,LatestRestorableDateTime:LatestRestorableDateTime}'
done
```

**Restore Procedure:**

```bash
# Restore to a specific point in time
RESTORE_TIME="2026-03-20T10:00:00Z"
SOURCE_TABLE="chimera-tenants-prod"
TARGET_TABLE="chimera-tenants-restored-$(date +%s)"

aws dynamodb restore-table-to-point-in-time \
  --source-table-name "$SOURCE_TABLE" \
  --target-table-name "$TARGET_TABLE" \
  --restore-date-time "$RESTORE_TIME"

# Monitor restore progress
watch -n 10 'aws dynamodb describe-table --table-name '"$TARGET_TABLE"' --query "Table.TableStatus"'
```

---

### S3 Versioning + Cross-Region Replication

**Configuration:**

```typescript
// Skill assets bucket with versioning + CRR
const skillAssetsBucket = new s3.Bucket(this, 'SkillAssetsBucket', {
  bucketName: 'chimera-skill-assets-prod',
  versioned: true,
  lifecycleRules: [
    {
      noncurrentVersionExpiration: cdk.Duration.days(90),
    },
  ],
  replicationConfiguration: {
    role: replicationRole,
    rules: [
      {
        id: 'CRR-to-us-west-2',
        status: 'Enabled',
        destination: {
          bucket: 'arn:aws:s3:::chimera-skill-assets-dr',
          replicationTime: { status: 'Enabled', minutes: 15 },
        },
      },
    ],
  },
});
```

**Verification:**

```bash
# Check versioning status
aws s3api get-bucket-versioning --bucket chimera-skill-assets-prod

# Check replication status
aws s3api get-bucket-replication --bucket chimera-skill-assets-prod

# List versions of a specific object
aws s3api list-object-versions \
  --bucket chimera-skill-assets-prod \
  --prefix skills/web-search/v1.0.0/index.js
```

**Recovery from Accidental Deletion:**

```bash
# List deleted objects (delete markers)
aws s3api list-object-versions \
  --bucket chimera-skill-assets-prod \
  --prefix skills/ \
  --query 'DeleteMarkers[].{Key:Key,VersionId:VersionId,DeleteMarker:IsLatest}'

# Restore by removing delete marker
OBJECT_KEY="skills/web-search/v1.0.0/index.js"
DELETE_MARKER_VERSION_ID="abcd1234"

aws s3api delete-object \
  --bucket chimera-skill-assets-prod \
  --key "$OBJECT_KEY" \
  --version-id "$DELETE_MARKER_VERSION_ID"

# Previous version is now current
```

---

### CloudWatch Logs Export to S3

**Configuration:**

Daily export task via EventBridge + Lambda:

```bash
# Create export task
aws logs create-export-task \
  --log-group-name /chimera/prod/platform \
  --from $(date -u -v-1d +%s)000 \
  --to $(date -u +%s)000 \
  --destination chimera-logs-archive-prod \
  --destination-prefix logs/platform/$(date +%Y/%m/%d)
```

**Retention:**
- CloudWatch Logs: 180 days (prod), 7 days (staging)
- S3 archived logs: 7 years (compliance requirement)

---

## Cross-Region Replication Strategy

### DynamoDB Global Tables

**Configured Tables:**
- `chimera-audit` (compliance requirement — zero data loss)
- `chimera-tenants` (critical for authentication)

**Configuration:**

```bash
# Enable global table replication
aws dynamodb create-global-table \
  --global-table-name chimera-audit \
  --replication-group RegionName=us-east-1 RegionName=us-west-2
```

**Monitoring:**

```bash
# Check replication status
aws dynamodb describe-global-table \
  --global-table-name chimera-audit \
  --query 'GlobalTableDescription.ReplicationGroup[].{Region:RegionName,Status:ReplicaStatus,LastUpdateTime:LastUpdateToReplicateTime}'
```

### ECS Task Definitions (Multi-Region)

**Strategy:** Active-passive DR architecture

- **Primary (us-east-1):** Full capacity (10 tasks)
- **DR (us-west-2):** Warm standby (2 tasks)

**Activation Procedure:**

```bash
# Scale up DR region tasks
aws ecs update-service \
  --cluster chimera-chat-dr \
  --service chat-sdk \
  --desired-count 10 \
  --region us-west-2

# Verify scale-up
aws ecs describe-services \
  --cluster chimera-chat-dr \
  --services chat-sdk \
  --region us-west-2 \
  --query 'services[0].{Running:runningCount,Desired:desiredCount}'
```

---

## DR Testing Schedule

| Test Type | Frequency | Duration | Scope |
|-----------|-----------|----------|-------|
| **Tabletop Exercise** | Quarterly | 2 hours | All runbooks reviewed |
| **PITR Restore Test** | Monthly | 1 hour | Restore one table to test environment |
| **Regional Failover Test** | Semi-annually | 4 hours | Full failover to us-west-2 |
| **Security Breach Simulation** | Annually | 8 hours | Full compromise scenario |

---

## Emergency Contacts

| Role | Contact | Phone | Escalation |
|------|---------|-------|------------|
| **On-Call SRE** | PagerDuty | +1-555-0123 | Primary |
| **Platform Lead** | John Doe | +1-555-0456 | After 30 min |
| **VP Engineering** | Jane Smith | +1-555-0789 | After 1 hour (SEV1) |
| **AWS TAM** | AWS Support | +1-800-AWS-HELP | For AWS service issues |
| **Security Lead** | Bob Johnson | +1-555-0321 | For breach scenarios |

---

## Post-DR Checklist

After a disaster recovery event:

1. ☑ **Document timeline** — exact timestamps for detection, activation, recovery
2. ☑ **Capture metrics** — actual RTO/RPO vs. targets
3. ☑ **Identify gaps** — what went wrong, what was missing from runbook
4. ☑ **Update runbooks** — incorporate lessons learned
5. ☑ **Schedule post-mortem** — within 72 hours of resolution
6. ☑ **Notify customers** — transparent communication about impact
7. ☑ **Test restored systems** — full regression testing before declaring "recovered"
8. ☑ **Review costs** — DR activation may incur significant AWS charges

---

## Related Documents

- [Incident Response Runbook](../runbooks/incident-response.md)
- [Alarm Runbooks](../runbooks/alarm-runbooks.md)
- [Capacity Planning Runbook](../runbooks/capacity-planning.md)
- [ObservabilityStack CDK](../../infra/lib/observability-stack.ts)
- [DataStack CDK](../../infra/lib/data-stack.ts)

---

**Feedback:** Found an issue? Create a ticket: `sd create --title "DR Guide: [topic]"`
