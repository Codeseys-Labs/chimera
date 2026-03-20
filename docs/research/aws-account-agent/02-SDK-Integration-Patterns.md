# AWS SDK Integration Patterns for Agent Capabilities

---
**Date:** 2026-03-20
**Purpose:** Define patterns for integrating boto3 (Python), AWS SDK v3 (TypeScript/Node.js), and AWS CLI into agent runtimes
**Context:** Part of AWS Account Agent research series - implementation guide for exposing AWS APIs as agent tools
---

## Executive Summary

This document provides **implementation patterns** for integrating AWS SDKs into Chimera agent runtimes, enabling agents to invoke AWS APIs as first-class tools. Covers authentication, error handling, multi-region operations, cost optimization, and security best practices.

### SDK Stack

| Language | SDK | Use Case | Example Service |
|----------|-----|----------|-----------------|
| **Python** | boto3 | Lambda tools, data processing scripts | `boto3.client('s3').put_object()` |
| **TypeScript/Node.js** | AWS SDK v3 | Agent core runtime, API Gateway handlers | `new S3Client()` |
| **Shell** | AWS CLI | Wrapper tools, DevOps automation | `aws ec2 describe-instances` |

### Key Patterns

1. **IAM Role-Based Authentication** — No hardcoded credentials, runtime assumes tenant-scoped IAM roles
2. **Regional Client Caching** — Reuse SDK clients across requests for performance
3. **Exponential Backoff with Jitter** — Retry failed requests with randomized delays
4. **Tenant Isolation via Session Tags** — STS session tags enforce multi-tenancy
5. **Cost Attribution via Request Tags** — Tag API calls with tenant ID for billing

---

## 1. boto3 Integration (Python)

### 1.1 Basic Client Setup

**Pattern:** Use IAM role credentials, not access keys.

```python
import boto3
from botocore.config import Config

# Global config for all clients
retry_config = Config(
    retries={'max_attempts': 3, 'mode': 'adaptive'},
    connect_timeout=5,
    read_timeout=30,
    region_name='us-east-1'
)

# Create client (automatically uses IAM role credentials)
s3 = boto3.client('s3', config=retry_config)

# Upload object
response = s3.put_object(
    Bucket='my-bucket',
    Key='data/file.json',
    Body=b'{"hello": "world"}',
    ContentType='application/json'
)

print(f"Uploaded: {response['ETag']}")
```

### 1.2 Multi-Region Client Factory

**Pattern:** Cache clients per region to avoid repeated initialization.

```python
from typing import Dict
import boto3
from botocore.config import Config

class AWSClientFactory:
    """Factory for creating and caching AWS SDK clients per region"""

    def __init__(self):
        self._clients: Dict[str, Dict[str, any]] = {}
        self._config = Config(
            retries={'max_attempts': 3, 'mode': 'adaptive'},
            connect_timeout=5,
            read_timeout=30
        )

    def get_client(self, service: str, region: str = 'us-east-1'):
        """Get or create cached client for service in region"""
        cache_key = f"{service}:{region}"

        if cache_key not in self._clients:
            config = self._config.copy(region_name=region)
            self._clients[cache_key] = boto3.client(service, config=config)

        return self._clients[cache_key]

    def clear_cache(self):
        """Clear all cached clients"""
        self._clients.clear()

# Usage
factory = AWSClientFactory()

# Clients are cached and reused
s3_east = factory.get_client('s3', 'us-east-1')
s3_west = factory.get_client('s3', 'us-west-2')
lambda_east = factory.get_client('lambda', 'us-east-1')
```

### 1.3 Tenant-Scoped Credentials with STS AssumeRole

**Pattern:** Agent assumes tenant-specific IAM role with session tags for isolation.

