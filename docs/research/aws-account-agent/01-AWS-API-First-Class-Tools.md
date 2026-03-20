# AWS API First-Class Tools for Agent Capabilities

---
**Date:** 2026-03-20
**Purpose:** Define which AWS APIs should be exposed as first-class agent tools for tenant agents to interact with AWS accounts
**Context:** Part of AWS Account Agent research series - focuses on agents-as-operators, not infrastructure
---

## Executive Summary

This document identifies **25 core AWS services** across 8 categories that should be exposed as first-class agent tools, enabling tenant agents to operate AWS accounts programmatically. Unlike the infrastructure audit (which covers services Chimera *uses*), this focuses on services tenant agents *control*.

### Distinction: Infrastructure vs Agent Capabilities

| Type | Example | Who Uses It | Purpose |
|------|---------|-------------|---------|
| **Infrastructure** | Amazon Bedrock | Chimera platform | Multi-provider LLM support for agent runtime |
| **Agent Capability** | AWS Lambda API | Tenant agent | Deploy/invoke functions as part of workflow |

**Key Insight:** Infrastructure services power Chimera; agent capability services are **tools** exposed to tenant agents for AWS automation.

### Priority Tiers

**Tier 1 (Core Compute & Storage):** EC2, Lambda, S3, ECS/Fargate, CloudWatch
**Tier 2 (Database & Messaging):** DynamoDB, RDS, SQS, SNS, EventBridge
**Tier 3 (Orchestration & ML):** Step Functions, Bedrock, SageMaker, Glue
**Tier 4 (Security & Networking):** IAM, VPC, CloudFront, Route 53

---

## 1. Compute Services (Agent Tools)

### 1.1 AWS Lambda — Serverless Function Management

**Agent Use Case:** Deploy and invoke serverless functions as part of agent workflows.

**Tool Interface:**
```typescript
interface LambdaTool {
  // Create function from inline code or S3 artifact
  create_function(config: {
    function_name: string;
    runtime: 'python3.12' | 'nodejs20.x' | 'provided.al2023';
    code: { zip_file?: Buffer; s3_bucket?: string; s3_key?: string };
    handler: string;
    role: string;  // IAM role ARN
    timeout?: number;
    memory_size?: number;
    environment?: Record<string, string>;
    layers?: string[];
  }): Promise<{ function_arn: string; version: string }>;

  // Invoke function synchronously or asynchronously
  invoke_function(config: {
    function_name: string;
    payload: any;
    invocation_type: 'RequestResponse' | 'Event' | 'DryRun';
    log_type?: 'None' | 'Tail';
  }): Promise<{ status_code: number; payload: any; log_result?: string }>;

  // Update function code or configuration
  update_function(config: {
    function_name: string;
    code?: { zip_file?: Buffer; s3_bucket?: string; s3_key?: string };
    runtime?: string;
    timeout?: number;
    memory_size?: number;
  }): Promise<{ last_modified: string }>;

  // Delete function
  delete_function(function_name: string): Promise<void>;

  // List functions with pagination
  list_functions(filters?: {
    max_items?: number;
    function_version?: 'ALL' | '$LATEST';
  }): Promise<{ functions: Array<{ function_name: string; runtime: string; memory_size: number }> }>;

  // Get function configuration and metadata
  get_function(function_name: string): Promise<{
    configuration: any;
    code: { repository_type: string; location: string };
    tags: Record<string, string>;
  }>;
}
```

**Permission Scoping (Least Privilege):**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:InvokeFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:ListFunctions",
        "lambda:GetFunction"
      ],
      "Resource": "arn:aws:lambda:*:${account_id}:function:agent-managed-*",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": ["us-east-1", "us-west-2"]
        }
      }
    }
  ]
}
```

**Common Workflows:**
1. **Scheduled Data Processing** — Agent creates Lambda triggered by EventBridge cron rule
2. **API Endpoint** — Agent deploys Lambda behind API Gateway for external integration
3. **Event-Driven Automation** — Lambda responds to S3 uploads, DynamoDB streams, SQS messages

**Priority:** **Tier 1** — Core serverless capability for agent-driven automation.

---

### 1.2 Amazon EC2 — Virtual Machine Management

**Agent Use Case:** Launch, configure, and manage EC2 instances for long-running workloads.

**Tool Interface:**
```typescript
interface EC2Tool {
  // Launch instances
  run_instances(config: {
    image_id: string;  // AMI ID
    instance_type: string;  // e.g., 't3.micro', 'm5.large'
    min_count: number;
    max_count: number;
    key_name?: string;
    security_group_ids?: string[];
    subnet_id?: string;
    user_data?: string;  // Startup script
    iam_instance_profile?: string;
    tags?: Array<{ key: string; value: string }>;
  }): Promise<{ instances: Array<{ instance_id: string; private_ip: string; public_ip?: string }> }>;

