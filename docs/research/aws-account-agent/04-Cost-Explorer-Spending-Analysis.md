---
title: "Cost Explorer: Programmatic Spending Analysis"
version: 1.0.0
status: research
last_updated: 2026-03-20
context: "AWS account-wide discovery - Cost Explorer for spending visibility"
supersedes: []
---

# Cost Explorer: Programmatic Spending Analysis

## Overview

AWS Cost Explorer provides programmatic access to cost and usage data, enabling Chimera agents to maintain real-time spending awareness across the entire AWS account. Unlike reactive billing alerts, Cost Explorer API enables proactive cost optimization by surfacing spending patterns, anomalies, and trends as they occur.

**Key Capabilities:**
- **Granular cost queries**: Daily/hourly usage data down to individual resource level
- **Multi-dimensional analysis**: Group by service, account, region, tag, usage type
- **Predictive forecasting**: Machine learning-based spending predictions
- **Cost allocation tags**: Map spending to business entities (teams, projects, environments)
- **Programmatic access**: Full API for agent-driven cost intelligence

## API Access Patterns

### Endpoint and Authentication

```
Endpoint: https://ce.us-east-1.amazonaws.com
Region: us-east-1 (global service, single endpoint)
```

**IAM Permissions Required:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ce:GetCostAndUsage",
        "ce:GetCostForecast",
        "ce:GetDimensionValues",
        "ce:GetTags",
        "ce:GetReservationUtilization",
        "ce:GetSavingsPlansUtilization"
      ],
      "Resource": "*"
    }
  ]
}
```

### Core API Operations

#### 1. GetCostAndUsage

Retrieve historical cost and usage data with flexible grouping and filtering.

**Request Pattern:**
```python
import boto3
from datetime import datetime, timedelta

ce = boto3.client('ce', region_name='us-east-1')

# Query last 30 days, grouped by service
end_date = datetime.now().date()
start_date = end_date - timedelta(days=30)

response = ce.get_cost_and_usage(
    TimePeriod={
        'Start': start_date.isoformat(),
        'End': end_date.isoformat()
    },
    Granularity='DAILY',  # or HOURLY, MONTHLY
    Metrics=['UnblendedCost', 'UsageQuantity'],
    GroupBy=[
        {'Type': 'DIMENSION', 'Key': 'SERVICE'},
        {'Type': 'TAG', 'Key': 'Environment'}
    ],
    Filter={
        'Dimensions': {
            'Key': 'REGION',
            'Values': ['us-east-1', 'us-west-2']
        }
    }
)

# Response structure
for result in response['ResultsByTime']:
    date = result['TimePeriod']['Start']
    for group in result['Groups']:
        service = group['Keys'][0]
        environment = group['Keys'][1]
        cost = group['Metrics']['UnblendedCost']['Amount']
        print(f"{date} | {service} | {environment} | ${cost}")
```

**Granularity Trade-offs:**
- **DAILY**: High-level trends, 13 months retention (recommended default)
- **HOURLY**: Deep analysis, spike detection, 14 days retention
- **MONTHLY**: Executive reporting, long-term trends

#### 2. GetCostForecast

Predict future spending using AWS machine learning models.

```python
# Forecast next 7 days
forecast_end = (datetime.now() + timedelta(days=7)).date()

response = ce.get_cost_forecast(
    TimePeriod={
        'Start': datetime.now().date().isoformat(),
        'End': forecast_end.isoformat()
    },
    Metric='UNBLENDED_COST',
    Granularity='DAILY',
    Filter={
        'Dimensions': {
            'Key': 'SERVICE',
            'Values': ['Amazon Elastic Compute Cloud - Compute']
        }
    }
)

predicted_cost = response['Total']['Amount']
```

**Use Cases:**
- Budget variance prediction
- Capacity planning cost estimates
- Anomaly detection (actual vs forecast divergence)

#### 3. GetDimensionValues

Discover available filter dimensions (services, regions, instance types, etc.).

```python
# List all active services in the account
response = ce.get_dimension_values(
    TimePeriod={
        'Start': (datetime.now() - timedelta(days=30)).date().isoformat(),
        'End': datetime.now().date().isoformat()
    },
    Dimension='SERVICE',
    SearchString='Amazon'  # Optional filter
)

