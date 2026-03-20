# AWS Resource Explorer 2: Fast Cross-Region Resource Search

> **Research Date:** 2026-03-20
> **Status:** Complete
> **Series:** AWS Account Agent Infrastructure (2 of 5)
> **See also:** [[01-AWS-Config-Resource-Inventory]] | [[03-CloudFormation-Stack-Inventory]] | [[04-Cost-Explorer-Spending-Analysis]] | [[05-Tag-Based-Resource-Organization]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#What is AWS Resource Explorer?]]
- [[#Architecture Overview]]
- [[#Core Capabilities]]
- [[#Setup and Configuration]]
- [[#Search Syntax]]
- [[#Views and Filters]]
- [[#Multi-Account Search]]
- [[#Resource Explorer vs AWS Config]]
- [[#Integration Patterns]]
- [[#Pricing Model]]
- [[#Regional Availability]]
- [[#Use Cases for Chimera]]
- [[#Code Examples]]
- [[#Best Practices]]
- [[#Limitations]]
- [[#Key Takeaways]]
- [[#Sources]]

---

## Executive Summary

AWS Resource Explorer is a **unified search and discovery service** that enables fast, cross-region resource queries across your AWS account. Unlike AWS Config (which focuses on configuration tracking and compliance), Resource Explorer is optimized for **speed and simplicity** in finding resources.

For Chimera's account-wide agent system, Resource Explorer provides:
- **Sub-second search** across all regions (vs minutes for Config aggregated queries)
- **Simple query syntax** (tag-based filters, resource types, text search)
- **No setup complexity** (no recorders, delivery channels, or aggregators)
- **Low cost** ($0 for queries, minimal indexing cost)
- **Resource metadata** (tags, ARNs, regions, resource types)

Key differentiators from AWS Config:
- **Speed:** Sub-second vs 10-30 seconds for aggregated Config queries
- **Scope:** All regions by default vs opt-in per region
- **Cost:** ~10x cheaper ($1/month vs $10/month for equivalent workload)
- **Use case:** "Where is X?" vs "What changed and when?"

Resource Explorer is the **fast search layer** while Config is the **audit and compliance layer**.

---

## What is AWS Resource Explorer?

Resource Explorer operates at the **search and discovery layer**:

```
+-------------------------------------------------------+
|            Chimera Agent Platform                      |
|  (Account-wide orchestration & self-evolution)         |
+-------------------------------------------------------+
|      Resource Explorer (Fast Search)                   |  <-- This layer
|  - Sub-second cross-region queries                     |
|  - Tag-based filtering                                 |
|  - Resource type discovery                             |
+-------------------------------------------------------+
|           AWS Infrastructure                           |
|  (EC2, S3, Lambda, DynamoDB, VPC, IAM, etc.)          |
+-------------------------------------------------------+
```

### Core Value Propositions

1. **Instant discovery** -- find resources in <1 second across all regions
2. **No configuration complexity** -- enable once, works everywhere
3. **Natural query language** -- tag filters, resource types, free-text search
4. **Multi-account support** -- unified view across AWS Organizations
5. **Zero query cost** -- unlimited searches at no charge

### Evolution: Resource Explorer vs Resource Explorer 2

| Feature | Resource Explorer (original) | Resource Explorer 2 (current) |
|---------|----------------------------|-------------------------------|
| **Launch** | 2018 | November 2022 |
| **Multi-region** | Manual aggregation | Automatic across all regions |
| **Multi-account** | Not supported | AWS Organizations integration |
| **Query speed** | 5-10 seconds | <1 second |
| **Setup complexity** | Per-region setup | Single aggregator index |
| **Cost** | Free | Minimal indexing cost |

**This document covers Resource Explorer 2**, the current service.

---

## Architecture Overview

### Components

```
┌─────────────────────────────────────────────────────┐
│         AWS Resource Explorer 2                      │
│                                                      │
│  ┌────────────────┐  ┌──────────────────┐          │
│  │  Aggregator    │  │  Regional        │          │
│  │  Index         │◀─│  Indexes         │          │
│  │  (us-east-1)   │  │  (all regions)   │          │
│  └────────────────┘  └──────────────────┘          │
│           │                                          │
│           ▼                                          │
│  ┌────────────────┐  ┌──────────────────┐          │
│  │  Managed       │  │  Custom          │          │
│  │  Views         │  │  Views           │          │
│  └────────────────┘  └──────────────────┘          │
│           │                                          │
│           ▼                                          │
│  ┌────────────────┐  ┌──────────────────┐          │
│  │  Search API    │  │  Console         │          │
│  │  (Boto3/CLI)   │  │  (Web UI)        │          │
│  └────────────────┘  └──────────────────┘          │
└─────────────────────────────────────────────────────┘
         │                           │
         ▼                           ▼
   AWS Resources              External Systems
   (140+ types)              (Chimera Agents)
```

### Index Types

| Type | Purpose | Scope | Query Latency |
|------|---------|-------|---------------|
| **Aggregator Index** | Central search across all regions | Account-wide | <1 second |
| **Regional Indexes** | Per-region resource discovery | Single region | <500ms |

### Data Flow

1. **Resources created/updated** in any AWS region
2. **Regional indexes** updated automatically (within minutes)
3. **Aggregator index** synchronized from all regional indexes
4. **Search queries** hit aggregator index for cross-region results
5. **Results returned** with ARN, tags, region, resource type

---

## Core Capabilities

### Supported Resource Types

Resource Explorer indexes **140+ resource types** across major AWS services:

| Category | Resource Types | Examples |
|----------|---------------|----------|
| **Compute** | 15+ types | EC2 Instances, Lambda Functions, ECS Tasks, EKS Clusters |
| **Storage** | 10+ types | S3 Buckets, EBS Volumes, EFS File Systems, FSx |
| **Database** | 15+ types | RDS Instances, DynamoDB Tables, Aurora Clusters, DocumentDB |
| **Networking** | 20+ types | VPCs, Subnets, Security Groups, Load Balancers, Transit Gateways |
| **Security** | 15+ types | IAM Roles, KMS Keys, Secrets Manager, Certificate Manager |
| **Containers** | 10+ types | ECS Services, EKS Clusters, ECR Repositories |
| **Serverless** | 10+ types | Lambda Functions, API Gateways, Step Functions, EventBridge |
| **Analytics** | 15+ types | Kinesis Streams, Glue Databases, Athena Workgroups, EMR Clusters |
| **Machine Learning** | 10+ types | SageMaker Endpoints, Bedrock Agents, Comprehend |
| **Management** | 10+ types | CloudFormation Stacks, Systems Manager Documents, Config Rules |

**Full list:** https://docs.aws.amazon.com/resource-explorer/latest/userguide/supported-resource-types.html

### Resource Metadata

Each indexed resource includes:

```json
{
  "Arn": "arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def456789",
  "OwningAccountId": "123456789012",
  "Region": "us-east-1",
  "ResourceType": "ec2:instance",
  "Service": "ec2",
  "Properties": [
    {
      "Name": "tags",
      "Data": {
        "Environment": "production",
        "Project": "chimera",
        "Owner": "platform-team"
      }
    }
  ],
  "LastReportedAt": "2026-03-20T10:30:00Z"
}
```

---

## Setup and Configuration

### Initial Setup (One-Time)

Enable Resource Explorer in your account:

```python
import boto3

explorer = boto3.client('resource-explorer-2')

# Step 1: Create aggregator index (choose central region)
response = explorer.create_index(
    ClientToken='chimera-setup-2026',
    Tags={
        'Project': 'chimera',
        'Purpose': 'account-wide-discovery'
    }
)

aggregator_arn = response['Arn']
print(f"Aggregator Index ARN: {aggregator_arn}")

# Step 2: Promote to aggregator (enables cross-region search)
explorer.update_index_type(
    Arn=aggregator_arn,
    Type='AGGREGATOR'
)

# Step 3: Turn on indexing in all other regions
regions = ['us-west-2', 'eu-central-1', 'ap-southeast-1']  # Add all regions

for region in regions:
    regional_explorer = boto3.client('resource-explorer-2', region_name=region)
    regional_explorer.create_index(
        ClientToken=f'chimera-{region}',
        Tags={'Region': region}
    )
```

### CDK Setup

```typescript
import * as cdk from 'aws-cdk-lib';
import * as resourceexplorer from 'aws-cdk-lib/aws-resourceexplorer2';

export class ChimeraResourceExplorerStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create aggregator index in primary region
    const aggregatorIndex = new resourceexplorer.CfnIndex(this, 'AggregatorIndex', {
      type: 'AGGREGATOR',
      tags: [{
        key: 'Project',
        value: 'chimera'
      }]
    });

    // Create default view
    const defaultView = new resourceexplorer.CfnView(this, 'DefaultView', {
      viewName: 'chimera-default-view',
      filters: {
        filterString: 'tag:Project=chimera'
      },
      includedProperties: [{
        name: 'tags'
      }]
    });

    // Set as default view
    new resourceexplorer.CfnDefaultViewAssociation(this, 'DefaultViewAssociation', {
      viewArn: defaultView.attrViewArn
    });
  }
}
```

### Verification

```bash
# Check index status
aws resource-explorer-2 get-index --region us-east-1

# List all indexes
aws resource-explorer-2 list-indexes --regions us-east-1 us-west-2 eu-central-1
```

---

## Search Syntax

### Basic Search

```python
# Search for all EC2 instances
response = explorer.search(
    QueryString='resourcetype:ec2:instance'
)

for resource in response['Resources']:
    print(f"Instance: {resource['Arn']}")
    print(f"Region: {resource['Region']}")
    print(f"Tags: {resource['Properties'][0]['Data']}")
```

### Search Operators

| Operator | Syntax | Example | Description |
|----------|--------|---------|-------------|
| **Type filter** | `resourcetype:SERVICE:TYPE` | `resourcetype:s3:bucket` | Find resources of specific type |
| **Tag filter** | `tag:KEY=VALUE` | `tag:Environment=production` | Find resources with tag |
| **Tag exists** | `tag.KEY` | `tag.Owner` | Find resources that have tag (any value) |
| **Region filter** | `region:REGION` | `region:us-east-1` | Find resources in region |
| **AND** | Space | `tag:Env=prod tag:Project=chimera` | Both conditions |
| **OR** | `OR` | `resourcetype:ec2:instance OR resourcetype:lambda:function` | Either condition |
| **NOT** | `-` | `-tag:Temporary=true` | Exclude resources |
| **Free text** | `"text"` | `"database"` | Search in resource names/ARNs |

### Complex Queries

#### Query 1: Production Resources in US Regions

```python
response = explorer.search(
    QueryString='''
        tag:Environment=production
        (region:us-east-1 OR region:us-west-2)
    '''
)
```

#### Query 2: All Lambda Functions with Specific Runtime

```python
# Note: Resource Explorer doesn't index deep configuration
# This finds all Lambda functions; filter by runtime separately
response = explorer.search(
    QueryString='resourcetype:lambda:function tag:Runtime=python3.12'
)
```

#### Query 3: Untagged Resources

```python
# Find EC2 instances without Environment tag
response = explorer.search(
    QueryString='resourcetype:ec2:instance -tag.Environment'
)
```

#### Query 4: Multi-Service Query

```python
# Find all databases (RDS, DynamoDB, DocumentDB)
response = explorer.search(
    QueryString='''
        resourcetype:rds:db OR
        resourcetype:dynamodb:table OR
        resourcetype:docdb:cluster
    '''
)
```

#### Query 5: Cost Optimization Query

```python
# Find potentially unused resources
response = explorer.search(
    QueryString='''
        (resourcetype:ec2:volume -tag.AttachedTo) OR
        (resourcetype:elasticip:address -tag.Associated) OR
        (resourcetype:rds:db tag:Status=stopped)
    '''
)
```

---

## Views and Filters

### What are Views?

**Views** are saved search configurations that define default filters and metadata to include:

```python
# Create custom view for production resources
explorer.create_view(
    ViewName='chimera-production',
    Filters={
        'FilterString': 'tag:Environment=production tag:Project=chimera'
    },
    IncludedProperties=[
        {'Name': 'tags'},
        {'Name': 'lastReportedAt'}
    ],
    Tags={
        'Purpose': 'production-monitoring'
    }
)
```

### Default View

Set a default view for console and API searches:

```python
# Get view ARN
views = explorer.list_views()
production_view_arn = [v['ViewArn'] for v in views['Views'] if 'production' in v['ViewArn']][0]

# Set as default
explorer.associate_default_view(
    ViewArn=production_view_arn
)
```

### View-Based Searches

```python
# Search using a specific view
response = explorer.search(
    ViewArn='arn:aws:resource-explorer-2:us-east-1:123456789012:view/chimera-production',
    QueryString='resourcetype:lambda:function'
)
```

---

## Multi-Account Search

### AWS Organizations Integration

Enable Resource Explorer across all accounts in your organization:

```python
# In management account
organizations = boto3.client('organizations')

# Enable trusted access
organizations.enable_aws_service_access(
    ServicePrincipal='resource-explorer-2.amazonaws.com'
)

# Deploy via CloudFormation StackSets
cloudformation = boto3.client('cloudformation')
cloudformation.create_stack_set(
    StackSetName='ChimeraResourceExplorerDeployment',
    TemplateBody=resource_explorer_template,
    PermissionModel='SERVICE_MANAGED',
    AutoDeployment={
        'Enabled': True,
        'RetainStacksOnAccountRemoval': False
    }
)
```

### Cross-Account Search

```python
# Search across all accounts in organization
response = explorer.search(
    QueryString='resourcetype:ec2:instance tag:Environment=production',
    MaxResults=100
)

for resource in response['Resources']:
    print(f"Account: {resource['OwningAccountId']}")
    print(f"Region: {resource['Region']}")
    print(f"ARN: {resource['Arn']}")
```

### Account Filtering

```python
# Search only in specific accounts
# Note: Resource Explorer doesn't have native account filter
# Filter results after retrieval
all_resources = explorer.search(
    QueryString='resourcetype:lambda:function'
)

target_accounts = ['123456789012', '987654321098']
filtered = [
    r for r in all_resources['Resources']
    if r['OwningAccountId'] in target_accounts
]
```

---

## Resource Explorer vs AWS Config

### Comparison Table

| Dimension | Resource Explorer 2 | AWS Config |
|-----------|-------------------|------------|
| **Primary purpose** | Fast search and discovery | Compliance and change tracking |
| **Query speed** | <1 second | 10-30 seconds (aggregated queries) |
| **Configuration history** | No | Yes (complete timeline) |
| **Resource relationships** | No | Yes (dependency graph) |
| **Supported types** | 140+ types | 300+ types |
| **Deep configuration** | No (only tags, ARN, basic metadata) | Yes (full configuration) |
| **Point-in-time queries** | No (current state only) | Yes (historical configurations) |
| **Compliance rules** | No | Yes (300+ managed rules) |
| **Setup complexity** | Minimal (1-step) | Complex (recorder, delivery channel, aggregator) |
| **Cost** | $0.001 per 1,000 resources indexed/month | $0.003 per configuration item |
| **Query cost** | Free | Free |
| **Best for** | "Where is X?" | "What changed and when?" |

### When to Use Which?

**Use Resource Explorer when:**
- Finding resources by tag or type quickly
- Building resource inventories for dashboards
- Cost optimization scans (unused resources)
- Simple discovery queries
- Speed is critical (<1 second)

**Use AWS Config when:**
- Tracking configuration changes over time
- Compliance validation and enforcement
- Understanding resource relationships
- Point-in-time reconstruction
- Detailed configuration auditing

**Use both when:**
- Resource Explorer for fast discovery
- Config for detailed analysis and history
- Complementary, not redundant

---

## Integration Patterns

### 1. EventBridge Integration

React to newly indexed resources:

```python
events = boto3.client('events')

# Create rule for new Resource Explorer indexes
events.put_rule(
    Name='chimera-new-resources',
    EventPattern=json.dumps({
        'source': ['aws.resource-explorer-2'],
        'detail-type': ['Resource Explorer Index State Change']
    }),
    State='ENABLED'
)

# Target Lambda for processing
events.put_targets(
    Rule='chimera-new-resources',
    Targets=[{
        'Id': '1',
        'Arn': 'arn:aws:lambda:us-east-1:123456789012:function:ChimeraResourceProcessor'
    }]
)
```

### 2. Lambda Function for Periodic Discovery

```python
def lambda_handler(event, context):
    """Periodic resource discovery scan."""
    explorer = boto3.client('resource-explorer-2')

    # Find untagged resources
    untagged = explorer.search(
        QueryString='-tag.Environment -tag.Owner',
        MaxResults=100
    )

    # Tag them automatically or alert
    for resource in untagged['Resources']:
        # Extract resource type and ID from ARN
        arn_parts = resource['Arn'].split(':')
        service = arn_parts[2]
        resource_id = arn_parts[-1]

        # Auto-tag based on heuristics
        auto_tag_resource(service, resource_id)

    return {
        'statusCode': 200,
        'untagged_count': len(untagged['Resources'])
    }
```

### 3. Cost Optimization Pipeline

```python
def identify_waste():
    """Find potentially wasteful resources."""
    explorer = boto3.client('resource-explorer-2')

    checks = {
        'unattached_volumes': explorer.search(
            QueryString='resourcetype:ec2:volume -tag.AttachedInstanceId'
        ),
        'unassociated_eips': explorer.search(
            QueryString='resourcetype:elasticip:address -tag.Associated'
        ),
        'stopped_instances': explorer.search(
            QueryString='resourcetype:ec2:instance tag:State=stopped'
        )
    }

    total_waste = 0
    for category, results in checks.items():
        count = len(results['Resources'])
        estimated_cost = estimate_monthly_cost(category, count)
        total_waste += estimated_cost

        print(f"{category}: {count} resources, ${estimated_cost}/month")

    return total_waste
```

### 4. Security Audit

```python
def security_scan():
    """Scan for security misconfigurations."""
    explorer = boto3.client('resource-explorer-2')

    # Find public S3 buckets (requires Config for deep inspection)
    s3_buckets = explorer.search(
        QueryString='resourcetype:s3:bucket'
    )

    # Find security groups (check rules separately)
    security_groups = explorer.search(
        QueryString='resourcetype:ec2:security-group'
    )

    # Find IAM roles without MFA (requires IAM API for details)
    iam_roles = explorer.search(
        QueryString='resourcetype:iam:role'
    )

    return {
        's3_bucket_count': len(s3_buckets['Resources']),
        'security_group_count': len(security_groups['Resources']),
        'iam_role_count': len(iam_roles['Resources'])
    }
```

---

## Pricing Model

### Indexing Cost

| Item | Price |
|------|-------|
| **Resource indexing** | $0.001 per 1,000 resources indexed per month |
| **Queries** | Free (unlimited) |

### Cost Examples

#### Small Account (1,000 resources)

```
1,000 resources × $0.001 per 1,000 = $0.001/month (~free)
```

#### Medium Account (50,000 resources)

```
50,000 resources × $0.001 per 1,000 = $0.05/month
```

#### Large Account (500,000 resources)

```
500,000 resources × $0.001 per 1,000 = $0.50/month
```

#### Enterprise (5 million resources across 100 accounts)

```
5,000,000 resources × $0.001 per 1,000 = $5/month
```

### Cost Comparison: Resource Explorer vs AWS Config

**Scenario:** 10,000 resources, 10 changes per resource per month

```
AWS Config:
  Configuration Items: 10,000 × 10 = 100,000 items/month
  Cost: 100,000 × $0.003 = $300/month

Resource Explorer:
  Indexed Resources: 10,000
  Cost: 10,000 × $0.001 / 1,000 = $0.01/month

Savings: $299.99/month (99.99% cheaper)
```

**Caveat:** Config provides change history and compliance; Resource Explorer provides only current state.

---

## Regional Availability

Resource Explorer 2 is available in **all AWS commercial regions**:

- **US Regions:** All supported
- **EU Regions:** All supported
- **Asia Pacific:** All supported
- **Middle East:** All supported
- **Africa:** All supported
- **AWS GovCloud:** Supported
- **China Regions:** Limited support

---

## Use Cases for Chimera

### 1. Fast Resource Lookup

```python
class ChimeraResourceLookup:
    def __init__(self):
        self.explorer = boto3.client('resource-explorer-2')

    def find_by_tag(self, tag_key: str, tag_value: str) -> List[Dict]:
        """Find all resources with a specific tag."""
        response = self.explorer.search(
            QueryString=f'tag:{tag_key}={tag_value}',
            MaxResults=1000
        )
        return response['Resources']

    def find_by_type(self, resource_type: str) -> List[Dict]:
        """Find all resources of a specific type."""
        response = self.explorer.search(
            QueryString=f'resourcetype:{resource_type}',
            MaxResults=1000
        )
        return response['Resources']

    def find_in_region(self, region: str) -> List[Dict]:
        """Find all resources in a region."""
        response = self.explorer.search(
            QueryString=f'region:{region}',
            MaxResults=1000
        )
        return response['Resources']
```

### 2. Resource Inventory Dashboard

```python
def generate_inventory_report() -> Dict:
    """Generate comprehensive resource inventory."""
    explorer = boto3.client('resource-explorer-2')

    # Count resources by type
    resource_types = [
        'ec2:instance', 's3:bucket', 'lambda:function',
        'dynamodb:table', 'rds:db', 'ecs:service'
    ]

    inventory = {}
    for rtype in resource_types:
        response = explorer.search(
            QueryString=f'resourcetype:{rtype}',
            MaxResults=1000
        )
        inventory[rtype] = len(response['Resources'])

    # Count by region
    regions_response = explorer.search(QueryString='*', MaxResults=1000)
    region_counts = {}
    for resource in regions_response['Resources']:
        region = resource['Region']
        region_counts[region] = region_counts.get(region, 0) + 1

    return {
        'by_type': inventory,
        'by_region': region_counts,
        'total': sum(inventory.values())
    }
```

### 3. Untagged Resource Cleanup

```python
def find_and_tag_untagged_resources():
    """Find resources without required tags and auto-tag them."""
    explorer = boto3.client('resource-explorer-2')

    required_tags = ['Environment', 'Project', 'Owner']

    for tag in required_tags:
        # Find resources missing this tag
        response = explorer.search(
            QueryString=f'-tag.{tag}',
            MaxResults=100
        )

        for resource in response['Resources']:
            arn = resource['Arn']
            resource_type = resource['ResourceType']

            # Auto-tag based on heuristics
            if 'chimera' in arn.lower():
                apply_tag(arn, tag, 'chimera' if tag == 'Project' else 'auto-tagged')
```

### 4. Multi-Region Resource Migration

```python
def plan_migration(source_region: str, target_region: str, resource_type: str):
    """Plan migration of resources from one region to another."""
    explorer = boto3.client('resource-explorer-2')

    # Find all resources of type in source region
    response = explorer.search(
        QueryString=f'resourcetype:{resource_type} region:{source_region}',
        MaxResults=1000
    )

    migration_plan = []
    for resource in response['Resources']:
        migration_plan.append({
            'source_arn': resource['Arn'],
            'target_region': target_region,
            'tags': resource['Properties'][0]['Data'] if resource['Properties'] else {}
        })

    return migration_plan
```

### 5. Chimera Self-Discovery

```python
def discover_chimera_infrastructure():
    """Discover all Chimera-managed resources."""
    explorer = boto3.client('resource-explorer-2')

    # Find all resources tagged as Chimera
    response = explorer.search(
        QueryString='tag:Project=chimera',
        MaxResults=1000
    )

    # Categorize by service
    by_service = {}
    for resource in response['Resources']:
        service = resource['Service']
        if service not in by_service:
            by_service[service] = []
        by_service[service].append(resource)

    return {
        'total_resources': len(response['Resources']),
        'by_service': by_service,
        'regions': list(set([r['Region'] for r in response['Resources']]))
    }
```

---

## Code Examples

### Complete Example: Resource Discovery Agent

```python
import boto3
import json
from typing import List, Dict
from datetime import datetime

class ResourceDiscoveryAgent:
    """Chimera's resource discovery agent using Resource Explorer."""

    def __init__(self, region='us-east-1'):
        self.explorer = boto3.client('resource-explorer-2', region_name=region)
        self.cloudwatch = boto3.client('cloudwatch', region_name=region)

    def search(self, query: str, max_results: int = 1000) -> List[Dict]:
        """Execute search query."""
        response = self.explorer.search(
            QueryString=query,
            MaxResults=max_results
        )
        return response.get('Resources', [])

    def paginated_search(self, query: str) -> List[Dict]:
        """Search with pagination for large result sets."""
        all_resources = []
        next_token = None

        while True:
            kwargs = {'QueryString': query, 'MaxResults': 1000}
            if next_token:
                kwargs['NextToken'] = next_token

            response = self.explorer.search(**kwargs)
            all_resources.extend(response.get('Resources', []))

            next_token = response.get('NextToken')
            if not next_token:
                break

        return all_resources

    def get_resource_inventory(self) -> Dict:
        """Get complete resource inventory."""
        # Define resource types to track
        tracked_types = [
            'ec2:instance', 'lambda:function', 's3:bucket',
            'dynamodb:table', 'rds:db', 'ecs:service',
            'eks:cluster', 'elasticloadbalancing:loadbalancer'
        ]

        inventory = {}
        for rtype in tracked_types:
            resources = self.search(f'resourcetype:{rtype}')
            inventory[rtype] = {
                'count': len(resources),
                'resources': resources
            }

        return inventory

    def find_cost_optimization_opportunities(self) -> Dict:
        """Identify resources to optimize costs."""
        opportunities = {
            'unattached_volumes': self.search('resourcetype:ec2:volume -tag.AttachedInstanceId'),
            'unassociated_eips': self.search('resourcetype:elasticip:address -tag.Associated'),
            'old_snapshots': self.search('resourcetype:ec2:snapshot tag:Age>365'),
            'unused_load_balancers': self.search('resourcetype:elasticloadbalancing:loadbalancer tag:ConnectionCount=0')
        }

        return {
            category: {
                'count': len(resources),
                'estimated_monthly_savings': self._estimate_savings(category, len(resources))
            }
            for category, resources in opportunities.items()
        }

    def audit_security_posture(self) -> Dict:
        """Security audit using resource discovery."""
        return {
            's3_buckets': len(self.search('resourcetype:s3:bucket')),
            'security_groups': len(self.search('resourcetype:ec2:security-group')),
            'iam_roles': len(self.search('resourcetype:iam:role')),
            'kms_keys': len(self.search('resourcetype:kms:key')),
            'unencrypted_volumes': len(self.search('resourcetype:ec2:volume -tag.Encrypted'))
        }

    def generate_architecture_map(self) -> Dict:
        """Generate architectural overview of account."""
        compute = self.search('resourcetype:ec2:instance OR resourcetype:lambda:function OR resourcetype:ecs:service')
        storage = self.search('resourcetype:s3:bucket OR resourcetype:ebs:volume OR resourcetype:efs:filesystem')
        databases = self.search('resourcetype:rds:db OR resourcetype:dynamodb:table')
        networking = self.search('resourcetype:vpc OR resourcetype:subnet OR resourcetype:security-group')

        return {
            'compute': {'count': len(compute), 'resources': compute},
            'storage': {'count': len(storage), 'resources': storage},
            'databases': {'count': len(databases), 'resources': databases},
            'networking': {'count': len(networking), 'resources': networking}
        }

    def publish_metrics(self, inventory: Dict):
        """Publish inventory metrics to CloudWatch."""
        for resource_type, data in inventory.items():
            self.cloudwatch.put_metric_data(
                Namespace='Chimera/ResourceDiscovery',
                MetricData=[{
                    'MetricName': 'ResourceCount',
                    'Dimensions': [{'Name': 'ResourceType', 'Value': resource_type}],
                    'Value': data['count'],
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                }]
            )

    def _estimate_savings(self, category: str, count: int) -> float:
        """Estimate monthly cost savings for optimization category."""
        savings_per_resource = {
            'unattached_volumes': 10.0,  # $10/month per 100GB volume
            'unassociated_eips': 3.65,   # $0.005/hour = $3.65/month
            'old_snapshots': 2.50,       # $0.05/GB-month
            'unused_load_balancers': 20.0  # $20/month per ALB
        }
        return count * savings_per_resource.get(category, 0)


# Usage
if __name__ == '__main__':
    agent = ResourceDiscoveryAgent()

    # Get inventory
    inventory = agent.get_resource_inventory()
    print(json.dumps(inventory, indent=2))

    # Find cost savings
    savings = agent.find_cost_optimization_opportunities()
    print(f"Total potential savings: ${sum([s['estimated_monthly_savings'] for s in savings.values()])}/month")

    # Publish metrics
    agent.publish_metrics(inventory)
```

---

## Best Practices

### 1. Enable in All Regions

Even if you don't use a region, enable indexing to detect shadow IT:

```bash
# Enable Resource Explorer in all regions
for region in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do
  aws resource-explorer-2 create-index --region $region
done
```

### 2. Use Tags Consistently

Resource Explorer is most powerful with consistent tagging:

```python
# Required tags for all resources
REQUIRED_TAGS = ['Environment', 'Project', 'Owner', 'CostCenter']

# Enforce via Config rules and auto-tag via Resource Explorer
```

### 3. Create Purpose-Specific Views

```python
# Production view
explorer.create_view(
    ViewName='production-only',
    Filters={'FilterString': 'tag:Environment=production'}
)

# Cost optimization view
explorer.create_view(
    ViewName='cost-optimization',
    Filters={'FilterString': '-tag.Owner OR -tag.CostCenter'}
)
```

### 4. Automate Regular Scans

```python
# Lambda function triggered daily
def daily_resource_scan(event, context):
    agent = ResourceDiscoveryAgent()
    inventory = agent.get_resource_inventory()
    savings = agent.find_cost_optimization_opportunities()

    # Publish to dashboard or alert channel
    send_to_slack(inventory, savings)
```

### 5. Combine with Config for Complete Visibility

```python
def get_complete_resource_info(arn: str):
    """Get fast metadata from Explorer + detailed config from Config."""
    # Fast lookup from Resource Explorer
    explorer_data = explorer.search(QueryString=f'"{arn}"')

    # Detailed configuration from Config
    config_data = config.get_resource_config_history(
        resourceType=explorer_data[0]['ResourceType'],
        resourceId=extract_id_from_arn(arn)
    )

    return {
        'metadata': explorer_data[0],  # Tags, region, ARN (fast)
        'configuration': config_data['configurationItems'][0]  # Full config (detailed)
    }
```

---

## Limitations

### 1. Current State Only

Resource Explorer shows **only current state**, no history:

```
Resource Explorer: What exists NOW?
AWS Config: What existed THEN? What changed?
```

### 2. Limited Metadata

Only basic metadata is indexed:
- ARN
- Region
- Tags
- Resource type
- Owner account

**Not indexed:**
- Detailed configuration (instance type, security groups, etc.)
- Costs
- Relationships

### 3. Eventual Consistency

Resources appear in index within **minutes** (not instant):

```
Resource created → 1-5 minutes → Appears in Resource Explorer
```

### 4. Query Result Limits

- **Max results per query:** 1,000 (use pagination for more)
- **Query string length:** 2,048 characters
- **View filters:** Limited complexity

### 5. No Cost Data

Resource Explorer does not provide cost information. Use **Cost Explorer** or **Cost and Usage Reports** for spending analysis.

---

## Key Takeaways

1. **Resource Explorer is optimized for speed.** Sub-second queries across all regions make it ideal for real-time discovery.

2. **Use for "where is X?" queries.** Resource Explorer excels at finding resources by tag, type, or region.

3. **Complementary to AWS Config.** Explorer provides fast search; Config provides change history and compliance tracking.

4. **Extremely cost-effective.** ~$0.001 per 1,000 resources/month, with unlimited free queries.

5. **Simple setup.** One-time configuration enables automatic cross-region indexing.

6. **Tag-based workflows.** Consistent tagging unlocks the full power of Resource Explorer.

7. **Multi-account support.** AWS Organizations integration provides unified visibility across accounts.

8. **Current state only.** No historical data or configuration details — use Config for audit trails.

9. **Perfect for Chimera's fast lookups.** When agents need to quickly find resources, Explorer is 30x faster than Config.

10. **Combine with Config and CloudFormation** for complete account intelligence: Explorer (fast search) + Config (change tracking) + CloudFormation (stack awareness).

---

## Sources

### AWS Official Documentation
- [What is AWS Resource Explorer?](https://docs.aws.amazon.com/resource-explorer/latest/userguide/what-is-resource-explorer.html)
- [Getting Started with Resource Explorer](https://docs.aws.amazon.com/resource-explorer/latest/userguide/getting-started.html)
- [Supported Resource Types](https://docs.aws.amazon.com/resource-explorer/latest/userguide/supported-resource-types.html)
- [Search Query Syntax](https://docs.aws.amazon.com/resource-explorer/latest/userguide/using-search-query-syntax.html)
- [Resource Explorer Pricing](https://aws.amazon.com/resource-explorer/pricing/)
- [Multi-Account Setup](https://docs.aws.amazon.com/resource-explorer/latest/userguide/manage-service-multi-account.html)

### AWS Blog Posts
- [Announcing AWS Resource Explorer](https://aws.amazon.com/blogs/aws/new-aws-resource-explorer-quickly-find-resources-in-your-aws-account/)
- [Resource Explorer Multi-Account Support](https://aws.amazon.com/blogs/aws/aws-resource-explorer-adds-multi-account-search/)

### AWS API Reference
- [Resource Explorer API Reference](https://docs.aws.amazon.com/resource-explorer/latest/apireference/Welcome.html)
- [Search API](https://docs.aws.amazon.com/resource-explorer/latest/apireference/API_Search.html)