  // Describe instances
  describe_instances(filters?: {
    instance_ids?: string[];
    filters?: Array<{ name: string; values: string[] }>;
  }): Promise<{ instances: Array<{ instance_id: string; state: string; public_ip?: string }> }>;

  // Start/stop/terminate
  start_instances(instance_ids: string[]): Promise<void>;
  stop_instances(instance_ids: string[]): Promise<void>;
  terminate_instances(instance_ids: string[]): Promise<void>;

  // Modify instance attributes
  modify_instance_attribute(config: {
    instance_id: string;
    instance_type?: string;
    user_data?: string;
  }): Promise<void>;
}
```

**Permission Scoping:**
```json
{
  "Effect": "Allow",
  "Action": [
    "ec2:RunInstances",
    "ec2:DescribeInstances",
    "ec2:StartInstances",
    "ec2:StopInstances",
    "ec2:TerminateInstances",
    "ec2:ModifyInstanceAttribute"
  ],
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "aws:RequestTag/ManagedBy": "chimera-agent-${tenant_id}"
    }
  }
}
```

**Common Workflows:**
1. **On-Demand Compute** — Agent launches GPU instance for ML training, terminates after job completion
2. **Auto-Scaling** — Agent monitors load metrics, launches/terminates instances dynamically
3. **Testing Infrastructure** — Spin up test environments, run validation, tear down

**Priority:** **Tier 1** — Essential for agents managing cloud infrastructure.

---

### 1.3 Amazon ECS/Fargate — Container Orchestration

**Agent Use Case:** Deploy and manage containerized workloads without Kubernetes complexity.

**Tool Interface:**
```typescript
interface ECSTool {
  // Register task definition
  register_task_definition(config: {
    family: string;
    container_definitions: Array<{
      name: string;
      image: string;
      memory: number;
      cpu: number;
      environment?: Array<{ name: string; value: string }>;
      port_mappings?: Array<{ container_port: number; protocol: string }>;
    }>;
    requires_compatibilities: ['FARGATE' | 'EC2'];
    network_mode: 'awsvpc' | 'bridge' | 'host';
    cpu: string;  // e.g., '256', '512'
    memory: string;  // e.g., '512', '1024'
    execution_role_arn: string;
    task_role_arn?: string;
  }): Promise<{ task_definition_arn: string; revision: number }>;

  // Run task (one-off)
  run_task(config: {
    cluster: string;
    task_definition: string;
    launch_type: 'FARGATE' | 'EC2';
    network_configuration: {
      subnets: string[];
      security_groups?: string[];
      assign_public_ip?: 'ENABLED' | 'DISABLED';
    };
    overrides?: any;
  }): Promise<{ tasks: Array<{ task_arn: string; last_status: string }> }>;

  // Create service (long-running)
  create_service(config: {
    cluster: string;
    service_name: string;
    task_definition: string;
    desired_count: number;
    launch_type: 'FARGATE' | 'EC2';
    network_configuration: any;
    load_balancers?: Array<{ target_group_arn: string; container_name: string; container_port: number }>;
  }): Promise<{ service: { service_arn: string; status: string } }>;

  // Stop task
  stop_task(config: { cluster: string; task: string; reason?: string }): Promise<void>;

  // Delete service
  delete_service(config: { cluster: string; service: string; force?: boolean }): Promise<void>;
}
```

**Common Workflows:**
1. **Batch Processing** — Agent runs ECS tasks for data transformation jobs
2. **Microservices** — Deploy containerized APIs with auto-scaling and load balancing
3. **ML Inference** — Deploy model inference containers behind ALB

**Priority:** **Tier 1** — Modern container management for agent-driven workloads.

---

## 2. Storage Services (Agent Tools)

### 2.1 Amazon S3 — Object Storage

**Agent Use Case:** Store and retrieve files, artifacts, backups, and data lakes.

**Tool Interface:**
```typescript
interface S3Tool {
  // Upload object
  put_object(config: {
    bucket: string;
    key: string;
    body: Buffer | string;
    content_type?: string;
    metadata?: Record<string, string>;
    server_side_encryption?: 'AES256' | 'aws:kms';
    storage_class?: 'STANDARD' | 'GLACIER' | 'INTELLIGENT_TIERING';
  }): Promise<{ etag: string; version_id?: string }>;

  // Download object
  get_object(config: { bucket: string; key: string }): Promise<{
    body: Buffer;
    content_type: string;
    metadata: Record<string, string>;
    last_modified: Date;
  }>;