```python
import boto3
from datetime import datetime

def assume_tenant_role(tenant_id: str, agent_id: str, session_name: str = None) -> dict:
    """
    Assume tenant-specific IAM role with session tags for multi-tenant isolation.

    Args:
        tenant_id: Unique tenant identifier
        agent_id: Agent identifier for audit trail
        session_name: Optional session name (defaults to agent_id)

    Returns:
        Temporary credentials (access key, secret key, session token)
    """
    sts = boto3.client('sts')

    # Role ARN pattern: arn:aws:iam::ACCOUNT_ID:role/tenant-TENANT_ID-agent-role
    role_arn = f"arn:aws:iam::123456789012:role/tenant-{tenant_id}-agent-role"
    session_name = session_name or f"{agent_id}-{int(datetime.now().timestamp())}"

    response = sts.assume_role(
        RoleArn=role_arn,
        RoleSessionName=session_name,
        DurationSeconds=3600,  # 1 hour
        Tags=[
            {'Key': 'tenantId', 'Value': tenant_id},
            {'Key': 'agentId', 'Value': agent_id},
            {'Key': 'assumedAt', 'Value': datetime.now().isoformat()}
        ],
        # Enforce permission boundary
        PolicyArns=[
            {'arn': f"arn:aws:iam::123456789012:policy/TenantPermissionsBoundary"}
        ]
    )

    return response['Credentials']

# Create tenant-scoped clients
creds = assume_tenant_role('tenant-abc123', 'agent-research-01')

s3 = boto3.client(
    's3',
    aws_access_key_id=creds['AccessKeyId'],
    aws_secret_access_key=creds['SecretAccessKey'],
    aws_session_token=creds['SessionToken']
)

# All S3 operations now run with tenant-abc123's permissions
s3.list_buckets()
```

### 1.4 Error Handling with Exponential Backoff

**Pattern:** Retry transient errors (throttling, timeouts) with exponential backoff and jitter.

```python
import boto3
import time
import random
from botocore.exceptions import ClientError

def invoke_lambda_with_retry(
    function_name: str,
    payload: dict,
    max_retries: int = 3,
    base_delay: float = 1.0
) -> dict:
    """
    Invoke Lambda with exponential backoff retry on throttling/errors.

    Args:
        function_name: Lambda function name
        payload: JSON-serializable payload
        max_retries: Maximum retry attempts
        base_delay: Base delay in seconds (doubles each retry)

    Returns:
        Lambda response payload

    Raises:
        ClientError: If all retries exhausted
    """
    lambda_client = boto3.client('lambda')

    for attempt in range(max_retries + 1):
        try:
            response = lambda_client.invoke(
                FunctionName=function_name,
                InvocationType='RequestResponse',
                Payload=json.dumps(payload)
            )

            if response['StatusCode'] == 200:
                return json.loads(response['Payload'].read())
            else:
                raise Exception(f"Lambda returned {response['StatusCode']}")

        except ClientError as e:
            error_code = e.response['Error']['Code']

            # Retry on throttling or service errors
            if error_code in ['TooManyRequestsException', 'ServiceException', 'ThrottlingException']:
                if attempt < max_retries:
                    # Exponential backoff with jitter
                    delay = base_delay * (2 ** attempt) + random.uniform(0, 1)
                    print(f"Retry {attempt + 1}/{max_retries} after {delay:.2f}s (error: {error_code})")
                    time.sleep(delay)
                else:
                    raise  # All retries exhausted
            else:
                # Non-retryable error (e.g., InvalidParameterException)
                raise

    raise Exception("Unexpected: all retries exhausted without raising")

# Usage
try:
    result = invoke_lambda_with_retry(
        function_name='data-processor',
        payload={'input': 'data.csv'}
    )
    print(f"Result: {result}")
except ClientError as e:
    print(f"Lambda invocation failed: {e}")
```

### 1.5 Pagination Helper

**Pattern:** Abstract pagination logic for list/describe operations.

```python
import boto3
from typing import Iterator, Dict, Any

def paginate_s3_objects(bucket: str, prefix: str = '', max_keys: int = 1000) -> Iterator[Dict[str, Any]]:
    """
    Paginate through all S3 objects in bucket with prefix.

    Args:
        bucket: S3 bucket name
        prefix: Key prefix filter
        max_keys: Objects per page

    Yields:
        Object metadata dicts
    """
    s3 = boto3.client('s3')
    paginator = s3.get_paginator('list_objects_v2')

    page_iterator = paginator.paginate(
        Bucket=bucket,
        Prefix=prefix,
        PaginationConfig={'PageSize': max_keys}
    )

    for page in page_iterator:
        if 'Contents' in page:
            for obj in page['Contents']:
                yield obj

# Usage: iterate through all objects without manual pagination
for obj in paginate_s3_objects('my-bucket', prefix='data/2024/'):
    print(f"{obj['Key']}: {obj['Size']} bytes")
```

