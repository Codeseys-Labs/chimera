import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { TaggingAspect } from '../../aspects/tagging';

jest.setTimeout(30000);

describe('TaggingAspect', () => {
  describe('applies standard Chimera tags', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'TaggingStack');

      new s3.CfnBucket(stack, 'TargetBucket', {});

      cdk.Aspects.of(stack).add(new TaggingAspect({ environment: 'dev' }));
      template = Template.fromStack(stack);
    });

    it('should apply Project=chimera tag', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([{ Key: 'Project', Value: 'chimera' }]),
      });
    });

    it('should apply Environment=dev tag', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([{ Key: 'Environment', Value: 'dev' }]),
      });
    });

    it('should apply ManagedBy=cdk tag', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([{ Key: 'ManagedBy', Value: 'cdk' }]),
      });
    });
  });

  describe('accepts custom project name', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'CustomProjectStack');

      new s3.CfnBucket(stack, 'Bucket', {});

      cdk.Aspects.of(stack).add(
        new TaggingAspect({ environment: 'prod', project: 'my-project' }),
      );
      template = Template.fromStack(stack);
    });

    it('should use provided project name', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([{ Key: 'Project', Value: 'my-project' }]),
      });
    });
  });

  describe('preserves existing tags', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, 'PreserveTagsStack');

      const bucket = new s3.CfnBucket(stack, 'TaggedBucket', {});
      // Set a custom tag directly on the resource before the aspect runs
      bucket.tags.setTag('Team', 'platform');

      cdk.Aspects.of(stack).add(new TaggingAspect({ environment: 'staging' }));
      template = Template.fromStack(stack);
    });

    it('should keep pre-existing custom tags', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([{ Key: 'Team', Value: 'platform' }]),
      });
    });

    // Match.arrayWith() is ordered (subsequence match) so check each tag separately
    it('should apply Project tag alongside existing tags', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([{ Key: 'Project', Value: 'chimera' }]),
      });
    });

    it('should apply Environment tag alongside existing tags', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([{ Key: 'Environment', Value: 'staging' }]),
      });
    });

    it('should apply ManagedBy tag alongside existing tags', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        Tags: Match.arrayWith([{ Key: 'ManagedBy', Value: 'cdk' }]),
      });
    });
  });
});