  // List objects
  list_objects(config: {
    bucket: string;
    prefix?: string;
    max_keys?: number;
    continuation_token?: string;
  }): Promise<{
    contents: Array<{ key: string; size: number; last_modified: Date }>;
    next_continuation_token?: string;
  }>;

  // Delete object
  delete_object(config: { bucket: string; key: string }): Promise<void>;

  // Generate presigned URL
  get_presigned_url(config: {
    bucket: string;
    key: string;
    expires_in: number;
    operation: 'getObject' | 'putObject';
  }): Promise<{ url: string; expires_at: Date }>;

  // Copy object
  copy_object(config: {
    source_bucket: string;
    source_key: string;
    destination_bucket: string;
    destination_key: string;
  }): Promise<{ copy_object_result: any }>;
}
```

**Permission Scoping:**
```json
{
  "Effect": "Allow",
  "Action": [
    "s3:PutObject",
    "s3:GetObject",
    "s3:ListBucket",
    "s3:DeleteObject"
  ],
  "Resource": [
    "arn:aws:s3:::tenant-${tenant_id}-*",
    "arn:aws:s3:::tenant-${tenant_id}-*/*"
  ]
}
```

**Common Workflows:**
1. **Data Lake Ingestion** — Agent uploads CSV/JSON/Parquet files to S3 for analytics
2. **Backup Automation** — Agent backs up databases to S3 with lifecycle policies
3. **Static Site Hosting** — Agent deploys HTML/CSS/JS to S3 bucket with CloudFront

**Priority:** **Tier 1** — Fundamental storage capability for all agent workflows.

---

## 3. Database Services (Agent Tools)

### 3.1 Amazon DynamoDB — NoSQL Database

**Agent Use Case:** Manage key-value and document data with millisecond latency.

**Tool Interface:**
```typescript
interface DynamoDBTool {
  // Create table
  create_table(config: {
    table_name: string;
    key_schema: Array<{ attribute_name: string; key_type: 'HASH' | 'RANGE' }>;
    attribute_definitions: Array<{ attribute_name: string; attribute_type: 'S' | 'N' | 'B' }>;
    billing_mode: 'PROVISIONED' | 'PAY_PER_REQUEST';
    provisioned_throughput?: { read_capacity_units: number; write_capacity_units: number };
    global_secondary_indexes?: Array<any>;
    tags?: Array<{ key: string; value: string }>;
  }): Promise<{ table_arn: string; table_status: string }>;

  // Put item
  put_item(config: {
    table_name: string;
    item: Record<string, any>;
    condition_expression?: string;
  }): Promise<void>;

  // Get item
  get_item(config: {
    table_name: string;
    key: Record<string, any>;
    projection_expression?: string;
  }): Promise<{ item?: Record<string, any> }>;

  // Query (partition key + optional sort key range)
  query(config: {
    table_name: string;
    key_condition_expression: string;
    expression_attribute_values: Record<string, any>;
    filter_expression?: string;
    limit?: number;
    exclusive_start_key?: Record<string, any>;
  }): Promise<{ items: Array<Record<string, any>>; last_evaluated_key?: any }>;

  // Scan (full table scan)
  scan(config: {
    table_name: string;
    filter_expression?: string;
    expression_attribute_values?: Record<string, any>;
    limit?: number;
  }): Promise<{ items: Array<Record<string, any>> }>;

  // Update item
  update_item(config: {
    table_name: string;
    key: Record<string, any>;
    update_expression: string;
    expression_attribute_values: Record<string, any>;
    return_values?: 'NONE' | 'ALL_OLD' | 'UPDATED_OLD' | 'ALL_NEW' | 'UPDATED_NEW';
  }): Promise<{ attributes?: Record<string, any> }>;

  // Delete item
  delete_item(config: {
    table_name: string;
    key: Record<string, any>;
  }): Promise<void>;

