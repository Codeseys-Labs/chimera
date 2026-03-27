import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { TenantIsolationAspect } from '../../aspects/tenant-isolation';

jest.setTimeout(30000);

describe('TenantIsolationAspect', () => {
  describe('compliant: table has a partition key', () => {
    let annotations: Annotations;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'CompliantStack');

      new dynamodb.CfnTable(stack, 'ValidTable', {
        keySchema: [{ attributeName: 'PK', keyType: 'HASH' }],
        attributeDefinitions: [
          { attributeName: 'PK', attributeType: 'S' },
        ],
        billingMode: 'PAY_PER_REQUEST',
      });

      cdk.Aspects.of(stack).add(new TenantIsolationAspect());
      annotations = Annotations.fromStack(stack);
    });

    it('should not add errors when table has a HASH key', () => {
      annotations.hasNoError('*', Match.anyValue());
    });
  });

  describe('non-compliant: table missing partition key', () => {
    let annotations: Annotations;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'NonCompliantStack');

      // CfnTable with only a RANGE key and no HASH key (structurally invalid but tests aspect)
      new dynamodb.CfnTable(stack, 'InvalidTable', {
        keySchema: [{ attributeName: 'SK', keyType: 'RANGE' }],
        attributeDefinitions: [
          { attributeName: 'SK', attributeType: 'S' },
        ],
        billingMode: 'PAY_PER_REQUEST',
      });

      cdk.Aspects.of(stack).add(new TenantIsolationAspect());
      annotations = Annotations.fromStack(stack);
    });

    it('should add an error annotation when HASH key is absent', () => {
      annotations.hasError(
        '/NonCompliantStack/InvalidTable',
        Match.stringLikeRegexp('partition key'),
      );
    });

    it('error message should mention partition key', () => {
      const errors = annotations.findError(
        '*',
        Match.stringLikeRegexp('DynamoDB table must define a partition key'),
      );
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
