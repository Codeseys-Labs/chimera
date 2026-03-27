import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { LogRetentionAspect } from '../../aspects/log-retention';

jest.setTimeout(30000);

describe('LogRetentionAspect', () => {
  describe('compliant: LogGroup with retentionInDays set', () => {
    let annotations: Annotations;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'RetainedLogStack');

      new logs.CfnLogGroup(stack, 'RetainedGroup', {
        retentionInDays: 90,
      });

      cdk.Aspects.of(stack).add(new LogRetentionAspect());
      annotations = Annotations.fromStack(stack);
    });

    it('should not warn when retentionInDays is set', () => {
      annotations.hasNoWarning('*', Match.anyValue());
    });
  });

  describe('non-compliant: LogGroup without retentionInDays', () => {
    let annotations: Annotations;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'UnretainedLogStack');

      new logs.CfnLogGroup(stack, 'UnretainedGroup', {
        // No retentionInDays — logs accumulate forever
      });

      cdk.Aspects.of(stack).add(new LogRetentionAspect());
      annotations = Annotations.fromStack(stack);
    });

    it('should warn when retentionInDays is absent', () => {
      annotations.hasWarning(
        '/UnretainedLogStack/UnretainedGroup',
        Match.stringLikeRegexp('retentionInDays'),
      );
    });

    it('warning message should mention unbounded log storage', () => {
      const warnings = annotations.findWarning(
        '*',
        Match.stringLikeRegexp('unbounded log storage'),
      );
      expect(warnings.length).toBeGreaterThan(0);
    });
  });
});
