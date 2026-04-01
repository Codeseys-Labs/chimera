/**
 * CDK tests for PipelineStack
 *
 * Validates the CI/CD pipeline infrastructure:
 * - 2 ECR repositories (agent runtime, chat gateway) with lifecycle policies
 * - S3 artifact bucket with versioning and lifecycle rules
 * - 4 CodeBuild projects (build, docker-build, deploy, test)
 * - 4 Lambda functions for canary orchestration (Python 3.12)
 * - Step Functions state machine for canary rollout
 * - CodePipeline with 5 stages (Source→Build→Deploy→Test→Rollout)
 * - CloudWatch alarms for auto-rollback triggers
 * - Stack outputs for all resources
 *
 * Note: Uses beforeAll (not beforeEach) because PipelineStack synthesis is
 * expensive (4 Lambda inline functions + Step Functions + CodePipeline).
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PipelineStack } from '../lib/pipeline-stack';

describe('PipelineStack', () => {
  describe('Dev Environment', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new PipelineStack(app, 'TestPipelineStack', {
        envName: 'dev',
        repositoryName: 'chimera',
        branch: 'main',
      });
      template = Template.fromStack(stack);
    }, 120_000); // 120s — CDK synthesis is expensive (Lambda inline functions + Step Functions)

    describe('ECR Repositories', () => {
      it('should create exactly 2 ECR repositories', () => {
        template.resourceCountIs('AWS::ECR::Repository', 2);
      });

      it('should create agent runtime ECR repository with scan on push', () => {
        template.hasResourceProperties('AWS::ECR::Repository', {
          RepositoryName: 'chimera-agent-runtime-dev',
          ImageScanningConfiguration: { ScanOnPush: true },
        });
      });

      it('should create chat gateway ECR repository with scan on push', () => {
        template.hasResourceProperties('AWS::ECR::Repository', {
          RepositoryName: 'chimera-chat-gateway-dev',
          ImageScanningConfiguration: { ScanOnPush: true },
        });
      });

      it('should use MUTABLE image tags on ECR repositories', () => {
        template.hasResourceProperties('AWS::ECR::Repository', {
          RepositoryName: 'chimera-agent-runtime-dev',
          ImageTagMutability: 'MUTABLE',
        });
      });

      it('should delete ECR repositories in non-prod on stack destroy', () => {
        const repos = template.findResources('AWS::ECR::Repository', {
          Properties: {
            RepositoryName: 'chimera-agent-runtime-dev',
          },
        });
        const repo = Object.values(repos)[0] as any;
        expect(repo.DeletionPolicy).toBe('Delete');
      });
    });

    describe('S3 Artifact Bucket', () => {
      it('should create artifact bucket with versioning and KMS-managed encryption', () => {
        template.hasResourceProperties('AWS::S3::Bucket', {
          VersioningConfiguration: { Status: 'Enabled' },
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [{
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'aws:kms',
              },
            }],
          },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        });
      });

      it('should have lifecycle rule to delete artifacts after 30 days', () => {
        template.hasResourceProperties('AWS::S3::Bucket', {
          LifecycleConfiguration: {
            Rules: Match.arrayWith([
              Match.objectLike({
                Id: 'DeleteOldArtifacts',
                ExpirationInDays: 30,
                Status: 'Enabled',
              }),
            ]),
          },
        });
      });
    });

    describe('CodeBuild Projects', () => {
      it('should create build project', () => {
        template.hasResourceProperties('AWS::CodeBuild::Project', {
          Name: 'chimera-build-dev',
        });
      });

      it('should create Docker build project with privileged mode enabled', () => {
        template.hasResourceProperties('AWS::CodeBuild::Project', {
          Name: 'chimera-docker-build-dev',
          Environment: Match.objectLike({
            PrivilegedMode: true,
          }),
        });
      });

      it('should create deploy project', () => {
        template.hasResourceProperties('AWS::CodeBuild::Project', {
          Name: 'chimera-deploy-dev',
        });
      });

      it('should create test project with privileged mode for Docker integration tests', () => {
        template.hasResourceProperties('AWS::CodeBuild::Project', {
          Name: 'chimera-test-dev',
          Environment: Match.objectLike({
            PrivilegedMode: true,
          }),
        });
      });
    });

    describe('Lambda Functions', () => {
      it('should create deploy canary Lambda function', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
          FunctionName: 'chimera-deploy-canary-dev',
          Runtime: 'python3.12',
          Timeout: 300,
        });
      });

      it('should create canary bake validation Lambda function', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
          FunctionName: 'chimera-canary-validation-dev',
          Runtime: 'python3.12',
          Timeout: 120,
        });
      });

      it('should create progressive rollout Lambda function', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
          FunctionName: 'chimera-progressive-rollout-dev',
          Runtime: 'python3.12',
        });
      });

      it('should create rollback Lambda function', () => {
        template.hasResourceProperties('AWS::Lambda::Function', {
          FunctionName: 'chimera-rollback-dev',
          Runtime: 'python3.12',
          Timeout: 300,
        });
      });
    });

    describe('Step Functions State Machine', () => {
      it('should create canary orchestration state machine', () => {
        template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
          StateMachineName: 'chimera-canary-orchestration-dev',
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

      it('should enable logging on state machine', () => {
        template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
          LoggingConfiguration: Match.objectLike({
            Level: 'ALL',
            IncludeExecutionData: true,
          }),
        });
      });

      it('ValidateCanary task should use ResultPath not OutputPath to preserve imageUri', () => {
        // Bug: outputPath: '$.Payload' replaces entire state, losing imageUri.
        // rollout tasks use 'imageUri.$': '$.imageUri', causing States.Runtime error.
        // Fix: resultPath: '$.validation' merges result into state, preserving imageUri.
        //
        // DefinitionString is a CloudFormation Fn::Join intrinsic — stringify it and
        // search for the ASL fragment. JSON.stringify escapes inner `"` to `\"`,
        // so search strings use `\\"` (backslash + quote in the resulting JavaScript string).
        const machines = template.findResources('AWS::StepFunctions::StateMachine');
        const machine = Object.values(machines)[0] as any;
        const defnStr = JSON.stringify(machine.Properties.DefinitionString);
        // ValidateCanary must store result under $.validation (only that task uses this path)
        expect(defnStr).toContain('\\"ResultPath\\":\\"$.validation\\"');
      });

      it('CheckCanaryHealth choice should reference $.validation.Payload.status', () => {
        // Bug: after validateCanaryTask uses resultPath, the validation result is
        // nested at $.validation.Payload.status — not $.status.
        // CheckCanaryHealth checking $.status would silently always take the otherwise branch.
        const machines = template.findResources('AWS::StepFunctions::StateMachine');
        const machine = Object.values(machines)[0] as any;
        const defnStr = JSON.stringify(machine.Properties.DefinitionString);
        expect(defnStr).toContain('$.validation.Payload.status');
      });
    });

    describe('CodePipeline', () => {
      it('should create pipeline with correct name', () => {
        template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
          Name: 'chimera-deploy-dev',
        });
      });

      it('should have exactly 5 stages', () => {
        const pipelines = template.findResources('AWS::CodePipeline::Pipeline', {
          Properties: { Name: 'chimera-deploy-dev' },
        });
        const pipeline = Object.values(pipelines)[0] as any;
        expect(pipeline.Properties.Stages).toHaveLength(5);
      });

      it('should have Source stage with CodeCommit provider', () => {
        const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
        const pipeline = Object.values(pipelines)[0] as any;
        const sourceStage = pipeline.Properties.Stages.find((s: any) => s.Name === 'Source');
        expect(sourceStage).toBeDefined();
        expect(sourceStage.Actions[0].ActionTypeId.Provider).toBe('CodeCommit');
      });

      it('should have Build stage with 2 parallel actions', () => {
        const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
        const pipeline = Object.values(pipelines)[0] as any;
        const buildStage = pipeline.Properties.Stages.find((s: any) => s.Name === 'Build');
        expect(buildStage).toBeDefined();
        expect(buildStage.Actions).toHaveLength(2);
      });

      it('should have Rollout stage with StepFunctions provider', () => {
        const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
        const pipeline = Object.values(pipelines)[0] as any;
        const rolloutStage = pipeline.Properties.Stages.find((s: any) => s.Name === 'Rollout');
        expect(rolloutStage).toBeDefined();
        expect(rolloutStage.Actions[0].ActionTypeId.Provider).toBe('StepFunctions');
      });

      it('should have Test stage with SourceOutput as primary input (not BuildOutput)', () => {
        // Root cause of chimera-ae82: buildOutput has no package.json/bun.lockb,
        // so bun install fails in the Test stage. Primary input must be sourceOutput.
        const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
        const pipeline = Object.values(pipelines)[0] as any;
        const testStage = pipeline.Properties.Stages.find((s: any) => s.Name === 'Test');
        expect(testStage).toBeDefined();
        const testAction = testStage.Actions[0];
        // Primary input artifact name must be SourceOutput, not BuildOutput
        const inputArtifactName = testAction.InputArtifacts?.[0]?.Name;
        expect(inputArtifactName).toBe('SourceOutput');
      });
    });

    describe('CodeBuild Bun PATH sourcing', () => {
      // CodeBuild runs each phase in a separate shell — export PATH in install
      // does NOT carry over. Each phase that calls bun must re-export PATH.
      // Use `export PATH="$HOME/.bun/bin:$PATH"` (not source .bun/env — the env
      // file may not exist on all CodeBuild images). Convention: mx-b8e992.
      const getBunPathCmd = (cmds: string[]): boolean =>
        cmds.some((cmd: string) => cmd.includes('.bun/bin') && cmd.includes('PATH'));

      it('deploy project pre_build should set bun PATH before bun install', () => {
        const projects = template.findResources('AWS::CodeBuild::Project', {
          Properties: { Name: 'chimera-deploy-dev' },
        });
        const project = Object.values(projects)[0] as any;
        const preBuildCmds: string[] = project.Properties.Source.BuildSpec
          ? JSON.parse(project.Properties.Source.BuildSpec).phases?.pre_build?.commands ?? []
          : [];
        expect(getBunPathCmd(preBuildCmds)).toBe(true);
      });

      it('test project pre_build should set bun PATH before bun install', () => {
        const projects = template.findResources('AWS::CodeBuild::Project', {
          Properties: { Name: 'chimera-test-dev' },
        });
        const project = Object.values(projects)[0] as any;
        const preBuildCmds: string[] = project.Properties.Source.BuildSpec
          ? JSON.parse(project.Properties.Source.BuildSpec).phases?.pre_build?.commands ?? []
          : [];
        expect(getBunPathCmd(preBuildCmds)).toBe(true);
      });

      it('test project build phase should set bun PATH before running tests', () => {
        const projects = template.findResources('AWS::CodeBuild::Project', {
          Properties: { Name: 'chimera-test-dev' },
        });
        const project = Object.values(projects)[0] as any;
        const buildCmds: string[] = project.Properties.Source.BuildSpec
          ? JSON.parse(project.Properties.Source.BuildSpec).phases?.build?.commands ?? []
          : [];
        expect(getBunPathCmd(buildCmds)).toBe(true);
      });
    });

    describe('Lambda canary functions', () => {
      it('canary Lambda functions should use elbv2 not elasticloadbalancingv2 boto3 client name', () => {
        // Lambda Python 3.12 botocore in Lambda runtime uses 'elbv2' as service name.
        // 'elasticloadbalancingv2' raises UnknownServiceError: unknown service elbv2.
        // This caused Rollout stage Step Functions failure immediately on execution start.
        const fns = template.findResources('AWS::Lambda::Function');
        const inlineFns = Object.values(fns).filter((fn: any) =>
          fn.Properties.Code?.ZipFile?.includes('elasticloadbalancingv2')
        );
        expect(inlineFns).toHaveLength(0);
      });

      it('canary validation Lambda should default eval_score to 100 when no CloudWatch data', () => {
        // Bug: eval_score defaulted to 0 when no EvaluationCompositeScore datapoints.
        // On first deployment there are no metrics => score=0 fails >=80 threshold => always FAIL+rollback.
        // Fix: default to 100.0 so no-data is treated as passing (same logic as error_rate=0 when no invocations).
        const fns = template.findResources('AWS::Lambda::Function');
        const validationFn = Object.values(fns).find((fn: any) =>
          fn.Properties.FunctionName === 'chimera-canary-validation-dev'
        ) as any;
        expect(validationFn).toBeDefined();
        const code: string = validationFn.Properties.Code?.ZipFile ?? '';
        // Must default to 100.0 (not 0) when no datapoints
        // eval_score specifically must default to 100.0 (not 0) — other metrics (error_rate,
        // guardrail_rate) correctly default to 0 when there are no invocations.
        expect(code).toContain('else 100.0');
      });
    });

    describe('CloudWatch Alarms', () => {
      it('should create error rate alarm for auto-rollback', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
          AlarmName: 'Chimera-Pipeline-ErrorRate-dev',
          Threshold: 50,
          EvaluationPeriods: 1,
          ComparisonOperator: 'GreaterThanThreshold',
        });
      });

      it('should create latency alarm for auto-rollback', () => {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
          AlarmName: 'Chimera-Pipeline-Latency-dev',
          Threshold: 60000,
          EvaluationPeriods: 2,
          ComparisonOperator: 'GreaterThanThreshold',
        });
      });
    });

    describe('SNS Topic', () => {
      it('should create pipeline alarm topic', () => {
        template.hasResourceProperties('AWS::SNS::Topic', {
          TopicName: 'chimera-pipeline-alarms-dev',
        });
      });
    });

    describe('Stack Outputs', () => {
      it('should export PipelineArn', () => {
        template.hasOutput('PipelineArn', {
          Export: { Name: 'TestPipelineStack-PipelineArn' },
        });
      });

      it('should export PipelineName', () => {
        template.hasOutput('PipelineName', {
          Export: { Name: 'TestPipelineStack-PipelineName' },
        });
      });

      it('should export ArtifactBucketName', () => {
        template.hasOutput('ArtifactBucketName', {
          Export: { Name: 'TestPipelineStack-ArtifactBucketName' },
        });
      });

      it('should export OrchestrationStateMachineArn', () => {
        template.hasOutput('OrchestrationStateMachineArn', {
          Export: { Name: 'TestPipelineStack-OrchestrationArn' },
        });
      });

      it('should export AlarmTopicArn', () => {
        template.hasOutput('AlarmTopicArn', {
          Export: { Name: 'TestPipelineStack-AlarmTopicArn' },
        });
      });

      it('should export EcrRepositoryArn', () => {
        template.hasOutput('EcrRepositoryArn', {
          Export: { Name: 'TestPipelineStack-EcrRepositoryArn' },
        });
      });

      it('should export EcrRepositoryUri', () => {
        template.hasOutput('EcrRepositoryUri', {
          Export: { Name: 'TestPipelineStack-EcrRepositoryUri' },
        });
      });

      it('should export ChatGatewayEcrRepositoryArn', () => {
        template.hasOutput('ChatGatewayEcrRepositoryArn', {
          Export: { Name: 'TestPipelineStack-ChatGatewayEcrRepositoryArn' },
        });
      });

      it('should export ChatGatewayEcrRepositoryUri', () => {
        template.hasOutput('ChatGatewayEcrRepositoryUri', {
          Export: { Name: 'TestPipelineStack-ChatGatewayEcrRepositoryUri' },
        });
      });
    });
  });

  describe('Prod Environment', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new PipelineStack(app, 'TestPipelineStackProd', {
        envName: 'prod',
        repositoryName: 'chimera',
        branch: 'main',
      });
      template = Template.fromStack(stack);
    }, 120_000);

    it('should retain ECR repositories in prod', () => {
      const repos = template.findResources('AWS::ECR::Repository', {
        Properties: { RepositoryName: 'chimera-agent-runtime-prod' },
      });
      const repo = Object.values(repos)[0] as any;
      expect(repo.DeletionPolicy).toBe('Retain');
    });

    it('should retain artifact bucket in prod', () => {
      const buckets = template.findResources('AWS::S3::Bucket');
      const artifactBucket = Object.values(buckets).find((b: any) => {
        const rules = b.Properties?.LifecycleConfiguration?.Rules;
        return rules?.some((r: any) => r.Id === 'DeleteOldArtifacts');
      }) as any;
      expect(artifactBucket).toBeDefined();
      expect(artifactBucket.DeletionPolicy).toBe('Retain');
    });

    it('should use ONE_MONTH log retention for prod CodeBuild projects', () => {
      // ONE_MONTH = 30
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/aws/codebuild/chimera-build-prod',
        RetentionInDays: 30,
      });
    });
  });

  describe('With ALB Canary Wiring', () => {
    let template: Template;

    beforeAll(() => {
      const app = new cdk.App();
      const stack = new PipelineStack(app, 'TestPipelineStackWired', {
        envName: 'dev',
        repositoryName: 'chimera',
        branch: 'main',
        albListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789:listener/app/test/abc/def',
        stableTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789:targetgroup/stable/abc',
        canaryTargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789:targetgroup/canary/abc',
        ecsClusterName: 'chimera-cluster-dev',
        ecsCanaryServiceName: 'chimera-canary-dev',
      });
      template = Template.fromStack(stack);
    }, 120_000);

    it('should pass ALB listener ARN to deploy canary function environment', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-deploy-canary-dev',
        Environment: {
          Variables: Match.objectLike({
            ALB_LISTENER_ARN: 'arn:aws:elasticloadbalancing:us-east-1:123456789:listener/app/test/abc/def',
          }),
        },
      });
    });

    it('should pass ECS cluster name to deploy canary function environment', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'chimera-deploy-canary-dev',
        Environment: {
          Variables: Match.objectLike({
            ECS_CLUSTER: 'chimera-cluster-dev',
          }),
        },
      });
    });
  });
});
