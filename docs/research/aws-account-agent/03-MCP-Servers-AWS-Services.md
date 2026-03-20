# MCP Servers for AWS Services

> **Research Date:** 2026-03-20
> **Task:** chimera-83f9
> **Agent:** builder-mcp-orch
> **Status:** Complete
> **Series:** AWS Account Agent Integration (Part 3 of 4)

---

## Table of Contents

- [Executive Summary](#executive-summary)
- [AWS Services as First-Class Agent Tools](#aws-services-as-first-class-agent-tools)
- [Existing AWS MCP Servers](#existing-aws-mcp-servers)
- [Building Custom AWS MCP Servers](#building-custom-aws-mcp-servers)
- [AWS SDK Integration Patterns](#aws-sdk-integration-patterns)
- [Security and IAM Scoping](#security-and-iam-scoping)
- [Multi-Region Operations](#multi-region-operations)
- [Recommended AWS Services for Agents](#recommended-aws-services-for-agents)
- [Implementation Architecture](#implementation-architecture)
- [Key Takeaways](#key-takeaways)

---

## Executive Summary

AWS Chimera agents need deep integration with AWS services to automate cloud operations. This research examines how to expose AWS services as MCP tools, enabling agents to:

1. **Manage Infrastructure**: Create, modify, and delete AWS resources (EC2, Lambda, RDS, etc.)
2. **Query State**: Inspect resource configurations, logs, and metrics
3. **Orchestrate Workflows**: Chain AWS service operations for complex tasks
4. **Monitor and Alert**: React to CloudWatch alarms and EventBridge events

**Key Findings:**

- **MCP as AWS Service Bridge**: MCP protocol provides a standardized interface for agents to interact with 200+ AWS services
- **Existing Ecosystem**: `aws-knowledge-mcp-server` and `aws-diagram-mcp-server` provide foundation; custom servers needed for operational tools
- **Security Model**: Per-tenant IAM roles with least-privilege policies, enforced through Cedar at MCP Gateway layer
- **SDK Options**: boto3 (Python) for Lambda-based tools, AWS SDK v3 (TypeScript) for AgentCore Runtime tools
- **Multi-Region**: MCP servers support region-specific operations via configuration or tool parameters

---

## AWS Services as First-Class Agent Tools

### The Vision

Every AWS service is accessible via API — agents should be able to interact with any of them to complete tasks. Instead of hardcoding AWS SDK calls into agent logic, expose services as **MCP tools** that agents discover and invoke dynamically.

**Example Agent Workflow:**

```
User: "Our API Lambda is experiencing high error rates. Investigate and fix."

Agent thinks:
1. Query CloudWatch Logs for recent errors
   → Tool: cloudwatch:get_log_insights

2. Check Lambda function configuration
   → Tool: lambda:get_function

3. Inspect recent deployments
   → Tool: lambda:list_versions

4. Review IAM permissions
   → Tool: iam:get_role_policy

5. Identify issue: timeout too low for external API calls

6. Update Lambda timeout
   → Tool: lambda:update_function_configuration

7. Verify fix with test invocation
   → Tool: lambda:invoke
```

All AWS operations happen through standardized MCP tool calls, logged for audit, and scoped by tenant IAM permissions.

### Benefits of MCP-Based AWS Integration

| Benefit | Description |
|---------|-------------|
| **Standardization** | All AWS services exposed through uniform MCP protocol (JSON-RPC 2.0) |
| **Discovery** | Agents query available AWS tools via `tools/list`, no hardcoded service knowledge |
| **Multi-Tenancy** | IAM roles enforce per-tenant access control at MCP Gateway layer |
| **Auditability** | All AWS operations logged through MCP Gateway for compliance |
| **Versioning** | AWS SDK updates don't break agents — MCP tool schemas evolve independently |
| **Portability** | Same MCP tools work across AgentCore Runtime, Lambda, ECS, or local development |

---

## Existing AWS MCP Servers

### 1. aws-knowledge-mcp-server

**Purpose:** Provides AI-powered documentation and best practice recommendations for AWS services.

**Available Tools:**

```typescript
interface AwsKnowledgeTools {
  // Get AWS service documentation
  aws___read_documentation: {
    service: string;      // e.g., "lambda", "dynamodb"
    topic: string;        // e.g., "configuration", "pricing"
  };

  // Search AWS docs semantically
  aws___search_documentation: {
    query: string;        // Natural language query
    services?: string[];  // Filter to specific services
    max_results?: number; // Default: 10
  };

  // Get regional service availability
  aws___get_regional_availability: {
    service: string;
    feature?: string;     // Optional: specific feature
  };

  // List all AWS regions
  aws___list_regions: {
    service?: string;     // Filter to regions supporting service
  };

  // AI recommendations for architecture
  aws___recommend: {
    use_case: string;     // e.g., "serverless API", "data lake"
    constraints?: {
      budget?: string;
      latency?: string;
      compliance?: string[];
    };
  };

  // Retrieve agent standard operating procedures
  aws___retrieve_agent_sop: {
    task_type: string;    // e.g., "deploy-lambda", "create-vpc"
  };
}
```

**Use Cases:**
- Agent needs to understand AWS service capabilities before using them
- Selecting optimal services for a given workload
- Retrieving deployment best practices
- Checking regional availability before provisioning

**Integration with Chimera:**

```typescript
// Chimera agent queries AWS knowledge before deploying infrastructure
const recommendation = await mcpClient.callTool('aws___recommend', {
  use_case: 'multi-tenant SaaS with agent runtime',
  constraints: {
    budget: 'moderate',
    latency: 'low (<100ms p99)',
    compliance: ['SOC2', 'HIPAA']
  }
});

// Returns architecture recommendation:
// {
//   compute: { primary: 'ECS Fargate', reasoning: '...' },
//   database: { primary: 'DynamoDB', reasoning: '...' },
//   storage: { primary: 'S3', secondary: 'EFS', reasoning: '...' },
//   estimated_monthly_cost: '$5,000 - $15,000'
// }
```

### 2. awslabs/aws-diagram-mcp-server

**Purpose:** Generates architecture diagrams from AWS resource configurations or natural language descriptions.

**Available Tools:**

```typescript
interface AwsDiagramTools {
  // Generate architecture diagram
  generate_diagram: {
    description?: string;           // Natural language architecture description
    resources?: AwsResource[];      // Existing AWS resources to diagram
    format: 'svg' | 'png' | 'pdf'; // Output format
    style?: 'minimal' | 'detailed'; // Diagram style
  };

  // List available AWS service icons
  list_icons: {
    category?: string;  // e.g., "compute", "storage", "networking"
  };

  // Get example diagrams
  get_diagram_examples: {
    pattern: string;    // e.g., "three-tier-web-app", "data-pipeline"
  };
}
```

**Use Cases:**
- Generate architecture diagrams for documentation
- Visualize existing infrastructure
- Design new architectures with agent guidance
- Create compliance diagrams (data flow, security zones)

**Integration with Chimera:**

```typescript
// Agent generates diagram after deploying infrastructure
const diagram = await mcpClient.callTool('generate_diagram', {
  description: `
    Multi-tenant SaaS architecture with:
    - ALB routing to ECS Fargate tasks
    - DynamoDB tables with per-tenant partitions
    - S3 buckets for artifact storage
    - CloudWatch for observability
  `,
  format: 'svg',
  style: 'detailed'
});

// Returns SVG diagram URL or base64-encoded image
```

---

## Building Custom AWS MCP Servers

### Architecture Patterns

#### Pattern 1: SDK Wrapper MCP Server

**Concept:** Thin MCP server that wraps AWS SDK calls, exposing them as tools.

```
┌─────────────────────────────────────────────┐
│         MCP Server (Python/TypeScript)       │
│  ┌───────────────────────────────────────┐  │
│  │  Tool Definitions (MCP protocol)      │  │
│  │  - lambda:list_functions              │  │
│  │  - lambda:get_function                │  │
│  │  - lambda:update_function_config      │  │
│  └───────────────┬───────────────────────┘  │
│                  │                           │
│  ┌───────────────▼───────────────────────┐  │
│  │  boto3 / AWS SDK v3                   │  │
│  │  - Lambda client                      │  │
│  │  - IAM role with scoped permissions   │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

**Python Example (boto3):**

```python
# mcp-aws-lambda/server.py
import boto3
from mcp.server import Server
from mcp.server.models import Tool, TextContent

# Initialize boto3 Lambda client
lambda_client = boto3.client('lambda')

# Create MCP server
mcp = Server("aws-lambda")

@mcp.tool()
async def lambda__list_functions(
    max_results: int = 50,
    region: str = "us-east-1"
) -> list[dict]:
    """List all Lambda functions in the account."""

    # Call AWS API
    response = lambda_client.list_functions(MaxItems=max_results)

    # Extract relevant fields
    functions = [
        {
            "name": f["FunctionName"],
            "runtime": f["Runtime"],
            "memory": f["MemorySize"],
            "timeout": f["Timeout"],
            "last_modified": f["LastModified"]
        }
        for f in response["Functions"]
    ]

    return [TextContent(type="text", text=str(functions))]

@mcp.tool()
async def lambda__get_function(function_name: str) -> dict:
    """Get detailed configuration for a Lambda function."""

    response = lambda_client.get_function(FunctionName=function_name)

    config = response["Configuration"]
    return [TextContent(
        type="text",
        text=f"""
Function: {config['FunctionName']}
Runtime: {config['Runtime']}
Memory: {config['MemorySize']} MB
Timeout: {config['Timeout']} seconds
IAM Role: {config['Role']}
Environment Variables: {config.get('Environment', {}).get('Variables', {})}
        """
    )]

@mcp.tool()
async def lambda__update_function_configuration(
    function_name: str,
    timeout: int | None = None,
    memory_size: int | None = None,
    environment: dict | None = None
) -> dict:
    """Update Lambda function configuration."""

    update_params = {"FunctionName": function_name}

    if timeout:
        update_params["Timeout"] = timeout
    if memory_size:
        update_params["MemorySize"] = memory_size
    if environment:
        update_params["Environment"] = {"Variables": environment}

    response = lambda_client.update_function_configuration(**update_params)

    return [TextContent(
        type="text",
        text=f"Updated {function_name}: timeout={timeout}, memory={memory_size}"
    )]

# Run MCP server
if __name__ == "__main__":
    mcp.run()
```

**TypeScript Example (AWS SDK v3):**

```typescript
// mcp-aws-dynamodb/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { DynamoDBClient, ListTablesCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

// Initialize DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });

// Create MCP server
const server = new Server({
  name: 'aws-dynamodb',
  version: '1.0.0'
});

// Tool: List DynamoDB tables
server.tool(
  'dynamodb__list_tables',
  'List all DynamoDB tables in the region',
  {
    limit: {
      type: 'number',
      description: 'Maximum number of tables to return',
      default: 100
    }
  },
  async (args) => {
    const command = new ListTablesCommand({ Limit: args.limit });
    const response = await dynamodb.send(command);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.TableNames, null, 2)
        }
      ]
    };
  }
);

// Tool: Describe table
server.tool(
  'dynamodb__describe_table',
  'Get detailed information about a DynamoDB table',
  {
    table_name: {
      type: 'string',
      description: 'Name of the DynamoDB table',
      required: true
    }
  },
  async (args) => {
    const command = new DescribeTableCommand({ TableName: args.table_name });
    const response = await dynamodb.send(command);

    const table = response.Table;

    return {
      content: [
        {
          type: 'text',
          text: `
Table: ${table.TableName}
Status: ${table.TableStatus}
Item Count: ${table.ItemCount}
Size: ${table.TableSizeBytes} bytes
Keys: ${JSON.stringify(table.KeySchema)}
GSIs: ${table.GlobalSecondaryIndexes?.length || 0}
          `.trim()
        }
      ]
    };
  }
);

// Start server
server.listen();
```

#### Pattern 2: CloudFormation/CDK Template Generator

**Concept:** MCP tools that generate IaC templates for deploying AWS resources.

```typescript
@mcp.tool()
async def iac__generate_lambda_stack(
    function_name: str,
    runtime: str,
    memory: int = 512,
    timeout: int = 30
) -> str:
    """Generate CloudFormation template for Lambda function."""

    template = {
        "AWSTemplateFormatVersion": "2010-09-09",
        "Resources": {
            "LambdaFunction": {
                "Type": "AWS::Lambda::Function",
                "Properties": {
                    "FunctionName": function_name,
                    "Runtime": runtime,
                    "MemorySize": memory,
                    "Timeout": timeout,
                    "Role": {"Fn::GetAtt": ["LambdaExecutionRole", "Arn"]},
                    "Code": {
                        "ZipFile": "# Lambda function code goes here"
                    }
                }
            },
            "LambdaExecutionRole": {
                "Type": "AWS::IAM::Role",
                "Properties": {
                    "AssumeRolePolicyDocument": {
                        "Statement": [{
                            "Effect": "Allow",
                            "Principal": {"Service": "lambda.amazonaws.com"},
                            "Action": "sts:AssumeRole"
                        }]
                    },
                    "ManagedPolicyArns": [
                        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
                    ]
                }
            }
        }
    }

    return [TextContent(type="text", text=json.dumps(template, indent=2))]
```

#### Pattern 3: Event-Driven MCP Server

**Concept:** MCP server that subscribes to EventBridge events and exposes them as resources.

```typescript
// MCP server exposes AWS events as resources
server.resource(
  'cloudwatch://alarms/high-cpu',
  'CloudWatch alarm for high CPU usage',
  async () => {
    // Query recent alarm state transitions
    const cloudwatch = new CloudWatchClient({});
    const command = new DescribeAlarmHistoryCommand({
      AlarmName: 'HighCPUAlarm',
      MaxRecords: 10
    });

    const response = await cloudwatch.send(command);

    return {
      uri: 'cloudwatch://alarms/high-cpu',
      mimeType: 'application/json',
      text: JSON.stringify(response.AlarmHistoryItems, null, 2)
    };
  }
);
```

---

## AWS SDK Integration Patterns

### boto3 (Python) for Lambda-Based Tools

**Use Case:** MCP servers running in AWS Lambda, triggered by AgentCore Gateway.

**Advantages:**
- Serverless: No infrastructure to manage
- Auto-scaling: Handles burst traffic
- IAM integration: Lambda execution role provides AWS credentials
- Cost-effective: Pay only for execution time

**Example Deployment:**

```python
# lambda_function.py (AWS Lambda handler)
import json
from mcp_aws_lambda.server import create_lambda_mcp_handler

# Create MCP handler from server definition
handler = create_lambda_mcp_handler(
    tools=[
        lambda__list_functions,
        lambda__get_function,
        lambda__update_function_configuration
    ]
)

def lambda_handler(event, context):
    """AWS Lambda handler that processes MCP requests."""

    # Parse MCP request from event
    mcp_request = json.loads(event['body'])

    # Process MCP request
    mcp_response = handler(mcp_request)

    # Return as HTTP response
    return {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(mcp_response)
    }
```

**IAM Role for Lambda:**

```yaml
# Lambda execution role with scoped AWS permissions
LambdaExecutionRole:
  Type: AWS::IAM::Role
  Properties:
    AssumeRolePolicyDocument:
      Statement:
        - Effect: Allow
          Principal:
            Service: lambda.amazonaws.com
          Action: sts:AssumeRole
    ManagedPolicyArns:
      - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    Policies:
      - PolicyName: LambdaOperations
        PolicyDocument:
          Statement:
            - Effect: Allow
              Action:
                - lambda:ListFunctions
                - lambda:GetFunction
                - lambda:UpdateFunctionConfiguration
              Resource: "*"
```

### AWS SDK v3 (TypeScript) for AgentCore Runtime Tools

**Use Case:** MCP servers running directly in AgentCore Runtime (Strands agents).

**Advantages:**
- Low latency: Direct SDK calls without Lambda cold starts
- Session state: Maintain AWS client connections across tool calls
- Complex workflows: Multi-step AWS operations in single session

**Example Integration:**

```typescript
// packages/core/src/tools/aws-ec2-tools.ts
import { EC2Client, DescribeInstancesCommand, StartInstancesCommand } from '@aws-sdk/client-ec2';
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';

export class AwsEc2Tools {
  private ec2Client: EC2Client;

  constructor(tenantId: string, region: string = 'us-east-1') {
    // Assume tenant-specific IAM role
    this.ec2Client = new EC2Client({
      region,
      credentials: fromTemporaryCredentials({
        params: {
          RoleArn: `arn:aws:iam::${AWS_ACCOUNT_ID}:role/TenantAgent-${tenantId}`,
          RoleSessionName: `chimera-agent-${tenantId}`
        }
      })
    });
  }

  async listInstances(filters?: Record<string, string>): Promise<any[]> {
    const command = new DescribeInstancesCommand({
      Filters: filters ? Object.entries(filters).map(([key, value]) => ({
        Name: key,
        Values: [value]
      })) : undefined
    });

    const response = await this.ec2Client.send(command);

    return response.Reservations?.flatMap(r => r.Instances || []) || [];
  }

  async startInstance(instanceId: string): Promise<void> {
    const command = new StartInstancesCommand({
      InstanceIds: [instanceId]
    });

    await this.ec2Client.send(command);
  }
}
```

---

## Security and IAM Scoping

### Multi-Tenant IAM Architecture

**Challenge:** Each tenant's agents must have scoped access to AWS resources, preventing cross-tenant data leakage.

**Solution:** Per-tenant IAM roles with least-privilege policies.

```
┌─────────────────────────────────────────────────┐
│          Chimera Agent (Tenant A)               │
│  ┌────────────────────────────────────────┐    │
│  │  MCP Gateway Client                    │    │
│  │  - Tenant ID: tenant-a                 │    │
│  └────────────────┬───────────────────────┘    │
└───────────────────┼─────────────────────────────┘
                    │ HTTPS (IAM SigV4)
                    │ X-Tenant-ID: tenant-a
┌───────────────────▼─────────────────────────────┐
│          AgentCore Gateway                      │
│  ┌────────────────────────────────────────┐    │
│  │  Cedar Policy Enforcement              │    │
│  │  - Validate tenant-a can invoke tool   │    │
│  └────────────────┬───────────────────────┘    │
└───────────────────┼─────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────┐
│          MCP AWS Lambda Server                  │
│  ┌────────────────────────────────────────┐    │
│  │  Assume Tenant Role                    │    │
│  │  sts:AssumeRole(TenantAgent-tenant-a)  │    │
│  └────────────────┬───────────────────────┘    │
│                   │                             │
│  ┌────────────────▼───────────────────────┐    │
│  │  boto3 with Tenant Credentials         │    │
│  │  - Access scoped to tenant-a resources │    │
│  └────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

### IAM Policy Template

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TenantScopedDynamoDB",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:UpdateItem"
      ],
      "Resource": "arn:aws:dynamodb:*:*:table/chimera-*",
      "Condition": {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["TENANT#${tenant_id}"]
        }
      }
    },
    {
      "Sid": "TenantScopedS3",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::chimera-artifacts/${tenant_id}/*"
    },
    {
      "Sid": "TenantScopedLambda",
      "Effect": "Allow",
      "Action": [
        "lambda:InvokeFunction"
      ],
      "Resource": "arn:aws:lambda:*:*:function:tenant-${tenant_id}-*"
    },
    {
      "Sid": "ReadOnlyCloudWatch",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics",
        "logs:FilterLogEvents",
        "logs:GetLogEvents"
      ],
      "Resource": "*",
      "Condition": {
        "StringLike": {
          "logs:LogGroupName": "/chimera/tenant-${tenant_id}/*"
        }
      }
    }
  ]
}
```

### Cedar Policy Integration

```cedar
// Cedar policy for MCP Gateway
permit(
  principal is TenantAgent,
  action == "invoke_tool",
  resource is MCPTool
)
when {
  // Tool must be in tenant's allowed list
  resource.tool_name in principal.allowed_tools &&

  // AWS tools require additional IAM scope validation
  (resource.tool_name.startsWith("lambda__") implies
    principal.aws_role_arn.contains(principal.tenant_id)) &&

  // Rate limiting
  principal.daily_tool_calls < principal.quota
};
```

---

## Multi-Region Operations

### Region-Aware Tool Parameters

MCP tools accept `region` parameter for cross-region operations:

```typescript
@mcp.tool()
async def ec2__list_instances(
    region: str = "us-east-1",
    filters: dict[str, str] | None = None
) -> list[dict]:
    """List EC2 instances in specified region."""

    # Create region-specific client
    ec2 = boto3.client('ec2', region_name=region)

    response = ec2.describe_instances(
        Filters=[{"Name": k, "Values": [v]} for k, v in (filters or {}).items()]
    )

    # ... process response
```

### Multi-Region Orchestration

Agents can fan out operations across regions:

```typescript
// Agent workflow: Deploy Lambda function to all regions
const regions = ['us-east-1', 'us-west-2', 'eu-central-1'];

const deployments = await Promise.all(
  regions.map(region =>
    mcpClient.callTool('lambda__create_function', {
      function_name: 'chimera-api-handler',
      runtime: 'python3.12',
      region: region,
      code_s3_bucket: `chimera-deployments-${region}`,
      code_s3_key: 'api-handler-v1.2.3.zip'
    })
  )
);

console.log(`Deployed to ${deployments.length} regions`);
```

---

## Recommended AWS Services for Agents

### Tier 1: Essential Agent Operations

| Service | MCP Tools | Use Cases |
|---------|-----------|-----------|
| **Lambda** | `lambda__*` | Invoke functions, deploy code, update configs |
| **DynamoDB** | `dynamodb__*` | Query tables, update items, manage GSIs |
| **S3** | `s3__*` | Store/retrieve artifacts, manage buckets |
| **CloudWatch Logs** | `logs__*` | Query logs, filter events, tail log streams |
| **IAM** | `iam__*` | Inspect roles/policies, generate credentials |

### Tier 2: Infrastructure Management

| Service | MCP Tools | Use Cases |
|---------|-----------|-----------|
| **EC2** | `ec2__*` | List instances, start/stop, modify security groups |
| **ECS** | `ecs__*` | Deploy tasks, update services, scale clusters |
| **RDS** | `rds__*` | Create databases, snapshots, modify configs |
| **ElastiCache** | `elasticache__*` | Manage Redis/Memcached clusters |
| **VPC** | `vpc__*` | Create subnets, manage route tables, security groups |

### Tier 3: Observability & Monitoring

| Service | MCP Tools | Use Cases |
|---------|-----------|-----------|
| **CloudWatch** | `cloudwatch__*` | Query metrics, create alarms, dashboards |
| **X-Ray** | `xray__*` | Analyze traces, identify bottlenecks |
| **EventBridge** | `eventbridge__*` | Subscribe to events, trigger workflows |
| **SNS** | `sns__*` | Send notifications, manage topics |
| **SQS** | `sqs__*` | Send/receive messages, manage queues |

### Tier 4: Advanced Orchestration

| Service | MCP Tools | Use Cases |
|---------|-----------|-----------|
| **Step Functions** | `sfn__*` | Start/stop workflows, inspect executions |
| **CodePipeline** | `codepipeline__*` | Trigger deployments, check pipeline status |
| **CodeBuild** | `codebuild__*` | Start builds, retrieve logs |
| **Systems Manager** | `ssm__*` | Run commands on EC2, manage parameters |
| **Secrets Manager** | `secretsmanager__*` | Retrieve secrets (read-only) |

---

## Implementation Architecture

### Chimera AWS MCP Integration

```
┌─────────────────────────────────────────────────────────┐
│              Chimera Agent Runtime (Strands)            │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Agent Skill Invocation Layer                     │  │
│  │  - Discovers AWS tools via MCP Gateway            │  │
│  │  - Invokes tools with tenant context              │  │
│  └───────────────────┬───────────────────────────────┘  │
└────────────────────── ┼─────────────────────────────────┘
                        │ HTTPS (MCP over HTTP/SSE)
                        │ X-Tenant-ID header
┌───────────────────────▼─────────────────────────────────┐
│          Amazon Bedrock AgentCore Gateway               │
│  ┌───────────────────────────────────────────────────┐  │
│  │  IAM Auth + Cedar Policy Enforcement              │  │
│  │  - Validates tenant can invoke AWS tools          │  │
│  │  - Rate limiting per tenant                       │  │
│  └───────────────────┬───────────────────────────────┘  │
│                      │                                   │
│  ┌───────────────────▼───────────────────────────────┐  │
│  │  MCP Tool Registry                                │  │
│  │  - aws-lambda (54 tools)                          │  │
│  │  - aws-dynamodb (32 tools)                        │  │
│  │  - aws-s3 (28 tools)                              │  │
│  │  - aws-cloudwatch (45 tools)                      │  │
│  └───────────────────┬───────────────────────────────┘  │
└────────────────────── ┼─────────────────────────────────┘
                        │
         ┌──────────────┴──────────────┬──────────────┐
         │                             │              │
┌────────▼────────┐  ┌────────────────▼────┐  ┌──────▼──────┐
│ AWS Lambda      │  │ AgentCore Runtime   │  │ ECS Fargate │
│ MCP Servers     │  │ Direct SDK Calls    │  │ MCP Servers │
│                 │  │                     │  │             │
│ - boto3         │  │ - AWS SDK v3        │  │ - boto3     │
│ - Serverless    │  │ - Low latency       │  │ - Long-run  │
│ - Auto-scale    │  │ - Session state     │  │ - Stateful  │
└─────────────────┘  └─────────────────────┘  └─────────────┘
```

### Deployment Strategy

1. **Phase 1: Core Services (Lambda, DynamoDB, S3)**
   - Deploy Lambda-based MCP servers for essential operations
   - Register with AgentCore Gateway
   - Configure per-tenant IAM roles

2. **Phase 2: Observability (CloudWatch, X-Ray, EventBridge)**
   - Add monitoring and alerting tools
   - Enable event-driven agent workflows

3. **Phase 3: Infrastructure (EC2, ECS, RDS, VPC)**
   - Expand to full infrastructure management
   - Implement safety guardrails (e.g., prevent accidental deletions)

4. **Phase 4: Advanced Orchestration (Step Functions, CodePipeline)**
   - Cross-service workflow coordination
   - CI/CD integration

---

## Key Takeaways

1. **MCP Standardizes AWS Access**: All AWS services exposed through uniform MCP protocol, enabling dynamic tool discovery and invocation

2. **Security Through IAM**: Per-tenant IAM roles + Cedar policies enforce least-privilege access at MCP Gateway layer

3. **Flexible Deployment**: Lambda (serverless), AgentCore Runtime (low latency), or ECS (long-running) depending on use case

4. **Existing Ecosystem**: `aws-knowledge-mcp-server` and `aws-diagram-mcp-server` provide foundation; custom servers needed for operational tools

5. **Multi-Region Support**: Tools accept `region` parameter for cross-region operations

6. **Phased Rollout**: Start with core services (Lambda, DynamoDB, S3), expand to full AWS service coverage

**Next Steps:**
- Implement Lambda-based MCP servers for Tier 1 services
- Configure AgentCore Gateway with AWS tool registry
- Define per-tenant IAM roles and Cedar policies
- Build agent workflows that orchestrate AWS operations

---

## References

- [AWS SDK for Python (boto3)](https://boto3.amazonaws.com/v1/documentation/api/latest/index.html)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [Amazon Bedrock AgentCore Gateway Documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/agentcore-gateway.html)
- [AWS IAM Best Practices for Multi-Tenant Applications](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/security.html)
- [Cedar Policy Language](https://www.cedarpolicy.com/)
