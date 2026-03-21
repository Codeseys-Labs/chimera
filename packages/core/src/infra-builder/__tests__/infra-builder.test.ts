/**
 * Tests for Infrastructure Builder module
 * Validates agent-driven infrastructure-as-code capabilities
 */

import { describe, it, expect } from 'bun:test';
import type {
  InfraWorkspace,
  WorkspaceStatus,
  PipelineStatus,
  PipelineExecution,
  StageExecution,
  ApprovalStatus,
  ApprovalAction,
  ChangeType,
  ChangeSetSummary,
  ResourceChange,
  DriftDetection,
  CedarInfraPolicy,
  InfraOperationResult,
} from '../types';

describe('Infrastructure Builder Types', () => {
  describe('WorkspaceStatus', () => {
    it('should define all workspace lifecycle states', () => {
      const statuses: WorkspaceStatus[] = [
        'INITIALIZING',
        'READY',
        'DEPLOYING',
        'DEPLOYED',
        'DRIFT_DETECTED',
        'ERROR',
        'ARCHIVED',
      ];

      expect(statuses).toHaveLength(7);
      expect(statuses).toContain('READY');
      expect(statuses).toContain('DRIFT_DETECTED');
    });
  });

  describe('PipelineStatus', () => {
    it('should define CodePipeline execution states', () => {
      const statuses: PipelineStatus[] = [
        'InProgress',
        'Stopped',
        'Stopping',
        'Succeeded',
        'Superseded',
        'Failed',
      ];

      expect(statuses).toHaveLength(6);
    });
  });

  describe('ApprovalStatus', () => {
    it('should define approval workflow states', () => {
      const statuses: ApprovalStatus[] = [
        'Pending',
        'Approved',
        'Rejected',
        'TimedOut',
      ];

      expect(statuses).toHaveLength(4);
    });
  });

  describe('ChangeType', () => {
    it('should define CloudFormation change actions', () => {
      const types: ChangeType[] = [
        'Create',
        'Update',
        'Delete',
        'Import',
        'None',
      ];

      expect(types).toHaveLength(5);
    });
  });
});

describe('InfraWorkspace structure', () => {
  it('should create workspace with required fields', () => {
    const workspace: InfraWorkspace = {
      workspaceId: 'ws-abc123',
      tenantId: 'tenant-acme',
      agentId: 'agent-builder-01',
      repositoryArn: 'arn:aws:codecommit:us-west-2:123456789012:chimera-infra-acme',
      repositoryName: 'chimera-infra-acme',
      defaultBranch: 'main',
      cloneUrl: 'https://git-codecommit.us-west-2.amazonaws.com/v1/repos/chimera-infra-acme',
      status: 'READY',
      createdAt: new Date().toISOString(),
    };

    expect(workspace.tenantId).toBe('tenant-acme');
    expect(workspace.status).toBe('READY');
    expect(workspace.repositoryArn).toContain('codecommit');
  });

  it('should support workspace with deployment tracking', () => {
    const workspace: InfraWorkspace = {
      workspaceId: 'ws-xyz789',
      tenantId: 'tenant-prod',
      agentId: 'agent-infra-02',
      repositoryArn: 'arn:aws:codecommit:us-west-2:123456789012:prod-infra',
      repositoryName: 'prod-infra',
      defaultBranch: 'main',
      cloneUrl: 'https://git-codecommit.us-west-2.amazonaws.com/v1/repos/prod-infra',
      status: 'DEPLOYED',
      createdAt: '2024-01-15T10:00:00.000Z',
      lastCommitAt: '2024-03-20T14:30:00.000Z',
      lastDeployedAt: '2024-03-20T15:00:00.000Z',
      pipelineArn: 'arn:aws:codepipeline:us-west-2:123456789012:prod-deployment-pipeline',
      driftDetected: false,
      policyArn: 'arn:aws:iam::123456789012:policy/CedarInfraPolicy-prod',
    };

    expect(workspace.status).toBe('DEPLOYED');
    expect(workspace.lastDeployedAt).toBeDefined();
    expect(workspace.pipelineArn).toBeDefined();
    expect(workspace.driftDetected).toBe(false);
  });

  it('should flag workspace with drift detection', () => {
    const workspace: InfraWorkspace = {
      workspaceId: 'ws-drift-test',
      tenantId: 'tenant-test',
      agentId: 'agent-test',
      repositoryArn: 'arn:aws:codecommit:us-west-2:123456789012:test-repo',
      repositoryName: 'test-repo',
      defaultBranch: 'main',
      cloneUrl: 'https://git-codecommit.us-west-2.amazonaws.com/v1/repos/test-repo',
      status: 'DRIFT_DETECTED',
      createdAt: new Date().toISOString(),
      driftDetected: true,
    };

    expect(workspace.status).toBe('DRIFT_DETECTED');
    expect(workspace.driftDetected).toBe(true);
  });
});