### 1.6 Cost Attribution with Request Tags

**Pattern:** Tag API requests with tenant ID for cost allocation.

```python
import boto3

def tag_s3_object_for_cost_tracking(bucket: str, key: str, tenant_id: str, data: bytes):
    """
    Upload S3 object with cost allocation tags.

    Tags enable AWS Cost Explorer to group costs by tenant.
    """
    s3 = boto3.client('s3')

    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=data,
        # Object tags for cost allocation
        Tagging=f'tenantId={tenant_id}&billingCategory=storage'
    )

    # Also tag the request itself (for API call costs)
    # Note: Request tags require S3 bucket policy allowing tagging
    s3.put_object_tagging(
        Bucket=bucket,
        Key=key,
        Tagging={
            'TagSet': [
                {'Key': 'tenantId', 'Value': tenant_id},
                {'Key': 'billingCategory', 'Value': 'storage'}
            ]
        }
    )
```

---

## 2. AWS SDK v3 Integration (TypeScript/Node.js)

### 2.1 Basic Client Setup

**Pattern:** Use modular SDK v3 with only required service clients.

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Create client with retry configuration
const s3Client = new S3Client({
  region: 'us-east-1',
  maxAttempts: 3,
  retryMode: 'adaptive'
});

// Upload object
const command = new PutObjectCommand({
  Bucket: 'my-bucket',
  Key: 'data/file.json',
  Body: Buffer.from(JSON.stringify({ hello: 'world' })),
  ContentType: 'application/json'
});

const response = await s3Client.send(command);
console.log(`Uploaded: ${response.ETag}`);
```

### 2.2 Multi-Region Client Factory (TypeScript)

**Pattern:** Cache clients per region with singleton pattern.

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

type AWSClient = S3Client | LambdaClient | DynamoDBClient;

interface ClientConfig {
  region?: string;
  maxAttempts?: number;
  requestTimeout?: number;
}

class AWSClientFactory {
  private clients = new Map<string, AWSClient>();
  private defaultConfig: ClientConfig = {
    region: 'us-east-1',
    maxAttempts: 3,
    requestTimeout: 30000
  };

  getS3Client(region: string = 'us-east-1'): S3Client {
    return this.getOrCreateClient('s3', region, () =>
      new S3Client({ ...this.defaultConfig, region })
    );
  }

  getLambdaClient(region: string = 'us-east-1'): LambdaClient {
    return this.getOrCreateClient('lambda', region, () =>
      new LambdaClient({ ...this.defaultConfig, region })
    );
  }

  getDynamoDBClient(region: string = 'us-east-1'): DynamoDBClient {
    return this.getOrCreateClient('dynamodb', region, () =>
      new DynamoDBClient({ ...this.defaultConfig, region })
    );
  }

  private getOrCreateClient<T extends AWSClient>(
    service: string,
    region: string,
    factory: () => T
  ): T {
    const key = `${service}:${region}`;
    if (!this.clients.has(key)) {
      this.clients.set(key, factory());
    }
    return this.clients.get(key) as T;
  }

  clearCache(): void {
    this.clients.clear();
  }
}

// Singleton instance
export const awsClients = new AWSClientFactory();

// Usage
const s3East = awsClients.getS3Client('us-east-1');
const s3West = awsClients.getS3Client('us-west-2');
const lambdaEast = awsClients.getLambdaClient('us-east-1');
```

### 2.3 Tenant-Scoped Credentials with STS AssumeRole (TypeScript)

**Pattern:** Assume role with session tags for multi-tenant isolation.

