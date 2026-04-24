/**
 * CDK tests for SkillPipelineStack
 *
 * Validates the 7-stage skill security scanning pipeline:
 * - 8 Lambda functions (7 pipeline stages + 1 failure handler)
 * - SNS topic for failure notifications
 * - Secrets Manager secret for Ed25519 signing key
 * - Step Functions Standard state machine
 * - CloudWatch log group for state machine execution logs
 * - Stack outputs for state machine ARN, name, and failure topic ARN
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { SkillPipelineStack } from '../lib/skill-pipeline-stack';

describe('SkillPipelineStack', () => {
  let app: cdk.App;
  let skillsTable: dynamodb.Table;
  let skillsBucket: s3.Bucket;

  beforeEach(() => {
    app = new cdk.App();

    const depStack = new cdk.Stack(app, 'DepStack');
    skillsTable = new dynamodb.Table(depStack, 'SkillsTable', {
      tableName: 'mock-skills-table',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
    });
    skillsBucket = new s3.Bucket(depStack, 'SkillsBucket');
  });

  describe('Dev Environment', () => {
    let stack: SkillPipelineStack;
    let template: Template;

    beforeEach(() => {
      stack = new SkillPipelineStack(app, 'TestSkillPipelineStack', {
        envName: 'dev',
        skillsTable,
        skillsBucket,
      });
      template = Template.fromStack(stack);
    });

    describe('Lambda Functions', () => {
      it('should create 9 Lambda functions (8 pipeline stages + 1 LogRetention)', () => {
        // ChimeraLambda logRetention triggers CDK LogRetention custom resource Lambda (singleton)
        template.resourceCountIs('AWS::Lambda::Function', 9);
      });

      it('should create all application functions with Node.js 20.x runtime', () => {
        const functions = template.findResources('AWS::Lambda::Function');
        // Filter to only application Lambda functions (those with a chimera- FunctionName)
        const appFunctions = Object.values(functions).filter(
          (fn: any) => fn.Properties.FunctionName?.startsWith?.('chimera-')
        );
        const allNodejs20 = appFunctions.every(
          (fn: any) => fn.Properties.Runtime === 'nodejs20.x'
        );
        expect(allNodejs20).toBe(true);
        expect(appFunctions.length).toBe(8); // 7 pipeline stages + 1 scan-failure handler
      });

      describe('Stage 1: Static Analysis', () => {
        it('should create static analysis function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-skill-static-analysis-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 512,
            Timeout: 60,
          });
        });
      });

      describe('Stage 2: Dependency Audit', () => {
        it('should create dependency audit function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-skill-dependency-audit-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 512,
            Timeout: 60,
          });
        });
      });

      describe('Stage 3: Sandbox Run', () => {
        it('should create sandbox run function with extended timeout and memory', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-skill-sandbox-test-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 1024,
            Timeout: 300,
          });
        });
      });

      describe('Stage 4: Signature Verification', () => {
        it('should create signature verification function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-skill-signature-verification-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 512,
            Timeout: 60,
          });
        });

        it('should inject SIGNING_KEY_SECRET_ARN into signature verification environment', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-skill-signature-verification-dev',
            Environment: {
              Variables: Match.objectLike({
                SIGNING_KEY_SECRET_ARN: Match.anyValue(),
              }),
            },
          });
        });
      });

      describe('Stage 5: Performance Testing', () => {
        it('should create performance testing function with extended timeout and memory', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-skill-performance-testing-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 1024,
            Timeout: 300,
          });
        });
      });

      describe('Stage 6: Manual Review', () => {
        it('should create manual review function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-skill-manual-review-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 256,
            Timeout: 30,
          });
        });
      });

      describe('Stage 7: Skill Deployment', () => {
        it('should create skill deployment function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-skill-deployment-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 512,
            Timeout: 120,
          });
        });
      });

      describe('Scan Failure Handler', () => {
        it('should create scan failure notification function with correct config', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-skill-scan-notify-failure-dev',
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            MemorySize: 256,
            Timeout: 30,
          });
        });

        it('should inject NOTIFICATION_TOPIC_ARN into scan failure function', () => {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: 'chimera-skill-scan-notify-failure-dev',
            Environment: {
              Variables: Match.objectLike({
                NOTIFICATION_TOPIC_ARN: Match.anyValue(),
              }),
            },
          });
        });
      });

      it('should inject SKILLS_TABLE env var into pipeline stage functions', () => {
        const stagesWithCommonEnv = [
          'chimera-skill-static-analysis-dev',
          'chimera-skill-signature-verification-dev',
          'chimera-skill-performance-testing-dev',
          'chimera-skill-deployment-dev',
          'chimera-skill-scan-notify-failure-dev',
        ];

        for (const fnName of stagesWithCommonEnv) {
          template.hasResourceProperties('AWS::Lambda::Function', {
            FunctionName: fnName,
            Environment: {
              Variables: Match.objectLike({
                SKILLS_TABLE: Match.anyValue(),
              }),
            },
          });
        }
      });
    });

    describe('SNS Topic', () => {
      it('should create exactly 1 SNS topic for failure notifications', () => {
        template.resourceCountIs('AWS::SNS::Topic', 1);
      });

      it('should create SNS topic with correct name and display name', () => {
        template.hasResourceProperties('AWS::SNS::Topic', {
          TopicName: 'chimera-skill-scan-failures-dev',
          DisplayName: 'Chimera Skill Pipeline Failure Notifications',
        });
      });
    });

    describe('Secrets Manager', () => {
      it('should create exactly 1 Secrets Manager secret', () => {
        template.resourceCountIs('AWS::SecretsManager::Secret', 1);
      });

      it('should create Ed25519 signing key secret with correct name', () => {
        template.hasResourceProperties('AWS::SecretsManager::Secret', {
          Name: 'chimera/skill-pipeline/signing-key-dev',
          Description: 'Ed25519 key pair used by the SkillPipeline signature-verification Lambda',
        });
      });

      it('should use DESTROY removal policy for signing key in dev', () => {
        const secrets = template.findResources('AWS::SecretsManager::Secret');
        const secret = Object.values(secrets)[0] as any;
        expect(secret.DeletionPolicy).toBe('Delete');
      });
    });

    describe('Step Functions State Machine', () => {
      it('should create exactly 1 state machine', () => {
        template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
      });

      it('should create STANDARD state machine with correct name', () => {
        template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
          StateMachineName: 'chimera-skill-pipeline-dev',
          StateMachineType: 'STANDARD',
        });
      });

      it('should enable X-Ray tracing on state machine', () => {
        template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
          TracingConfiguration: {
            Enabled: true,
          },
        });
      });

      it('should configure CloudWatch logging on the state machine', () => {
        template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
          LoggingConfiguration: Match.objectLike({
            Level: 'ALL',
            IncludeExecutionData: true,
            Destinations: Match.arrayWith([
              Match.objectLike({
                CloudWatchLogsLogGroup: Match.objectLike({
                  LogGroupArn: Match.anyValue(),
                }),
              }),
            ]),
          }),
        });
      });
    });

    describe('CloudWatch Log Group', () => {
      it('should create log group for state machine', () => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: '/aws/states/chimera-skill-pipeline-dev',
        });
      });

      it('should use debug-class retention in dev (3 days)', () => {
        // Wave-16b: SFN logs use debug class (dev=3d).
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: '/aws/states/chimera-skill-pipeline-dev',
          RetentionInDays: 3,
        });
      });
    });

    describe('Stack Outputs', () => {
      it('should export StateMachineArn', () => {
        template.hasOutput('StateMachineArn', {
          Export: {
            Name: 'TestSkillPipelineStack-StateMachineArn',
          },
        });
      });

      it('should export StateMachineName', () => {
        template.hasOutput('StateMachineName', {
          Export: {
            Name: 'TestSkillPipelineStack-StateMachineName',
          },
        });
      });

      it('should export FailureNotificationTopicArn', () => {
        template.hasOutput('FailureNotificationTopicArn', {
          Export: {
            Name: 'TestSkillPipelineStack-FailureTopicArn',
          },
        });
      });
    });
  });

  describe('Prod Environment', () => {
    let stack: SkillPipelineStack;
    let template: Template;

    beforeEach(() => {
      stack = new SkillPipelineStack(app, 'TestSkillPipelineStackProd', {
        envName: 'prod',
        skillsTable,
        skillsBucket,
      });
      template = Template.fromStack(stack);
    });

    it('should use RETAIN removal policy for signing key in prod', () => {
      const secrets = template.findResources('AWS::SecretsManager::Secret');
      const secret = Object.values(secrets)[0] as any;
      expect(secret.DeletionPolicy).toBe('Retain');
    });

    it('should use debug-class retention for log group in prod (7 days)', () => {
      // Wave-16b: SFN logs use debug class (prod=ONE_WEEK).
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/states/chimera-skill-pipeline-prod',
        RetentionInDays: 7,
      });
    });

    it('should use RETAIN removal policy for log group in prod', () => {
      const logGroups = template.findResources('AWS::Logs::LogGroup', {
        Properties: {
          LogGroupName: '/aws/states/chimera-skill-pipeline-prod',
        },
      });
      const logGroup = Object.values(logGroups)[0] as any;
      expect(logGroup.DeletionPolicy).toBe('Retain');
    });
  });
});
