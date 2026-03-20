# AWS CloudFormation: Stack Inventory & Infrastructure-as-Code Tracking

> **Research Date:** 2026-03-20
> **Status:** Complete
> **Series:** AWS Account Agent Infrastructure (3 of 5)
> **See also:** [[01-AWS-Config-Resource-Inventory]] | [[02-Resource-Explorer-Cross-Region-Search]] | [[04-Cost-Explorer-Spending-Analysis]] | [[05-Tag-Based-Resource-Organization]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#What is CloudFormation for Discovery?]]
- [[#Stack-Based Resource Organization]]
- [[#Stack Detection and Enumeration]]
- [[#Stack Status and Health Monitoring]]
- [[#Drift Detection]]
- [[#StackSets for Multi-Account]]
- [[#Change Sets and Update Tracking]]
- [[#Resource Import and Adoption]]
- [[#Integration Patterns]]
- [[#Pricing Model]]
- [[#Use Cases for Chimera]]
- [[#Code Examples]]
- [[#Best Practices]]
- [[#Limitations]]
- [[#Key Takeaways]]
- [[#Sources]]

---

## Executive Summary

While **AWS CloudFormation** is primarily known as an Infrastructure-as-Code (IaC) service, it also provides powerful **stack inventory and resource organization** capabilities for account-wide discovery systems like Chimera.

For Chimera's account-wide agent system, CloudFormation provides:
- **Logical resource grouping** -- understand which resources belong together
- **Stack relationships** -- nested stacks, cross-stack references, dependencies
- **Drift detection** -- identify resources that have deviated from defined state
- **Change tracking** -- understand what changed, when, and why (via change sets)
- **Multi-account management** -- StackSets provide cross-account infrastructure visibility
- **IaC-native tags** -- automatically propagate tags from stack to resources

Key differentiators:
- **Logical grouping** -- CloudFormation knows which resources form a cohesive unit
- **Intent tracking** -- understand the *why* behind resource configurations
- **Drift awareness** -- detect when reality diverges from code
- **Update history** -- complete audit trail of infrastructure changes

CloudFormation complements Config (resource inventory) and Resource Explorer (fast search) by adding **architectural context** -- it knows that these 20 resources form a "web application stack" and that these 5 stacks form a "microservices platform".

---

## What is CloudFormation for Discovery?

CloudFormation operates at the **infrastructure orchestration layer**:

```
+-------------------------------------------------------+
|            Chimera Agent Platform                      |
|  (Account-wide orchestration & self-evolution)         |
+-------------------------------------------------------+
|     CloudFormation (Stack Inventory)                   |  <-- This layer
|  - Stack-based resource grouping                       |
|  - Drift detection                                     |
|  - Change tracking                                     |
|  - Multi-account visibility (StackSets)                |
+-------------------------------------------------------+
|       Resource Discovery Services                      |
|  Config (change history) | Resource Explorer (search) |
+-------------------------------------------------------+
|           AWS Infrastructure                           |
|  (EC2, S3, Lambda, DynamoDB, VPC, IAM, etc.)          |
+-------------------------------------------------------+
```

### Core Value Propositions

1. **Architectural awareness** -- understand resource relationships and groupings
2. **Drift detection** -- identify manual changes that deviate from IaC
3. **Change history** -- audit trail of all stack modifications
4. **Multi-account orchestration** -- StackSets for organization-wide deployments
5. **Resource lifecycle** -- track creation, updates, deletions at stack level

### CloudFormation in the Discovery Stack

| Service | Discovery Capability | Speed | Depth | Use Case |
|---------|---------------------|-------|-------|----------|
| **Resource Explorer** | Find resources by tag/type | <1 sec | Shallow | "Show me all Lambda functions" |
| **AWS Config** | Track configuration changes | 10-30 sec | Deep | "What changed in the last hour?" |
| **CloudFormation** | Stack-based organization | 5-10 sec | Architectural | "What resources belong to this application?" |

---

## Stack-Based Resource Organization

### What is a Stack?

A **stack** is a collection of AWS resources managed as a single unit:

```yaml
# Example: Web Application Stack
Resources:
  VPC:
    Type: AWS::EC2::VPC
    # ... properties

  PublicSubnet:
    Type: AWS::EC2::Subnet
    # ... properties

  LoadBalancer:
    Type: AWS::ElasticLoadBalancingV2::LoadBalancer
    # ... properties

  WebServerGroup:
    Type: AWS::AutoScaling::AutoScalingGroup
    # ... properties

  Database:
    Type: AWS::RDS::DBInstance
    # ... properties
```

When deployed, this creates a **stack** containing all resources:

```
Stack: chimera-web-app-prod
├── VPC: vpc-0abc123
├── Subnet: subnet-0def456
├── Load Balancer: alb-789xyz
├── Auto Scaling Group: asg-web-servers
└── RDS Instance: db-chimera-prod
```

### Stack Metadata

Each stack includes rich metadata:

```python
import boto3

cfn = boto3.client('cloudformation')

stack = cfn.describe_stacks(StackName='chimera-web-app-prod')['Stacks'][0]

print(f"Stack Name: {stack['StackName']}")
print(f"Stack ID: {stack['StackId']}")
print(f"Status: {stack['StackStatus']}")
print(f"Creation Time: {stack['CreationTime']}")
print(f"Last Updated: {stack.get('LastUpdatedTime', 'Never')}")
print(f"Tags: {stack.get('Tags', [])}")
print(f"Outputs: {stack.get('Outputs', [])}")
print(f"Parameters: {stack.get('Parameters', [])}")
```

### Resource-to-Stack Mapping

CloudFormation tags all resources with stack metadata:

```python
# Every resource created by CloudFormation has these tags
{
    'aws:cloudformation:stack-name': 'chimera-web-app-prod',
    'aws:cloudformation:stack-id': 'arn:aws:cloudformation:...',
    'aws:cloudformation:logical-id': 'WebServerGroup'
}
```

This enables **reverse lookup**: given a resource, find its stack.

---

## Stack Detection and Enumeration

### List All Stacks

```python
def get_all_stacks(region='us-east-1') -> List[Dict]:
    """Get all CloudFormation stacks in a region."""
    cfn = boto3.client('cloudformation', region_name=region)

    stacks = []
    paginator = cfn.get_paginator('describe_stacks')

    for page in paginator.paginate():
        for stack in page['Stacks']:
            stacks.append({
                'name': stack['StackName'],
                'status': stack['StackStatus'],
                'creation_time': stack['CreationTime'],
                'last_updated': stack.get('LastUpdatedTime'),
                'tags': {tag['Key']: tag['Value'] for tag in stack.get('Tags', [])}
            })

    return stacks
```

### Filter by Status

```python
# Get only active stacks (exclude deleted)
active_stacks = cfn.describe_stacks()['Stacks']
active_stacks = [s for s in active_stacks if 'DELETE' not in s['StackStatus']]

# Get failed stacks
failed_stacks = [s for s in active_stacks if 'FAILED' in s['StackStatus']]

# Get stacks currently updating
updating_stacks = [s for s in active_stacks if 'IN_PROGRESS' in s['StackStatus']]
```

### Multi-Region Stack Discovery

```python
def get_all_stacks_all_regions() -> Dict[str, List[Dict]]:
    """Get stacks across all AWS regions."""
    ec2 = boto3.client('ec2')
    regions = [r['RegionName'] for r in ec2.describe_regions()['Regions']]

    all_stacks = {}
    for region in regions:
        try:
            cfn = boto3.client('cloudformation', region_name=region)
            stacks = cfn.describe_stacks()['Stacks']
            all_stacks[region] = stacks
        except Exception as e:
            print(f"Error in {region}: {e}")

    return all_stacks
```

---

## Stack Status and Health Monitoring

### Stack Statuses

| Status | Category | Description |
|--------|----------|-------------|
| `CREATE_IN_PROGRESS` | Transitional | Stack creation in progress |
| `CREATE_COMPLETE` | Stable | Stack created successfully |
| `CREATE_FAILED` | Failed | Stack creation failed (rolled back) |
| `ROLLBACK_IN_PROGRESS` | Transitional | Rolling back failed creation |
| `ROLLBACK_COMPLETE` | Failed | Creation rolled back successfully |
| `UPDATE_IN_PROGRESS` | Transitional | Stack update in progress |
| `UPDATE_COMPLETE` | Stable | Stack updated successfully |
| `UPDATE_ROLLBACK_IN_PROGRESS` | Transitional | Rolling back failed update |
| `UPDATE_ROLLBACK_COMPLETE` | Failed | Update rolled back successfully |
| `DELETE_IN_PROGRESS` | Transitional | Stack deletion in progress |
| `DELETE_COMPLETE` | Deleted | Stack deleted successfully |
| `DELETE_FAILED` | Failed | Stack deletion failed |

### Health Monitoring

```python
def monitor_stack_health() -> Dict:
    """Monitor health of all stacks."""
    cfn = boto3.client('cloudformation')
    stacks = cfn.describe_stacks()['Stacks']

    health_report = {
        'healthy': [],
        'unhealthy': [],
        'in_progress': []
    }

    for stack in stacks:
        status = stack['StackStatus']
        stack_info = {
            'name': stack['StackName'],
            'status': status,
            'age': (datetime.now() - stack['CreationTime'].replace(tzinfo=None)).days
        }

        if 'COMPLETE' in status and 'ROLLBACK' not in status:
            health_report['healthy'].append(stack_info)
        elif 'FAILED' in status or 'ROLLBACK' in status:
            health_report['unhealthy'].append(stack_info)
        elif 'IN_PROGRESS' in status:
            health_report['in_progress'].append(stack_info)

    return health_report
```

### Stack Events

Track detailed stack operations:

```python
def get_stack_events(stack_name: str, limit: int = 50) -> List[Dict]:
    """Get recent events for a stack."""
    cfn = boto3.client('cloudformation')

    events = []
    paginator = cfn.get_paginator('describe_stack_events')

    for page in paginator.paginate(StackName=stack_name):
        for event in page['StackEvents'][:limit]:
            events.append({
                'timestamp': event['Timestamp'],
                'resource_type': event.get('ResourceType'),
                'logical_id': event.get('LogicalResourceId'),
                'status': event['ResourceStatus'],
                'reason': event.get('ResourceStatusReason', '')
            })

    return events
```

---

## Drift Detection

### What is Drift?

**Drift** occurs when resources managed by CloudFormation are modified outside of CloudFormation (manual changes via console, CLI, or other tools):

```
CloudFormation Template:     Actual Resource:
InstanceType: t3.medium      InstanceType: t3.large  ← DRIFT DETECTED
```

### Detect Drift

```python
def detect_drift(stack_name: str) -> Dict:
    """Detect drift for a stack."""
    cfn = boto3.client('cloudformation')

    # Initiate drift detection
    response = cfn.detect_stack_drift(StackName=stack_name)
    drift_id = response['StackDriftDetectionId']

    # Wait for detection to complete
    waiter = cfn.get_waiter('stack_drift_detection_complete')
    waiter.wait(StackDriftDetectionId=drift_id)

    # Get results
    drift_result = cfn.describe_stack_drift_detection_status(
        StackDriftDetectionId=drift_id
    )

    return {
        'stack_name': stack_name,
        'drift_status': drift_result['StackDriftStatus'],
        'drifted_resources': drift_result['DriftedStackResourceCount'],
        'detection_time': drift_result['Timestamp']
    }
```

### Drift Statuses

| Status | Description |
|--------|-------------|
| `IN_SYNC` | No drift detected |
| `DRIFTED` | Drift detected in one or more resources |
| `NOT_CHECKED` | Drift detection has not been run |
| `UNKNOWN` | Drift status cannot be determined |

### Get Drifted Resources

```python
def get_drifted_resources(stack_name: str) -> List[Dict]:
    """Get list of resources with drift."""
    cfn = boto3.client('cloudformation')

    # First, detect drift
    drift_result = detect_drift(stack_name)

    if drift_result['drift_status'] != 'DRIFTED':
        return []

    # Get drifted resources
    response = cfn.describe_stack_resource_drifts(
        StackName=stack_name,
        StackResourceDriftStatusFilters=['MODIFIED', 'DELETED']
    )

    drifted = []
    for drift in response['StackResourceDrifts']:
        drifted.append({
            'logical_id': drift['LogicalResourceId'],
            'resource_type': drift['ResourceType'],
            'physical_id': drift['PhysicalResourceId'],
            'drift_status': drift['StackResourceDriftStatus'],
            'expected_properties': drift.get('ExpectedProperties'),
            'actual_properties': drift.get('ActualProperties'),
            'property_differences': drift.get('PropertyDifferences', [])
        })

    return drifted
```

### Automated Drift Remediation

```python
def auto_remediate_drift(stack_name: str):
    """Automatically fix drift by updating stack to match template."""
    cfn = boto3.client('cloudformation')

    # Detect drift
    drifted_resources = get_drifted_resources(stack_name)

    if not drifted_resources:
        print(f"No drift detected for {stack_name}")
        return

    # Update stack to enforce template configuration
    # This will revert manual changes
    cfn.update_stack(
        StackName=stack_name,
        UsePreviousTemplate=True,
        Capabilities=['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
    )

    print(f"Remediating drift for {stack_name}: {len(drifted_resources)} resources")
```

---

## StackSets for Multi-Account

### What are StackSets?

**StackSets** deploy stacks across multiple accounts and regions simultaneously:

```
┌────────────────────────────────────────────────┐
│     Management Account                         │
│                                                 │
│  ┌──────────────────────────────────────────┐ │
│  │  StackSet: chimera-baseline              │ │
│  │  - Config enabling                       │ │
│  │  - Resource Explorer setup               │ │
│  │  - CloudWatch dashboards                 │ │
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
│ Stack   │      │ Stack   │       │ Stack   │
│Instance │      │Instance │       │Instance │
└─────────┘      └─────────┘       └─────────┘
```

### Create StackSet

```python
def create_stackset(template_body: str, stack_set_name: str):
    """Create a StackSet for multi-account deployment."""
    cfn = boto3.client('cloudformation')

    cfn.create_stack_set(
        StackSetName=stack_set_name,
        Description='Chimera baseline infrastructure',
        TemplateBody=template_body,
        Capabilities=['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'],
        PermissionModel='SERVICE_MANAGED',  # For Organizations
        AutoDeployment={
            'Enabled': True,  # Auto-deploy to new accounts
            'RetainStacksOnAccountRemoval': False
        },
        Tags=[
            {'Key': 'Project', 'Value': 'chimera'},
            {'Key': 'Purpose', 'Value': 'baseline-infrastructure'}
        ]
    )
```

### Deploy to Accounts

```python
def deploy_stackset_to_org(stack_set_name: str):
    """Deploy StackSet to all accounts in organization."""
    cfn = boto3.client('cloudformation')
    organizations = boto3.client('organizations')

    # Get all organizational units
    root_id = organizations.list_roots()['Roots'][0]['Id']

    # Deploy to entire organization
    cfn.create_stack_instances(
        StackSetName=stack_set_name,
        DeploymentTargets={
            'OrganizationalUnitIds': [root_id]
        },
        Regions=['us-east-1', 'us-west-2', 'eu-central-1']  # Target regions
    )
```

### Monitor StackSet Operations

```python
def get_stackset_status(stack_set_name: str) -> Dict:
    """Get status of StackSet deployment."""
    cfn = boto3.client('cloudformation')

    # Get StackSet info
    stackset = cfn.describe_stack_set(StackSetName=stack_set_name)['StackSet']

    # Get stack instances
    instances = cfn.list_stack_instances(StackSetName=stack_set_name)

    status_summary = {
        'total_instances': len(instances['Summaries']),
        'current': 0,
        'outdated': 0,
        'failed': 0
    }

    for instance in instances['Summaries']:
        status = instance['StackInstanceStatus']['DetailedStatus']
        if status == 'CURRENT':
            status_summary['current'] += 1
        elif status == 'OUTDATED':
            status_summary['outdated'] += 1
        else:
            status_summary['failed'] += 1

    return {
        'stackset_name': stack_set_name,
        'status': stackset['Status'],
        'instances': status_summary
    }
```

---

## Change Sets and Update Tracking

### What are Change Sets?

**Change Sets** preview infrastructure changes before applying them:

```
Current State          Change Set           New State
─────────────         ────────────         ─────────────
t3.medium    ───▶    t3.large   ───▶     t3.large
             preview            apply
```

### Create Change Set

```python
def create_change_set(stack_name: str, template_body: str) -> str:
    """Create a change set to preview updates."""
    cfn = boto3.client('cloudformation')

    response = cfn.create_change_set(
        StackName=stack_name,
        TemplateBody=template_body,
        ChangeSetName=f'{stack_name}-changeset-{int(time.time())}',
        ChangeSetType='UPDATE',
        Capabilities=['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM']
    )

    return response['Id']
```

### Review Change Set

```python
def review_change_set(change_set_name: str, stack_name: str) -> List[Dict]:
    """Review changes in a change set."""
    cfn = boto3.client('cloudformation')

    # Wait for change set to be created
    waiter = cfn.get_waiter('change_set_create_complete')
    waiter.wait(ChangeSetName=change_set_name, StackName=stack_name)

    # Get change set details
    response = cfn.describe_change_set(
        ChangeSetName=change_set_name,
        StackName=stack_name
    )

    changes = []
    for change in response['Changes']:
        resource_change = change['ResourceChange']
        changes.append({
            'action': resource_change['Action'],  # Add, Modify, Remove
            'logical_id': resource_change['LogicalResourceId'],
            'resource_type': resource_change['ResourceType'],
            'replacement': resource_change.get('Replacement', 'False'),
            'details': resource_change.get('Details', [])
        })

    return changes
```

### Execute Change Set

```python
def execute_change_set(change_set_name: str, stack_name: str):
    """Execute a change set."""
    cfn = boto3.client('cloudformation')

    cfn.execute_change_set(
        ChangeSetName=change_set_name,
        StackName=stack_name
    )

    # Wait for update to complete
    waiter = cfn.get_waiter('stack_update_complete')
    waiter.wait(StackName=stack_name)
```

---

## Resource Import and Adoption

### Import Existing Resources

CloudFormation can **adopt** existing resources:

```python
def import_existing_resource(stack_name: str, template_body: str, resources_to_import: List[Dict]):
    """Import existing AWS resources into CloudFormation management."""
    cfn = boto3.client('cloudformation')

    # Create change set for import
    change_set = cfn.create_change_set(
        StackName=stack_name,
        ChangeSetName=f'{stack_name}-import-{int(time.time())}',
        ChangeSetType='IMPORT',
        TemplateBody=template_body,
        ResourcesToImport=resources_to_import,
        Capabilities=['CAPABILITY_IAM']
    )

    # Execute import
    cfn.execute_change_set(
        ChangeSetName=change_set['Id'],
        StackName=stack_name
    )
```

### Example: Import EC2 Instance

```python
# Import existing EC2 instance
resources_to_import = [
    {
        'ResourceType': 'AWS::EC2::Instance',
        'LogicalResourceId': 'WebServer',
        'ResourceIdentifier': {
            'InstanceId': 'i-0abc123def456789'
        }
    }
]

template = """
Resources:
  WebServer:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: t3.medium
      ImageId: ami-12345678
"""

import_existing_resource('chimera-web-stack', template, resources_to_import)
```

---

## Integration Patterns

### 1. EventBridge Integration

React to CloudFormation stack events:

```python
events = boto3.client('events')

# Create rule for stack failures
events.put_rule(
    Name='chimera-stack-failures',
    EventPattern=json.dumps({
        'source': ['aws.cloudformation'],
        'detail-type': ['CloudFormation Stack Status Change'],
        'detail': {
            'status-details': {
                'status': [
                    'CREATE_FAILED',
                    'UPDATE_FAILED',
                    'DELETE_FAILED',
                    'ROLLBACK_COMPLETE'
                ]
            }
        }
    }),
    State='ENABLED'
)

# Target Lambda for alerting
events.put_targets(
    Rule='chimera-stack-failures',
    Targets=[{
        'Id': '1',
        'Arn': 'arn:aws:lambda:us-east-1:123456789012:function:ChimeraStackFailureHandler'
    }]
)
```

### 2. Config Integration

Track CloudFormation-managed resources in Config:

```python
def get_stack_resource_config(stack_name: str) -> Dict:
    """Get Config data for all resources in a stack."""
    cfn = boto3.client('cloudformation')
    config = boto3.client('config')

    # Get stack resources
    resources = cfn.list_stack_resources(StackName=stack_name)['StackResourceSummaries']

    resource_configs = {}
    for resource in resources:
        resource_type = resource['ResourceType']
        physical_id = resource['PhysicalResourceId']

        try:
            # Get detailed config from AWS Config
            config_data = config.get_resource_config_history(
                resourceType=resource_type,
                resourceId=physical_id,
                limit=1
            )
            resource_configs[resource['LogicalResourceId']] = config_data
        except Exception as e:
            print(f"Could not get config for {resource['LogicalResourceId']}: {e}")

    return resource_configs
```

### 3. Resource Explorer Integration

Find all CloudFormation-managed resources:

```python
def find_cfn_managed_resources() -> List[Dict]:
    """Find all resources managed by CloudFormation."""
    explorer = boto3.client('resource-explorer-2')

    # Search for resources with CloudFormation tags
    response = explorer.search(
        QueryString='tag.aws:cloudformation:stack-name',
        MaxResults=1000
    )

    return response['Resources']
```

---

## Pricing Model

### CloudFormation Costs

| Feature | Cost |
|---------|------|
| **Stack operations** | Free (create, update, delete) |
| **Stack creation** | Free |
| **Drift detection** | Free (first 1,000 resources/month) |
| **Drift detection** | $0.001 per resource after 1,000 |
| **StackSets** | Free |
| **Handler operations** | $0.00009 per handler operation (for custom resources) |

### Cost Optimization

- **Free for most use cases** -- standard stack operations have no charge
- **Drift detection** -- first 1,000 resources/month free
- **Use StackSets** -- no additional cost for multi-account deployments

---

## Use Cases for Chimera

### 1. Stack Inventory

```python
class ChimeraStackInventory:
    def __init__(self):
        self.cfn = boto3.client('cloudformation')

    def get_all_stacks_with_resources(self) -> Dict:
        """Get complete stack inventory with resources."""
        stacks = self.cfn.describe_stacks()['Stacks']

        inventory = {}
        for stack in stacks:
            stack_name = stack['StackName']
            resources = self.cfn.list_stack_resources(StackName=stack_name)

            inventory[stack_name] = {
                'status': stack['StackStatus'],
                'creation_time': stack['CreationTime'],
                'tags': {t['Key']: t['Value'] for t in stack.get('Tags', [])},
                'resources': [
                    {
                        'logical_id': r['LogicalResourceId'],
                        'type': r['ResourceType'],
                        'physical_id': r['PhysicalResourceId']
                    }
                    for r in resources['StackResourceSummaries']
                ]
            }

        return inventory
```

### 2. Drift Monitoring

```python
def monitor_all_stacks_for_drift():
    """Monitor all stacks for drift and alert on detection."""
    cfn = boto3.client('cloudformation')
    stacks = cfn.describe_stacks()['Stacks']

    drifted_stacks = []
    for stack in stacks:
        stack_name = stack['StackName']

        # Detect drift
        drift_result = detect_drift(stack_name)

        if drift_result['drift_status'] == 'DRIFTED':
            drifted_resources = get_drifted_resources(stack_name)
            drifted_stacks.append({
                'stack_name': stack_name,
                'drifted_resource_count': len(drifted_resources),
                'drifted_resources': drifted_resources
            })

    return drifted_stacks
```

### 3. Infrastructure Dependency Graph

```python
def build_stack_dependency_graph() -> Dict:
    """Build dependency graph of stacks (nested stacks, cross-stack refs)."""
    cfn = boto3.client('cloudformation')
    stacks = cfn.describe_stacks()['Stacks']

    dependency_graph = {}
    for stack in stacks:
        stack_name = stack['StackName']
        resources = cfn.list_stack_resources(StackName=stack_name)

        # Find nested stacks
        nested_stacks = [
            r['PhysicalResourceId']
            for r in resources['StackResourceSummaries']
            if r['ResourceType'] == 'AWS::CloudFormation::Stack'
        ]

        # Find cross-stack references (outputs used by other stacks)
        outputs = stack.get('Outputs', [])
        exported_outputs = [o['OutputKey'] for o in outputs if 'ExportName' in o]

        dependency_graph[stack_name] = {
            'nested_stacks': nested_stacks,
            'exported_outputs': exported_outputs
        }

    return dependency_graph
```

### 4. Automated Rollback on Failure

```python
def auto_rollback_failed_stacks():
    """Automatically rollback failed stack updates."""
    cfn = boto3.client('cloudformation')
    stacks = cfn.describe_stacks()['Stacks']

    for stack in stacks:
        if 'ROLLBACK_COMPLETE' in stack['StackStatus']:
            stack_name = stack['StackName']
            print(f"Rolling back {stack_name}")

            # Delete failed stack and redeploy
            cfn.delete_stack(StackName=stack_name)

            # Wait for deletion
            waiter = cfn.get_waiter('stack_delete_complete')
            waiter.wait(StackName=stack_name)

            # Redeploy with previous known-good template
            # ... (retrieve from S3 or Git)
```

### 5. Self-Modifying Infrastructure

```python
def chimera_self_modify_infrastructure(stack_name: str, optimizations: Dict):
    """Chimera modifies its own infrastructure based on learned patterns."""
    cfn = boto3.client('cloudformation')

    # Get current template
    template = cfn.get_template(StackName=stack_name)['TemplateBody']

    # Apply optimizations (e.g., scale resources based on usage)
    modified_template = apply_optimizations(template, optimizations)

    # Create change set to preview
    change_set_id = create_change_set(stack_name, modified_template)
    changes = review_change_set(change_set_id, stack_name)

    # Execute if safe
    if is_safe_to_execute(changes):
        execute_change_set(change_set_id, stack_name)
    else:
        print(f"Changes deemed unsafe: {changes}")
```

---

## Code Examples

### Complete Example: Stack Manager

```python
import boto3
import json
from typing import List, Dict
from datetime import datetime

class ChimeraStackManager:
    """Manage CloudFormation stacks for Chimera."""

    def __init__(self, region='us-east-1'):
        self.cfn = boto3.client('cloudformation', region_name=region)
        self.cloudwatch = boto3.client('cloudwatch', region_name=region)

    def get_stack_inventory(self) -> Dict:
        """Get complete stack inventory."""
        stacks = self.cfn.describe_stacks()['Stacks']

        inventory = {
            'total_stacks': len(stacks),
            'by_status': {},
            'stacks': []
        }

        for stack in stacks:
            status = stack['StackStatus']
            inventory['by_status'][status] = inventory['by_status'].get(status, 0) + 1

            inventory['stacks'].append({
                'name': stack['StackName'],
                'status': status,
                'creation_time': stack['CreationTime'],
                'tags': {t['Key']: t['Value'] for t in stack.get('Tags', [])}
            })

        return inventory

    def detect_drift_all_stacks(self) -> List[Dict]:
        """Detect drift across all stacks."""
        stacks = self.cfn.describe_stacks()['Stacks']
        drifted = []

        for stack in stacks:
            stack_name = stack['StackName']

            try:
                drift_result = detect_drift(stack_name)
                if drift_result['drift_status'] == 'DRIFTED':
                    drifted.append(drift_result)
            except Exception as e:
                print(f"Could not detect drift for {stack_name}: {e}")

        return drifted

    def get_stack_health(self, stack_name: str) -> Dict:
        """Get health status of a stack."""
        stack = self.cfn.describe_stacks(StackName=stack_name)['Stacks'][0]
        resources = self.cfn.list_stack_resources(StackName=stack_name)

        failed_resources = [
            r for r in resources['StackResourceSummaries']
            if 'FAILED' in r['ResourceStatus']
        ]

        return {
            'stack_name': stack_name,
            'status': stack['StackStatus'],
            'healthy': len(failed_resources) == 0,
            'failed_resources': failed_resources,
            'total_resources': len(resources['StackResourceSummaries'])
        }

    def publish_metrics(self, inventory: Dict):
        """Publish stack metrics to CloudWatch."""
        for status, count in inventory['by_status'].items():
            self.cloudwatch.put_metric_data(
                Namespace='Chimera/CloudFormation',
                MetricData=[{
                    'MetricName': 'StackCount',
                    'Dimensions': [{'Name': 'Status', 'Value': status}],
                    'Value': count,
                    'Unit': 'Count',
                    'Timestamp': datetime.utcnow()
                }]
            )

# Usage
manager = ChimeraStackManager()
inventory = manager.get_stack_inventory()
print(json.dumps(inventory, indent=2, default=str))

drifted_stacks = manager.detect_drift_all_stacks()
print(f"Drifted stacks: {len(drifted_stacks)}")

manager.publish_metrics(inventory)
```

---

## Best Practices

### 1. Use Tags Consistently

Tag all stacks for organization:

```python
cfn.create_stack(
    StackName='chimera-web-app',
    TemplateBody=template,
    Tags=[
        {'Key': 'Project', 'Value': 'chimera'},
        {'Key': 'Environment', 'Value': 'production'},
        {'Key': 'Owner', 'Value': 'platform-team'},
        {'Key': 'CostCenter', 'Value': 'engineering'}
    ]
)
```

### 2. Enable Drift Detection Regularly

```python
# Run drift detection daily
def daily_drift_scan():
    stacks = cfn.describe_stacks()['Stacks']
    for stack in stacks:
        detect_drift(stack['StackName'])
```

### 3. Use StackSets for Multi-Account

```python
# Deploy baseline infrastructure to all accounts
create_stackset(baseline_template, 'chimera-baseline')
deploy_stackset_to_org('chimera-baseline')
```

### 4. Preview Changes with Change Sets

```python
# Always preview before applying
change_set_id = create_change_set(stack_name, new_template)
changes = review_change_set(change_set_id, stack_name)

if user_approves(changes):
    execute_change_set(change_set_id, stack_name)
```

### 5. Monitor Stack Events

```python
# Subscribe to stack events via EventBridge
# Alert on failures, completions, and drift
```

---

## Limitations

### 1. Not All Resources Supported

CloudFormation supports **1,000+ resource types**, but not all AWS services.

### 2. Drift Detection Limitations

- Not all resource properties support drift detection
- Some resources cannot be drift-detected (e.g., S3 bucket policies)
- Detection takes time (minutes for large stacks)

### 3. StackSet Quotas

- **Max concurrent operations:** 3,500
- **Max stack instances per StackSet:** 5,000
- **Max StackSets per administrator account:** 100

### 4. Template Size Limits

- **Max template body size:** 51,200 bytes (direct upload)
- **Max template via S3:** 1 MB
- **Max parameters:** 200
- **Max outputs:** 200

---

## Key Takeaways

1. **CloudFormation provides architectural context** that Config and Resource Explorer lack -- it knows which resources form a cohesive application.

2. **Drift detection is critical** for maintaining infrastructure-as-code discipline in environments with manual changes.

3. **StackSets enable multi-account management** with automatic deployment to new accounts.

4. **Change sets provide safety** by previewing infrastructure changes before applying them.

5. **Stack-based organization** makes it easy to understand resource relationships and dependencies.

6. **Integration with EventBridge** enables real-time reaction to stack events.

7. **Free for most operations** -- only drift detection has costs (after first 1,000 resources/month).

8. **Resource import** allows gradual adoption of CloudFormation for existing infrastructure.

9. **Combine with Config and Resource Explorer** for complete account intelligence: CloudFormation (architecture) + Config (history) + Explorer (fast search).

10. **Chimera's self-evolution** can leverage CloudFormation to understand current architecture and safely modify infrastructure programmatically.

---

## Sources

### AWS Official Documentation
- [What is AWS CloudFormation?](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/Welcome.html)
- [Working with Stacks](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stacks.html)
- [Detecting Unmanaged Configuration Changes](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html)
- [Working with StackSets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/what-is-cfnstacksets.html)
- [CloudFormation Pricing](https://aws.amazon.com/cloudformation/pricing/)
- [Change Sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html)
- [Resource Import](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import.html)

### AWS API Reference
- [CloudFormation API Reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/Welcome.html)
- [DetectStackDrift](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DetectStackDrift.html)
- [CreateChangeSet](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateChangeSet.html)

