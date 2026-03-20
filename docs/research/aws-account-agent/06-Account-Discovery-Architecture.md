---
title: "Account Discovery Architecture: Living AWS Infrastructure Map"
version: 1.0.0
status: research
last_updated: 2026-03-20
context: "AWS account-wide discovery - Unified architecture synthesis"
supersedes: []
---

# Account Discovery Architecture: Living AWS Infrastructure Map

## Vision

Chimera agents operate with **omniscient awareness** of their AWS environment. When a user asks "What's running in my account?" or "Why did my costs spike?", the agent doesn't guess — it **knows**:

- **Inventory**: Every resource across all regions (EC2, RDS, Lambda, S3, DynamoDB, etc.)
- **Relationships**: How resources connect (ALB → ECS → RDS, Lambda → DynamoDB)
- **Provenance**: How resources were created (CloudFormation, Terraform, Console)
- **Cost**: Real-time spending per resource, service, team, project
- **Health**: Resource status, compliance posture, drift detection
- **Context**: Tags mapping resources to business entities (teams, projects, environments)

This isn't a periodic scan or manual inventory — it's a **living architecture diagram** maintained in real-time through AWS native services.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CHIMERA AGENT                               │
│                     (Omniscient AWS Awareness)                      │
└────────────┬────────────────────────────────────────────────────────┘
             │
             │ "What resources exist in production?"
             │ "Show me all databases in us-east-1"
             │ "Why did Lambda costs spike 40%?"
             │ "What changed in the last 24 hours?"
             │
             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  UNIFIED DISCOVERY LAYER                            │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │  Query Engine  │  │  Cache Layer │  │  Relationship Graph    │  │
│  │   (GraphQL)    │  │  (DynamoDB)  │  │   (Neptune/DynamoDB)   │  │
│  └────────────────┘  └──────────────┘  └────────────────────────┘  │
└───────────┬──────────────────┬────────────────────┬─────────────────┘
            │                  │                    │
            │                  │                    │
    ┌───────▼──────┐   ┌───────▼─────────┐   ┌────▼──────────────┐
    │  AWS Config  │   │ Resource        │   │  Cost Explorer    │
    │  Aggregator  │   │ Explorer 2      │   │  API              │
    │              │   │                 │   │                   │
    │ • Inventory  │   │ • Cross-region  │   │ • Spending data   │
    │ • Changes    │   │   search        │   │ • Forecasting     │
    │ • Compliance │   │ • Tag-based     │   │ • Tag allocation  │
    │ • Drift      │   │   queries       │   │ • Anomalies       │
    └──────────────┘   └─────────────────┘   └───────────────────┘
            │                  │                    │
            │                  │                    │
    ┌───────▼──────────────────▼────────────────────▼──────────────┐
    │              AWS MULTI-REGION ACCOUNT                         │
    │  us-east-1  │  us-west-2  │  eu-west-1  │  ap-southeast-1   │
    │                                                               │
    │  EC2, RDS, Lambda, S3, DynamoDB, ECS, CloudFormation, etc.  │
    └───────────────────────────────────────────────────────────────┘
