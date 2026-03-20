import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface EvolutionStackProps extends cdk.StackProps {
  envName: string;
  auditTable: dynamodb.ITable;
}

/**
 * Self-Evolution Engine for Chimera.
 *
 * Implements the self-improvement mechanisms from Chimera-Self-Evolution-Engine.md:
 * - Prompt evolution via A/B testing
 * - Auto-skill generation from repeated patterns
 * - Model routing optimization (Bayesian)
 * - Memory evolution and garbage collection
 * - Cron self-scheduling
 * - Infrastructure self-modification (GitOps)
 *
 * All changes are bounded by Cedar policies, audited, and reversible via S3 snapshots.
 *
 * Reference: docs/research/architecture-reviews/Chimera-Self-Evolution-Engine.md
 */
export class EvolutionStack extends cdk.Stack {
  public readonly evolutionStateTable: dynamodb.Table;
  public readonly evolutionArtifactsBucket: s3.Bucket;
  public readonly promptEvolutionStateMachine: stepfunctions.StateMachine;
  public readonly skillGenerationStateMachine: stepfunctions.StateMachine;
  public readonly memoryEvolutionStateMachine: stepfunctions.StateMachine;
  public readonly feedbackProcessorStateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: EvolutionStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // DynamoDB: chimera-evolution-state
    // Stores A/B test state, model routing weights, memory lifecycle,
    // detected patterns, cron suggestions, feedback events, health scores.
    // ======================================================================
    this.evolutionStateTable = new dynamodb.Table(this, 'EvolutionStateTable', {
      tableName: `chimera-evolution-state-${props.envName}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ttl',
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // GSI1: Memory Lifecycle Index
    // Query all memories by lifecycle status (active, hot, warm, cold, archived)
    // PK: TENANT#{tenant_id}#LIFECYCLE#{lifecycle}, SK: last_accessed
    this.evolutionStateTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-lifecycle',
      partitionKey: { name: 'lifecycleIndexPK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'last_accessed', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: Unprocessed Feedback Index
    // Query all unprocessed feedback events by type for batch processing
    // PK: TENANT#{tenant_id}#UNPROCESSED, SK: feedback_type#timestamp
    this.evolutionStateTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-unprocessed-feedback',
      partitionKey: { name: 'unprocessedIndexPK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'feedbackSortKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ======================================================================
    // S3: Evolution Artifacts
    // Stores pre-change snapshots for rollback, A/B test golden datasets,
    // generated skill packages, and memory evolution logs.
    // ======================================================================
    this.evolutionArtifactsBucket = new s3.Bucket(this, 'EvolutionArtifactsBucket', {
      bucketName: `chimera-evolution-artifacts-${this.account}-${this.region}-${props.envName}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'expire-old-snapshots',
          prefix: 'snapshots/',
          expiration: cdk.Duration.days(90), // Rollback window: 90 days
        },
        {
          id: 'archive-golden-datasets',
          prefix: 'golden-datasets/',
          transitions: [{
            storageClass: s3.StorageClass.GLACIER,
            transitionAfter: cdk.Duration.days(180),
          }],
        },
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // ======================================================================
    // Lambda Functions for Evolution Tasks
    // ======================================================================

    // Prompt Evolution: Analyze conversation logs for failure patterns
    const analyzeConversationLogsFunction = new lambda.Function(this, 'AnalyzeConversationLogsFunction', {
      functionName: `chimera-evolution-analyze-logs-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    """
    Analyze conversation logs for failure patterns.

    Scans recent sessions for:
    - Tool call failures
    - User corrections ("no, I meant...", "that's wrong")
    - Repeated clarification requests
    - High-latency exchanges
    """
    # TODO: Implement actual log analysis
    return {
        'tenant_id': event['tenant_id'],
        'failures': [],
        'corrections': [],
        'patterns': []
    }
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        EVOLUTION_TABLE: this.evolutionStateTable.tableName,
        ARTIFACTS_BUCKET: this.evolutionArtifactsBucket.bucketName,
      },
    });

    // Prompt Evolution: Generate improved prompt variants
    const generatePromptVariantFunction = new lambda.Function(this, 'GeneratePromptVariantFunction', {
      functionName: `chimera-evolution-generate-prompt-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    """
    Generate improved prompt variant based on failure analysis.

    Uses Nova Micro meta-agent to rewrite prompts addressing failures.
    """
    # TODO: Implement meta-agent prompt generation
    return {
        'variant_id': 'v-202603200000',
        'improved_prompt': 'placeholder',
        'changes': []
    }
`),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
    });

    // Prompt Evolution: Test prompt variant in sandbox
    const testPromptVariantFunction = new lambda.Function(this, 'TestPromptVariantFunction', {
      functionName: `chimera-evolution-test-prompt-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    """
    Test prompt variant against golden dataset in AgentCore sandbox.
    """
    # TODO: Implement sandbox testing
    return {
        'variant_id': event['variant_id'],
        'avg_quality_score': 0.88,
        'pass_rate': 0.85,
        'avg_tokens_per_case': 1200
    }
`),
      timeout: cdk.Duration.minutes(10),
      memorySize: 2048,
    });

    // Skill Generation: Detect repeated tool call patterns
    const detectPatternsFunction = new lambda.Function(this, 'DetectPatternsFunction', {
      functionName: `chimera-evolution-detect-patterns-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    """
    Detect repeated multi-step tool sequences using n-gram extraction.

    Analyzes conversation logs with sliding window, identifies patterns
    that appear >= min_occurrences times.
    """
    # TODO: Implement pattern detection algorithm
    return {
        'tenant_id': event['tenant_id'],
        'patterns_found': 0,
        'top_patterns': []
    }
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
    });

    // Skill Generation: Generate SKILL.md from detected pattern
    const generateSkillFunction = new lambda.Function(this, 'GenerateSkillFunction', {
      functionName: `chimera-evolution-generate-skill-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    """
    Generate SKILL.md and tool wrapper from repeated pattern.
    """
    # TODO: Implement skill generation
    return {
        'skill_name': 'auto-generated-skill',
        'skill_md': 'placeholder',
        'tool_code': 'placeholder',
        'confidence': 0.8
    }
`),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
    });

