import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { ChimeraTable } from '../../constructs/chimera-table';

jest.setTimeout(30000);

// TableV2 with customerManagedKey requires an environment-bound stack
const ENV = { account: '123456789012', region: 'us-east-1' };

describe('ChimeraTable', () => {
  let stack: cdk.Stack;
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack', { env: ENV });
    new ChimeraTable(stack, 'MyTable', {
      tableName: 'test-table',
    });
    template = Template.fromStack(stack);
  });

  it('enables point-in-time recovery (in Replicas)', () => {
    // TableV2 (GlobalTable) stores PITR inside the Replicas array
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: Match.arrayWith([
        Match.objectLike({
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true,
          },
        }),
      ]),
    });
  });

  it('uses PAY_PER_REQUEST billing', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('enables deletion protection (in Replicas)', () => {
    // TableV2 (GlobalTable) stores DeletionProtection inside the Replicas array
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: Match.arrayWith([
        Match.objectLike({
          DeletionProtectionEnabled: true,
        }),
      ]),
    });
  });

  it('uses KMS (customer-managed) encryption', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      SSESpecification: {
        SSEEnabled: true,
        SSEType: 'KMS',
      },
    });
  });

  it('enables DynamoDB streams with NEW_AND_OLD_IMAGES', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      StreamSpecification: {
        StreamViewType: 'NEW_AND_OLD_IMAGES',
      },
    });
  });

  it('uses default PK=PK and SK=SK', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ]),
      KeySchema: Match.arrayWith([
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ]),
    });
  });

  it('creates a KMS key for encryption', () => {
    template.resourceCountIs('AWS::KMS::Key', 1);
  });

  describe('with provided encryption key', () => {
    let keyStack: cdk.Stack;
    let keyTemplate: Template;

    beforeAll(() => {
      const app2 = new cdk.App();
      keyStack = new cdk.Stack(app2, 'KeyStack', { env: ENV });
      const externalKey = new kms.Key(keyStack, 'ExternalKey');
      new ChimeraTable(keyStack, 'TableWithKey', {
        tableName: 'keyed-table',
        encryptionKey: externalKey,
      });
      keyTemplate = Template.fromStack(keyStack);
    });

    it('does not create an additional KMS key', () => {
      // Only 1 key: the provided external key
      keyTemplate.resourceCountIs('AWS::KMS::Key', 1);
    });
  });

  describe('with TTL attribute', () => {
    let ttlStack: cdk.Stack;
    let ttlTemplate: Template;

    beforeAll(() => {
      const app3 = new cdk.App();
      ttlStack = new cdk.Stack(app3, 'TtlStack', { env: ENV });
      new ChimeraTable(ttlStack, 'TtlTable', {
        tableName: 'ttl-table',
        ttlAttribute: 'expiresAt',
      });
      ttlTemplate = Template.fromStack(ttlStack);
    });

    it('sets the TTL attribute', () => {
      ttlTemplate.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        TimeToLiveSpecification: {
          AttributeName: 'expiresAt',
          Enabled: true,
        },
      });
    });
  });

  describe('with custom partition key', () => {
    let pkStack: cdk.Stack;
    let pkTemplate: Template;

    beforeAll(() => {
      const app4 = new cdk.App();
      pkStack = new cdk.Stack(app4, 'PkStack', { env: ENV });
      new ChimeraTable(pkStack, 'CustomPkTable', {
        tableName: 'custom-pk-table',
        partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
        sortKey: undefined,
      });
      pkTemplate = Template.fromStack(pkStack);
    });

    it('uses the provided partition key', () => {
      pkTemplate.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        KeySchema: Match.arrayWith([
          { AttributeName: 'tenantId', KeyType: 'HASH' },
        ]),
      });
    });
  });
});