```

### Five Pillars of Discovery

| Service | Purpose | Update Latency | Retention | Cost |
|---------|---------|----------------|-----------|------|
| **AWS Config** | Resource inventory, compliance, change tracking, relationships | 5-15 minutes | Configurable (90d-7y) | ~$0.003/config item |
| **Resource Explorer 2** | Cross-region search, tag-based queries, instant discovery | Real-time | N/A (index only) | Free |
| **CloudFormation** | Stack inventory, managed resources, drift detection | Real-time | Unlimited | Free |
| **Cost Explorer** | Spending analysis, forecasting, tag-based attribution | Daily (24h lag) | 13 months | Free (API: $0.01/request) |
| **Tag-based Organization** | Business context mapping, cost allocation, access control | Real-time | N/A | Free |

## Component Deep Dive

### 1. AWS Config: Configuration History and Compliance

**Role:** Authoritative source of truth for resource configurations, changes, and relationships.

#### What Config Tracks

```python
# Config records every resource change as a Configuration Item (CI)
{
  "configurationItemCaptureTime": "2026-03-20T16:45:00Z",
  "resourceType": "AWS::DynamoDB::Table",
  "resourceId": "chimera-sessions",
  "configurationItemStatus": "OK",
  "arn": "arn:aws:dynamodb:us-east-1:123456789012:table/chimera-sessions",

  # Full configuration snapshot
  "configuration": {
    "tableName": "chimera-sessions",
    "billingMode": "PAY_PER_REQUEST",
    "tableStatus": "ACTIVE",
    "provisionedThroughput": {...},
    "attributeDefinitions": [...],
    "globalSecondaryIndexes": [...],
    "streamSpecification": {...},
    "tags": [
      {"key": "Environment", "value": "production"},
      {"key": "Project", "value": "chimera"},
      {"key": "Owner", "value": "platform-team"}
    ]
  },

  # Resource relationships
  "relationships": [
    {
      "resourceType": "AWS::IAM::Role",
      "resourceId": "ChimeraPlatformRole",
      "relationshipName": "Is associated with"
    },
    {
      "resourceType": "AWS::Lambda::Function",
      "resourceId": "chimera-agent-runtime",
      "relationshipName": "Is accessed by"
    }
  ]
}
```

#### Multi-Region Aggregation

Config Aggregator collects data from all regions into a single view:

```python
import boto3

config = boto3.client('config', region_name='us-east-1')

# Create aggregator for entire organization
config.put_configuration_aggregator(
    ConfigurationAggregatorName='chimera-global-aggregator',
    OrganizationAggregationSource={
        'RoleArn': 'arn:aws:iam::123456789012:role/ConfigAggregatorRole',
        'AllAwsRegions': True  # Collect from all regions
    }
)
```

#### Query Resources via Advanced Query

SQL-like queries across entire account:

```python
# Find all production RDS databases not encrypted
query = """
SELECT
  resourceId,
  resourceType,
  configuration.dBInstanceIdentifier,
  configuration.dBInstanceClass,
  configuration.storageEncrypted,
  awsRegion,
  tags
WHERE
  resourceType = 'AWS::RDS::DBInstance'
  AND configuration.storageEncrypted = false
  AND tags.tag = 'Environment:production'
"""

response = config.select_aggregate_resource_config(
    Expression=query,
    ConfigurationAggregatorName='chimera-global-aggregator'
)

for result in response['Results']:
    resource = json.loads(result)
    print(f"Unencrypted DB: {resource['configuration']['dBInstanceIdentifier']} in {resource['awsRegion']}")
```

#### Change Tracking

Config streams all resource changes to EventBridge:

```python
# EventBridge rule: Trigger Lambda on any Config change
{
  "source": ["aws.config"],
  "detail-type": ["Config Configuration Item Change"],
  "detail": {
    "configurationItemDiff": {
      "changeType": ["CREATE", "UPDATE", "DELETE"]
    }
  }
}

# Lambda: Update Chimera's resource graph
def lambda_handler(event, context):
    change = event['detail']
    resource_type = change['resourceType']
    resource_id = change['resourceId']
    change_type = change['configurationItemDiff']['changeType']

    # Update DynamoDB resource index
    ddb.update_item(
        TableName='chimera-resource-index',
        Key={'PK': f'RESOURCE#{resource_id}', 'SK': 'METADATA'},
        UpdateExpression='SET #type = :type, #status = :status, #updated = :updated',
        ExpressionAttributeNames={
            '#type': 'resourceType',
            '#status': 'status',
            '#updated': 'lastUpdated'
        },
        ExpressionAttributeValues={
            ':type': resource_type,
            ':status': change['configurationItem']['configurationItemStatus'],
            ':updated': datetime.utcnow().isoformat()
        }
    )
```

### 2. Resource Explorer 2: Instant Cross-Region Search

**Role:** Fast, tag-based search across all regions without pre-configuration.

#### Immediate Resource Discovery

As of October 2025, Resource Explorer provides **instant partial results** without setup:

```python
import boto3

resource_explorer = boto3.client('resource-explorer-2', region_name='us-east-1')

# Search all regions for Lambda functions tagged "Team=ai"
response = resource_explorer.search(
    QueryString='tag:Team=ai resourcetype:lambda:function'
)