```typescript
import { STSClient, AssumeRoleCommand, Credentials } from '@aws-sdk/client-sts';
import { S3Client } from '@aws-sdk/client-s3';
import { AwsCredentialIdentity } from '@smithy/types';

interface TenantCredentials extends AwsCredentialIdentity {
  sessionToken: string;
}

async function assumeTenantRole(
  tenantId: string,
  agentId: string
): Promise<TenantCredentials> {
  const sts = new STSClient({ region: 'us-east-1' });

  const roleArn = `arn:aws:iam::123456789012:role/tenant-${tenantId}-agent-role`;
  const sessionName = `${agentId}-${Date.now()}`;

  const command = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    DurationSeconds: 3600,  // 1 hour
    Tags: [
      { Key: 'tenantId', Value: tenantId },
      { Key: 'agentId', Value: agentId },
      { Key: 'assumedAt', Value: new Date().toISOString() }
    ]
  });

  const response = await sts.send(command);

  if (!response.Credentials) {
    throw new Error('Failed to assume role: no credentials returned');
  }

  const creds = response.Credentials;
  return {
    accessKeyId: creds.AccessKeyId!,
    secretAccessKey: creds.SecretAccessKey!,
    sessionToken: creds.SessionToken!,
    expiration: creds.Expiration
  };
}

// Create tenant-scoped S3 client
const tenantCreds = await assumeTenantRole('tenant-abc123', 'agent-research-01');

const s3 = new S3Client({
  region: 'us-east-1',
  credentials: tenantCreds
});

// All S3 operations run with tenant-abc123's permissions
const buckets = await s3.send(new ListBucketsCommand({}));
console.log(`Tenant buckets: ${buckets.Buckets?.length}`);
```

### 2.4 Error Handling with Custom Retry Logic

**Pattern:** Retry transient errors with exponential backoff.

```typescript
import { LambdaClient, InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';

async function invokeLambdaWithRetry(
  functionName: string,
  payload: any,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<InvokeCommandOutput> {
  const lambda = new LambdaClient({ region: 'us-east-1' });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const command = new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload))
      });

      const response = await lambda.send(command);

      if (response.StatusCode === 200) {
        return response;
      } else {
        throw new Error(`Lambda returned ${response.StatusCode}`);
      }

    } catch (error: any) {
      const errorName = error.name;

      // Retry on throttling or service errors
      const retryableErrors = [
        'TooManyRequestsException',
        'ServiceException',
        'ThrottlingException',
        'TimeoutError'
      ];

      if (retryableErrors.includes(errorName) && attempt < maxRetries) {
        // Exponential backoff with jitter
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay.toFixed(0)}ms (error: ${errorName})`);
        await sleep(delay);
      } else {
        // Non-retryable error or retries exhausted
        throw error;
      }
    }
  }

  throw new Error('Unexpected: all retries exhausted');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Usage
try {
  const result = await invokeLambdaWithRetry(
    'data-processor',
    { input: 'data.csv' }
  );
  console.log('Result:', JSON.parse(Buffer.from(result.Payload!).toString()));
} catch (error) {
  console.error('Lambda invocation failed:', error);
}
```

### 2.5 Pagination Helper (TypeScript)

**Pattern:** Use SDK v3 paginators for list operations.

```typescript
import { S3Client, paginateListObjectsV2 } from '@aws-sdk/client-s3';

async function* paginateS3Objects(
  bucket: string,
  prefix: string = ''
): AsyncGenerator<{ Key: string; Size: number; LastModified: Date }> {
  const s3 = new S3Client({ region: 'us-east-1' });

  const paginator = paginateListObjectsV2(
    { client: s3, pageSize: 1000 },
    { Bucket: bucket, Prefix: prefix }
  );

  for await (const page of paginator) {
    if (page.Contents) {
      for (const obj of page.Contents) {
        yield {
          Key: obj.Key!,
          Size: obj.Size!,
          LastModified: obj.LastModified!
        };
      }
    }
  }
}

// Usage: iterate through all objects without manual pagination
for await (const obj of paginateS3Objects('my-bucket', 'data/2024/')) {
  console.log(`${obj.Key}: ${obj.Size} bytes`);
}
```

### 2.6 Middleware for Cost Attribution

**Pattern:** Add middleware to tag all API requests with tenant ID.

```typescript
import { S3Client } from '@aws-sdk/client-s3';

function addTenantTagMiddleware(tenantId: string) {
  return (next: any) => async (args: any) => {
    // Add tenant tag to request headers
    if (!args.request.headers) {
      args.request.headers = {};
    }
    args.request.headers['x-tenant-id'] = tenantId;
    args.request.headers['x-billing-category'] = 'agent-operations';

    return next(args);
  };
}

// Create S3 client with tenant tagging middleware
const s3 = new S3Client({ region: 'us-east-1' });

s3.middlewareStack.add(
  addTenantTagMiddleware('tenant-abc123'),
  { step: 'build', priority: 'high' }
);