    // Memory Evolution: Run garbage collection on memories
    const memoryGarbageCollectionFunction = new lambda.Function(this, 'MemoryGCFunction', {
      functionName: `chimera-evolution-memory-gc-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    """
    Memory garbage collection: prune, merge, promote, archive.

    Phases:
    1. Temporal decay - archive stale memories
    2. Promotion - frequently accessed memories become skills
    3. Contradiction detection - identify conflicting facts
    4. Deduplication - merge near-duplicate entries
    """
    # TODO: Implement memory GC algorithm
    return {
        'tenant_id': event['tenant_id'],
        'pruned': 0,
        'promoted': 0,
        'merged': 0,
        'archived': 0
    }
`),
      timeout: cdk.Duration.minutes(10),
      memorySize: 2048,
    });

    // Feedback Processing: Route feedback to appropriate subsystems
    const processFeedbackFunction = new lambda.Function(this, 'ProcessFeedbackFunction', {
      functionName: `chimera-evolution-process-feedback-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    """
    Process feedback events and route to evolution subsystems.

    Routes:
    - thumbs_down -> prompt evolution + model routing (negative reward)
    - thumbs_up -> model routing (positive reward)
    - correction -> prompt evolution + memory
    - remember -> memory storage
    """
    # TODO: Implement feedback routing
    return {
        'processed': 0,
        'routed_to': []
    }
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
    });

    // Rollback: Restore previous state from S3 snapshot
    const rollbackChangeFunction = new lambda.Function(this, 'RollbackChangeFunction', {
      functionName: `chimera-evolution-rollback-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    """
    Roll back evolution change using pre-state snapshot from S3.
    """
    # TODO: Implement rollback logic
    return {
        'status': 'rolled_back',
        'event_id': event['event_id']
    }
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
    });

    // Grant permissions
    this.evolutionStateTable.grantReadWriteData(analyzeConversationLogsFunction);
    this.evolutionStateTable.grantReadWriteData(generatePromptVariantFunction);
    this.evolutionStateTable.grantReadWriteData(testPromptVariantFunction);
    this.evolutionStateTable.grantReadWriteData(detectPatternsFunction);
    this.evolutionStateTable.grantReadWriteData(generateSkillFunction);
    this.evolutionStateTable.grantReadWriteData(memoryGarbageCollectionFunction);
    this.evolutionStateTable.grantReadWriteData(processFeedbackFunction);
    this.evolutionStateTable.grantReadWriteData(rollbackChangeFunction);

    this.evolutionArtifactsBucket.grantReadWrite(analyzeConversationLogsFunction);
    this.evolutionArtifactsBucket.grantReadWrite(testPromptVariantFunction);
    this.evolutionArtifactsBucket.grantReadWrite(generateSkillFunction);
    this.evolutionArtifactsBucket.grantReadWrite(rollbackChangeFunction);

    props.auditTable.grantWriteData(rollbackChangeFunction);

    // ======================================================================
    // Step Functions: Prompt Evolution Pipeline
    // ======================================================================

    const analyzeLogsTask = new tasks.LambdaInvoke(this, 'AnalyzeLogs', {
      lambdaFunction: analyzeConversationLogsFunction,
      outputPath: '$.Payload',
    });

    const generateVariantTask = new tasks.LambdaInvoke(this, 'GenerateVariant', {
      lambdaFunction: generatePromptVariantFunction,
      outputPath: '$.Payload',
    });

    const testVariantTask = new tasks.LambdaInvoke(this, 'TestVariant', {
      lambdaFunction: testPromptVariantFunction,
      outputPath: '$.Payload',
    });

    const variantTestPassed = new stepfunctions.Choice(this, 'VariantTestPassed')
      .when(
        stepfunctions.Condition.numberGreaterThan('$.avg_quality_score', 0.8),
        new stepfunctions.Succeed(this, 'PromptEvolutionSuccess')
      )
      .otherwise(new stepfunctions.Fail(this, 'PromptEvolutionFailed', {
        error: 'VariantDidNotImprove',
        cause: 'New prompt variant did not exceed quality threshold',
      }));

    const promptEvolutionDefinition = analyzeLogsTask
      .next(generateVariantTask)
      .next(testVariantTask)
      .next(variantTestPassed);

    const promptEvolutionLogGroup = new logs.LogGroup(this, 'PromptEvolutionLogGroup', {
      logGroupName: `/aws/states/chimera-prompt-evolution-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.promptEvolutionStateMachine = new stepfunctions.StateMachine(this, 'PromptEvolutionPipeline', {
      stateMachineName: `chimera-prompt-evolution-${props.envName}`,
      definition: promptEvolutionDefinition,
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      logs: {
        destination: promptEvolutionLogGroup,
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });

    // ======================================================================
    // Step Functions: Skill Auto-Generation Pipeline
    // ======================================================================

    const detectPatternsTask = new tasks.LambdaInvoke(this, 'DetectPatterns', {
      lambdaFunction: detectPatternsFunction,
      outputPath: '$.Payload',
    });

    const generateSkillTask = new tasks.LambdaInvoke(this, 'GenerateSkill', {
      lambdaFunction: generateSkillFunction,
      outputPath: '$.Payload',
    });

    const patternsFound = new stepfunctions.Choice(this, 'PatternsFound')
      .when(
        stepfunctions.Condition.numberGreaterThan('$.patterns_found', 0),
        generateSkillTask.next(new stepfunctions.Succeed(this, 'SkillGenerationSuccess'))
      )
      .otherwise(new stepfunctions.Succeed(this, 'NoPatternsDetected'));

    const skillGenerationDefinition = detectPatternsTask.next(patternsFound);

    const skillGenerationLogGroup = new logs.LogGroup(this, 'SkillGenerationLogGroup', {
      logGroupName: `/aws/states/chimera-skill-generation-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.skillGenerationStateMachine = new stepfunctions.StateMachine(this, 'SkillGenerationPipeline', {
      stateMachineName: `chimera-skill-generation-${props.envName}`,
      definition: skillGenerationDefinition,
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      logs: {
        destination: skillGenerationLogGroup,
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });

    // ======================================================================
    // Step Functions: Memory Evolution Pipeline
    // ======================================================================

    const memoryGCTask = new tasks.LambdaInvoke(this, 'MemoryGC', {
      lambdaFunction: memoryGarbageCollectionFunction,
      outputPath: '$.Payload',
    });

    const memoryEvolutionDefinition = memoryGCTask.next(
      new stepfunctions.Succeed(this, 'MemoryEvolutionSuccess')
    );

    const memoryEvolutionLogGroup = new logs.LogGroup(this, 'MemoryEvolutionLogGroup', {
      logGroupName: `/aws/states/chimera-memory-evolution-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.memoryEvolutionStateMachine = new stepfunctions.StateMachine(this, 'MemoryEvolutionPipeline', {
      stateMachineName: `chimera-memory-evolution-${props.envName}`,
      definition: memoryEvolutionDefinition,
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      logs: {
        destination: memoryEvolutionLogGroup,
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });

    // ======================================================================
    // Step Functions: Feedback Processing Pipeline
    // ======================================================================

    const processFeedbackTask = new tasks.LambdaInvoke(this, 'ProcessFeedback', {
      lambdaFunction: processFeedbackFunction,
      outputPath: '$.Payload',
    });

    const feedbackProcessorDefinition = processFeedbackTask.next(
      new stepfunctions.Succeed(this, 'FeedbackProcessingSuccess')
    );

    const feedbackProcessorLogGroup = new logs.LogGroup(this, 'FeedbackProcessorLogGroup', {
      logGroupName: `/aws/states/chimera-feedback-processor-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.feedbackProcessorStateMachine = new stepfunctions.StateMachine(this, 'FeedbackProcessorPipeline', {
      stateMachineName: `chimera-feedback-processor-${props.envName}`,
      definition: feedbackProcessorDefinition,
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      logs: {
        destination: feedbackProcessorLogGroup,
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });

    // ======================================================================
    // EventBridge: Scheduled Evolution Tasks
    // ======================================================================

    // Daily: Prompt evolution analysis
    new events.Rule(this, 'DailyPromptEvolutionRule', {
      ruleName: `chimera-daily-prompt-evolution-${props.envName}`,
      description: 'Trigger daily prompt evolution analysis',
      schedule: events.Schedule.cron({ hour: '2', minute: '0' }), // 2 AM UTC
      targets: [new targets.SfnStateMachine(this.promptEvolutionStateMachine)],
    });

    // Weekly: Skill pattern detection
    new events.Rule(this, 'WeeklySkillGenerationRule', {
      ruleName: `chimera-weekly-skill-generation-${props.envName}`,
      description: 'Trigger weekly skill auto-generation',
      schedule: events.Schedule.cron({ weekDay: 'SUN', hour: '3', minute: '0' }), // Sunday 3 AM UTC
      targets: [new targets.SfnStateMachine(this.skillGenerationStateMachine)],
    });

    // Daily: Memory garbage collection
    new events.Rule(this, 'DailyMemoryEvolutionRule', {
      ruleName: `chimera-daily-memory-evolution-${props.envName}`,
      description: 'Trigger daily memory evolution and GC',
      schedule: events.Schedule.cron({ hour: '4', minute: '0' }), // 4 AM UTC
      targets: [new targets.SfnStateMachine(this.memoryEvolutionStateMachine)],
    });

    // Hourly: Feedback processing
    new events.Rule(this, 'HourlyFeedbackProcessingRule', {
      ruleName: `chimera-hourly-feedback-processing-${props.envName}`,
      description: 'Trigger hourly feedback event processing',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.SfnStateMachine(this.feedbackProcessorStateMachine)],
    });

    // ======================================================================
    // Stack Outputs
    // ======================================================================

    new cdk.CfnOutput(this, 'EvolutionStateTableArn', {
      value: this.evolutionStateTable.tableArn,
      exportName: `${this.stackName}-EvolutionStateTableArn`,
      description: 'Evolution state DynamoDB table ARN',
    });

    new cdk.CfnOutput(this, 'EvolutionStateTableName', {
      value: this.evolutionStateTable.tableName,
      exportName: `${this.stackName}-EvolutionStateTableName`,
      description: 'Evolution state DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'EvolutionArtifactsBucketArn', {
      value: this.evolutionArtifactsBucket.bucketArn,
      exportName: `${this.stackName}-EvolutionArtifactsBucketArn`,
      description: 'Evolution artifacts S3 bucket ARN',
    });

    new cdk.CfnOutput(this, 'EvolutionArtifactsBucketName', {
      value: this.evolutionArtifactsBucket.bucketName,
      exportName: `${this.stackName}-EvolutionArtifactsBucketName`,
      description: 'Evolution artifacts S3 bucket name',
    });

    new cdk.CfnOutput(this, 'PromptEvolutionStateMachineArn', {
      value: this.promptEvolutionStateMachine.stateMachineArn,
      exportName: `${this.stackName}-PromptEvolutionStateMachineArn`,
      description: 'Prompt evolution pipeline state machine ARN',
    });

    new cdk.CfnOutput(this, 'SkillGenerationStateMachineArn', {
      value: this.skillGenerationStateMachine.stateMachineArn,
      exportName: `${this.stackName}-SkillGenerationStateMachineArn`,
      description: 'Skill auto-generation pipeline state machine ARN',
    });

    new cdk.CfnOutput(this, 'MemoryEvolutionStateMachineArn', {
      value: this.memoryEvolutionStateMachine.stateMachineArn,
      exportName: `${this.stackName}-MemoryEvolutionStateMachineArn`,
      description: 'Memory evolution pipeline state machine ARN',
    });

    new cdk.CfnOutput(this, 'FeedbackProcessorStateMachineArn', {
      value: this.feedbackProcessorStateMachine.stateMachineArn,
      exportName: `${this.stackName}-FeedbackProcessorStateMachineArn`,
      description: 'Feedback processing pipeline state machine ARN',
    });
  }
}