services = [item['Value'] for item in response['DimensionValues']]
# ['Amazon EC2', 'Amazon S3', 'Amazon DynamoDB', ...]
```

**Available Dimensions:**
- `SERVICE` - AWS service names
- `LINKED_ACCOUNT` - Multi-account organizations
- `REGION` - Geographic regions
- `INSTANCE_TYPE` - EC2/RDS instance types
- `USAGE_TYPE` - Detailed usage categories
- `OPERATION` - API operation names
- `PURCHASE_TYPE` - On-Demand, Reserved, Spot

## Cost Allocation Tags

Tags are the bridge between technical resources and business context. Cost allocation tags enable Chimera to answer questions like:

- "How much did the staging environment cost this month?"
- "Which team's resources drove the $10k spike?"
- "What's the ROI of our new feature (tagged `project:feature-x`)?"

### Tag Activation Workflow

Cost allocation tags must be **explicitly activated** in the Billing console before appearing in Cost Explorer queries.

**Activation Steps:**
1. Resources are tagged (via Terraform, CDK, console)
2. Tag keys appear in Billing console after 24 hours
3. Administrator activates tags for cost allocation
4. Tags appear in Cost Explorer within 24 hours of activation

**Important:** Historical costs are **backfilled** up to 12 months when a tag is activated.

### User-Defined vs AWS-Generated Tags

| Type | Example | Purpose | Activation Required |
|------|---------|---------|---------------------|
| **User-Defined** | `Environment=production`<br>`Team=platform`<br>`Project=chimera` | Business logic mapping | Yes (manual) |
| **AWS-Generated** | `aws:createdBy=IAMUser/alice`<br>`aws:cloudformation:stack-name=DataStack` | Provenance tracking | Yes (automatic) |

**AWS-Generated Tags:**
- `aws:createdBy` - IAM principal who created resource
- `aws:cloudformation:stack-name` - CFN stack association
- `aws:cloudformation:logical-id` - Resource ID in template

### Tag-Based Cost Queries

```python
# Query costs grouped by custom tags
response = ce.get_cost_and_usage(
    TimePeriod={
        'Start': '2026-03-01',
        'End': '2026-03-20'
    },
    Granularity='MONTHLY',
    Metrics=['UnblendedCost'],
    GroupBy=[
        {'Type': 'TAG', 'Key': 'Environment'},
        {'Type': 'TAG', 'Key': 'Team'}
    ]
)

# Filter by specific tag values
response = ce.get_cost_and_usage(
    TimePeriod={'Start': '2026-03-01', 'End': '2026-03-20'},
    Granularity='DAILY',
    Metrics=['UnblendedCost'],
    Filter={
        'Tags': {
            'Key': 'Project',
            'Values': ['chimera', 'chimera-infra']
        }
    }
)
```

## Cost Comparison and Trend Analysis

### Month-over-Month Analysis

Cost Explorer's comparison feature automates MoM variance detection:

```python
# Compare March 2026 vs February 2026
response = ce.get_cost_and_usage(
    TimePeriod={
        'Start': '2026-02-01',
        'End': '2026-03-31'
    },
    Granularity='MONTHLY',
    Metrics=['UnblendedCost'],
    GroupBy=[{'Type': 'DIMENSION', 'Key': 'SERVICE'}]
)

# Calculate variance
feb_costs = {g['Keys'][0]: float(g['Metrics']['UnblendedCost']['Amount'])
             for g in response['ResultsByTime'][0]['Groups']}
mar_costs = {g['Keys'][0]: float(g['Metrics']['UnblendedCost']['Amount'])
             for g in response['ResultsByTime'][1]['Groups']}

for service in mar_costs:
    delta = mar_costs[service] - feb_costs.get(service, 0)
    percent = (delta / feb_costs.get(service, 1)) * 100 if service in feb_costs else 100
    if abs(delta) > 100:  # Significant changes only
        print(f"{service}: ${delta:,.2f} ({percent:+.1f}%)")