// All S3 requests now include tenant ID headers for cost tracking
```

---

## 3. AWS CLI Integration (Shell Wrapper)

### 3.1 Basic CLI Wrapper Tool

**Pattern:** Wrap AWS CLI commands in agent tools for shell-based automation.

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function awsCli(command: string, region: string = 'us-east-1'): Promise<CLIResult> {
  """
  Execute AWS CLI command with error handling.

  Args:
      command: AWS CLI command (without 'aws' prefix)
      region: AWS region

  Returns:
      CLI output and exit code
  """
  const fullCommand = `aws ${command} --region ${region} --output json`;

  try {
    const { stdout, stderr } = await execAsync(fullCommand);
    return { stdout, stderr, exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.code || 1
    };
  }
}

// Usage: List EC2 instances
const result = await awsCli('ec2 describe-instances --filters "Name=tag:Environment,Values=production"');

if (result.exitCode === 0) {
  const instances = JSON.parse(result.stdout);
  console.log(`Found ${instances.Reservations.length} reservations`);
} else {
  console.error(`CLI error: ${result.stderr}`);
}
```

### 3.2 CLI with Assumed Role Credentials

**Pattern:** Export temporary credentials for CLI to assume tenant role.

```bash
#!/bin/bash
# assume_tenant_role.sh - Assume tenant IAM role and export credentials

TENANT_ID="$1"
AGENT_ID="$2"
ROLE_ARN="arn:aws:iam::123456789012:role/tenant-${TENANT_ID}-agent-role"
SESSION_NAME="${AGENT_ID}-$(date +%s)"

# Assume role
CREDS=$(aws sts assume-role \
  --role-arn "$ROLE_ARN" \
  --role-session-name "$SESSION_NAME" \
  --duration-seconds 3600 \
  --tags "Key=tenantId,Value=${TENANT_ID}" "Key=agentId,Value=${AGENT_ID}" \
  --output json)

# Export credentials to environment
export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r '.Credentials.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r '.Credentials.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r '.Credentials.SessionToken')

echo "Assumed role for tenant: $TENANT_ID"

# Now all AWS CLI commands use tenant credentials
aws s3 ls
aws lambda list-functions
```

### 3.3 CLI Tool Interface (Agent-Facing)

**Pattern:** Expose CLI as structured agent tool with validation.

```typescript
interface AWSCLITool {
  name: 'aws_cli';
  description: 'Execute AWS CLI commands';
  parameters: {
    service: string;  // e.g., 's3', 'ec2', 'lambda'
    action: string;  // e.g., 'ls', 'describe-instances', 'list-functions'
    arguments?: string[];  // Additional arguments
    region?: string;  // AWS region (default: us-east-1)
  };
}

async function executeAWSCLI(params: AWSCLITool['parameters']): Promise<any> {
  const { service, action, arguments: args = [], region = 'us-east-1' } = params;

  // Build CLI command
  const argStr = args.join(' ');
  const command = `${service} ${action} ${argStr}`.trim();

  // Execute with safety checks
  if (!isValidCLICommand(command)) {
    throw new Error(`Invalid CLI command: ${command}`);
  }

  const result = await awsCli(command, region);

  if (result.exitCode !== 0) {
    throw new Error(`CLI error: ${result.stderr}`);
  }

  // Parse JSON output
  try {
    return JSON.parse(result.stdout);
  } catch {
    return result.stdout;  // Return raw output if not JSON
  }
}

function isValidCLICommand(command: string): boolean {
  // Whitelist allowed services and actions
  const allowedServices = ['s3', 'ec2', 'lambda', 'dynamodb', 'iam', 'cloudwatch'];
  const service = command.split(' ')[0];

  if (!allowedServices.includes(service)) {
    return false;
  }

  // Block dangerous commands
  const blockedActions = ['delete-bucket', 'delete-account', 'delete-organization'];
  const hasBlockedAction = blockedActions.some(action => command.includes(action));

  return !hasBlockedAction;
}

// Agent invokes CLI tool
const instances = await executeAWSCLI({
  service: 'ec2',
  action: 'describe-instances',
  arguments: ['--filters', 'Name=tag:Environment,Values=production'],
  region: 'us-east-1'
});

console.log(`Found ${instances.Reservations.length} EC2 instances`);
```

---

## 4. Multi-Region Patterns

### 4.1 Cross-Region Resource Replication

**Pattern:** Replicate resources across regions for disaster recovery.

