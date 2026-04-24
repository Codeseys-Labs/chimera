/**
 * CDK tests for OrchestrationStack
 *
 * Validates Phase 5 orchestration infrastructure:
 * - EventBridge event bus with rules and archive
 * - SQS queues (Standard for parallel tasks, FIFO for ordered messages)
 * - EventBridge Scheduler for cron tasks
 * - Step Functions state machines for background workflows
 * - IAM roles and policies
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OrchestrationStack } from '../lib/orchestration-stack';
import * as kms from 'aws-cdk-lib/aws-kms';

describe('OrchestrationStack', () => {
  let app: cdk.App;
  let stack: OrchestrationStack;
  let template: Template;
  let platformKey: kms.Key;

  beforeEach(() => {
    app = new cdk.App();

    // Create a mock KMS key for encryption
    const keyStack = new cdk.Stack(app, 'KeyStack');
    platformKey = new kms.Key(keyStack, 'PlatformKey', {
      description: 'Test platform encryption key',
    });

    stack = new OrchestrationStack(app, 'TestOrchestrationStack', {
      envName: 'dev',
      platformKey,
    });

    template = Template.fromStack(stack);
  });

  describe('EventBridge Event Bus', () => {
    it('should create custom event bus', () => {
      template.resourceCountIs('AWS::Events::EventBus', 1);

      template.hasResourceProperties('AWS::Events::EventBus', {
        Name: 'chimera-agents-dev',
      });
    });

    it('should create event archive with 7-day retention', () => {
      template.resourceCountIs('AWS::Events::Archive', 1);

      template.hasResourceProperties('AWS::Events::Archive', {
        ArchiveName: 'chimera-agents-archive-dev',
        Description: 'Archive of all agent lifecycle events for replay and debugging',
        RetentionDays: 7,
        EventPattern: {
          source: ['chimera.agents'],
        },
      });
    });

    it('should create CloudWatch log group for event debugging (debug-class dev=3d)', () => {
      // Wave-16b: event-debug logs use debug class (dev=3d, prod=7d).
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/events/chimera-agents-dev',
        RetentionInDays: 3,
      });
    });
  });

  describe('EventBridge Rules', () => {
    it('should create 8 event rules', () => {
      template.resourceCountIs('AWS::Events::Rule', 8);
    });

    it('should create TaskStarted rule routing to CloudWatch', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-agent-started-dev',
        Description: 'Route agent task started events to CloudWatch Logs',
        EventPattern: {
          source: ['chimera.agents'],
          'detail-type': ['Agent Task Started'],
        },
      });
    });

    it('should create TaskCompleted rule', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-agent-completed-dev',
        Description: 'Route agent task completed events to CloudWatch',
        EventPattern: {
          source: ['chimera.agents'],
          'detail-type': ['Agent Task Completed'],
        },
      });
    });

    it('should create TaskFailed rule routing to logs and DLQ', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-agent-failed-dev',
        Description: 'Route agent task failed events to CloudWatch and DLQ',
        EventPattern: {
          source: ['chimera.agents'],
          'detail-type': ['Agent Task Failed'],
        },
      });
    });

    it('should create Error rule', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-agent-error-dev',
        Description: 'Route agent error events to CloudWatch',
        EventPattern: {
          source: ['chimera.agents'],
          'detail-type': ['Agent Error'],
        },
      });
    });

    it('should create SwarmTask rule routing to task queue', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-swarm-task-dev',
        Description: 'Route swarm task creation events to task queue',
        EventPattern: {
          source: ['chimera.agents'],
          'detail-type': ['Swarm Task Created'],
        },
      });
    });

    it('should create A2AMessage rule routing to FIFO queue', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-a2a-message-dev',
        Description: 'Route agent-to-agent messages to FIFO queue',
        EventPattern: {
          source: ['chimera.agents'],
          'detail-type': ['Agent Message'],
        },
      });
    });

    it('should create BackgroundTaskStarted rule routing to Step Functions', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'chimera-background-task-started-dev',
        Description: 'Route background task started events to Step Functions',
        EventPattern: {
          source: ['chimera.agents'],
          'detail-type': ['Background Task Started'],
        },
      });
    });
  });

  describe('SQS Queues', () => {
    it('should create 10 SQS queues (2 ChimeraQueue main + 2 ChimeraQueue DLQ + 6 Lambda DLQs)', () => {
      // ChimeraQueue provides 2 main queues + 2 DLQs.
      // ChimeraLambda creates 1 DLQ per Lambda × 6 Lambdas = 6 DLQs.
      template.resourceCountIs('AWS::SQS::Queue', 10);
    });

    it('should create Standard task queue with correct config', () => {
      // ChimeraQueue manages queue config internally; ReceiveMessageWaitTime not exposed
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'chimera-agent-tasks-dev',
        VisibilityTimeout: 900, // 15 minutes (passed via ChimeraQueue)
      });
    });

    it('should create FIFO message queue with correct config', () => {
      // contentBasedDeduplication set via escape hatch after ChimeraQueue creation
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'chimera-agent-messages-dev.fifo',
        FifoQueue: true,
        ContentBasedDeduplication: true,
        VisibilityTimeout: 300, // 5 minutes
      });
    });

    it('should create task DLQ (ChimeraQueue naming: {queue}-dlq)', () => {
      // ChimeraQueue DLQ naming: {queueName}-dlq (suffix, not prefix)
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'chimera-agent-tasks-dev-dlq',
        MessageRetentionPeriod: 1209600, // 14 days (ChimeraQueue default)
      });
    });

    it('should create message DLQ (FIFO) (ChimeraQueue naming: {queue}-dlq.fifo)', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'chimera-agent-messages-dev-dlq.fifo',
        FifoQueue: true,
        MessageRetentionPeriod: 1209600, // 14 days
      });
    });

    it('should configure DLQ redrive policy with maxReceiveCount=3', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'chimera-agent-tasks-dev',
        RedrivePolicy: Match.objectLike({
          maxReceiveCount: 3,
        }),
      });
    });

    it('should encrypt queues with KMS', () => {
      // All 10 queues should have KMS encryption (ChimeraQueue + ChimeraLambda DLQs)
      const queues = template.findResources('AWS::SQS::Queue');
      const encryptedCount = Object.values(queues).filter(
        (queue) =>
          (queue as { Properties: { KmsMasterKeyId?: string } }).Properties.KmsMasterKeyId !==
          undefined
      ).length;
      expect(encryptedCount).toBe(10);
    });
  });

  describe('EventBridge Scheduler', () => {
    it('should create scheduler group', () => {
      template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);

      template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', {
        Name: 'chimera-agent-schedules-dev',
      });
    });

    it('should create IAM role for scheduler', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'chimera-scheduler-dev',
        Description: 'Allows EventBridge Scheduler to publish agent task events',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: {
                Service: 'scheduler.amazonaws.com',
              },
            }),
          ]),
        }),
      });
    });

    it('should grant scheduler permission to publish events', () => {
      // Find policies attached to the scheduler role
      const policies = template.findResources('AWS::IAM::Policy');
      interface PolicyResource {
        Properties: {
          Roles: Array<{ Ref?: string }>;
        };
      }
      const schedulerPolicy = Object.values(policies).find((policy) =>
        (policy as PolicyResource).Properties.Roles.some(
          (role) => role.Ref && role.Ref.includes('SchedulerRole')
        )
      );
      expect(schedulerPolicy).toBeDefined();
    });
  });

  describe('Step Functions State Machines', () => {
    it('should create 3 state machines', () => {
      template.resourceCountIs('AWS::StepFunctions::StateMachine', 3);
    });

    it('should create Pipeline Build state machine', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: 'chimera-pipeline-build-dev',
      });
    });

    it('should create Data Analysis state machine', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: 'chimera-data-analysis-dev',
      });
    });

    it('should create Background Task state machine', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: 'chimera-background-task-dev',
      });
    });

    it('should configure state machine logging', () => {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        LoggingConfiguration: Match.objectLike({
          Level: 'ALL',
        }),
      });
    });

    it('should create log groups for state machines (debug class dev=3d)', () => {
      // Wave-16b: SFN vended logs use debug class (dev=3d).
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/vendedlogs/states/chimera-pipeline-build-dev',
        RetentionInDays: 3,
      });

      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/vendedlogs/states/chimera-data-analysis-dev',
        RetentionInDays: 3,
      });

      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/vendedlogs/states/chimera-background-task-dev',
        RetentionInDays: 3,
      });
    });
  });

  describe('Lambda Functions', () => {
    it('should create workflow Lambda functions', () => {
      // 6 ChimeraLambda functions + 1 LogRetention singleton + 1 LogRetention provider = 8
      // (ChimeraLambda logRetention triggers additional CDK custom resource machinery)
      template.resourceCountIs('AWS::Lambda::Function', 8);
    });

    it('should create StartBuildFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-workflow-start-build-dev',
        Runtime: 'python3.12',
        Timeout: 60,
        MemorySize: 256,
      });
    });

    it('should create CheckBuildStatusFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-workflow-check-build-dev',
        Runtime: 'python3.12',
        Timeout: 30,
        MemorySize: 256,
      });
    });

    it('should create RunDataQueryFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-workflow-run-query-dev',
        Runtime: 'python3.12',
        Timeout: 60,
        MemorySize: 512,
      });
    });

    it('should create CheckQueryStatusFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-workflow-check-query-dev',
        Runtime: 'python3.12',
        Timeout: 30,
        MemorySize: 256,
      });
    });

    it('should create ExecuteBackgroundTaskFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-workflow-execute-bg-task-dev',
        Runtime: 'python3.12',
        Timeout: 300,
        MemorySize: 512,
      });
    });

    it('should create CheckBackgroundTaskStatusFunction', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-workflow-check-bg-task-dev',
        Runtime: 'python3.12',
        Timeout: 30,
        MemorySize: 256,
      });
    });
  });

  describe('IAM Roles', () => {
    it('should create EventPublisher role', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'chimera-event-publisher-dev',
        Description: 'Allows agent runtime to publish events to EventBridge',
      });

      // Verify the role can be assumed by the correct services
      const roles = template.findResources('AWS::IAM::Role', {
        Properties: {
          RoleName: 'chimera-event-publisher-dev',
        },
      });
      const roleKey = Object.keys(roles)[0];
      interface AssumeRoleStatement {
        Principal?: {
          Service?: string | string[];
        };
      }
      interface RoleResource {
        Properties: {
          AssumeRolePolicyDocument: {
            Statement: AssumeRoleStatement[];
          };
        };
      }
      const assumePolicy = (roles[roleKey] as RoleResource).Properties.AssumeRolePolicyDocument;
      const services = assumePolicy.Statement.flatMap((stmt) => stmt.Principal?.Service || []);
      expect(services).toContain('lambda.amazonaws.com');
      expect(services).toContain('ecs-tasks.amazonaws.com');
      expect(services).toContain('bedrock.amazonaws.com');
    });

    it('should create QueueProvisioner role', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'chimera-queue-provisioner-dev',
        Description: 'Allows Lambda to create per-tenant SQS FIFO queues on demand',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: {
                Service: 'lambda.amazonaws.com',
              },
            }),
          ]),
        }),
      });
    });

    it('should grant QueueProvisioner SQS permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: [
                'sqs:CreateQueue',
                'sqs:SetQueueAttributes',
                'sqs:TagQueue',
                'sqs:GetQueueAttributes',
                'sqs:GetQueueUrl',
              ],
              Effect: 'Allow',
            }),
          ]),
        }),
      });
    });

    it('should grant EventPublisher permission to start Step Functions', () => {
      // Find policies attached to the event publisher role
      const policies = template.findResources('AWS::IAM::Policy');
      interface PolicyResource {
        Properties: {
          Roles: Array<{ Ref?: string }>;
          PolicyDocument: {
            Statement: Array<{ Action: string | string[] }>;
          };
        };
      }
      const publisherPolicy = Object.values(policies).find((policy) => {
        const p = policy as PolicyResource;
        return (
          p.Properties.Roles.some((role) => role.Ref && role.Ref.includes('EventPublisherRole')) &&
          p.Properties.PolicyDocument.Statement.some((stmt) => {
            const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
            return actions.includes('states:StartExecution');
          })
        );
      });
      expect(publisherPolicy).toBeDefined();
    });

    it('should create StepFunctionsInvoke role for EventBridge', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'chimera-sfn-invoke-dev',
        Description: 'Allows EventBridge to invoke Step Functions state machines',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: {
                Service: 'events.amazonaws.com',
              },
            }),
          ]),
        }),
      });
    });

    it('should create GroupChatProvisioner role', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'chimera-groupchat-provisioner-dev',
        Description: 'Allows Lambda to create SNS topics and SQS subscriptions for agent groupchat',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: {
                Service: 'lambda.amazonaws.com',
              },
            }),
          ]),
        }),
      });
    });

    it('should grant GroupChatProvisioner SNS permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: [
                'sns:CreateTopic',
                'sns:SetTopicAttributes',
                'sns:TagResource',
                'sns:GetTopicAttributes',
                'sns:Subscribe',
                'sns:ListSubscriptionsByTopic',
                'sns:Unsubscribe',
                'sns:DeleteTopic',
              ],
              Effect: 'Allow',
            }),
          ]),
        }),
      });
    });

    it('should grant GroupChatProvisioner SQS permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: [
                'sqs:CreateQueue',
                'sqs:SetQueueAttributes',
                'sqs:TagQueue',
                'sqs:GetQueueAttributes',
                'sqs:GetQueueUrl',
                'sqs:DeleteQueue',
              ],
              Effect: 'Allow',
            }),
          ]),
        }),
      });
    });

    it('should grant GroupChatProvisioner KMS permissions', () => {
      // Find policies attached to the groupchat provisioner role
      const policies = template.findResources('AWS::IAM::Policy');
      interface PolicyResource {
        Properties: {
          Roles: Array<{ Ref?: string }>;
          PolicyDocument: {
            Statement: Array<{ Action: string | string[] }>;
          };
        };
      }
      const groupChatPolicy = Object.values(policies).find((policy) => {
        const p = policy as PolicyResource;
        return (
          p.Properties.Roles.some(
            (role) => role.Ref && role.Ref.includes('GroupChatProvisionerRole')
          ) &&
          p.Properties.PolicyDocument.Statement.some((stmt) => {
            const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
            return actions.includes('kms:Decrypt') && actions.includes('kms:GenerateDataKey');
          })
        );
      });
      expect(groupChatPolicy).toBeDefined();
    });
  });

  describe('Stack Outputs', () => {
    it('should export event bus name', () => {
      template.hasOutput('EventBusName', {
        Export: {
          Name: 'TestOrchestrationStack-EventBusName',
        },
      });
    });

    it('should export event bus ARN', () => {
      template.hasOutput('EventBusArn', {
        Export: {
          Name: 'TestOrchestrationStack-EventBusArn',
        },
      });
    });

    it('should export task queue URL and ARN', () => {
      template.hasOutput('AgentTaskQueueUrl', {
        Export: {
          Name: 'TestOrchestrationStack-AgentTaskQueueUrl',
        },
      });

      template.hasOutput('AgentTaskQueueArn', {
        Export: {
          Name: 'TestOrchestrationStack-AgentTaskQueueArn',
        },
      });
    });

    it('should export message queue URL and ARN', () => {
      template.hasOutput('AgentMessageQueueUrl', {
        Export: {
          Name: 'TestOrchestrationStack-AgentMessageQueueUrl',
        },
      });

      template.hasOutput('AgentMessageQueueArn', {
        Export: {
          Name: 'TestOrchestrationStack-AgentMessageQueueArn',
        },
      });
    });

    it('should export scheduler group name', () => {
      template.hasOutput('SchedulerGroupName', {
        Export: {
          Name: 'TestOrchestrationStack-SchedulerGroupName',
        },
      });
    });

    it('should export state machine ARNs', () => {
      template.hasOutput('PipelineBuildStateMachineArn', {
        Export: {
          Name: 'TestOrchestrationStack-PipelineBuildStateMachineArn',
        },
      });

      template.hasOutput('DataAnalysisStateMachineArn', {
        Export: {
          Name: 'TestOrchestrationStack-DataAnalysisStateMachineArn',
        },
      });

      template.hasOutput('BackgroundTaskStateMachineArn', {
        Export: {
          Name: 'TestOrchestrationStack-BackgroundTaskStateMachineArn',
        },
      });
    });

    it('should export queue provisioner role ARN', () => {
      template.hasOutput('QueueProvisionerRoleArn', {
        Export: {
          Name: 'TestOrchestrationStack-QueueProvisionerRoleArn',
        },
      });
    });

    it('should export groupchat provisioner role ARN', () => {
      template.hasOutput('GroupChatProvisionerRoleArn', {
        Export: {
          Name: 'TestOrchestrationStack-GroupChatProvisionerRoleArn',
        },
      });
    });
  });

  describe('Production Configuration', () => {
    it('should use longer retention periods in prod', () => {
      // Create a new app for prod stack to avoid synthesis conflicts
      const prodApp = new cdk.App();
      const prodKeyStack = new cdk.Stack(prodApp, 'ProdKeyStack');
      const prodPlatformKey = new kms.Key(prodKeyStack, 'ProdPlatformKey', {
        description: 'Test platform encryption key',
      });

      const prodStack = new OrchestrationStack(prodApp, 'ProdOrchestrationStack', {
        envName: 'prod',
        platformKey: prodPlatformKey,
      });

      const prodTemplate = Template.fromStack(prodStack);

      // Event archive: 30 days in prod vs 7 in dev (not a log group; archive
      // retention is independent of the log-retention class refactor).
      prodTemplate.hasResourceProperties('AWS::Events::Archive', {
        RetentionDays: 30,
      });

      // Log groups: debug class prod=7d (Wave-16b harmonization — SFN/event
      // logs are high-volume debug streams and reduce from prior 1mo).
      prodTemplate.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/events/chimera-agents-prod',
        RetentionInDays: 7,
      });
    });

    it('should use RETAIN removal policy in prod', () => {
      // Create a new app for prod stack to avoid synthesis conflicts
      const prodApp = new cdk.App();
      const prodKeyStack = new cdk.Stack(prodApp, 'ProdKeyStack');
      const prodPlatformKey = new kms.Key(prodKeyStack, 'ProdPlatformKey', {
        description: 'Test platform encryption key',
      });

      const prodStack = new OrchestrationStack(prodApp, 'ProdOrchestrationStack', {
        envName: 'prod',
        platformKey: prodPlatformKey,
      });

      const prodTemplate = Template.fromStack(prodStack);

      // Check that log groups have RETAIN policy (DeletionPolicy in CFN)
      const logGroups = prodTemplate.findResources('AWS::Logs::LogGroup', {
        Properties: {
          LogGroupName: '/aws/events/chimera-agents-prod',
        },
      });

      const logGroupKey = Object.keys(logGroups)[0];
      expect(logGroups[logGroupKey].DeletionPolicy).toBe('Retain');
    });
  });

  describe('Integration Points', () => {
    it('should allow cross-stack references via exports', () => {
      // Verify all critical resources are exported for cross-stack use
      const outputs = template.findOutputs('*');

      expect(Object.keys(outputs)).toContain('EventBusName');
      expect(Object.keys(outputs)).toContain('EventBusArn');
      expect(Object.keys(outputs)).toContain('AgentTaskQueueUrl');
      expect(Object.keys(outputs)).toContain('AgentMessageQueueUrl');
      expect(Object.keys(outputs)).toContain('SchedulerGroupName');
      expect(Object.keys(outputs)).toContain('PipelineBuildStateMachineArn');
      expect(Object.keys(outputs)).toContain('DataAnalysisStateMachineArn');
      expect(Object.keys(outputs)).toContain('BackgroundTaskStateMachineArn');
      expect(Object.keys(outputs)).toContain('GroupChatProvisionerRoleArn');
    });

    it('should expose public properties for same-app references', () => {
      expect(stack.eventBus).toBeDefined();
      expect(stack.agentTaskQueue).toBeDefined();
      expect(stack.agentMessageQueue).toBeDefined();
      expect(stack.schedulerGroup).toBeDefined();
      expect(stack.pipelineBuildStateMachine).toBeDefined();
      expect(stack.dataAnalysisStateMachine).toBeDefined();
      expect(stack.backgroundTaskStateMachine).toBeDefined();
    });
  });
});