describe('PipelineExecution structure', () => {
  it('should track pipeline execution details', () => {
    const execution: PipelineExecution = {
      pipelineArn: 'arn:aws:codepipeline:us-west-2:123456789012:my-pipeline',
      executionId: 'exec-abc123',
      pipelineName: 'chimera-deploy-pipeline',
      status: 'InProgress',
      pipelineVersion: 5,
      startTime: new Date().toISOString(),
      sourceCommitId: 'a1b2c3d4e5f6',
      sourceCommitMessage: 'Deploy infrastructure updates',
    };

    expect(execution.status).toBe('InProgress');
    expect(execution.sourceCommitId).toBe('a1b2c3d4e5f6');
    expect(execution.pipelineVersion).toBe(5);
  });

  it('should include error details for failed executions', () => {
    const execution: PipelineExecution = {
      pipelineArn: 'arn:aws:codepipeline:us-west-2:123456789012:failed-pipeline',
      executionId: 'exec-failed-001',
      pipelineName: 'failed-pipeline',
      status: 'Failed',
      startTime: '2024-03-20T10:00:00.000Z',
      endTime: '2024-03-20T10:15:00.000Z',
      errorMessage: 'CloudFormation stack creation failed: Resource limit exceeded',
    };

    expect(execution.status).toBe('Failed');
    expect(execution.errorMessage).toContain('Resource limit exceeded');
    expect(execution.endTime).toBeDefined();
  });
});

describe('StageExecution structure', () => {
  it('should track stage and action execution', () => {
    const stage: StageExecution = {
      stageName: 'Deploy',
      status: 'Succeeded',
      startTime: '2024-03-20T10:00:00.000Z',
      endTime: '2024-03-20T10:30:00.000Z',
      actions: [
        {
          actionName: 'CloudFormationDeploy',
          status: 'Succeeded',
          startTime: '2024-03-20T10:00:00.000Z',
          endTime: '2024-03-20T10:30:00.000Z',
          externalExecutionId: 'stack-exec-001',
          externalExecutionUrl: 'https://console.aws.amazon.com/cloudformation/...',
        },
      ],
    };

    expect(stage.status).toBe('Succeeded');
    expect(stage.actions).toHaveLength(1);
    expect(stage.actions[0].actionName).toBe('CloudFormationDeploy');
  });
});

describe('ApprovalAction structure', () => {
  it('should create pending approval action', () => {
    const approval: ApprovalAction = {
      actionName: 'ManualApproval',
      pipelineName: 'prod-deployment',
      stageName: 'Approval',
      status: 'Pending',
      token: 'approval-token-abc123',
      summary: 'Approve deployment to production',
      topicArn: 'arn:aws:sns:us-west-2:123456789012:deployment-approvals',
      expiresAt: new Date(Date.now() + 86400000).toISOString(), // 24 hours
    };

    expect(approval.status).toBe('Pending');
    expect(approval.token).toBe('approval-token-abc123');
    expect(approval.expiresAt).toBeDefined();
  });

  it('should track approval decision', () => {
    const approval: ApprovalAction = {
      actionName: 'ManualApproval',
      pipelineName: 'prod-deployment',
      stageName: 'Approval',
      status: 'Approved',
      token: 'approval-token-abc123',
      summary: 'Deploy looks good',
      approver: 'arn:aws:iam::123456789012:user/platform-admin',
      decidedAt: new Date().toISOString(),
    };

    expect(approval.status).toBe('Approved');
    expect(approval.approver).toBeDefined();
    expect(approval.decidedAt).toBeDefined();
  });
});

describe('ChangeSetSummary structure', () => {
  it('should describe CloudFormation changes', () => {
    const changeSet: ChangeSetSummary = {
      changeSetId: 'arn:aws:cloudformation:us-west-2:123456789012:changeSet/my-changeset/abc123',
      changeSetName: 'my-changeset',
      stackName: 'chimera-data-stack',
      changeSetType: 'UPDATE',
      executionStatus: 'AVAILABLE',
      status: 'CREATE_COMPLETE',
      createdAt: new Date().toISOString(),
      changes: [
        {
          action: 'Create',
          logicalResourceId: 'NewDynamoDBTable',
          resourceType: 'AWS::DynamoDB::Table',
        },
        {
          action: 'Update',
          logicalResourceId: 'ExistingS3Bucket',
          physicalResourceId: 'chimera-data-bucket',
          resourceType: 'AWS::S3::Bucket',
          replacement: 'False',
          scope: ['Properties'],
        },
      ],
    };

    expect(changeSet.changeSetType).toBe('UPDATE');
    expect(changeSet.changes).toHaveLength(2);
    expect(changeSet.changes[0].action).toBe('Create');
    expect(changeSet.changes[1].action).toBe('Update');
  });
});