```python
import boto3
from concurrent.futures import ThreadPoolExecutor

def replicate_s3_object_to_regions(
    source_bucket: str,
    source_key: str,
    destination_regions: list[str]
):
    """
    Copy S3 object to multiple regions in parallel.

    Args:
        source_bucket: Source S3 bucket
        source_key: Source object key
        destination_regions: List of target regions
    """
    s3_source = boto3.client('s3', region_name='us-east-1')

    # Download object from source
    obj = s3_source.get_object(Bucket=source_bucket, Key=source_key)
    body = obj['Body'].read()
    content_type = obj.get('ContentType', 'application/octet-stream')

    def upload_to_region(region: str):
        s3_dest = boto3.client('s3', region_name=region)
        dest_bucket = f"{source_bucket}-{region}"

        s3_dest.put_object(
            Bucket=dest_bucket,
            Key=source_key,
            Body=body,
            ContentType=content_type
        )
        print(f"Replicated to {region}: s3://{dest_bucket}/{source_key}")

    # Parallel upload to all regions
    with ThreadPoolExecutor(max_workers=len(destination_regions)) as executor:
        executor.map(upload_to_region, destination_regions)

# Usage: replicate critical data to 3 regions
replicate_s3_object_to_regions(
    source_bucket='my-bucket',
    source_key='data/critical-config.json',
    destination_regions=['us-west-2', 'eu-west-1', 'ap-southeast-1']
)
```

### 4.2 Multi-Region Query Aggregation

**Pattern:** Query same resource across regions and aggregate results.

```typescript
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';

async function describeInstancesAllRegions(
  regions: string[]
): Promise<Map<string, any[]>> {
  const results = new Map<string, any[]>();

  const promises = regions.map(async (region) => {
    const ec2 = new EC2Client({ region });
    const command = new DescribeInstancesCommand({});
    const response = await ec2.send(command);

    const instances = response.Reservations?.flatMap(r => r.Instances || []) || [];
    results.set(region, instances);
  });

  await Promise.all(promises);

  return results;
}

// Usage: get all EC2 instances across 4 regions
const regions = ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1'];
const instancesByRegion = await describeInstancesAllRegions(regions);

let totalInstances = 0;
for (const [region, instances] of instancesByRegion.entries()) {
  console.log(`${region}: ${instances.length} instances`);
  totalInstances += instances.length;
}
console.log(`Total instances across all regions: ${totalInstances}`);
```

---

## 5. Cost Optimization Patterns

### 5.1 Batch Operations to Reduce API Calls

**Pattern:** Use batch APIs where available to reduce costs.

```python
import boto3

# ❌ Inefficient: 1000 individual PutItem calls = 1000 WCUs
dynamodb = boto3.client('dynamodb')
for i in range(1000):
    dynamodb.put_item(
        TableName='my-table',
        Item={'id': {'S': str(i)}, 'data': {'S': f'value-{i}'}}
    )

# ✅ Efficient: BatchWriteItem with 25 items per batch = 40 batches
def batch_write_items(table_name: str, items: list[dict]):
    dynamodb = boto3.client('dynamodb')

    # Split into batches of 25 (DynamoDB limit)
    for i in range(0, len(items), 25):
        batch = items[i:i+25]
        request_items = {
            table_name: [{'PutRequest': {'Item': item}} for item in batch]
        }
        dynamodb.batch_write_item(RequestItems=request_items)

items = [{'id': {'S': str(i)}, 'data': {'S': f'value-{i}'}} for i in range(1000)]
batch_write_items('my-table', items)
```

### 5.2 Client-Side Caching to Reduce Redundant Calls

**Pattern:** Cache immutable or slowly-changing data client-side.

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

class CachedS3Client {
  private cache = new Map<string, { data: Buffer; expires: number }>();
  private s3: S3Client;

  constructor() {
    this.s3 = new S3Client({ region: 'us-east-1' });
  }

  async getObject(
    bucket: string,
    key: string,
    ttl: number = 300  // Cache for 5 minutes
  ): Promise<Buffer> {
    const cacheKey = `${bucket}/${key}`;
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expires > Date.now()) {
      console.log(`Cache hit: ${cacheKey}`);
      return cached.data;
    }

    console.log(`Cache miss: ${cacheKey}`);
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await this.s3.send(command);
    const data = Buffer.from(await response.Body!.transformToByteArray());

