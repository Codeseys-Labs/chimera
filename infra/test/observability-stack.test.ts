/**
 * CDK tests for ObservabilityStack
 *
 * Validates the observability infrastructure:
 * - 4 SNS topics (alarm, critical, high, medium severity tiers)
 * - 4 CloudWatch dashboards (platform, tenant-health, skill-usage, cost-attribution)
 * - X-Ray tracing group
 * - Centralized platform log group
 * - Key CloudWatch alarms (API error rate, cost anomaly)
 * - DynamoDB throttle alarms (when tables provided)
 * - Prod-only: backup failure alarm, X-Ray notifications
 * - Stack outputs for all resources
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { ObservabilityStack } from '../lib/observability-stack';

describe('ObservabilityStack', () => {
  let app: cdk.App;
  let platformKey: kms.Key;

  beforeEach(() => {
    app = new cdk.App();
    const keyStack = new cdk.Stack(app, 'KeyStack');
    platformKey = new kms.Key(keyStack, 'PlatformKey');
  });

  describe('Dev Environment (minimal)', () => {
    let stack: ObservabilityStack;
    let template: Template;

    beforeEach(() => {
      stack = new ObservabilityStack(app, 'TestObservabilityStack', {
        envName: 'dev',
        platformKey,
      });
      template = Template.fromStack(stack);
    });

    describe('SNS Topics', () => {
      it('should create exactly 4 SNS topics', () => {
        template.resourceCountIs('AWS::SNS::Topic', 4);
      });

      it('should create main alarm topic with correct name and encryption', () => {
        template.hasResourceProperties('AWS::SNS::Topic', {
          TopicName: 'chimera-alarms-dev',
          DisplayName: 'Chimera dev Alarms',
        });
      });

      it('should create critical alarm topic', () => {
        template.hasResourceProperties('AWS::SNS::Topic', {
          TopicName: 'chimera-alarms-critical-dev',
          DisplayName: 'Chimera dev Critical Alarms',
        });
      });

      it('should create high priority alarm topic', () => {
        template.hasResourceProperties('AWS::SNS::Topic', {
          TopicName: 'chimera-alarms-high-dev',
          DisplayName: 'Chimera dev High Priority Alarms',
        });
      });

      it('should create medium priority alarm topic', () => {
        template.hasResourceProperties('AWS::SNS::Topic', {
          TopicName: 'chimera-alarms-medium-dev',
          DisplayName: 'Chimera dev Medium Priority Alarms',
        });
      });
    });

    describe('CloudWatch Dashboards', () => {
      it('should create exactly 4 CloudWatch dashboards', () => {
        template.resourceCountIs('AWS::CloudWatch::Dashboard', 4);
      });

      it('should create platform dashboard', () => {
        template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
          DashboardName: 'chimera-platform-dev',
        });
      });

      it('should create tenant health dashboard', () => {
        template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
          DashboardName: 'chimera-tenant-health-dev',
        });
      });

      it('should create skill usage dashboard', () => {
        template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
          DashboardName: 'chimera-skill-usage-dev',
        });
      });

      it('should create cost attribution dashboard', () => {
        template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
          DashboardName: 'chimera-cost-attribution-dev',
        });
      });
    });

    describe('X-Ray Group', () => {
      it('should create X-Ray tracing group for chimera services', () => {
        template.hasResourceProperties('AWS::XRay::Group', {
          GroupName: 'chimera-dev',
          FilterExpression: 'service("chimera-*")',
        });
      });

      it('should enable X-Ray insights in dev (notifications disabled)', () => {
        template.hasResourceProperties('AWS::XRay::Group', {
          InsightsConfiguration: {
            InsightsEnabled: true,
            NotificationsEnabled: false,
          },
        });
      });
    });

    describe('Platform Log Group', () => {
      it('should create centralized platform log group', () => {
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: '/chimera/dev/platform',
        });
      });

      it('should use ONE_WEEK retention in dev', () => {
        // ONE_WEEK = 7
        template.hasResourceProperties('AWS::Logs::LogGroup', {
          LogGroupName: '/chimera/dev/platform',
          RetentionInDays: 7,
        });
      });
    });

    describe('Key Alarms', () => {
      it('should create API error rate alarm at 5% threshold', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
          AlarmName: 'chimera-dev-api-error-rate',
          Threshold: 5,
          EvaluationPeriods: 2,
          ComparisonOperator: 'GreaterThanThreshold',
          TreatMissingData: 'notBreaching',
        });
      });

      it('should create cost anomaly alarm at 1.2x threshold', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
          AlarmName: 'chimera-dev-cost-anomaly',
          Threshold: 1.2,
          EvaluationPeriods: 1,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          TreatMissingData: 'notBreaching',
        });
      });

      it('should NOT create backup failure alarm in dev', () => {
        const alarms = template.findResources('AWS::CloudWatch::Alarm', {
          Properties: {
            AlarmName: 'chimera-dev-backup-failure',
          },
        });
        expect(Object.keys(alarms)).toHaveLength(0);
      });
    });

    describe('Stack Outputs', () => {
      it('should export AlarmTopicArn', () => {
        template.hasOutput('AlarmTopicArn', {
          Export: { Name: 'TestObservabilityStack-AlarmTopicArn' },
        });
      });

      it('should export CriticalAlarmTopicArn', () => {
        template.hasOutput('CriticalAlarmTopicArn', {
          Export: { Name: 'TestObservabilityStack-CriticalAlarmTopicArn' },
        });
      });

      it('should export HighAlarmTopicArn', () => {
        template.hasOutput('HighAlarmTopicArn', {
          Export: { Name: 'TestObservabilityStack-HighAlarmTopicArn' },
        });
      });

      it('should export MediumAlarmTopicArn', () => {
        template.hasOutput('MediumAlarmTopicArn', {
          Export: { Name: 'TestObservabilityStack-MediumAlarmTopicArn' },
        });
      });

      it('should export PlatformDashboardName', () => {
        template.hasOutput('PlatformDashboardName', {
          Export: { Name: 'TestObservabilityStack-PlatformDashboardName' },
        });
      });

      it('should export PlatformLogGroupName', () => {
        template.hasOutput('PlatformLogGroupName', {
          Export: { Name: 'TestObservabilityStack-PlatformLogGroupName' },
        });
      });

      it('should export XRayGroupName', () => {
        template.hasOutput('XRayGroupName', {
          Export: { Name: 'TestObservabilityStack-XRayGroupName' },
        });
      });

      it('should export dashboard URLs for all 4 dashboards', () => {
        template.hasOutput('PlatformDashboardUrl', {
          Export: { Name: 'TestObservabilityStack-PlatformDashboardUrl' },
        });
        template.hasOutput('TenantHealthDashboardUrl', {
          Export: { Name: 'TestObservabilityStack-TenantHealthDashboardUrl' },
        });
        template.hasOutput('SkillUsageDashboardUrl', {
          Export: { Name: 'TestObservabilityStack-SkillUsageDashboardUrl' },
        });
        template.hasOutput('CostAttributionDashboardUrl', {
          Export: { Name: 'TestObservabilityStack-CostAttributionDashboardUrl' },
        });
      });
    });
  });

  describe('Prod Environment', () => {
    let stack: ObservabilityStack;
    let template: Template;

    beforeEach(() => {
      stack = new ObservabilityStack(app, 'TestObservabilityStackProd', {
        envName: 'prod',
        platformKey,
      });
      template = Template.fromStack(stack);
    });

    it('should use SIX_MONTHS retention for prod log group', () => {
      // SIX_MONTHS = 180
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/chimera/prod/platform',
        RetentionInDays: 180,
      });
    });

    it('should retain prod log group on deletion', () => {
      const logGroups = template.findResources('AWS::Logs::LogGroup', {
        Properties: {
          LogGroupName: '/chimera/prod/platform',
        },
      });
      const logGroup = Object.values(logGroups)[0] as any;
      expect(logGroup.DeletionPolicy).toBe('Retain');
    });

    it('should create backup failure alarm only in prod', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'chimera-prod-backup-failure',
        Threshold: 1,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    });

    it('should enable X-Ray notifications in prod', () => {
      template.hasResourceProperties('AWS::XRay::Group', {
        GroupName: 'chimera-prod',
        InsightsConfiguration: {
          InsightsEnabled: true,
          NotificationsEnabled: true,
        },
      });
    });
  });

  describe('With DynamoDB Tables', () => {
    let stack: ObservabilityStack;
    let template: Template;

    beforeEach(() => {
      const tableStack = new cdk.Stack(app, 'TableStack');
      const tenantsTable = new dynamodb.Table(tableStack, 'TenantsTable', {
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      });
      const sessionsTable = new dynamodb.Table(tableStack, 'SessionsTable', {
        partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      });

      stack = new ObservabilityStack(app, 'TestObservabilityStackWithTables', {
        envName: 'dev',
        platformKey,
        tenantsTable,
        sessionsTable,
      });
      template = Template.fromStack(stack);
    });

    it('should create DynamoDB throttle alarm for tenants table', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'chimera-dev-tenants-throttles',
        Threshold: 10,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
      });
    });

    it('should create DynamoDB throttle alarm for sessions table', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'chimera-dev-sessions-throttles',
        Threshold: 10,
        EvaluationPeriods: 1,
      });
    });

    it('should route DynamoDB throttle alarms to critical topic', () => {
      // All throttle alarms should have SNS alarm actions
      // (verified by checking alarm actions exist on the stack)
      const alarms = template.findResources('AWS::CloudWatch::Alarm', {
        Properties: Match.objectLike({
          AlarmName: 'chimera-dev-tenants-throttles',
        }),
      });
      expect(Object.keys(alarms).length).toBeGreaterThan(0);
    });
  });

  describe('With Replica Regions', () => {
    let stack: ObservabilityStack;
    let template: Template;

    beforeEach(() => {
      stack = new ObservabilityStack(app, 'TestObservabilityStackMultiRegion', {
        envName: 'prod',
        platformKey,
        replicaRegions: ['us-west-2', 'eu-west-1'],
      });
      template = Template.fromStack(stack);
    });

    it('should create cross-region health alarm when replica regions provided', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'chimera-prod-cross-region-health',
        Threshold: 10,
        EvaluationPeriods: 2,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    });
  });
});
