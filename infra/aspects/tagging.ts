import * as cdk from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

export interface TaggingAspectProps {
  environment: string;
  project?: string;
}

/**
 * Applies standard Chimera tags to all taggable CDK resources.
 *
 * Tags applied: Project, Environment, ManagedBy=cdk.
 * Uses TagManager.setTag() which is additive — existing tags are preserved.
 */
export class TaggingAspect implements cdk.IAspect {
  private readonly environment: string;
  private readonly project: string;

  constructor(props: TaggingAspectProps) {
    this.environment = props.environment;
    this.project = props.project ?? 'chimera';
  }

  visit(node: IConstruct): void {
    if (
      node instanceof cdk.CfnResource &&
      cdk.TagManager.isTaggable(node)
    ) {
      node.tags.setTag('Project', this.project);
      node.tags.setTag('Environment', this.environment);
      node.tags.setTag('ManagedBy', 'cdk');
    }
  }
}