    // Cache with TTL
    this.cache.set(cacheKey, {
      data,
      expires: Date.now() + ttl * 1000
    });

    return data;
  }
}

// Usage: repeated reads only hit S3 once per TTL
const s3 = new CachedS3Client();
const data1 = await s3.getObject('my-bucket', 'config.json');  // S3 API call
const data2 = await s3.getObject('my-bucket', 'config.json');  // Cached
```

---

## 6. Security Best Practices

### 6.1 IAM Policy with Least Privilege

**Pattern:** Agents get minimal permissions via IAM roles.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowS3AgentManagedBuckets",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::tenant-${tenant_id}-*",
        "arn:aws:s3:::tenant-${tenant_id}-*/*"
      ]
    },
    {
      "Sid": "AllowLambdaInvokeAgentFunctions",
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "arn:aws:lambda:*:${account_id}:function:agent-managed-*"
    },
    {
      "Sid": "DenyDangerousActions",
      "Effect": "Deny",
      "Action": [
        "iam:DeleteRole",
        "iam:DeleteUser",
        "s3:DeleteBucket",
        "dynamodb:DeleteTable",
        "rds:DeleteDBInstance"
      ],
      "Resource": "*"
    }
  ]
}
```

### 6.2 CloudTrail Audit Logging

**Pattern:** Log all agent API calls for security audit.

```python
import boto3

# Enable CloudTrail for agent IAM role
cloudtrail = boto3.client('cloudtrail')

cloudtrail.create_trail(
    Name='agent-api-audit',
    S3BucketName='audit-logs-bucket',
    IncludeGlobalServiceEvents=True,
    IsMultiRegionTrail=True,
    EnableLogFileValidation=True,
    Tags=[
        {'Key': 'purpose', 'Value': 'agent-audit'},
        {'Key': 'retention', 'Value': '7years'}
    ]
)

cloudtrail.start_logging(Name='agent-api-audit')
```

---

## 7. Implementation Checklist

### Phase 1: Foundation (Week 1-2)
- [ ] Set up IAM roles per tenant with permission boundaries
- [ ] Implement STS AssumeRole pattern for tenant isolation
- [ ] Create SDK client factories (boto3, AWS SDK v3)
- [ ] Add exponential backoff retry logic
- [ ] Enable CloudTrail logging for all agent API calls

### Phase 2: Core Tools (Week 3-4)
- [ ] Implement Lambda tool (create, invoke, delete functions)
- [ ] Implement S3 tool (upload, download, list, delete objects)
- [ ] Implement EC2 tool (launch, describe, start, stop, terminate instances)
- [ ] Implement DynamoDB tool (CRUD operations, query, scan)
- [ ] Add CLI wrapper tool with command validation

### Phase 3: Advanced Tools (Week 5-6)
- [ ] Implement Step Functions tool (create state machine, start execution)
- [ ] Implement Bedrock tool (invoke model, streaming)
- [ ] Implement CloudWatch tool (put metrics, query logs, create alarms)
- [ ] Add multi-region support across all tools
- [ ] Implement cost attribution tagging

### Phase 4: Security & Governance (Week 7-8)
- [ ] Add IAM policy validation before agent actions
- [ ] Implement quota enforcement (API call limits per tenant)
- [ ] Add security scanning for agent-created resources
- [ ] Enable AWS Config rules for compliance checks
- [ ] Create dashboard for agent AWS usage monitoring

---

## Summary: SDK Integration Best Practices

| Pattern | boto3 | AWS SDK v3 | AWS CLI |
|---------|-------|------------|---------|
| **Authentication** | IAM role (automatic) | IAM role (automatic) | Env vars or assume-role script |
| **Retry Logic** | Built-in (adaptive mode) | Built-in (adaptive mode) | Manual retry wrapper |
| **Pagination** | `paginator.paginate()` | `paginateX()` async generator | Manual (`--starting-token`) |
| **Multi-Region** | Client factory per region | Client factory per region | `--region` flag |
| **Error Handling** | Catch `ClientError` | Catch SDK exceptions | Check exit code |
| **Cost Tagging** | S3 object tags | Middleware headers | CLI `--tags` flag |

**Next:** [00-AWS-Account-Agent-Index.md](./00-AWS-Account-Agent-Index.md) — Index for the complete 6-document research series.