for resource in response['Resources']:
    print(f"Function: {resource['Arn']}")
    print(f"  Region: {resource['Region']}")
    print(f"  LastReportedAt: {resource['LastReportedAt']}")
```

#### Cross-Region Search with Aggregator Index

For complete historical results, promote one region to aggregator:

```python
# Create aggregator index in us-east-1
resource_explorer.update_index_type(
    Arn='arn:aws:resource-explorer-2:us-east-1:123456789012:index/12345678-1234-1234-1234-123456789012',
    Type='AGGREGATOR'
)

# Now searches in us-east-1 return results from ALL regions
response = resource_explorer.search(
    QueryString='tag:Environment=production',
    ViewArn='arn:aws:resource-explorer-2:us-east-1:123456789012:view/default-view/12345678'
)
```

#### Tag-Based Queries

```python
# Complex tag queries
queries = [
    # Find all production databases
    'tag:Environment=production resourcetype:rds:db',

    # Find resources owned by platform team in us-west-2
    'tag:Owner=platform-team region:us-west-2',

    # Find temporary resources expiring soon
    'tag:TemporaryResource=true tag:ExpirationDate=2026-03*',

    # Find all resources for a specific tenant
    'tag:TenantId=abc123',

    # Wildcard searches
    'tag:Project=chimera* resourcetype:lambda:function'
]

for query in queries:
    response = resource_explorer.search(QueryString=query)
    print(f"Query: {query} → {len(response['Resources'])} results")
```

#### Integration with Unified Search

Resource Explorer powers the AWS Console's unified search bar. Chimera can use the same API:

```python
# Autocomplete resource search
def autocomplete_resources(search_term: str) -> List[dict]:
    response = resource_explorer.search(
        QueryString=search_term,
        MaxResults=10
    )

    return [
        {
            'arn': r['Arn'],
            'type': r['ResourceType'],
            'region': r['Region'],
            'display_name': extract_name_from_arn(r['Arn'])
        }
        for r in response['Resources']
    ]

# User types: "lambda production"
# Returns: All Lambda functions tagged Environment=production
```

### 3. CloudFormation: Stack-Based Provenance

**Role:** Track infrastructure-as-code deployments, managed resource inventory, drift detection.

#### Stack Inventory

```python
import boto3

cfn = boto3.client('cloudformation')

# List all stacks (including deleted)
paginator = cfn.get_paginator('list_stacks')
page_iterator = paginator.paginate(
    StackStatusFilter=[
        'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'
    ]
)

stacks = []
for page in page_iterator:
    for stack in page['StackSummaries']:
        stacks.append({
            'stack_name': stack['StackName'],
            'stack_status': stack['StackStatus'],
            'creation_time': stack['CreationTime'].isoformat(),
            'last_updated': stack.get('LastUpdatedTime', stack['CreationTime']).isoformat()
        })

print(f"Total active stacks: {len(stacks)}")
```

#### Resource-to-Stack Mapping

```python
# Given a resource ARN, find its CloudFormation stack
def find_stack_for_resource(resource_arn: str) -> Optional[dict]:
    # Extract resource ID from ARN
    resource_id = resource_arn.split('/')[-1]

    # Query all stacks
    paginator = cfn.get_paginator('list_stacks')
    for page in paginator.paginate():
        for stack in page['StackSummaries']:
            # Check stack resources
            try:
                response = cfn.describe_stack_resources(
                    StackName=stack['StackName']
                )

                for resource in response['StackResources']:
                    if resource_id in resource['PhysicalResourceId']:
                        return {
                            'stack_name': stack['StackName'],
                            'logical_id': resource['LogicalResourceId'],
                            'resource_type': resource['ResourceType'],
                            'resource_status': resource['ResourceStatus']
                        }
            except Exception:
                continue

    return None