  // Batch write (up to 25 items)
  batch_write_item(config: {
    request_items: Record<string, Array<{ put_request?: any; delete_request?: any }>>;
  }): Promise<{ unprocessed_items?: any }>;
}
```

**Permission Scoping:**
```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:CreateTable",
    "dynamodb:PutItem",
    "dynamodb:GetItem",
    "dynamodb:Query",
    "dynamodb:Scan",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
    "dynamodb:BatchWriteItem"
  ],
  "Resource": "arn:aws:dynamodb:*:${account_id}:table/agent-managed-*"
}
```

**Common Workflows:**
1. **Session Management** — Agent stores user sessions with TTL for auto-expiry
2. **Event Sourcing** — Agent appends events to DynamoDB stream, processes with Lambda
3. **Key-Value Cache** — Fast lookups for configuration, user profiles, feature flags

**Priority:** **Tier 2** — Core database capability for stateful agents.

---

### 3.2 Amazon RDS — Relational Database

**Agent Use Case:** Manage PostgreSQL, MySQL, or Aurora databases for structured data.

**Tool Interface:**
```typescript
interface RDSTool {
  // Create DB instance
  create_db_instance(config: {
    db_instance_identifier: string;
    engine: 'postgres' | 'mysql' | 'aurora-postgresql' | 'aurora-mysql';
    engine_version: string;
    db_instance_class: string;  // e.g., 'db.t3.micro'
    allocated_storage?: number;  // For non-Aurora
    master_username: string;
    master_user_password: string;
    vpc_security_group_ids?: string[];
    db_subnet_group_name?: string;
    backup_retention_period?: number;
    multi_az?: boolean;
    publicly_accessible?: boolean;
    tags?: Array<{ key: string; value: string }>;
  }): Promise<{ db_instance_arn: string; endpoint: { address: string; port: number } }>;

  // Describe DB instances
  describe_db_instances(config?: {
    db_instance_identifier?: string;
  }): Promise<{
    db_instances: Array<{
      db_instance_identifier: string;
      db_instance_status: string;
      endpoint?: { address: string; port: number };
      engine: string;
    }>;
  }>;

  // Modify DB instance (resize, change password, etc.)
  modify_db_instance(config: {
    db_instance_identifier: string;
    db_instance_class?: string;
    allocated_storage?: number;
    master_user_password?: string;
    apply_immediately?: boolean;
  }): Promise<void>;

  // Create snapshot
  create_db_snapshot(config: {
    db_snapshot_identifier: string;
    db_instance_identifier: string;
    tags?: Array<{ key: string; value: string }>;
  }): Promise<{ db_snapshot_arn: string }>;

  // Delete DB instance
  delete_db_instance(config: {
    db_instance_identifier: string;
    skip_final_snapshot?: boolean;
    final_db_snapshot_identifier?: string;
  }): Promise<void>;
}
```

**Common Workflows:**
1. **Application Database** — Agent provisions PostgreSQL for web app, configures read replicas
2. **Data Warehouse** — Create Aurora cluster for analytics workloads
3. **Backup/Restore** — Automated snapshot creation and point-in-time recovery

**Priority:** **Tier 2** — Essential for agents managing relational data.

---

## 4. Messaging & Event Services (Agent Tools)

### 4.1 Amazon SQS — Message Queuing

**Agent Use Case:** Decouple services with reliable message queues.

**Tool Interface:**
```typescript
interface SQSTool {
  // Create queue
  create_queue(config: {
    queue_name: string;
    attributes?: {
      DelaySeconds?: string;
      MessageRetentionPeriod?: string;  // 60-1209600 seconds (14 days)
      VisibilityTimeout?: string;  // 0-43200 seconds (12 hours)
      ReceiveMessageWaitTimeSeconds?: string;  // Long polling
      RedrivePolicy?: string;  // JSON string with DLQ config
    };
    tags?: Record<string, string>;
  }): Promise<{ queue_url: string }>;

  // Send message
  send_message(config: {
    queue_url: string;
    message_body: string;
    delay_seconds?: number;
    message_attributes?: Record<string, { data_type: string; string_value?: string }>;
  }): Promise<{ message_id: string; md5_of_body: string }>;

  // Receive messages
  receive_message(config: {
    queue_url: string;
    max_number_of_messages?: number;  // 1-10
    wait_time_seconds?: number;  // Long polling
    visibility_timeout?: number;
    attribute_names?: string[];
  }): Promise<{
    messages: Array<{
      message_id: string;
      receipt_handle: string;
      body: string;
      attributes: Record<string, string>;
    }>;
  }>;

  // Delete message
  delete_message(config: {
    queue_url: string;
    receipt_handle: string;
  }): Promise<void>;

  // Purge queue
  purge_queue(queue_url: string): Promise<void>;

  // Delete queue
  delete_queue(queue_url: string): Promise<void>;
}
```

**Common Workflows:**
1. **Task Distribution** — Agent sends tasks to queue, workers poll and process
2. **Rate Limiting** — Agent sends messages to queue, Lambda processes at controlled rate
3. **Dead Letter Queue** — Failed messages move to DLQ for retry/analysis

**Priority:** **Tier 2** — Core asynchronous communication primitive.

---

### 4.2 Amazon SNS — Pub/Sub Messaging

**Agent Use Case:** Fan-out notifications to multiple subscribers.

**Tool Interface:**
```typescript
interface SNSTool {
  // Create topic
  create_topic(config: {
    name: string;
    attributes?: Record<string, string>;
    tags?: Array<{ key: string; value: string }>;
  }): Promise<{ topic_arn: string }>;