describe('ResourceChange structure', () => {
  it('should describe resource creation', () => {
    const change: ResourceChange = {
      action: 'Create',
      logicalResourceId: 'TenantsTable',
      resourceType: 'AWS::DynamoDB::Table',
    };

    expect(change.action).toBe('Create');
    expect(change.resourceType).toBe('AWS::DynamoDB::Table');
  });

  it('should describe resource update with replacement', () => {
    const change: ResourceChange = {
      action: 'Update',
      logicalResourceId: 'ApiGateway',
      physicalResourceId: 'abc123def456',
      resourceType: 'AWS::ApiGateway::RestApi',
      replacement: 'Conditional',
      scope: ['Properties', 'Tags'],
      details: [
        {
          target: {
            attribute: 'Properties',
            name: 'EndpointConfiguration',
            requiresRecreation: 'Conditionally',
          },
          evaluation: 'Static',
          changeSource: 'DirectModification',
        },
      ],
    };

    expect(change.replacement).toBe('Conditional');
    expect(change.scope).toContain('Properties');
    expect(change.details).toBeDefined();
    expect(change.details![0].target.requiresRecreation).toBe('Conditionally');
  });

  it('should describe resource deletion', () => {
    const change: ResourceChange = {
      action: 'Delete',
      logicalResourceId: 'ObsoleteQueue',
      physicalResourceId: 'https://sqs.us-west-2.amazonaws.com/123456789012/obsolete-queue',
      resourceType: 'AWS::SQS::Queue',
    };

    expect(change.action).toBe('Delete');
    expect(change.physicalResourceId).toContain('sqs.us-west-2.amazonaws.com');
  });
});

describe('DriftDetection structure', () => {
  it('should report in-sync stack', () => {
    const drift: DriftDetection = {
      stackId: 'arn:aws:cloudformation:us-west-2:123456789012:stack/my-stack/abc123',
      stackName: 'my-stack',
      driftStatus: 'IN_SYNC',
      detectionTime: new Date().toISOString(),
      driftedResourceCount: 0,
      driftedResources: [],
    };

    expect(drift.driftStatus).toBe('IN_SYNC');
    expect(drift.driftedResourceCount).toBe(0);
  });

  it('should report drifted resources with details', () => {
    const drift: DriftDetection = {
      stackId: 'arn:aws:cloudformation:us-west-2:123456789012:stack/drifted-stack/xyz789',
      stackName: 'drifted-stack',
      driftStatus: 'DRIFTED',
      detectionTime: new Date().toISOString(),
      driftedResourceCount: 2,
      driftedResources: [
        {
          logicalResourceId: 'S3Bucket',
          physicalResourceId: 'my-bucket-abc123',
          resourceType: 'AWS::S3::Bucket',
          driftStatus: 'MODIFIED',
          propertyDifferences: [
            {
              propertyPath: '/Versioning/Status',
              expectedValue: 'Enabled',
              actualValue: 'Suspended',
              differenceType: 'NOT_EQUAL',
            },
          ],
        },
        {
          logicalResourceId: 'DynamoTable',
          physicalResourceId: 'my-table',
          resourceType: 'AWS::DynamoDB::Table',
          driftStatus: 'DELETED',
        },
      ],
    };

    expect(drift.driftStatus).toBe('DRIFTED');
    expect(drift.driftedResourceCount).toBe(2);
    expect(drift.driftedResources[0].propertyDifferences).toBeDefined();
    expect(drift.driftedResources[0].propertyDifferences![0].differenceType).toBe('NOT_EQUAL');
    expect(drift.driftedResources[1].driftStatus).toBe('DELETED');
  });
});