# Usage
lambda_arn = 'arn:aws:lambda:us-east-1:123456789012:function:chimera-agent-runtime'
stack_info = find_stack_for_resource(lambda_arn)
# → {'stack_name': 'ChimeraPlatformRuntimeStack', 'logical_id': 'AgentRuntimeFunction', ...}
```

#### Drift Detection

CloudFormation detects when resources deviate from template:

```python
# Detect drift for all stacks
for stack in stacks:
    try:
        # Initiate drift detection
        response = cfn.detect_stack_drift(
            StackName=stack['stack_name']
        )
        drift_detection_id = response['StackDriftDetectionId']

        # Wait for detection to complete
        waiter = cfn.get_waiter('stack_drift_detection_complete')
        waiter.wait(StackDriftDetectionId=drift_detection_id)

        # Get drift results
        drift = cfn.describe_stack_drift_detection_status(
            StackDriftDetectionId=drift_detection_id
        )

        if drift['StackDriftStatus'] == 'DRIFTED':
            print(f"⚠️  Stack {stack['stack_name']} has drifted!")

            # Get per-resource drift details
            response = cfn.describe_stack_resource_drifts(
                StackName=stack['stack_name']
            )

            for resource_drift in response['StackResourceDrifts']:
                if resource_drift['StackResourceDriftStatus'] == 'MODIFIED':
                    print(f"  Resource {resource_drift['LogicalResourceId']} modified:")
                    print(f"    Expected: {resource_drift['ExpectedProperties']}")
                    print(f"    Actual: {resource_drift['ActualProperties']}")

    except Exception as e:
        print(f"Error detecting drift for {stack['stack_name']}: {e}")
```

### 4. Cost Explorer: Financial Intelligence

**Role:** Map spending to resources, teams, projects; forecast future costs; detect anomalies.

#### Resource-Level Cost Attribution

```python
import boto3
from datetime import datetime, timedelta

ce = boto3.client('ce', region_name='us-east-1')

# Query costs by resource for the last 7 days
response = ce.get_cost_and_usage(
    TimePeriod={
        'Start': (datetime.now() - timedelta(days=7)).date().isoformat(),
        'End': datetime.now().date().isoformat()
    },
    Granularity='DAILY',
    Metrics=['UnblendedCost'],
    GroupBy=[
        {'Type': 'DIMENSION', 'Key': 'RESOURCE_ID'},
        {'Type': 'DIMENSION', 'Key': 'SERVICE'}
    ]
)

# Aggregate costs by resource
from collections import defaultdict
resource_costs = defaultdict(lambda: {'cost': 0.0, 'service': None})

for result in response['ResultsByTime']:
    for group in result['Groups']:
        resource_id = group['Keys'][0]
        service = group['Keys'][1]
        cost = float(group['Metrics']['UnblendedCost']['Amount'])

        resource_costs[resource_id]['cost'] += cost
        resource_costs[resource_id]['service'] = service

# Find top 10 most expensive resources
top_resources = sorted(resource_costs.items(), key=lambda x: x[1]['cost'], reverse=True)[:10]

for resource_id, data in top_resources:
    print(f"{data['service']}: {resource_id} → ${data['cost']:.2f}")
```

#### Cost Anomaly Detection

```python
def detect_cost_anomalies(days: int = 30) -> List[dict]:
    """
    Compare daily costs to 30-day average. Flag anomalies (>2 sigma).
    """
    response = ce.get_cost_and_usage(
        TimePeriod={
            'Start': (datetime.now() - timedelta(days=days)).date().isoformat(),
            'End': datetime.now().date().isoformat()
        },
        Granularity='DAILY',
        Metrics=['UnblendedCost']
    )

    costs = [float(r['Total']['UnblendedCost']['Amount']) for r in response['ResultsByTime']]

    import statistics
    avg = statistics.mean(costs[:-1])
    std_dev = statistics.stdev(costs[:-1])

    today_cost = costs[-1]
    threshold = avg + (2 * std_dev)

    if today_cost > threshold:
        return [{
            'date': datetime.now().date().isoformat(),
            'expected_cost': avg,
            'actual_cost': today_cost,
            'delta': today_cost - avg,
            'delta_percent': ((today_cost - avg) / avg) * 100,
            'severity': 'high' if today_cost > avg + (3 * std_dev) else 'medium'
        }]

    return []
```

### 5. Tags: Business Context Layer

**Role:** Map technical resources to organizational entities (teams, projects, cost centers).

#### Tag-Driven Resource Discovery

```python
import boto3

tagging = boto3.client('resourcegroupstaggingapi')

# Find all resources for a specific tenant
response = tagging.get_resources(
    TagFilters=[
        {'Key': 'TenantId', 'Values': ['tenant-abc123']},
        {'Key': 'Environment', 'Values': ['production']}
    ]
)

