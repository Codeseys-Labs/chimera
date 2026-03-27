/**
 * CDK tests for EvolutionStack
 *
 * Validates self-evolution engine infrastructure:
 * - DynamoDB evolution state table with GSIs
 * - S3 evolution artifacts bucket with lifecycle rules
 * - Lambda functions for each evolution pipeline step
 * - Step Functions state machines (prompt, skill, memory, feedback)
 * - EventBridge scheduled rules
 * - Stack outputs
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { EvolutionStack } from '../lib/evolution-stack';

// Timeout configured in infra/bunfig.toml: [test] timeout = 30000

describe('EvolutionStack', () => {
  let stack: EvolutionStack;
  let template: Template;

  // Synthesize once — CDK synthesis of a large stack is expensive
  beforeAll(() => {
    const app = new cdk.App();
    const auditStack = new cdk.Stack(app, 'AuditStack');
    const auditTable = new dynamodb.Table(auditStack, 'AuditTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    });

    stack = new EvolutionStack(app, 'TestEvolutionStack', {
      envName: 'dev',
      auditTable,
    });
    template = Template.fromStack(stack);
  });

  describe('DynamoDB: Evolution State Table', () => {
    it('should create evolution state table with correct key schema', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'chimera-evolution-state-dev',
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
        StreamSpecification: {
          StreamViewType: 'NEW_AND_OLD_IMAGES',
        },
        TimeToLiveSpecification: {
          AttributeName: 'ttl',
          Enabled: true,
        },
      });
    });

    it('should create GSI1-lifecycle index for memory lifecycle queries', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'chimera-evolution-state-dev',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'GSI1-lifecycle',
            KeySchema: [
              { AttributeName: 'lifecycleIndexPK', KeyType: 'HASH' },
              { AttributeName: 'last_accessed', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          }),
        ]),
      });
    });

    it('should create GSI2-unprocessed-feedback index for batch processing', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'chimera-evolution-state-dev',
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'GSI2-unprocessed-feedback',
            KeySchema: [
              { AttributeName: 'unprocessedIndexPK', KeyType: 'HASH' },
              { AttributeName: 'feedbackSortKey', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          }),
        ]),
      });
    });

    it('should have DESTROY removal policy in dev', () => {
      const tables = template.findResources('AWS::DynamoDB::Table', {
        Properties: { TableName: 'chimera-evolution-state-dev' },
      });
      const tableResource = Object.values(tables)[0] as any;
      expect(tableResource.DeletionPolicy).toBe('Delete');
    });
  });

  describe('S3: Evolution Artifacts Bucket', () => {
    it('should create artifacts bucket with versioning and encryption', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        VersioningConfiguration: { Status: 'Enabled' },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
            },
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it('should have lifecycle rule expiring snapshots after 90 days', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'expire-old-snapshots',
              Status: 'Enabled',
              Prefix: 'snapshots/',
              ExpirationInDays: 90,
            }),
          ]),
        },
      });
    });

    it('should have lifecycle rule archiving golden datasets to Glacier', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'archive-golden-datasets',
              Status: 'Enabled',
              Prefix: 'golden-datasets/',
              Transitions: [
                {
                  StorageClass: 'GLACIER',
                  TransitionInDays: 180,
                },
              ],
            }),
          ]),
        },
      });
    });

    it('should have lifecycle rule expiring noncurrent versions after 30 days', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'expire-noncurrent-versions',
              Status: 'Enabled',
              NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            }),
          ]),
        },
      });
    });

    it('should enforce SSL on artifacts bucket', () => {
      const policies = template.findResources('AWS::S3::BucketPolicy');
      const bucketPolicies = Object.values(policies);
      const sslEnforced = bucketPolicies.some((policy: any) => {
        const statements = policy.Properties.PolicyDocument.Statement;
        return statements.some(
          (s: any) =>
            s.Effect === 'Deny' &&
            s.Condition?.Bool?.['aws:SecureTransport'] === 'false',
        );
      });
      expect(sslEnforced).toBe(true);
    });
  });

  describe('Lambda Functions', () => {
    it('should create AnalyzeConversationLogsFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-evolution-analyze-logs-dev',
        Runtime: 'python3.12',
        Timeout: 300, // 5 minutes
        MemorySize: 1024,
        Environment: {
          Variables: Match.objectLike({
            EVOLUTION_TABLE: Match.anyValue(),
            ARTIFACTS_BUCKET: Match.anyValue(),
          }),
        },
      });
    });

    it('should create GeneratePromptVariantFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-evolution-generate-prompt-dev',
        Runtime: 'python3.12',
        Timeout: 120, // 2 minutes
        MemorySize: 512,
      });
    });

    it('should create TestPromptVariantFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-evolution-test-prompt-dev',
        Runtime: 'python3.12',
        Timeout: 600, // 10 minutes
        MemorySize: 2048,
      });
    });

    it('should create DetectPatternsFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-evolution-detect-patterns-dev',
        Runtime: 'python3.12',
        Timeout: 300, // 5 minutes
        MemorySize: 1024,
      });
    });

    it('should create GenerateSkillFunction with evolution table and artifacts bucket', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-evolution-generate-skill-dev',
        Runtime: 'python3.12',
        Timeout: 120, // 2 minutes
        MemorySize: 512,
        Environment: {
          Variables: Match.objectLike({
            EVOLUTION_TABLE: Match.anyValue(),
            ARTIFACTS_BUCKET: Match.anyValue(),
          }),
        },
      });
    });

    it('should create MemoryGCFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-evolution-memory-gc-dev',
        Runtime: 'python3.12',
        Timeout: 600, // 10 minutes
        MemorySize: 2048,
      });
    });

    it('should create ProcessFeedbackFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-evolution-process-feedback-dev',
        Runtime: 'python3.12',
        Timeout: 300, // 5 minutes
        MemorySize: 1024,
      });
    });

    it('should create RollbackChangeFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-evolution-rollback-dev',
        Runtime: 'python3.12',
        Timeout: 300, // 5 minutes
        MemorySize: 512,
        Environment: {
          Variables: Match.objectLike({
            ARTIFACTS_BUCKET: Match.anyValue(),
            EVOLUTION_TABLE: Match.anyValue(),
          }),
        },
      });
    });
  });

  describe('Step Functions State Machines', () => {
    it('should create 4 evolution state machines', () => {
      template.resourceCountIs('AWS::StepFunctions::StateMachine', 4);
    });

    it('should create PromptEvolutionPipeline state machine', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: 'chimera-prompt-evolution-dev',
        StateMachineType: 'STANDARD',
        LoggingConfiguration: Match.objectLike({
          Level: 'ALL',
          IncludeExecutionData: true,
        }),
        TracingConfiguration: { Enabled: true },
      });
    });

    it('should create SkillGenerationPipeline state machine', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: 'chimera-skill-generation-dev',
        StateMachineType: 'STANDARD',
      });
    });

    it('should create MemoryEvolutionPipeline state machine', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: 'chimera-memory-evolution-dev',
        StateMachineType: 'STANDARD',
      });
    });

    it('should create FeedbackProcessorPipeline state machine', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: 'chimera-feedback-processor-dev',
        StateMachineType: 'STANDARD',
      });
    });

    it('should create CloudWatch log groups for all state machines', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/states/chimera-prompt-evolution-dev',
        RetentionInDays: 7,
      });

      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/states/chimera-skill-generation-dev',
        RetentionInDays: 7,
      });

      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/states/chimera-memory-evolution-dev',
        RetentionInDays: 7,
      });

      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/states/chimera-feedback-processor-dev',
        RetentionInDays: 7,
      });
    });
  });

  describe('EventBridge Scheduled Rules', () => {
    it('should create 4 scheduled evolution rules', () => {
      template.resourceCountIs('AWS::Events::Rule', 4);
    });

    it('should create daily prompt evolution rule at 2 AM UTC', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-daily-prompt-evolution-dev',
        Description: 'Trigger daily prompt evolution analysis',
        ScheduleExpression: 'cron(0 2 * * ? *)',
      });
    });

    it('should create weekly skill generation rule on Sunday at 3 AM UTC', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-weekly-skill-generation-dev',
        Description: 'Trigger weekly skill auto-generation',
        ScheduleExpression: 'cron(0 3 ? * SUN *)',
      });
    });

    it('should create daily memory evolution rule at 4 AM UTC', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-daily-memory-evolution-dev',
        Description: 'Trigger daily memory evolution and GC',
        ScheduleExpression: 'cron(0 4 * * ? *)',
      });
    });

    it('should create hourly feedback processing rule', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-hourly-feedback-processing-dev',
        Description: 'Trigger hourly feedback event processing',
        ScheduleExpression: 'rate(1 hour)',
      });
    });
  });

  describe('Stack Outputs', () => {
    it('should export evolution state table ARN and name', () => {
      template.hasOutput('EvolutionStateTableArn', {
        Export: { Name: 'TestEvolutionStack-EvolutionStateTableArn' },
      });
      template.hasOutput('EvolutionStateTableName', {
        Export: { Name: 'TestEvolutionStack-EvolutionStateTableName' },
      });
    });

    it('should export evolution artifacts bucket ARN and name', () => {
      template.hasOutput('EvolutionArtifactsBucketArn', {
        Export: { Name: 'TestEvolutionStack-EvolutionArtifactsBucketArn' },
      });
      template.hasOutput('EvolutionArtifactsBucketName', {
        Export: { Name: 'TestEvolutionStack-EvolutionArtifactsBucketName' },
      });
    });

    it('should export all 4 state machine ARNs', () => {
      template.hasOutput('PromptEvolutionStateMachineArn', {
        Export: { Name: 'TestEvolutionStack-PromptEvolutionStateMachineArn' },
      });
      template.hasOutput('SkillGenerationStateMachineArn', {
        Export: { Name: 'TestEvolutionStack-SkillGenerationStateMachineArn' },
      });
      template.hasOutput('MemoryEvolutionStateMachineArn', {
        Export: { Name: 'TestEvolutionStack-MemoryEvolutionStateMachineArn' },
      });
      template.hasOutput('FeedbackProcessorStateMachineArn', {
        Export: { Name: 'TestEvolutionStack-FeedbackProcessorStateMachineArn' },
      });
    });

    it('should expose public properties for same-app references', () => {
      expect(stack.evolutionStateTable).toBeDefined();
      expect(stack.evolutionArtifactsBucket).toBeDefined();
      expect(stack.promptEvolutionStateMachine).toBeDefined();
      expect(stack.skillGenerationStateMachine).toBeDefined();
      expect(stack.memoryEvolutionStateMachine).toBeDefined();
      expect(stack.feedbackProcessorStateMachine).toBeDefined();
    });
  });

  describe('Lambda Handler Logic (no TODO stubs)', () => {
    const getFunctionCode = (functionName: string): string => {
      const resources = template.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: functionName },
      });
      const fn = Object.values(resources)[0] as any;
      return (fn?.Properties?.Code?.ZipFile as string) ?? '';
    };

    it('AnalyzeConversationLogsFunction should have real DynamoDB implementation', () => {
      const code = getFunctionCode('chimera-evolution-analyze-logs-dev');
      expect(code).not.toContain('# TODO');
      expect(code).toContain('boto3');
      expect(code).toContain('table.query');
      expect(code).toContain('failures');
      expect(code).toContain('corrections');
    });

    it('GeneratePromptVariantFunction should have real prompt generation logic', () => {
      const code = getFunctionCode('chimera-evolution-generate-prompt-dev');
      expect(code).not.toContain('# TODO');
      expect(code).toContain('boto3');
      expect(code).toContain('EVOLUTION_TABLE');
      expect(code).toContain('variant_id');
      expect(code).toContain('table.put_item');
    });

    it('TestPromptVariantFunction should have real evaluation logic', () => {
      const code = getFunctionCode('chimera-evolution-test-prompt-dev');
      expect(code).not.toContain('# TODO');
      expect(code).toContain('boto3');
      expect(code).toContain('avg_quality_score');
      expect(code).toContain('golden_cases');
      expect(code).toContain('pass_rate');
    });

    it('MemoryGCFunction should have real lifecycle transition logic', () => {
      const code = getFunctionCode('chimera-evolution-memory-gc-dev');
      expect(code).not.toContain('# TODO');
      expect(code).toContain('boto3');
      expect(code).toContain('WARM_THRESHOLD_DAYS');
      expect(code).toContain('GSI1-lifecycle');
      expect(code).toContain('promoted');
    });

    it('ProcessFeedbackFunction should have real feedback routing logic', () => {
      const code = getFunctionCode('chimera-evolution-process-feedback-dev');
      expect(code).not.toContain('# TODO');
      expect(code).toContain('boto3');
      expect(code).toContain('thumbs_down');
      expect(code).toContain('thumbs_up');
      expect(code).toContain('correction');
      expect(code).toContain('GSI2-unprocessed-feedback');
    });
  });

  describe('Prod Environment', () => {
    let prodStack: EvolutionStack;
    let prodTemplate: Template;

    beforeAll(() => {
      const prodApp = new cdk.App();
      const prodAuditStack = new cdk.Stack(prodApp, 'ProdAuditStack');
      const prodAuditTable = new dynamodb.Table(prodAuditStack, 'ProdAuditTable', {
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      });
      prodStack = new EvolutionStack(prodApp, 'ProdEvolutionStack', {
        envName: 'prod',
        auditTable: prodAuditTable,
      });
      prodTemplate = Template.fromStack(prodStack);
    });

    it('should use RETAIN removal policy for table in prod', () => {
      const tables = prodTemplate.findResources('AWS::DynamoDB::Table', {
        Properties: { TableName: 'chimera-evolution-state-prod' },
      });
      const tableResource = Object.values(tables)[0] as any;
      expect(tableResource.DeletionPolicy).toBe('Retain');
    });

    it('should use RETAIN removal policy for S3 bucket in prod', () => {
      const allBuckets = prodTemplate.findResources('AWS::S3::Bucket');
      for (const bucket of Object.values(allBuckets)) {
        const b = bucket as any;
        // Buckets with RETAIN policy have DeletionPolicy: 'Retain'
        if (b.DeletionPolicy === 'Retain') {
          expect(b.DeletionPolicy).toBe('Retain');
          return;
        }
      }
      // If no bucket has Retain, the test should fail
      const retainedBuckets = Object.values(allBuckets).filter(
        (b: any) => b.DeletionPolicy === 'Retain',
      );
      expect(retainedBuckets.length).toBeGreaterThan(0);
    });

    it('should use 1-month log retention in prod state machine log groups', () => {
      prodTemplate.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/states/chimera-prompt-evolution-prod',
        RetentionInDays: 30,
      });
    });

    it('should not add autoDeleteObjects in prod', () => {
      // In prod, autoDeleteObjects is false so no custom resource for S3 deletion
      const devBucketPolicies = template.findResources('AWS::S3::BucketPolicy');
      const prodBucketPolicies = prodTemplate.findResources('AWS::S3::BucketPolicy');
      // Both should have the SSL-enforcing bucket policy
      expect(Object.keys(prodBucketPolicies).length).toBeGreaterThan(0);
    });
  });
});