  // Subscribe to topic
  subscribe(config: {
    topic_arn: string;
    protocol: 'http' | 'https' | 'email' | 'email-json' | 'sms' | 'sqs' | 'lambda';
    endpoint: string;
    attributes?: Record<string, string>;
  }): Promise<{ subscription_arn: string }>;

  // Publish message
  publish(config: {
    topic_arn?: string;
    target_arn?: string;  // For direct publish
    message: string;
    subject?: string;
    message_attributes?: Record<string, { data_type: string; string_value?: string }>;
  }): Promise<{ message_id: string }>;

  // Unsubscribe
  unsubscribe(subscription_arn: string): Promise<void>;

  // Delete topic
  delete_topic(topic_arn: string): Promise<void>;
}
```

**Common Workflows:**
1. **Alerts & Notifications** — Agent publishes alerts to SNS, subscribers receive via email/SMS/webhook
2. **Event Fan-Out** — Single event published to SNS, multiple Lambda/SQS subscribers process
3. **Cross-Service Integration** — SNS topic bridges services (e.g., S3 → SNS → Lambda)

**Priority:** **Tier 2** — Essential for event-driven architectures.

---

### 4.3 Amazon EventBridge — Event Bus

**Agent Use Case:** Event-driven automation with rule-based routing.

**Tool Interface:**
```typescript
interface EventBridgeTool {
  // Put events
  put_events(config: {
    entries: Array<{
      source: string;
      detail_type: string;
      detail: string;  // JSON string
      resources?: string[];
      event_bus_name?: string;
    }>;
  }): Promise<{
    failed_entry_count: number;
    entries: Array<{ event_id?: string; error_code?: string }>;
  }>;

  // Create rule
  put_rule(config: {
    name: string;
    event_pattern: string;  // JSON string matching events
    state?: 'ENABLED' | 'DISABLED';
    description?: string;
    event_bus_name?: string;
  }): Promise<{ rule_arn: string }>;

  // Add target to rule (Lambda, SQS, SNS, Step Functions, etc.)
  put_targets(config: {
    rule: string;
    targets: Array<{
      id: string;
      arn: string;
      input?: string;
      input_transformer?: any;
      role_arn?: string;
    }>;
    event_bus_name?: string;
  }): Promise<{ failed_entry_count: number }>;

  // Remove targets
  remove_targets(config: {
    rule: string;
    ids: string[];
    event_bus_name?: string;
  }): Promise<void>;

  // Delete rule
  delete_rule(config: {
    name: string;
    event_bus_name?: string;
  }): Promise<void>;
}
```

**Common Workflows:**
1. **Scheduled Jobs** — Agent creates EventBridge rule with cron expression, targets Lambda
2. **Cross-Service Automation** — S3 upload triggers EventBridge event → Lambda processes
3. **Multi-Step Workflows** — EventBridge orchestrates Step Functions state machines

**Priority:** **Tier 2** — Modern event-driven orchestration.

---

## 5. Orchestration Services (Agent Tools)

### 5.1 AWS Step Functions — Workflow Orchestration

**Agent Use Case:** Coordinate multi-step workflows with retries, parallel execution, and error handling.

**Tool Interface:**
```typescript
interface StepFunctionsTool {
  // Create state machine
  create_state_machine(config: {
    name: string;
    definition: string;  // JSON string (Amazon States Language)
    role_arn: string;
    type?: 'STANDARD' | 'EXPRESS';
    logging_configuration?: any;
    tags?: Array<{ key: string; value: string }>;
  }): Promise<{ state_machine_arn: string; creation_date: Date }>;

  // Start execution
  start_execution(config: {
    state_machine_arn: string;
    input?: string;  // JSON string
    name?: string;
    trace_header?: string;
  }): Promise<{ execution_arn: string; start_date: Date }>;

  // Describe execution
  describe_execution(execution_arn: string): Promise<{
    status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED';
    start_date: Date;
    stop_date?: Date;
    input: string;
    output?: string;
    error?: string;
    cause?: string;
  }>;

  // Stop execution
  stop_execution(config: {
    execution_arn: string;
    error?: string;
    cause?: string;
  }): Promise<{ stop_date: Date }>;

  // List executions
  list_executions(config: {
    state_machine_arn: string;
    status_filter?: string;
    max_results?: number;
  }): Promise<{
    executions: Array<{
      execution_arn: string;
      name: string;
      status: string;
      start_date: Date;
    }>;
  }>;

