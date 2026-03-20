# AWS Config: Comprehensive Resource Inventory & Compliance Tracking

> **Research Date:** 2026-03-20
> **Status:** Complete
> **Series:** AWS Account Agent Infrastructure (1 of 5)
> **See also:** [[02-Resource-Explorer-Cross-Region-Search]] | [[03-CloudFormation-Stack-Inventory]] | [[04-Cost-Explorer-Spending-Analysis]] | [[05-Tag-Based-Resource-Organization]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#What is AWS Config?]]
- [[#Core Capabilities]]
- [[#Architecture Overview]]
- [[#Resource Recording]]
- [[#Multi-Account Multi-Region Strategy]]
- [[#Configuration History]]
- [[#Configuration Snapshots]]
- [[#Advanced Queries]]
- [[#Compliance and Rules]]
- [[#Integration with Other Services]]
- [[#Pricing Model]]
- [[#Regional Availability]]
- [[#Use Cases for Chimera]]
- [[#Code Examples]]
- [[#Best Practices]]
- [[#Limitations and Considerations]]
- [[#Key Takeaways]]
- [[#Sources]]

---

## Executive Summary

AWS Config is a **continuous resource inventory and compliance tracking service** that records configuration changes for AWS resources across your entire account. It provides a complete, time-based record of what resources exist, how they're configured, and how they relate to each other.

For Chimera's account-wide agent system, AWS Config serves as the **foundational resource inventory layer** that enables:
- **Real-time resource discovery** across all regions
- **Configuration change tracking** with complete history
- **Resource relationship mapping** (what depends on what)
- **Compliance state awareness** (is infrastructure in desired state?)
- **Point-in-time queries** ("what did my infrastructure look like yesterday?")

Key differentiators:
- **Continuous recording** -- captures every configuration change
- **Relationship tracking** -- understands resource dependencies
- **Time-travel queries** -- retrieve historical configurations
- **300+ resource types** supported (EC2, S3, IAM, Lambda, DynamoDB, etc.)
- **Multi-account aggregation** -- unified view across AWS Organizations
- **SQL-based advanced queries** -- flexible querying with AWS Config SQL

---

## What is AWS Config?

AWS Config operates at the **infrastructure visibility layer** of AWS:

```
+-------------------------------------------------------+
|            Chimera Agent Platform                      |
|  (Account-wide orchestration & self-evolution)         |
+-------------------------------------------------------+
|        AWS Config (Resource Inventory)                 |  <-- This layer
|  - Continuous recording of resources                   |
|  - Configuration history                               |
|  - Relationship mapping                                |
|  - Compliance evaluation                               |
+-------------------------------------------------------+
|           AWS Infrastructure                           |
|  (EC2, S3, Lambda, DynamoDB, VPC, IAM, etc.)          |
+-------------------------------------------------------+
```

### Core Value Propositions

1. **Complete visibility** -- know what resources exist, where, and how they're configured
2. **Change auditing** -- track who changed what, when, and how
3. **Compliance enforcement** -- continuously validate infrastructure against rules
4. **Disaster recovery** -- reconstruct infrastructure state from any point in time
5. **Cost attribution** -- understand resource relationships for chargeback

### What Can You Build?

With AWS Config as the foundation:
- **Self-healing infrastructure** -- detect drift and auto-remediate
- **Intelligent cost optimization** -- identify unused/underutilized resources
- **Security posture management** -- enforce security policies continuously
- **Change impact analysis** -- predict effects of infrastructure changes
- **Automated documentation** -- generate architecture diagrams from live state

---

## Core Capabilities

### 1. Resource Recording

AWS Config continuously records configurations for supported resource types:

| Category | Example Resources | Count |
|----------|------------------|-------|
| **Compute** | EC2 instances, ECS tasks, Lambda functions | 25+ types |
| **Storage** | S3 buckets, EBS volumes, EFS file systems | 15+ types |
| **Database** | RDS instances, DynamoDB tables, Aurora clusters | 20+ types |
| **Network** | VPCs, subnets, security groups, load balancers | 40+ types |
| **Security** | IAM roles, KMS keys, Secrets Manager secrets | 30+ types |
| **Containers** | EKS clusters, ECR repositories, ECS services | 10+ types |
| **Serverless** | Lambda functions, API Gateways, Step Functions | 15+ types |
| **Analytics** | Kinesis streams, Glue databases, Athena workgroups | 20+ types |

**Total:** 300+ resource types across all AWS services

### 2. Configuration Items (CIs)

Each resource configuration is stored as a **Configuration Item**:

```json
{
  "version": "1.3",
  "accountId": "123456789012",
  "configurationItemCaptureTime": "2026-03-20T10:15:30.123Z",
  "configurationItemStatus": "ResourceDiscovered",
  "configurationStateId": "1234567890",
  "resourceType": "AWS::EC2::Instance",
  "resourceId": "i-0abc123def456789",
  "resourceName": "chimera-agent-runtime-001",
  "awsRegion": "us-east-1",
  "availabilityZone": "us-east-1a",
  "tags": {
    "Environment": "production",
    "Project": "chimera",
    "ManagedBy": "AgentCore"
  },
  "relationships": [
    {
      "resourceType": "AWS::EC2::SecurityGroup",
      "resourceId": "sg-0123456789abcdef",
      "relationshipName": "Is associated with SecurityGroup"
    },
    {
      "resourceType": "AWS::EC2::Volume",
      "resourceId": "vol-0abc123def456",
      "relationshipName": "Is attached to Volume"
    }
  ],
  "configuration": {
    "instanceId": "i-0abc123def456789",
    "instanceType": "t3.medium",
    "state": { "name": "running" },
    "vpcId": "vpc-0123456789",
    "subnetId": "subnet-0abc123"
    // ... full instance configuration
  }
}
```

### 3. Configuration Timeline

Every resource has a complete history:

```
Resource: i-0abc123def456789 (EC2 Instance)
┃
├─ 2026-03-20 10:15:30 │ ResourceDiscovered     │ Instance launched
├─ 2026-03-20 10:16:45 │ ConfigurationChanged   │ Security group updated
├─ 2026-03-20 11:22:10 │ ConfigurationChanged   │ Instance type changed (t3.micro → t3.medium)
├─ 2026-03-20 14:00:00 │ ConfigurationChanged   │ Tags added
└─ 2026-03-20 16:30:00 │ ResourceDeleted        │ Instance terminated
```

---

## Architecture Overview

### Components

```
┌─────────────────────────────────────────────────────┐
│               AWS Config Service                     │
│                                                      │
│  ┌────────────────┐  ┌──────────────────┐          │
│  │  Config        │  │  Configuration   │          │
│  │  Recorder      │─▶│  Items (S3)      │          │
│  └────────────────┘  └──────────────────┘          │
│           │                                          │
│           ▼                                          │
│  ┌────────────────┐  ┌──────────────────┐          │
│  │  Resource      │  │  Aggregator      │          │
│  │  Inventory     │◀─│  (Multi-Account) │          │
│  └────────────────┘  └──────────────────┘          │
│           │                                          │
│           ▼                                          │
│  ┌────────────────┐  ┌──────────────────┐          │
│  │  Config Rules  │  │  Conformance     │          │
│  │  (Compliance)  │─▶│  Packs           │          │
│  └────────────────┘  └──────────────────┘          │
│           │                                          │
│           ▼                                          │
│  ┌────────────────┐  ┌──────────────────┐          │
│  │  Remediation   │  │  SNS             │          │
│  │  Actions       │  │  Notifications   │          │
│  └────────────────┘  └──────────────────┘          │
└─────────────────────────────────────────────────────┘
         │                           │
         ▼                           ▼
   AWS Resources              External Systems
   (EC2, S3, Lambda)         (CloudWatch, Lambda)
```

### Data Flow

1. **Resource creation/modification** triggers AWS API call
2. **Config recorder** detects change via AWS CloudTrail
3. **Configuration snapshot** captured and stored
4. **Relationships evaluated** (what does this resource connect to?)
5. **Compliance rules** evaluate resource configuration
6. **Configuration item** stored in S3 bucket
7. **Notifications** sent via SNS if configured
8. **Aggregator** collects data across accounts/regions

---

## Resource Recording

### Configuration Recorder

The **Configuration Recorder** is the core component that tracks resources:

```python
import boto3

config = boto3.client('config')

# Create configuration recorder
config.put_configuration_recorder(
    ConfigurationRecorder={
        'name': 'chimera-config-recorder',
        'roleARN': 'arn:aws:iam::123456789012:role/ChimeraConfigRole',
        'recordingGroup': {
            'allSupported': True,  # Record all supported resource types
            'includeGlobalResources': True,  # Include IAM, etc.
            'resourceTypes': []  # Empty when allSupported=True
        },
        'recordingMode': {
            'recordingFrequency': 'CONTINUOUS',  # or 'DAILY'
            'recordingModeOverrides': [
                {
                    'description': 'Record EC2 instances continuously',
                    'resourceTypes': ['AWS::EC2::Instance'],
                    'recordingFrequency': 'CONTINUOUS'
                }
            ]
        }
    }
)

# Start recording
config.start_configuration_recorder(
    ConfigurationRecorderName='chimera-config-recorder'
)
```

### Recording Modes

| Mode | Description | Use Case | Cost |
|------|-------------|----------|------|
| **CONTINUOUS** | Record every configuration change immediately | Production systems, compliance | Higher (per change) |
| **DAILY** | Record once per day at scheduled time | Dev/test environments | Lower (per snapshot) |
| **HYBRID** | Continuous for critical resources, daily for others | Cost optimization | Medium |

### Selective Recording

Record only specific resource types:

```python
config.put_configuration_recorder(
    ConfigurationRecorder={
        'name': 'chimera-selective-recorder',
        'roleARN': 'arn:aws:iam::123456789012:role/ChimeraConfigRole',
        'recordingGroup': {
            'allSupported': False,
            'includeGlobalResources': False,
            'resourceTypes': [
                'AWS::EC2::Instance',
                'AWS::Lambda::Function',
                'AWS::DynamoDB::Table',
                'AWS::S3::Bucket',
                'AWS::IAM::Role',
                'AWS::ECS::Service'
            ]
        }
    }
)
```

---

## Multi-Account Multi-Region Strategy

### Aggregator Setup

For **multi-account visibility** (critical for Chimera managing entire AWS Organizations):

```python
# In the central management account
config.put_configuration_aggregator(
    ConfigurationAggregatorName='chimera-org-aggregator',
    OrganizationAggregationSource={
        'RoleArn': 'arn:aws:iam::123456789012:role/ChimeraConfigAggregatorRole',
        'AwsRegions': [
            'us-east-1', 'us-west-2', 'eu-central-1',
            'ap-southeast-1', 'ap-northeast-1'
        ],
        'AllAwsRegions': True  # Aggregate from all regions
    }
)
```

### Architecture: Multi-Account Aggregation

```
┌────────────────────────────────────────────────┐
│     Management Account (Central)               │
│                                                 │
│  ┌──────────────────────────────────────────┐ │
│  │  AWS Config Aggregator                   │ │
│  │  - Unified view across all accounts      │ │
│  │  - Cross-region queries                  │ │
│  └──────────────────────────────────────────┘ │
│           │         │          │               │
└───────────┼─────────┼──────────┼───────────────┘
            │         │          │
    ────────┴─────────┴──────────┴────────
    │                 │                  │
    ▼                 ▼                  ▼
┌─────────┐      ┌─────────┐       ┌─────────┐
│ Account │      │ Account │       │ Account │
│   Dev   │      │  Prod   │       │Sandbox  │
│         │      │         │       │         │
│ Config  │      │ Config  │       │ Config  │
│ Enabled │      │ Enabled │       │ Enabled │
└─────────┘      └─────────┘       └─────────┘
```

### Query Across Accounts

```python
# Query all Lambda functions across all accounts and regions
response = config.select_aggregate_resource_config(
    ConfigurationAggregatorName='chimera-org-aggregator',
    Expression="""
        SELECT
            accountId,
            awsRegion,
            resourceName,
            configuration.runtime,
            configuration.memorySize,
            tags
        WHERE
            resourceType = 'AWS::Lambda::Function'
        ORDER BY
            accountId, awsRegion
    """
)

for result in response['Results']:
    print(json.loads(result))
```

---

## Configuration History

### Retrieve Historical Configurations

Get the complete history of a resource:

```python
# Get configuration history for an EC2 instance
response = config.get_resource_config_history(
    resourceType='AWS::EC2::Instance',
    resourceId='i-0abc123def456789',
    laterTime=datetime(2026, 3, 20, 16, 0, 0),
    earlierTime=datetime(2026, 3, 20, 8, 0, 0),
    chronologicalOrder='Reverse',  # Most recent first
    limit=100
)

for item in response['configurationItems']:
    print(f"Time: {item['configurationItemCaptureTime']}")
    print(f"Status: {item['configurationItemStatus']}")
    print(f"Config: {item['configuration']}")
    print("---")
```

### Use Cases for History

1. **Change impact analysis** -- understand what changed before an incident
2. **Compliance auditing** -- prove infrastructure was compliant at a specific time
3. **Rollback planning** -- retrieve previous configurations for restoration
4. **Cost forensics** -- trace when expensive resources were added

---

## Configuration Snapshots

### Delivery Channel

Configuration snapshots are stored in **S3** for durable access:

```python
config.put_delivery_channel(
    DeliveryChannel={
        'name': 'chimera-config-delivery',
        's3BucketName': 'chimera-config-bucket-us-east-1',
        's3KeyPrefix': 'config/',
        'snsTopicARN': 'arn:aws:sns:us-east-1:123456789012:chimera-config-changes',
        'configSnapshotDeliveryProperties': {
            'deliveryFrequency': 'TwentyFour_Hours'  # Daily snapshots
        }
    }
)
```

### Snapshot Structure in S3

```
s3://chimera-config-bucket-us-east-1/
├── config/
│   ├── AWSLogs/
│   │   ├── 123456789012/  # Account ID
│   │   │   ├── Config/
│   │   │   │   ├── us-east-1/
│   │   │   │   │   ├── 2026/03/20/
│   │   │   │   │   │   ├── ConfigSnapshot/
│   │   │   │   │   │   │   └── 123456789012_Config_us-east-1_ConfigSnapshot_20260320T100000Z.json.gz
│   │   │   │   │   │   ├── ConfigWritabilityCheckFile
│   │   │   │   │   │   └── ConfigHistory/
│   │   │   │   │   │       ├── AWS::EC2::Instance/
│   │   │   │   │   │       │   └── i-0abc123def456789.json
│   │   │   │   │   │       ├── AWS::Lambda::Function/
│   │   │   │   │   │       └── AWS::DynamoDB::Table/
```

### Query S3 with Athena

Use **Amazon Athena** to query Config snapshots:

```sql
-- Create external table for Config data
CREATE EXTERNAL TABLE config_snapshots (
    accountid string,
    awsregion string,
    resourcetype string,
    resourceid string,
    configuration string,
    tags map<string,string>
)
STORED AS PARQUET
LOCATION 's3://chimera-config-bucket-us-east-1/config/';

-- Find all public S3 buckets
SELECT
    accountid,
    resourceid,
    configuration
FROM config_snapshots
WHERE resourcetype = 'AWS::S3::Bucket'
  AND json_extract_scalar(configuration, '$.publicAccessBlockConfiguration.blockPublicAcls') = 'false';
```

---

## Advanced Queries

### AWS Config SQL

Advanced queries using SQL-like syntax:

#### Query 1: Find All Unencrypted EBS Volumes

```python
response = config.select_resource_config(
    Expression="""
        SELECT
            resourceId,
            resourceName,
            availabilityZone,
            configuration.size,
            configuration.encrypted,
            tags
        WHERE
            resourceType = 'AWS::EC2::Volume'
            AND configuration.encrypted = false
    """
)
```

#### Query 2: Find Lambda Functions with Old Runtimes

```python
response = config.select_resource_config(
    Expression="""
        SELECT
            accountId,
            awsRegion,
            resourceName,
            configuration.runtime,
            configuration.lastModified
        WHERE
            resourceType = 'AWS::Lambda::Function'
            AND (
                configuration.runtime LIKE 'python2%'
                OR configuration.runtime LIKE 'nodejs10%'
                OR configuration.runtime LIKE 'nodejs12%'
            )
    """
)
```

#### Query 3: Find Resources Without Required Tags

```python
response = config.select_resource_config(
    Expression="""
        SELECT
            resourceType,
            resourceId,
            tags
        WHERE
            resourceType IN (
                'AWS::EC2::Instance',
                'AWS::Lambda::Function',
                'AWS::DynamoDB::Table'
            )
            AND (
                tags.Environment IS NULL
                OR tags.Project IS NULL
                OR tags.Owner IS NULL
            )
    """
)
```

#### Query 4: Resource Relationship Graph

```python
response = config.select_resource_config(
    Expression="""
        SELECT
            resourceId,
            resourceType,
            relationships
        WHERE
            resourceType = 'AWS::EC2::Instance'
            AND resourceId = 'i-0abc123def456789'
    """
)

# Build dependency graph
for item in response['Results']:
    config_item = json.loads(item)
    for relationship in config_item.get('relationships', []):
        print(f"{config_item['resourceId']} -> {relationship['resourceId']}")
        print(f"  Type: {relationship['relationshipName']}")
```

---

## Compliance and Rules

### Managed Config Rules

AWS provides **300+ managed rules** for common compliance checks:

| Category | Example Rules |
|----------|---------------|
| **Security** | `encrypted-volumes`, `s3-bucket-public-read-prohibited`, `iam-password-policy` |
| **Access Control** | `iam-user-mfa-enabled`, `root-account-mfa-enabled`, `s3-bucket-ssl-requests-only` |
| **Tagging** | `required-tags`, `ec2-instance-managed-by-systems-manager` |
| **Backup** | `backup-plan-min-frequency-and-min-retention-check`, `rds-automatic-backups-enabled` |
| **Cost Optimization** | `ec2-stopped-instance`, `ebs-unattached-volume`, `rds-idle-db-instance` |

### Enable Compliance Rules

```python
# Enable a managed rule
config.put_config_rule(
    ConfigRule={
        'ConfigRuleName': 'chimera-encrypted-volumes',
        'Description': 'Ensure all EBS volumes are encrypted',
        'Source': {
            'Owner': 'AWS',
            'SourceIdentifier': 'ENCRYPTED_VOLUMES'
        },
        'Scope': {
            'ComplianceResourceTypes': ['AWS::EC2::Volume']
        }
    }
)

# Check compliance status
response = config.describe_compliance_by_config_rule(
    ConfigRuleNames=['chimera-encrypted-volumes']
)

for rule in response['ComplianceByConfigRules']:
    print(f"Rule: {rule['ConfigRuleName']}")
    print(f"Compliance: {rule['Compliance']['ComplianceType']}")
```

### Custom Config Rules

Create custom rules with **AWS Lambda**:

```python
# Lambda function for custom compliance check
def lambda_handler(event, context):
    config_item = json.loads(event['configurationItem'])

    # Custom logic: EC2 instances must have Project=chimera tag
    compliance = 'NON_COMPLIANT'
    if config_item['resourceType'] == 'AWS::EC2::Instance':
        tags = config_item.get('tags', {})
        if tags.get('Project') == 'chimera':
            compliance = 'COMPLIANT'

    config = boto3.client('config')
    config.put_evaluations(
        Evaluations=[{
            'ComplianceResourceType': config_item['resourceType'],
            'ComplianceResourceId': config_item['resourceId'],
            'ComplianceType': compliance,
            'OrderingTimestamp': config_item['configurationItemCaptureTime']
        }],
        ResultToken=event['resultToken']
    )
```

### Remediation Actions

Auto-remediate non-compliant resources:

```python
config.put_remediation_configuration(
    ConfigRuleName='chimera-encrypted-volumes',
    RemediationConfiguration={
        'TargetType': 'SSM_DOCUMENT',
        'TargetIdentifier': 'AWS-EnableEBSEncryptionByDefault',
        'Automatic': True,  # Auto-remediate
        'MaximumAutomaticAttempts': 3,
        'RetryAttemptSeconds': 60
    }
)
```

---

## Integration with Other Services

### 1. AWS Organizations

Enable Config across all accounts:

```python
# In management account
organizations = boto3.client('organizations')

# Enable trusted access for Config
organizations.enable_aws_service_access(
    ServicePrincipal='config.amazonaws.com'
)

# Deploy Config via StackSets to all accounts
cloudformation = boto3.client('cloudformation')
cloudformation.create_stack_set(
    StackSetName='ChimeraConfigDeployment',
    TemplateBody=config_template,
    Capabilities=['CAPABILITY_NAMED_IAM'],
    # Deploy to all accounts in organization
)
```

### 2. AWS Security Hub

Config findings feed into **Security Hub**:

```python
# Config rule violations automatically appear in Security Hub
securityhub = boto3.client('securityhub')

findings = securityhub.get_findings(
    Filters={
        'ProductName': [{'Value': 'Config', 'Comparison': 'EQUALS'}],
        'ComplianceStatus': [{'Value': 'FAILED', 'Comparison': 'EQUALS'}]
    }
)
```

### 3. EventBridge

React to configuration changes:

```python
events = boto3.client('events')

# Create EventBridge rule for Config changes
events.put_rule(
    Name='chimera-config-changes',
    EventPattern=json.dumps({
        'source': ['aws.config'],
        'detail-type': ['Config Configuration Item Change'],
        'detail': {
            'configurationItem': {
                'resourceType': ['AWS::EC2::Instance']
            }
        }
    }),
    State='ENABLED'
)

# Target Lambda for processing
events.put_targets(
    Rule='chimera-config-changes',
    Targets=[{
        'Id': '1',
        'Arn': 'arn:aws:lambda:us-east-1:123456789012:function:ChimeraConfigProcessor'
    }]
)
```

### 4. CloudWatch

Monitor Config metrics:

```python
cloudwatch = boto3.client('cloudwatch')

# Get compliance metrics
response = cloudwatch.get_metric_statistics(
    Namespace='AWS/Config',
    MetricName='ComplianceScore',
    Dimensions=[
        {'Name': 'ConfigRuleName', 'Value': 'chimera-encrypted-volumes'}
    ],
    StartTime=datetime.now() - timedelta(days=7),
    EndTime=datetime.now(),
    Period=86400,  # Daily
    Statistics=['Average']
)
```

---

## Pricing Model

### Configuration Items

| Tier | Configuration Items/Month | Price per Item |
|------|--------------------------|----------------|
| **First 100,000** | 0 - 100K | $0.003 |
| **Next 400,000** | 100K - 500K | $0.0015 |
| **Over 500,000** | 500K+ | $0.0008 |

**Configuration Item** = one resource configuration recorded once

### Config Rules

| Type | Price |
|------|-------|
| **Rule evaluations** | $0.001 per evaluation |
| **Conformance packs** | $0.0012 per evaluation (multi-rule bundles) |

### Custom Config Rules

- **Lambda invocations** charged separately at Lambda pricing
- Typically $0.20 per million evaluations

### Example Cost Calculation

**Scenario:** 10,000 resources, continuous recording, 5 config rules

```
Monthly Configuration Items:
  10,000 resources × 10 changes/month = 100,000 items
  Cost: 100,000 × $0.003 = $300

Config Rule Evaluations:
  10,000 resources × 5 rules × 10 evaluations/month = 500,000 evaluations
  Cost: 500,000 × $0.001 = $500

Total: $800/month
```

### Cost Optimization Tips

1. **Use daily recording mode** for non-critical resources (10x fewer items)
2. **Selective recording** -- only track resources you need visibility into
3. **Aggregator consolidation** -- one aggregator instead of per-account queries
4. **Rule optimization** -- use conformance packs (cheaper) instead of individual rules
5. **Lifecycle policies** -- delete old configuration snapshots from S3

---

## Regional Availability

AWS Config is available in **all AWS commercial regions**:

| Region | Support Level |
|--------|---------------|
| **US Regions** | Full support (all features) |
| **EU Regions** | Full support |
| **Asia Pacific** | Full support |
| **Middle East** | Full support |
| **Africa** | Full support |
| **AWS GovCloud** | Full support |
| **China Regions** | Limited support |

---

## Use Cases for Chimera

### 1. Live Infrastructure Inventory

Chimera maintains real-time awareness of all resources:

```python
# Chimera's resource discovery agent
class ChimeraResourceDiscovery:
    def __init__(self):
        self.config = boto3.client('config')

    def get_all_resources(self) -> List[Dict]:
        """Retrieve all resources across the account."""
        response = self.config.select_resource_config(
            Expression="""
                SELECT
                    accountId,
                    awsRegion,
                    resourceType,
                    resourceId,
                    resourceName,
                    tags,
                    configuration
                WHERE
                    resourceType IS NOT NULL
            """
        )
        return [json.loads(r) for r in response['Results']]

    def get_resource_graph(self, resource_id: str) -> Dict:
        """Build dependency graph for a resource."""
        response = self.config.select_resource_config(
            Expression=f"""
                SELECT
                    resourceId,
                    resourceType,
                    relationships
                WHERE
                    resourceId = '{resource_id}'
            """
        )
        # Build graph from relationships
        # ...
```

### 2. Change Impact Analysis

Before making changes, understand blast radius:

```python
def analyze_change_impact(resource_id: str) -> Dict:
    """Analyze what would be affected if this resource changes."""
    # Get all resources that depend on this one
    response = config.select_resource_config(
        Expression=f"""
            SELECT
                resourceId,
                resourceType,
                relationships
            WHERE
                relationships LIKE '%{resource_id}%'
        """
    )

    dependent_resources = [json.loads(r) for r in response['Results']]
    return {
        'target_resource': resource_id,
        'dependent_count': len(dependent_resources),
        'dependent_types': list(set([r['resourceType'] for r in dependent_resources])),
        'risk_level': 'HIGH' if len(dependent_resources) > 10 else 'LOW'
    }
```

### 3. Compliance-Driven Self-Evolution

Chimera auto-remediates drift:

```python
def detect_and_remediate_drift():
    """Detect non-compliant resources and auto-fix."""
    # Get all non-compliant resources
    response = config.describe_compliance_by_config_rule(
        ComplianceTypes=['NON_COMPLIANT']
    )

    for rule_compliance in response['ComplianceByConfigRules']:
        rule_name = rule_compliance['ConfigRuleName']

        # Get non-compliant resources
        resources = config.get_compliance_details_by_config_rule(
            ConfigRuleName=rule_name,
            ComplianceTypes=['NON_COMPLIANT']
        )

        for resource in resources['EvaluationResults']:
            # Trigger remediation via Systems Manager or Lambda
            remediate_resource(resource)
```

### 4. Cost Attribution & Optimization

Track which resources are expensive:

```python
def identify_cost_outliers():
    """Find resources likely contributing to high costs."""
    # Unattached EBS volumes
    volumes = config.select_resource_config(
        Expression="""
            SELECT
                resourceId,
                awsRegion,
                configuration.size,
                configuration.volumeType
            WHERE
                resourceType = 'AWS::EC2::Volume'
                AND configuration.attachments IS NULL
        """
    )

    # Stopped EC2 instances (still incurring EBS costs)
    instances = config.select_resource_config(
        Expression="""
            SELECT
                resourceId,
                configuration.instanceType,
                configuration.state.name
            WHERE
                resourceType = 'AWS::EC2::Instance'
                AND configuration.state.name = 'stopped'
        """
    )

    # Return cleanup recommendations
    # ...
```

### 5. Security Posture Monitoring

Continuous security validation:

```python
def security_audit():
    """Audit account security posture."""
    checks = {
        'public_s3_buckets': config.select_resource_config(
            Expression="""
                SELECT resourceId
                WHERE resourceType = 'AWS::S3::Bucket'
                  AND configuration.publicAccessBlockConfiguration.blockPublicAcls = false
            """
        ),
        'unencrypted_volumes': config.select_resource_config(
            Expression="""
                SELECT resourceId
                WHERE resourceType = 'AWS::EC2::Volume'
                  AND configuration.encrypted = false
            """
        ),
        'iam_users_without_mfa': config.describe_compliance_by_config_rule(
            ConfigRuleNames=['iam-user-mfa-enabled'],
            ComplianceTypes=['NON_COMPLIANT']
        )
    }

    return {
        'security_score': calculate_score(checks),
        'findings': checks
    }
```

---

## Code Examples

### Complete Setup: CDK Stack

```typescript
import * as cdk from 'aws-cdk-lib';
import * as config from 'aws-cdk-lib/aws-config';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class ChimeraConfigStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for configuration snapshots
    const configBucket = new s3.Bucket(this, 'ConfigBucket', {
      bucketName: `chimera-config-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{
        expiration: cdk.Duration.days(365)  // Retain for 1 year
      }]
    });

    // IAM role for Config
    const configRole = new iam.Role(this, 'ConfigRole', {
      assumedBy: new iam.ServicePrincipal('config.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/ConfigRole')
      ]
    });

    configBucket.grantWrite(configRole);

    // Configuration recorder
    const recorder = new config.CfnConfigurationRecorder(this, 'Recorder', {
      roleArn: configRole.roleArn,
      recordingGroup: {
        allSupported: true,
        includeGlobalResourceTypes: true,
        recordingStrategy: {
          useOnly: 'ALL_SUPPORTED_RESOURCE_TYPES'
        }
      },
      recordingMode: {
        recordingFrequency: 'CONTINUOUS'
      }
    });

    // Delivery channel
    const deliveryChannel = new config.CfnDeliveryChannel(this, 'DeliveryChannel', {
      s3BucketName: configBucket.bucketName,
      configSnapshotDeliveryProperties: {
        deliveryFrequency: 'TwentyFour_Hours'
      }
    });

    // Managed Config Rules
    const encryptedVolumesRule = new config.ManagedRule(this, 'EncryptedVolumes', {
      identifier: config.ManagedRuleIdentifiers.ENCRYPTED_VOLUMES,
      description: 'Ensure all EBS volumes are encrypted'
    });

    const s3PublicReadProhibited = new config.ManagedRule(this, 'S3PublicReadProhibited', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_READ_PROHIBITED,
      description: 'Ensure S3 buckets are not publicly readable'
    });

    // Aggregator (if management account)
    if (this.node.tryGetContext('isManagementAccount')) {
      new config.CfnConfigurationAggregator(this, 'OrgAggregator', {
        configurationAggregatorName: 'chimera-org-aggregator',
        organizationAggregationSource: {
          roleArn: `arn:aws:iam::${this.account}:role/ChimeraConfigAggregatorRole`,
          allAwsRegions: true
        }
      });
    }
  }
}
```

---

## Best Practices

### 1. Enable Config in All Regions

Even if you don't deploy to a region, enable Config to detect unauthorized resource creation:

```bash
# Enable Config in all regions via script
aws ec2 describe-regions --query 'Regions[].RegionName' --output text | \
while read region; do
  aws configservice put-configuration-recorder \
    --configuration-recorder name=default,roleARN=arn:aws:iam::123456789012:role/ConfigRole \
    --region $region
done
```

### 2. Use Aggregators for Multi-Account

One aggregator in management account > individual account queries:

```python
# Bad: Query each account individually
for account in accounts:
    config = boto3.client('config', region_name='us-east-1')
    # ... query each account

# Good: Single aggregated query
response = config.select_aggregate_resource_config(
    ConfigurationAggregatorName='chimera-org-aggregator',
    Expression="SELECT ..."
)
```

### 3. Tag Everything

Config queries are more powerful with consistent tagging:

```python
# Query by tag
response = config.select_resource_config(
    Expression="""
        SELECT resourceId, resourceType
        WHERE tags.Environment = 'production'
          AND tags.Project = 'chimera'
    """
)
```

### 4. Automate Remediation

Don't just detect non-compliance -- fix it:

```python
# Enable automatic remediation for all rules
for rule in config.describe_config_rules()['ConfigRules']:
    config.put_remediation_configuration(
        ConfigRuleName=rule['ConfigRuleName'],
        RemediationConfiguration={
            'Automatic': True,
            'MaximumAutomaticAttempts': 3
        }
    )
```

### 5. Monitor Config Service Health

Ensure Config is always recording:

```python
# Check recorder status
response = config.describe_configuration_recorder_status()
for recorder in response['ConfigurationRecordersStatus']:
    if not recorder['recording']:
        # Alert! Config has stopped recording
        sns.publish(
            TopicArn='arn:aws:sns:us-east-1:123456789012:chimera-alerts',
            Message=f"Config recorder {recorder['name']} is not recording!"
        )
```

---

## Limitations and Considerations

### 1. Resource Type Coverage

Not all AWS resources are supported:

- **Supported:** 300+ types (EC2, S3, Lambda, DynamoDB, RDS, etc.)
- **Not supported:** Some newer services, third-party resources
- **Check:** https://docs.aws.amazon.com/config/latest/developerguide/resource-config-reference.html

### 2. Eventual Consistency

Configuration changes are recorded within **minutes**, not instantly:

```
Resource created → 1-5 minutes → Appears in Config
```

For real-time needs, use **EventBridge** directly.

### 3. Query Limits

- **Max results:** 100 per query (use pagination)
- **Query complexity:** Complex joins are limited
- **Expression length:** 4096 characters max

### 4. Storage Costs

Configuration snapshots in S3 accumulate:

```
10,000 resources × 10 changes/month × 12 months = 1.2M items/year
Snapshot size: ~5KB per item = 6GB/year

S3 Standard: 6GB × $0.023/GB = $0.14/month
```

Use **lifecycle policies** to transition to Glacier or delete old data.

### 5. Cross-Region Latency

Aggregator queries across regions can take **10-30 seconds**.

---

## Key Takeaways

1. **AWS Config is the foundation for account-wide visibility.** It tracks every resource, every change, with complete history.

2. **Continuous recording mode** is critical for production compliance tracking. Daily mode is suitable only for dev/test.

3. **Aggregators are essential for multi-account organizations.** One centralized aggregator > querying individual accounts.

4. **Compliance rules + auto-remediation = self-healing infrastructure.** Detect drift and fix it automatically.

5. **SQL-based queries** provide flexible, powerful resource discovery without custom API pagination logic.

6. **Relationship tracking** enables dependency analysis, blast radius calculation, and intelligent orchestration.

7. **Integration with EventBridge** enables real-time reactions to configuration changes (vs batch processing).

8. **Cost optimization requires selective recording.** Track only what you need visibility into.

9. **S3 storage costs** can grow large over time. Implement lifecycle policies to archive or delete old snapshots.

10. **Chimera's resource discovery layer** should combine Config (comprehensive history), Resource Explorer (fast search), and CloudFormation (stack awareness) for complete account intelligence.

---

## Sources

### AWS Official Documentation
- [What is AWS Config?](https://docs.aws.amazon.com/config/latest/developerguide/WhatIsConfig.html)
- [How AWS Config Works](https://docs.aws.amazon.com/config/latest/developerguide/how-does-config-work.html)
- [Supported Resource Types](https://docs.aws.amazon.com/config/latest/developerguide/resource-config-reference.html)
- [AWS Config Pricing](https://aws.amazon.com/config/pricing/)
- [AWS Config FAQs](https://aws.amazon.com/config/faq/)
- [Multi-Account Multi-Region Data Aggregation](https://docs.aws.amazon.com/config/latest/developerguide/aggregate-data.html)
- [Advanced Queries with AWS Config](https://docs.aws.amazon.com/config/latest/developerguide/querying-AWS-resources.html)
- [Config Rules](https://docs.aws.amazon.com/config/latest/developerguide/evaluate-config.html)
- [Remediation Actions](https://docs.aws.amazon.com/config/latest/developerguide/remediation.html)

### AWS Blog Posts
- [Introducing Multi-Account Multi-Region Data Aggregation](https://aws.amazon.com/blogs/aws/aws-config-adds-support-for-multi-account-multi-region-data-aggregation/)
- [Query Your AWS Resource Configuration State](https://aws.amazon.com/blogs/aws/aws-config-update-query-your-configuration-state/)
- [Conformance Packs](https://aws.amazon.com/blogs/mt/introducing-aws-config-conformance-packs/)
- [AWS Config Integration with Security Hub](https://aws.amazon.com/blogs/security/how-to-use-aws-config-and-aws-security-hub-to-detect-and-remediate-compliance-drift/)

### AWS API Reference
- [AWS Config API Reference](https://docs.aws.amazon.com/config/latest/APIReference/Welcome.html)
- [SelectResourceConfig](https://docs.aws.amazon.com/config/latest/APIReference/API_SelectResourceConfig.html)
- [SelectAggregateResourceConfig](https://docs.aws.amazon.com/config/latest/APIReference/API_SelectAggregateResourceConfig.html)

### GitHub
- [AWS Config Rules Repository](https://github.com/awslabs/aws-config-rules)
- [AWS Config RDK (Rule Development Kit)](https://github.com/awslabs/aws-config-rdk)