```

**Automated Insights:**
- Top cost increases by service, account, region
- New services activated this month
- Reserved Instance utilization changes
- Savings Plan discount application

## Integration with Chimera Architecture

### Real-Time Cost Tracking Table

Chimera's `chimera-cost-tracking` DynamoDB table accumulates costs per tenant:

```typescript
// Table schema
{
  PK: 'TENANT#abc123',
  SK: 'MONTH#2026-03',

  // Aggregated costs
  totalCost: 142.35,
  computeCost: 89.20,
  storageCost: 32.15,
  networkCost: 21.00,

  // Resource-level breakdown
  resources: [
    { type: 'Lambda', functionName: 'agent-runtime', cost: 12.40 },
    { type: 'DynamoDB', tableName: 'sessions', cost: 8.75 }
  ],

  // Quota tracking
  quotaUsagePercent: 71.2,
  quotaExceeded: false,

  // Timestamps
  lastUpdated: '2026-03-20T16:30:00Z',
  ttl: 1741910400  // 2yr retention
}
```

### Cost-Aware Agent Workflow

```python
class CostAwareAgent:
    def __init__(self, tenant_id: str):
        self.ce = boto3.client('ce', region_name='us-east-1')
        self.tenant_id = tenant_id

    async def check_spending_before_action(self, action: str) -> bool:
        """
        Query current month spending, compare to quota, decide if action is allowed.
        """
        # Get current month costs for this tenant's resources
        month_start = datetime.now().replace(day=1).date()

        response = self.ce.get_cost_and_usage(
            TimePeriod={
                'Start': month_start.isoformat(),
                'End': datetime.now().date().isoformat()
            },
            Granularity='MONTHLY',
            Metrics=['UnblendedCost'],
            Filter={
                'Tags': {
                    'Key': 'TenantId',
                    'Values': [self.tenant_id]
                }
            }
        )

        current_spend = float(response['ResultsByTime'][0]['Total']['UnblendedCost']['Amount'])
        tenant_quota = await self.get_tenant_quota(self.tenant_id)

        if current_spend >= tenant_quota * 0.95:
            await self.send_quota_alert(current_spend, tenant_quota)
            return False  # Block action

        return True  # Allow action

    async def optimize_costs(self):
        """
        Identify cost optimization opportunities.
        """
        # Find idle resources (low usage, high cost)
        response = self.ce.get_cost_and_usage(
            TimePeriod={
                'Start': (datetime.now() - timedelta(days=7)).date().isoformat(),
                'End': datetime.now().date().isoformat()
            },
            Granularity='DAILY',
            Metrics=['UnblendedCost', 'UsageQuantity'],
            GroupBy=[
                {'Type': 'DIMENSION', 'Key': 'RESOURCE_ID'}
            ]
        )

        # Analyze: if cost > $10/day but usage < 10%, recommend termination
        for result in response['ResultsByTime']:
            for group in result['Groups']:
                resource_id = group['Keys'][0]
                cost = float(group['Metrics']['UnblendedCost']['Amount'])
                usage = float(group['Metrics']['UsageQuantity']['Amount'])

                if cost > 10 and usage < 10:
                    yield {
                        'resource': resource_id,
                        'recommendation': 'Consider terminating idle resource',
                        'potential_savings': cost * 30  # monthly projection
                    }
```

## Cost Allocation Strategies

### 1. Account-Based (Lowest Effort)

**Pattern:** One AWS account per team/project
**Cost Visibility:** Direct via account-level billing
**Pros:** Zero tagging effort, clear ownership
**Cons:** Account sprawl, service quota limits

```python
# Multi-account cost query (AWS Organizations)
response = ce.get_cost_and_usage(
    TimePeriod={'Start': '2026-03-01', 'End': '2026-03-20'},
    Granularity='MONTHLY',
    Metrics=['UnblendedCost'],
    GroupBy=[{'Type': 'DIMENSION', 'Key': 'LINKED_ACCOUNT'}]
)
```

### 2. Tag-Based (Highest Accuracy)

**Pattern:** Fine-grained resource tagging
**Cost Visibility:** Requires tag activation, 24hr lag
**Pros:** Precise attribution, flexible reporting
**Cons:** Tagging discipline required, governance overhead

**Recommended Tag Schema:**
```yaml
# Core cost allocation tags
Environment: [production, staging, development]
Team: [platform, ai-agents, api, infra]
Project: [chimera, chimera-marketplace, chimera-evo]
CostCenter: [engineering, research, operations]
Owner: [alice@example.com, bob@example.com]

# Lifecycle tags
TemporaryResource: [true, false]  # Auto-terminate candidates
ExpirationDate: [2026-04-01, 2026-12-31]
```

### 3. Hybrid (AWS Cost Categories)

AWS Cost Categories create virtual cost buckets without requiring tags:

```python
# Create cost category
cost_categories = boto3.client('ce')

response = cost_categories.create_cost_category_definition(
    Name='ChimeraBusinessUnits',
    RuleVersion='CostCategoryExpression.v1',
    Rules=[
        {
            'Value': 'AI-Platform',
            'Rule': {
                'Or': [
                    {'Tags': {'Key': 'Team', 'Values': ['ai-agents', 'platform']}},
                    {'Dimensions': {'Key': 'SERVICE', 'Values': ['Amazon Bedrock']}}
                ]
            }
        },
        {
            'Value': 'Infrastructure',
            'Rule': {
                'Tags': {'Key': 'Team', 'Values': ['infra', 'devops']}
            }
        }
    ]
)
```

## Unallocated Spend Handling

**Unallocatable costs** (Reserved Instance fees, Savings Plans, Support fees) cannot be tagged in advance but can be tracked retroactively:

```python
# Query RI and SP costs
response = ce.get_cost_and_usage(
    TimePeriod={'Start': '2026-03-01', 'End': '2026-03-20'},
    Granularity='MONTHLY',
    Metrics=['UnblendedCost'],
    Filter={
        'Dimensions': {
            'Key': 'PURCHASE_TYPE',
            'Values': ['Reservation', 'SavingsPlan']
        }
    }
)