  // Delete state machine
  delete_state_machine(state_machine_arn: string): Promise<void>;
}
```

**Common Workflows:**
1. **Data Pipeline** — Agent orchestrates ETL: Extract (Lambda) → Transform (Glue) → Load (Redshift)
2. **Human-in-the-Loop** — Workflow pauses for manual approval before proceeding
3. **Saga Pattern** — Coordinate distributed transactions with compensating actions on failure

**Priority:** **Tier 3** — Advanced orchestration for complex workflows.

---

## 6. Machine Learning Services (Agent Tools)

### 6.1 Amazon Bedrock — LLM API

**Agent Use Case:** Invoke foundation models for text generation, embeddings, and chat.

**Tool Interface:**
```typescript
interface BedrockTool {
  // Invoke model
  invoke_model(config: {
    model_id: string;  // e.g., 'us.anthropic.claude-sonnet-4-20250514'
    body: string;  // JSON string with model-specific parameters
    accept?: string;
    content_type?: string;
    guardrail_identifier?: string;
    guardrail_version?: string;
  }): Promise<{ body: Buffer; content_type: string }>;

  // Invoke model with streaming
  invoke_model_with_response_stream(config: {
    model_id: string;
    body: string;
  }): AsyncIterable<{ chunk: { bytes: Buffer } }>;

  // List foundation models
  list_foundation_models(config?: {
    by_provider?: string;
    by_output_modality?: 'TEXT' | 'IMAGE' | 'EMBEDDING';
  }): Promise<{
    model_summaries: Array<{
      model_id: string;
      model_name: string;
      provider_name: string;
      input_modalities: string[];
      output_modalities: string[];
    }>;
  }>;
}
```

**Common Workflows:**
1. **Text Generation** — Agent uses Claude for content creation, summarization, Q&A
2. **Embeddings** — Generate vector embeddings for semantic search
3. **Multi-Model Routing** — Agent selects model based on task (Claude for reasoning, Llama for code)

**Priority:** **Tier 3** — AI-powered agents invoking LLMs as tools.

---

### 6.2 Amazon SageMaker — Custom Model Deployment

**Agent Use Case:** Deploy and invoke custom ML models.

**Tool Interface:**
```typescript
interface SageMakerTool {
  // Create endpoint
  create_endpoint(config: {
    endpoint_name: string;
    endpoint_config_name: string;
    tags?: Array<{ key: string; value: string }>;
  }): Promise<{ endpoint_arn: string }>;

  // Invoke endpoint
  invoke_endpoint(config: {
    endpoint_name: string;
    body: Buffer | string;
    content_type?: string;
    accept?: string;
  }): Promise<{ body: Buffer; content_type: string }>;

  // Describe endpoint
  describe_endpoint(endpoint_name: string): Promise<{
    endpoint_status: string;
    endpoint_arn: string;
    creation_time: Date;
  }>;

  // Delete endpoint
  delete_endpoint(endpoint_name: string): Promise<void>;
}
```

**Common Workflows:**
1. **Custom Inference** — Agent invokes fine-tuned model for domain-specific predictions
2. **Batch Predictions** — Agent processes large datasets through SageMaker endpoint
3. **A/B Testing** — Agent routes traffic between model variants

**Priority:** **Tier 3** — Advanced ML for custom models.

---

## 7. Monitoring & Logging (Agent Tools)

### 7.1 Amazon CloudWatch — Metrics & Logs

**Agent Use Case:** Monitor infrastructure, query logs, create alarms.

**Tool Interface:**
```typescript
interface CloudWatchTool {
  // Put metric data
  put_metric_data(config: {
    namespace: string;
    metric_data: Array<{
      metric_name: string;
      value?: number;
      values?: number[];
      counts?: number[];
      timestamp?: Date;
      dimensions?: Array<{ name: string; value: string }>;
      unit?: string;
      storage_resolution?: number;
    }>;
  }): Promise<void>;

  // Query logs (CloudWatch Logs Insights)
  start_query(config: {
    log_group_names: string[];
    start_time: number;
    end_time: number;
    query_string: string;  // CloudWatch Insights query
    limit?: number;
  }): Promise<{ query_id: string }>;

  // Get query results
  get_query_results(query_id: string): Promise<{
    status: 'Scheduled' | 'Running' | 'Complete' | 'Failed' | 'Cancelled';
    results?: Array<Array<{ field: string; value: string }>>;
  }>;

  // Create alarm
  put_metric_alarm(config: {
    alarm_name: string;
    comparison_operator: 'GreaterThanThreshold' | 'LessThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanOrEqualToThreshold';
    evaluation_periods: number;
    metric_name: string;
    namespace: string;
    period: number;
    statistic: 'Average' | 'Sum' | 'Minimum' | 'Maximum' | 'SampleCount';
    threshold: number;
    actions_enabled?: boolean;
    alarm_actions?: string[];  // SNS topic ARNs
    alarm_description?: string;
  }): Promise<void>;