tenant_resources = []
for resource in response['ResourceTagMappingList']:
    tags = {t['Key']: t['Value'] for t in resource['Tags']}
    tenant_resources.append({
        'arn': resource['ResourceARN'],
        'type': resource['ResourceARN'].split(':')[2],  # Extract service
        'tags': tags
    })

print(f"Tenant abc123 has {len(tenant_resources)} production resources")
```

## Unified Discovery Layer: Integration

### DynamoDB Resource Index

Chimera maintains a denormalized resource index in DynamoDB for fast queries:

```typescript
// Table: chimera-resource-index
{
  PK: 'RESOURCE#arn:aws:lambda:us-east-1:123456789012:function:agent-runtime',
  SK: 'METADATA',

  // Resource identity
  resourceType: 'AWS::Lambda::Function',
  resourceId: 'agent-runtime',
  arn: 'arn:aws:lambda:us-east-1:123456789012:function:agent-runtime',
  region: 'us-east-1',
  accountId: '123456789012',

  // Provenance
  createdBy: 'IAMUser/alice',
  createdAt: '2026-01-15T10:30:00Z',
  cloudFormationStack: 'ChimeraPlatformRuntimeStack',
  managedBy: 'cloudformation',

  // Current state
  status: 'ACTIVE',
  lastUpdatedAt: '2026-03-20T16:45:00Z',

  // Tags (indexed separately via GSI)
  tags: {
    'Environment': 'production',
    'Team': 'platform',
    'Project': 'chimera',
    'TenantId': 'tenant-abc123'
  },

  // Costs (last 7 days)
  weeklyC Cost: 45.32,
  dailyCostAvg: 6.47,

  // Compliance
  compliant: true,
  lastComplianceCheck: '2026-03-20T12:00:00Z',

  // Relationships (denormalized)
  dependencies: [
    'arn:aws:dynamodb:us-east-1:123456789012:table/chimera-sessions',
    'arn:aws:iam::123456789012:role/ChimeraPlatformRole'
  ],
  dependents: [
    'arn:aws:apigateway:us-east-1::/restapis/abc123/stages/prod'
  ]
}
```

#### GSI for Tag-Based Queries

```typescript
// GSI1: Query by tag key-value pairs
{
  GSI1PK: 'TAG#Environment:production',
  GSI1SK: 'RESOURCE#arn:aws:lambda:us-east-1:123456789012:function:agent-runtime',
  ...
}

// Query: "Find all production Lambda functions"
const response = await ddb.query({
  TableName: 'chimera-resource-index',
  IndexName: 'GSI1',
  KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
  ExpressionAttributeValues: {
    ':pk': 'TAG#Environment:production',
    ':sk': 'RESOURCE#arn:aws:lambda'
  }
});
```

### Real-Time Update Pipeline

```
AWS Config Change
       │
       ▼
EventBridge Rule
       │
       ▼
Lambda: ProcessConfigChange
       │
       ├─→ Update DynamoDB index
       ├─→ Query Cost Explorer (if resource type has costs)
       ├─→ Update relationship graph
       └─→ Trigger compliance re-evaluation
```

```python
def process_config_change(event, context):
    """
    Lambda handler: Sync Config changes to Chimera resource index.
    """
    change = event['detail']
    resource_arn = change['resourceArn']
    resource_type = change['resourceType']
    change_type = change['configurationItemDiff']['changeType']

    if change_type == 'DELETE':
        # Remove from index
        ddb.delete_item(
            TableName='chimera-resource-index',
            Key={'PK': f'RESOURCE#{resource_arn}', 'SK': 'METADATA'}
        )

    else:
        # Upsert resource metadata
        config_item = change['configurationItem']
        tags = {t['key']: t['value'] for t in config_item.get('tags', [])}

        item = {
            'PK': f'RESOURCE#{resource_arn}',
            'SK': 'METADATA',
            'resourceType': resource_type,
            'resourceId': config_item['resourceId'],
            'arn': resource_arn,
            'region': config_item['awsRegion'],
            'status': config_item['configurationItemStatus'],
            'lastUpdatedAt': config_item['configurationItemCaptureTime'],
            'tags': tags,
            'configuration': json.dumps(config_item['configuration'])
        }

        # Add tag GSI entries
        for key, value in tags.items():
            item[f'GSI1PK'] = f'TAG#{key}:{value}'
            item[f'GSI1SK'] = f'RESOURCE#{resource_arn}'

        ddb.put_item(TableName='chimera-resource-index', Item=item)

        # Query recent costs for this resource (async)
        if resource_type in COST_TRACKED_TYPES:
            invoke_async_lambda('UpdateResourceCosts', {'arn': resource_arn})