# Allocate proportionally based on usage
total_on_demand = get_total_on_demand_cost()
ri_cost = float(response['ResultsByTime'][0]['Total']['UnblendedCost']['Amount'])

for team in teams:
    team_usage_percent = team.on_demand_cost / total_on_demand
    team_allocated_ri_cost = ri_cost * team_usage_percent
```

## Best Practices for Chimera

### 1. Daily Cost Snapshots

Run scheduled Lambda to snapshot daily costs into DynamoDB:

```python
# Store daily snapshot
ddb.put_item(
    TableName='chimera-cost-tracking',
    Item={
        'PK': 'TENANT#abc123',
        'SK': f'DAY#{datetime.now().date().isoformat()}',
        'totalCost': Decimal('142.35'),
        'services': {
            'Lambda': Decimal('45.20'),
            'DynamoDB': Decimal('32.15'),
            'Bedrock': Decimal('65.00')
        },
        'ttl': int((datetime.now() + timedelta(days=730)).timestamp())
    }
)
```

### 2. Anomaly Detection

Compare daily costs to 30-day moving average:

```python
def detect_anomalies(tenant_id: str) -> List[dict]:
    # Query last 30 days
    response = ce.get_cost_and_usage(
        TimePeriod={
            'Start': (datetime.now() - timedelta(days=30)).date().isoformat(),
            'End': datetime.now().date().isoformat()
        },
        Granularity='DAILY',
        Metrics=['UnblendedCost'],
        Filter={'Tags': {'Key': 'TenantId', 'Values': [tenant_id]}}
    )

    costs = [float(r['Total']['UnblendedCost']['Amount']) for r in response['ResultsByTime']]
    avg = sum(costs[:-1]) / len(costs[:-1])
    std_dev = statistics.stdev(costs[:-1])

    today_cost = costs[-1]
    if today_cost > avg + (2 * std_dev):  # 2 sigma threshold
        return [{
            'type': 'cost_spike',
            'expected': avg,
            'actual': today_cost,
            'delta': today_cost - avg,
            'severity': 'high' if today_cost > avg + (3 * std_dev) else 'medium'
        }]

    return []
```

### 3. Resource-Level Attribution

Use resource-level Cost Explorer queries to map costs to specific infrastructure:

```python
# Find top 10 most expensive resources
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

# Aggregate by resource
resource_costs = defaultdict(float)
for result in response['ResultsByTime']:
    for group in result['Groups']:
        resource_id = group['Keys'][0]
        cost = float(group['Metrics']['UnblendedCost']['Amount'])
        resource_costs[resource_id] += cost

top_10 = sorted(resource_costs.items(), key=lambda x: x[1], reverse=True)[:10]
```

## Rate Limits and Pagination

**Cost Explorer API Quotas:**
- 5 requests per second per account
- 100 TPS burst capacity
- Use exponential backoff for throttling

**Pagination:**
```python
def get_all_cost_data(start_date: str, end_date: str) -> List[dict]:
    results = []
    next_token = None

    while True:
        params = {
            'TimePeriod': {'Start': start_date, 'End': end_date},
            'Granularity': 'DAILY',
            'Metrics': ['UnblendedCost']
        }
        if next_token:
            params['NextPageToken'] = next_token

        response = ce.get_cost_and_usage(**params)
        results.extend(response['ResultsByTime'])

        next_token = response.get('NextPageToken')
        if not next_token:
            break

    return results
```

## Summary

Cost Explorer transforms billing from a monthly surprise to continuous cost intelligence. For Chimera:

1. **Real-time spending awareness** - Know costs as they occur, not 30 days later
2. **Multi-dimensional analysis** - Group by service, region, tag, resource
3. **Predictive forecasting** - Prevent budget overruns before they happen
4. **Tag-based attribution** - Map technical resources to business entities
5. **Programmatic access** - Enable agent-driven cost optimization

**Next Steps:**
- [05-Tag-Organization-Strategy.md](./05-Tag-Organization-Strategy.md) - Tag governance and best practices
- [06-Account-Discovery-Architecture.md](./06-Account-Discovery-Architecture.md) - Unified discovery architecture

---

**References:**
- [Cost Explorer API Documentation](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-api.html)
- [Cost Allocation Tags Guide](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-alloc-tags.html)
- [AWS Well-Architected: Cost Optimization](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html)