  // Describe alarms
  describe_alarms(config?: {
    alarm_names?: string[];
    state_value?: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';
  }): Promise<{
    metric_alarms: Array<{
      alarm_name: string;
      state_value: string;
      state_reason: string;
    }>;
  }>;
}
```

**Common Workflows:**
1. **Custom Metrics** — Agent publishes business metrics (orders/min, API latency)
2. **Log Analysis** — Query application logs for errors, patterns, trends
3. **Auto-Remediation** — Alarm triggers SNS → Lambda → auto-scaling action

**Priority:** **Tier 1** — Essential observability for agent-managed infrastructure.

---

## 8. Security & IAM (Agent Tools)

### 8.1 AWS IAM — Identity & Access Management

**Agent Use Case:** Create and manage IAM roles, policies, and users.

**Tool Interface:**
```typescript
interface IAMTool {
  // Create role
  create_role(config: {
    role_name: string;
    assume_role_policy_document: string;  // JSON trust policy
    description?: string;
    max_session_duration?: number;
    tags?: Array<{ key: string; value: string }>;
  }): Promise<{ role: { arn: string; role_id: string } }>;

  // Attach policy to role
  attach_role_policy(config: {
    role_name: string;
    policy_arn: string;  // Managed policy ARN
  }): Promise<void>;

  // Put inline policy
  put_role_policy(config: {
    role_name: string;
    policy_name: string;
    policy_document: string;  // JSON policy
  }): Promise<void>;

  // Create policy
  create_policy(config: {
    policy_name: string;
    policy_document: string;
    description?: string;
    tags?: Array<{ key: string; value: string }>;
  }): Promise<{ policy: { arn: string; policy_id: string } }>;

  // List roles
  list_roles(config?: {
    path_prefix?: string;
    max_items?: number;
  }): Promise<{
    roles: Array<{ role_name: string; arn: string; create_date: Date }>;
  }>;

  // Delete role
  delete_role(role_name: string): Promise<void>;
}
```

**Permission Scoping:**
```json
{
  "Effect": "Allow",
  "Action": [
    "iam:CreateRole",
    "iam:AttachRolePolicy",
    "iam:PutRolePolicy",
    "iam:CreatePolicy",
    "iam:ListRoles",
    "iam:DeleteRole"
  ],
  "Resource": "arn:aws:iam::${account_id}:role/agent-managed-*",
  "Condition": {
    "StringEquals": {
      "iam:PermissionsBoundary": "arn:aws:iam::${account_id}:policy/TenantPermissionsBoundary"
    }
  }
}
```

**Common Workflows:**
1. **Service Roles** — Agent creates IAM roles for Lambda, EC2, ECS with least-privilege policies
2. **Cross-Account Access** — Create roles with trust relationships for external accounts
3. **Temporary Credentials** — Agent assumes roles for time-limited access

**Priority:** **Tier 4** — Advanced capability requiring careful permission boundaries.

---

## 9. Multi-Region & Networking (Agent Tools)

### 9.1 Amazon Route 53 — DNS Management

**Agent Use Case:** Manage DNS records, health checks, and traffic routing.

**Tool Interface:**
```typescript
interface Route53Tool {
  // Create hosted zone
  create_hosted_zone(config: {
    name: string;  // e.g., 'example.com.'
    caller_reference: string;
    hosted_zone_config?: { comment?: string; private_zone?: boolean };
  }): Promise<{ hosted_zone: { id: string; name: string } }>;

  // Change resource record sets
  change_resource_record_sets(config: {
    hosted_zone_id: string;
    changes: Array<{
      action: 'CREATE' | 'DELETE' | 'UPSERT';
      resource_record_set: {
        name: string;
        type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV';
        ttl?: number;
        resource_records?: Array<{ value: string }>;
        alias_target?: { hosted_zone_id: string; dns_name: string; evaluate_target_health: boolean };
      };
    }>;
  }): Promise<{ change_info: { id: string; status: string } }>;

  // List resource record sets
  list_resource_record_sets(config: {
    hosted_zone_id: string;
    max_items?: number;
  }): Promise<{
    resource_record_sets: Array<{
      name: string;
      type: string;
      ttl?: number;
      resource_records?: Array<{ value: string }>;
    }>;
  }>;