```

### GraphQL Query API

Expose unified discovery via GraphQL:

```graphql
type Query {
  # Find resources by filters
  searchResources(
    tags: [TagFilter!]
    resourceTypes: [String!]
    regions: [String!]
    status: [String!]
  ): [Resource!]!

  # Get single resource
  getResource(arn: String!): Resource

  # Get resource relationships
  getResourceDependencies(arn: String!): [Resource!]!
  getResourceDependents(arn: String!): [Resource!]!

  # Cost queries
  getResourceCosts(
    arn: String!
    startDate: String!
    endDate: String!
  ): CostData!

  # Compliance queries
  getComplianceStatus(
    resourceType: String
    tags: [TagFilter!]
  ): ComplianceSummary!
}

type Resource {
  arn: String!
  resourceType: String!
  resourceId: String!
  region: String!
  status: String!
  tags: [Tag!]!
  configuration: JSON!
  createdAt: String!
  lastUpdatedAt: String!
  cloudFormationStack: String
  weeklyyCost: Float
  compliant: Boolean!
  dependencies: [Resource!]!
  dependents: [Resource!]!
}
```

**Example query:**

```graphql
query FindProductionDatabases {
  searchResources(
    tags: [{key: "Environment", value: "production"}]
    resourceTypes: ["AWS::RDS::DBInstance", "AWS::DynamoDB::Table"]
    regions: ["us-east-1", "us-west-2"]
  ) {
    arn
    resourceType
    region
    tags {
      key
      value
    }
    weeklyCost
    compliant
  }
}
```

## Use Cases

### Use Case 1: "What's running in my account?"

**User query:** "Show me all resources in production"

**Agent workflow:**
1. Query DynamoDB index via GSI: `TAG#Environment:production`
2. Return aggregated view:
   - By service: 45 Lambda functions, 12 DynamoDB tables, 8 RDS instances, ...
   - By region: us-east-1 (60%), us-west-2 (30%), eu-west-1 (10%)
   - By cost: Total $4,230/week
3. Surface top resources by cost: "Your top 3 resources are..."

### Use Case 2: "Why did costs spike?"

**User query:** "Costs increased 40% this week — why?"

**Agent workflow:**
1. Query Cost Explorer: Compare this week vs last week by service
2. Identify spike: Lambda costs up from $1,200 → $2,400
3. Drill down: Query Cost Explorer by RESOURCE_ID dimension
4. Find culprit: `agent-runtime` function increased from $300 → $1,800
5. Query Config: Check recent changes to `agent-runtime`
6. Config history shows: Memory increased from 512MB → 3008MB on March 18
7. Response: "Lambda costs spiked due to memory increase on `agent-runtime` function (512MB → 3008MB on March 18). This change was made by IAM user `alice` via CloudFormation stack update."

### Use Case 3: "Find all databases not encrypted"

**User query:** "Are all my databases encrypted?"

**Agent workflow:**
1. Query Resource Explorer: `resourcetype:rds:db resourcetype:dynamodb:table`
2. For each resource, query Config for encryption status
3. Config Advanced Query:
```sql
SELECT resourceId, configuration.storageEncrypted, awsRegion, tags
WHERE resourceType = 'AWS::RDS::DBInstance'
  AND configuration.storageEncrypted = false
```
4. Return non-compliant resources with remediation steps

### Use Case 4: "What resources belong to the AI team?"

**User query:** "Show me everything the AI team owns"

**Agent workflow:**
1. Query DynamoDB index: `TAG#Team:ai`
2. Return resources grouped by type and region
3. Surface costs: "AI team resources cost $12,450 this month"
4. Highlight compliance issues: "3 resources missing required tags"

### Use Case 5: "What changed in the last 24 hours?"

