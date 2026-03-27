import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { ChimeraLambda } from '../../constructs/chimera-lambda';

jest.setTimeout(30000);

describe('ChimeraLambda', () => {
  let stack: cdk.Stack;
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack');
    new ChimeraLambda(stack, 'MyFunction', {
      functionName: 'chimera-test-fn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    });
    template = Template.fromStack(stack);
  });

  it('enables X-Ray tracing (ACTIVE)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      TracingConfig: {
        Mode: 'Active',
      },
    });
  });

  it('creates a dead letter queue', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      DeadLetterConfig: {
        TargetArn: Match.anyValue(),
      },
    });
  });

  it('wires DLQ on the function', () => {
    // SQS queue resource exists
    template.resourceCountIs('AWS::SQS::Queue', 1);
  });

  it('sets default LOG_LEVEL=INFO environment variable', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          LOG_LEVEL: 'INFO',
        }),
      },
    });
  });

  it('sets default NODE_OPTIONS environment variable', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          NODE_OPTIONS: '--enable-source-maps',
        }),
      },
    });
  });

  it('configures log retention', () => {
    // log retention is managed via a custom resource Lambda
    template.resourceCountIs('Custom::LogRetention', 1);
  });

  it('sets default memory to 256MB', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 256,
    });
  });

  it('sets default timeout to 30 seconds', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 30,
    });
  });

  describe('with custom environment variables', () => {
    let envStack: cdk.Stack;
    let envTemplate: Template;

    beforeAll(() => {
      const app2 = new cdk.App();
      envStack = new cdk.Stack(app2, 'EnvStack');
      new ChimeraLambda(envStack, 'EnvFn', {
        functionName: 'chimera-env-fn',
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('exports.handler = async () => ({})'),
        environment: { MY_VAR: 'my-value' },
      });
      envTemplate = Template.fromStack(envStack);
    });

    it('merges user env with defaults', () => {
      envTemplate.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            LOG_LEVEL: 'INFO',
            NODE_OPTIONS: '--enable-source-maps',
            MY_VAR: 'my-value',
          }),
        },
      });
    });
  });

  describe('with custom log retention', () => {
    let retStack: cdk.Stack;
    let retTemplate: Template;

    beforeAll(() => {
      const app3 = new cdk.App();
      retStack = new cdk.Stack(app3, 'RetStack');
      new ChimeraLambda(retStack, 'RetFn', {
        functionName: 'chimera-ret-fn',
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('exports.handler = async () => ({})'),
        logRetention: logs.RetentionDays.ONE_WEEK,
      });
      retTemplate = Template.fromStack(retStack);
    });

    it('creates log retention custom resource', () => {
      retTemplate.resourceCountIs('Custom::LogRetention', 1);
    });
  });
});