  // Delete hosted zone
  delete_hosted_zone(hosted_zone_id: string): Promise<void>;
}
```

**Common Workflows:**
1. **Dynamic DNS** — Agent updates DNS records based on deployment changes
2. **Traffic Routing** — Geo-routing, weighted routing, failover routing
3. **Health Checks** — Monitor endpoint health, failover to backup

**Priority:** **Tier 4** — Advanced networking for multi-region deployments.

---

## 10. Cost Management (Agent Tools)

### 10.1 AWS Cost Explorer — Cost Analysis

**Agent Use Case:** Query and analyze AWS spending programmatically.

**Tool Interface:**
```typescript
interface CostExplorerTool {
  // Get cost and usage
  get_cost_and_usage(config: {
    time_period: { start: string; end: string };  // 'YYYY-MM-DD'
    granularity: 'DAILY' | 'MONTHLY' | 'HOURLY';
    metrics: Array<'BlendedCost' | 'UnblendedCost' | 'AmortizedCost' | 'UsageQuantity'>;
    group_by?: Array<{ type: 'DIMENSION' | 'TAG'; key: string }>;
    filter?: any;
  }): Promise<{
    results_by_time: Array<{
      time_period: { start: string; end: string };
      total: Record<string, { amount: string; unit: string }>;
      groups?: Array<{ keys: string[]; metrics: Record<string, any> }>;
    }>;
  }>;

  // Get cost forecast
  get_cost_forecast(config: {
    time_period: { start: string; end: string };
    metric: 'BLENDED_COST' | 'UNBLENDED_COST' | 'AMORTIZED_COST';
    granularity: 'DAILY' | 'MONTHLY';
  }): Promise<{
    total: { amount: string; unit: string };
    forecast_results_by_time: Array<{
      time_period: { start: string; end: string };
      mean_value: string;
    }>;
  }>;
}
```

**Common Workflows:**
1. **Budget Alerts** — Agent monitors daily spending, alerts on anomalies
2. **Cost Attribution** — Group costs by service, tag, or account for chargeback
3. **Optimization** — Identify idle resources, recommend rightsizing

**Priority:** **Tier 4** — Cost governance for enterprise tenants.

---

## Implementation Strategy

### Phase 1: Core Compute & Storage (Tier 1)
**Timeline:** Q1 2026
**Services:** Lambda, EC2, ECS, S3, CloudWatch
**Goal:** Enable basic infrastructure automation

### Phase 2: Data & Messaging (Tier 2)
**Timeline:** Q2 2026
**Services:** DynamoDB, RDS, SQS, SNS, EventBridge
**Goal:** Stateful workflows and event-driven architectures

### Phase 3: Orchestration & ML (Tier 3)
**Timeline:** Q3 2026
**Services:** Step Functions, Bedrock, SageMaker
**Goal:** Advanced workflows and AI-powered agents

### Phase 4: Security & Advanced (Tier 4)
**Timeline:** Q4 2026
**Services:** IAM, Route 53, Cost Explorer
**Goal:** Enterprise governance and multi-account management

---

## Security & Governance

### Permission Boundaries
All agent-created IAM roles must have a permission boundary:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "*",
      "Resource": "*",
      "Condition": {
        "StringLike": {
          "aws:ResourceTag/ManagedBy": "chimera-agent-${tenant_id}"
        }
      }
    }
  ]
}
```

### Resource Tagging
All agent-created resources must have:
- `ManagedBy: chimera-agent-${tenant_id}`
- `CreatedAt: ${timestamp}`
- `CreatedBy: ${agent_id}`

### Cost Controls
- Per-tenant spending limits enforced via AWS Budgets
- Real-time cost tracking in DynamoDB `chimera-cost-tracking` table
- Auto-suspend agents exceeding quota

---

## Summary: 25 Core Services as Agent Tools

| Service | Category | Priority | Use Case |
|---------|----------|----------|----------|
| **Lambda** | Compute | Tier 1 | Serverless functions |
| **EC2** | Compute | Tier 1 | Virtual machines |
| **ECS/Fargate** | Compute | Tier 1 | Containers |
| **S3** | Storage | Tier 1 | Object storage |
| **CloudWatch** | Monitoring | Tier 1 | Metrics & logs |
| **DynamoDB** | Database | Tier 2 | NoSQL |
| **RDS** | Database | Tier 2 | Relational DB |
| **SQS** | Messaging | Tier 2 | Message queues |
| **SNS** | Messaging | Tier 2 | Pub/sub |
| **EventBridge** | Events | Tier 2 | Event bus |
| **Step Functions** | Orchestration | Tier 3 | Workflows |
| **Bedrock** | ML | Tier 3 | LLM API |
| **SageMaker** | ML | Tier 3 | Custom models |
| **IAM** | Security | Tier 4 | Access control |
| **Route 53** | Networking | Tier 4 | DNS |
| **Cost Explorer** | Cost | Tier 4 | Spending analysis |

**Next:** [02-SDK-Integration-Patterns.md](./02-SDK-Integration-Patterns.md) — How to integrate boto3, AWS SDK v3, and AWS CLI into agent runtimes.