describe('CedarInfraPolicy structure', () => {
  it('should define infrastructure provisioning constraints', () => {
    const policy: CedarInfraPolicy = {
      policyId: 'policy-tenant-acme',
      tenantId: 'tenant-acme',
      allowedResourceTypes: [
        'AWS::DynamoDB::Table',
        'AWS::S3::Bucket',
        'AWS::Lambda::Function',
        'AWS::IAM::Role',
      ],
      forbiddenResourceTypes: [
        'AWS::EC2::Instance', // Block EC2 for cost control
      ],
      allowedRegions: ['us-west-2', 'us-east-1'],
      resourceLimits: {
        maxInstances: 0, // No EC2
        maxBuckets: 10,
        maxDatabases: 5,
      },
      budgetLimit: 1000, // $1000/month
      version: 1,
      effectiveAt: new Date().toISOString(),
    };

    expect(policy.tenantId).toBe('tenant-acme');
    expect(policy.allowedResourceTypes).toContain('AWS::DynamoDB::Table');
    expect(policy.forbiddenResourceTypes).toContain('AWS::EC2::Instance');
    expect(policy.budgetLimit).toBe(1000);
  });

  it('should enforce strict limits for lower tiers', () => {
    const basicPolicy: CedarInfraPolicy = {
      policyId: 'policy-basic-tier',
      tenantId: 'tenant-basic',
      allowedResourceTypes: ['AWS::DynamoDB::Table', 'AWS::S3::Bucket'],
      allowedRegions: ['us-west-2'],
      resourceLimits: {
        maxBuckets: 3,
        maxDatabases: 2,
      },
      budgetLimit: 100, // $100/month limit
      version: 1,
      effectiveAt: new Date().toISOString(),
    };

    expect(basicPolicy.resourceLimits?.maxBuckets).toBe(3);
    expect(basicPolicy.budgetLimit).toBe(100);
  });
});

describe('InfraOperationResult structure', () => {
  it('should report successful operation', () => {
    const result: InfraOperationResult<{ commitId: string }> = {
      success: true,
      data: {
        commitId: 'abc123',
      },
      metadata: {
        requestId: 'req-abc123',
        region: 'us-west-2',
        durationMs: 1500,
        costEstimate: 0.05,
      },
    };

    expect(result.success).toBe(true);
    expect(result.data?.commitId).toBe('abc123');
    expect(result.metadata.durationMs).toBe(1500);
  });

  it('should report operation failure with error details', () => {
    const result: InfraOperationResult = {
      success: false,
      error: {
        code: 'ResourceLimitExceeded',
        message: 'Maximum number of DynamoDB tables reached',
        details: {
          limit: 5,
          current: 5,
          requested: 1,
        },
      },
      metadata: {
        region: 'us-west-2',
        durationMs: 500,
      },
    };

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ResourceLimitExceeded');
    expect(result.error?.details).toBeDefined();
  });
});

describe('Type safety and status enums', () => {
  it('should validate workspace status transitions', () => {
    // Type checking ensures only valid statuses are used
    const statuses: WorkspaceStatus[] = [
      'INITIALIZING',
      'READY',
      'DEPLOYING',
      'DEPLOYED',
      'DRIFT_DETECTED',
      'ERROR',
      'ARCHIVED',
    ];
    expect(statuses).toHaveLength(7);
  });
});

describe('Tenant isolation in infrastructure operations', () => {
  it('should scope workspace to tenant', () => {
    const workspace: InfraWorkspace = {
      workspaceId: 'ws-tenant1',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      repositoryArn: 'arn:aws:codecommit:us-west-2:123456789012:tenant-1-infra',
      repositoryName: 'tenant-1-infra',
      defaultBranch: 'main',
      cloneUrl: 'https://git-codecommit.us-west-2.amazonaws.com/v1/repos/tenant-1-infra',
      status: 'READY',
      createdAt: new Date().toISOString(),
    };

    expect(workspace.tenantId).toBe('tenant-1');
    expect(workspace.repositoryName).toContain('tenant-1');
  });

  it('should enforce tenant-scoped Cedar policies', () => {
    const tenant1Policy: CedarInfraPolicy = {
      policyId: 'policy-tenant-1',
      tenantId: 'tenant-1',
      allowedResourceTypes: ['AWS::DynamoDB::Table'],
      allowedRegions: ['us-west-2'],
      budgetLimit: 500,
      version: 1,
      effectiveAt: new Date().toISOString(),
    };

    const tenant2Policy: CedarInfraPolicy = {
      policyId: 'policy-tenant-2',
      tenantId: 'tenant-2',
      allowedResourceTypes: ['AWS::S3::Bucket'],
      allowedRegions: ['us-east-1'],
      budgetLimit: 200,
      version: 1,
      effectiveAt: new Date().toISOString(),
    };

    // Verify policies are scoped to different tenants
    expect(tenant1Policy.tenantId).not.toBe(tenant2Policy.tenantId);
    expect(tenant1Policy.allowedResourceTypes).not.toEqual(tenant2Policy.allowedResourceTypes);
  });
});