**User query:** "What infrastructure changes happened yesterday?"

**Agent workflow:**
1. Query Config change history: Last 24 hours
2. Group by change type: 15 CREATE, 8 UPDATE, 2 DELETE
3. Surface significant changes:
   - "New DynamoDB table `chimera-analytics` created"
   - "Lambda `agent-runtime` memory increased 512MB → 3008MB"
   - "RDS instance `prod-db-01` deleted"
4. Map changes to CloudFormation stacks: "12 changes from `ChimeraDataStack` update"

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)

- ✅ Enable AWS Config in all regions
- ✅ Create Config Aggregator in us-east-1
- ✅ Enable Resource Explorer 2 with aggregator index
- ✅ Define core tag schema (Environment, Owner, Project, TenantId)
- ✅ Deploy DynamoDB resource index table

### Phase 2: Real-Time Sync (Week 3-4)

- ⏳ EventBridge rule: Config changes → Lambda
- ⏳ Lambda: Sync Config changes to DynamoDB index
- ⏳ Lambda: Query Cost Explorer for resource costs (daily batch)
- ⏳ GSI: Tag-based queries

### Phase 3: Relationship Graph (Week 5-6)

- ⏳ Parse Config relationships (Lambda → DynamoDB, ALB → ECS, etc.)
- ⏳ Store relationship graph in DynamoDB or Neptune
- ⏳ GraphQL API: Query dependencies and dependents

### Phase 4: Intelligence Layer (Week 7-8)

- ⏳ Cost anomaly detection (daily Lambda)
- ⏳ Compliance monitoring (AWS Config rules + custom checks)
- ⏳ Drift detection (weekly CloudFormation scan)
- ⏳ Resource lifecycle management (auto-terminate expired resources)

### Phase 5: Agent Integration (Week 9-10)

- ⏳ GraphQL API for Chimera agents
- ⏳ Natural language queries → GraphQL translation
- ⏳ Conversational responses with cost/compliance insights
- ⏳ Proactive recommendations (idle resources, cost optimization)

## Cost Estimate

| Service | Monthly Cost | Notes |
|---------|--------------|-------|
| **AWS Config** | ~$60 | $0.003/CI × 20,000 CIs/month |
| **Resource Explorer** | $0 | Free tier |
| **Cost Explorer API** | ~$30 | $0.01/request × 3,000 requests/month |
| **DynamoDB (index)** | ~$25 | 100k items, 10 RPS read/write |
| **Lambda (sync pipeline)** | ~$15 | 50k invocations/month |
| **EventBridge** | ~$5 | 1M events/month |
| **CloudWatch Logs** | ~$10 | 10 GB/month |
| **Total** | **~$145/month** | For account with 20k resources |

## Summary

Chimera's account discovery architecture transforms AWS from an opaque cloud into a **living, queryable infrastructure map**. By integrating:

1. **AWS Config** — Authoritative resource inventory and change history
2. **Resource Explorer** — Instant cross-region tag-based search
3. **CloudFormation** — Stack provenance and drift detection
4. **Cost Explorer** — Financial intelligence and spending attribution
5. **Tags** — Business context mapping

...Chimera agents gain omniscient awareness of the AWS environment, enabling:

- **Instant answers** to "What's running?" questions
- **Cost attribution** to teams, projects, tenants
- **Proactive optimization** based on usage patterns
- **Compliance enforcement** with automated remediation
- **Change tracking** with full audit history

This isn't a periodic scan — it's a **real-time, event-driven, multi-dimensional view** of an entire AWS account, synthesized into a unified API that agents can query naturally.

**Next Steps:**
- [04-Cost-Explorer-Spending-Analysis.md](./04-Cost-Explorer-Spending-Analysis.md) - Cost Explorer deep dive
- [05-Tag-Organization-Strategy.md](./05-Tag-Organization-Strategy.md) - Tagging best practices

---

**References:**
- [AWS Config Aggregator](https://docs.aws.amazon.com/config/latest/developerguide/aggregate-data.html)
- [AWS Resource Explorer Documentation](https://docs.aws.amazon.com/resource-explorer/latest/userguide/getting-started.html)
- [CloudFormation Drift Detection](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html)
- [Cost Explorer API](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-api.html)
