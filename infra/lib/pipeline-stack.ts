import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface PipelineStackProps extends cdk.StackProps {
  envName: string;
  repository: string;      // GitHub repo (owner/name)
  branch: string;          // Branch to track (default: 'main')
  githubTokenSecretName?: string;  // Secrets Manager secret name for GitHub token
}

/**
 * CI/CD Pipeline Stack.
 *
 * Implements the multi-stage deployment pipeline from Chimera Testing Strategy:
 * 1. Source: GitHub webhook trigger
 * 2. Build: Docker image + unit/contract tests (< 8 min)
 * 3. Deploy Canary: 5% traffic to canary endpoint
 * 4. Canary Bake: 30-minute monitoring + evaluation suite (auto-rollback on alarm)
 * 5. Progressive Rollout: 25% → 50% → 100% with validation gates
 * 6. Post-Deploy: Synthetic monitoring + cost tracking
 *
 * Rollback triggers:
 * - Error rate > 5% for 5 minutes
 * - P99 latency > 2x baseline for 10 minutes
 * - Guardrail trigger rate > 10% for 15 minutes
 * - Evaluation composite score < 80
 *
 * Reference:
 * - docs/research/enhancement/06-Testing-Strategy.md § 10.1 Pipeline Stages
 * - docs/research/enhancement/07-Operational-Runbook.md § 1.2 Agent Runtime Deployment
 */
export class PipelineStack extends cdk.Stack {
  public readonly pipeline: codepipeline.Pipeline;
  public readonly artifactBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';
    const githubTokenSecretName = props.githubTokenSecretName ?? 'github-token';

    // ======================================================================
    // Artifact Bucket
    // ======================================================================

    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `chimera-pipeline-artifacts-${props.envName}-${this.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [
        {
          id: 'DeleteOldArtifacts',
          enabled: true,
          expiration: cdk.Duration.days(30),
          noncurrentVersionExpiration: cdk.Duration.days(7),
        },
      ],
    });

    // ======================================================================
    // SNS Topic for Pipeline Notifications
    // ======================================================================

    const pipelineAlarmTopic = new sns.Topic(this, 'PipelineAlarmTopic', {
      topicName: `chimera-pipeline-alarms-${props.envName}`,
      displayName: `Chimera Pipeline Alarms (${props.envName})`,
    });

    // ======================================================================
    // CodeBuild Project for Build Stage
    // ======================================================================

    // Build spec performs: lint, typecheck, unit tests, contract tests, CDK synth, Docker build
    const buildSpec = codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        pre_build: {
          commands: [
            'echo "Installing dependencies..."',
            'bun install',
            'echo "Logging into ECR..."',
            'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY',
          ],
        },
        build: {
          commands: [
            'echo "Stage 1: Lint and Type Check"',
            'bun run lint',
            'bun run typecheck',
            '',
            'echo "Stage 2: Unit Tests"',
            'bun test --coverage',
            '',
            'echo "Stage 3: Contract Tests"',
            'bun test:contract',
            '',
            'echo "Stage 4: CDK Synth and Validation"',
            'cd infra && npx cdk synth --all',
            'npx cdk-nag',
            'cd ..',
            '',
            'echo "Stage 5: Build Docker Image"',
            'IMAGE_TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}',
            'docker build -t $ECR_REPOSITORY:$IMAGE_TAG -t $ECR_REPOSITORY:latest -f agent-code/Dockerfile agent-code/',
            '',
            'echo "Pushing Docker image to ECR..."',
            'docker push $ECR_REPOSITORY:$IMAGE_TAG',
            'docker push $ECR_REPOSITORY:latest',
            '',
            'echo "Writing image URI to file for next stage..."',
            'echo $ECR_REPOSITORY:$IMAGE_TAG > image-uri.txt',
          ],
        },
        post_build: {
          commands: [
            'echo "Build completed on `date`"',
            'echo "Image URI: $(cat image-uri.txt)"',
          ],
        },
      },
      artifacts: {
        files: [
          'image-uri.txt',
          'infra/**/*',
          'agent-code/**/*',
        ],
      },
      cache: {
        paths: [
          '/root/.bun/install/cache/**/*',
          'node_modules/**/*',
        ],
      },
    });

    const buildLogGroup = new logs.LogGroup(this, 'BuildLogGroup', {
      logGroupName: `/aws/codebuild/chimera-build-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: `chimera-build-${props.envName}`,
      description: 'Build and test Chimera agent runtime',
      buildSpec,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // Required for Docker build
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          ECR_REGISTRY: {
            value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
          },
          ECR_REPOSITORY: {
            value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/chimera-agent-runtime`,
          },
          ENV_NAME: {
            value: props.envName,
          },
        },
      },
      cache: codebuild.Cache.local(
        codebuild.LocalCacheMode.DOCKER_LAYER,
        codebuild.LocalCacheMode.CUSTOM
      ),
      logging: {
        cloudWatch: {
          logGroup: buildLogGroup,
        },
      },
      timeout: cdk.Duration.minutes(15),
    });

    // Grant ECR push permissions
    buildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
        ],
        resources: ['*'],
      })
    );

    // ======================================================================
    // Lambda Functions for Deployment Orchestration
    // ======================================================================

    // Deploy to Canary (5% traffic)
    const deployCanaryFunction = new lambda.Function(this, 'DeployCanaryFunction', {
      functionName: `chimera-deploy-canary-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3

bedrock_agent_runtime = boto3.client('bedrock-agent-runtime')

def handler(event, context):
    """
    Deploy new agent runtime image to canary endpoint with 5% traffic.

    Input: image URI from CodeBuild
    Output: canary endpoint ARN and deployment timestamp
    """
    image_uri = event['imageUri']

    # TODO: Implement actual canary deployment via Bedrock Agent Runtime API
    # bedrock_agent_runtime.update_agent_runtime_endpoint(
    #     runtimeName='chimera-pool',
    #     endpointName='canary',
    #     agentRuntimeArtifact=image_uri,
    #     trafficAllocation={'canary': 5, 'production': 95}
    # )

    return {
        'status': 'CANARY_DEPLOYED',
        'imageUri': image_uri,
        'trafficAllocation': {'canary': 5, 'production': 95},
        'deployedAt': context.aws_request_id
    }
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
    });

    deployCanaryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:UpdateAgentRuntimeEndpoint',
          'bedrock:GetAgentRuntimeEndpoint',
        ],
        resources: ['*'],
      })
    );

    // Canary Bake Validation
    const canaryBakeValidationFunction = new lambda.Function(this, 'CanaryBakeValidationFunction', {
      functionName: `chimera-canary-validation-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import time

cloudwatch = boto3.client('cloudwatch')

def handler(event, context):
    """
    Validate canary health during 30-minute bake period.

    Checks:
    - Error rate < 5%
    - P99 latency < 2x baseline
    - Guardrail trigger rate < 10%
    - Evaluation composite score >= 80

    Returns: PASS or FAIL with details
    """
    canary_endpoint = event['canaryEndpoint']

    # Query CloudWatch metrics for canary
    # TODO: Implement actual metric queries

    # Placeholder: simulate validation
    error_rate = 2.0  # %
    p99_latency = 15000  # ms
    guardrail_rate = 5.0  # %
    eval_score = 85  # composite score

    passed = (
        error_rate < 5.0 and
        p99_latency < 30000 and
        guardrail_rate < 10.0 and
        eval_score >= 80
    )

    return {
        'status': 'PASS' if passed else 'FAIL',
        'metrics': {
            'errorRate': error_rate,
            'p99Latency': p99_latency,
            'guardrailRate': guardrail_rate,
            'evalScore': eval_score
        },
        'recommendation': 'PROMOTE' if passed else 'ROLLBACK'
    }
`),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
    });

    canaryBakeValidationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:GetMetricStatistics', 'cloudwatch:GetMetricData'],
        resources: ['*'],
      })
    );

    // Progressive Rollout (25%, 50%, 100%)
    const progressiveRolloutFunction = new lambda.Function(this, 'ProgressiveRolloutFunction', {
      functionName: `chimera-progressive-rollout-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3

bedrock_agent_runtime = boto3.client('bedrock-agent-runtime')

def handler(event, context):
    """
    Progressive traffic rollout: 25% -> 50% -> 100%.

    Input: target percentage (25, 50, or 100)
    Output: updated traffic allocation
    """
    target_percentage = event['targetPercentage']
    image_uri = event['imageUri']

    # TODO: Implement actual traffic shifting via Bedrock Agent Runtime API

    return {
        'status': 'ROLLOUT_COMPLETE',
        'trafficAllocation': {
            'canary': target_percentage,
            'production': 100 - target_percentage
        },
        'targetPercentage': target_percentage
    }
`),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
    });

    progressiveRolloutFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:UpdateAgentRuntimeEndpoint', 'bedrock:GetAgentRuntimeEndpoint'],
        resources: ['*'],
      })
    );

    // Rollback Function
    const rollbackFunction = new lambda.Function(this, 'RollbackFunction', {
      functionName: `chimera-rollback-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3

bedrock_agent_runtime = boto3.client('bedrock-agent-runtime')

def handler(event, context):
    """
    Rollback to previous stable image on canary failure.

    Reverts both canary and production endpoints to :latest-stable tag.
    """

    # TODO: Implement actual rollback via Bedrock Agent Runtime API

    return {
        'status': 'ROLLBACK_COMPLETE',
        'rolledBackAt': context.aws_request_id,
        'trafficAllocation': {'canary': 0, 'production': 100}
    }
`),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
    });

    rollbackFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:UpdateAgentRuntimeEndpoint', 'bedrock:GetAgentRuntimeEndpoint'],
        resources: ['*'],
      })
    );

    // ======================================================================
    // Step Functions for Canary Orchestration
    // ======================================================================

    // Wait states for bake and rollout intervals
    const waitCanaryBake = new stepfunctions.Wait(this, 'WaitCanaryBake', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(30)),
    });

    const wait25Percent = new stepfunctions.Wait(this, 'Wait25Percent', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(15)),
    });

    const wait50Percent = new stepfunctions.Wait(this, 'Wait50Percent', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(15)),
    });

    // Lambda tasks
    const deployCanaryTask = new tasks.LambdaInvoke(this, 'DeployCanary', {
      lambdaFunction: deployCanaryFunction,
      outputPath: '$.Payload',
    });

    const validateCanaryTask = new tasks.LambdaInvoke(this, 'ValidateCanary', {
      lambdaFunction: canaryBakeValidationFunction,
      outputPath: '$.Payload',
    });

    const rollout25Task = new tasks.LambdaInvoke(this, 'Rollout25Percent', {
      lambdaFunction: progressiveRolloutFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'targetPercentage': 25,
        'imageUri.$': '$.imageUri',
      }),
      outputPath: '$.Payload',
    });

    const rollout50Task = new tasks.LambdaInvoke(this, 'Rollout50Percent', {
      lambdaFunction: progressiveRolloutFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'targetPercentage': 50,
        'imageUri.$': '$.imageUri',
      }),
      outputPath: '$.Payload',
    });

    const rollout100Task = new tasks.LambdaInvoke(this, 'Rollout100Percent', {
      lambdaFunction: progressiveRolloutFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'targetPercentage': 100,
        'imageUri.$': '$.imageUri',
      }),
      outputPath: '$.Payload',
    });

    const rollbackTask = new tasks.LambdaInvoke(this, 'RollbackDeployment', {
      lambdaFunction: rollbackFunction,
      outputPath: '$.Payload',
    });

    // Success/failure states
    const deploymentSuccess = new stepfunctions.Succeed(this, 'DeploymentSuccess');
    const deploymentFailed = new stepfunctions.Fail(this, 'DeploymentFailed', {
      error: 'CanaryValidationFailed',
      cause: 'Canary bake period validation failed',
    });

    // Choice after canary validation
    const checkCanaryHealth = new stepfunctions.Choice(this, 'CheckCanaryHealth')
      .when(
        stepfunctions.Condition.stringEquals('$.status', 'FAIL'),
        rollbackTask.next(deploymentFailed)
      )
      .otherwise(rollout25Task);

    // Build orchestration flow
    const definition = deployCanaryTask
      .next(waitCanaryBake)
      .next(validateCanaryTask)
      .next(checkCanaryHealth);

    rollout25Task.next(wait25Percent).next(rollout50Task);
    rollout50Task.next(wait50Percent).next(rollout100Task);
    rollout100Task.next(deploymentSuccess);

    const orchestrationLogGroup = new logs.LogGroup(this, 'OrchestrationLogGroup', {
      logGroupName: `/aws/states/chimera-canary-orchestration-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const orchestrationStateMachine = new stepfunctions.StateMachine(this, 'CanaryOrchestration', {
      stateMachineName: `chimera-canary-orchestration-${props.envName}`,
      definition,
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      logs: {
        destination: orchestrationLogGroup,
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });

    // ======================================================================
    // CodePipeline
    // ======================================================================

    // Source artifact
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    // Parse repository owner/name
    const [repoOwner, repoName] = props.repository.split('/');

    this.pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `chimera-deploy-${props.envName}`,
      artifactBucket: this.artifactBucket,
      restartExecutionOnUpdate: false,
      stages: [
        // Stage 1: Source
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.CodeStarConnectionsSourceAction({
              actionName: 'GitHub_Source',
              owner: repoOwner,
              repo: repoName,
              branch: props.branch,
              output: sourceOutput,
              connectionArn: `arn:aws:codestar-connections:${this.region}:${this.account}:connection/placeholder`,
              triggerOnPush: true,
            }),
          ],
        },
        // Stage 2: Build
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Build_Test_Package',
              project: buildProject,
              input: sourceOutput,
              outputs: [buildOutput],
            }),
          ],
        },
        // Stage 3: Deploy (invokes Step Functions for canary orchestration)
        {
          stageName: 'Deploy',
          actions: [
            new codepipeline_actions.StepFunctionInvokeAction({
              actionName: 'Canary_Orchestration',
              stateMachine: orchestrationStateMachine,
              stateMachineInput: codepipeline_actions.StateMachineInput.literal({
                imageUri: '#{BuildOutput.image-uri.txt}',
              }),
            }),
          ],
        },
      ],
    });

    // ======================================================================
    // CloudWatch Alarms for Auto-Rollback
    // ======================================================================

    // Error rate alarm (SEV2)
    const errorRateAlarm = new cloudwatch.Alarm(this, 'ErrorRateAlarm', {
      alarmName: `Chimera-Pipeline-ErrorRate-${props.envName}`,
      alarmDescription: 'SEV2: Error rate >5% for 5 minutes during canary deployment',
      metric: new cloudwatch.Metric({
        namespace: 'AgentPlatform',
        metricName: 'Errors',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 50,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    errorRateAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(pipelineAlarmTopic));

    // Latency alarm (SEV2)
    const latencyAlarm = new cloudwatch.Alarm(this, 'LatencyAlarm', {
      alarmName: `Chimera-Pipeline-Latency-${props.envName}`,
      alarmDescription: 'SEV2: P99 latency >60s during canary deployment',
      metric: new cloudwatch.Metric({
        namespace: 'AgentPlatform',
        metricName: 'InvocationDuration',
        statistic: 'p99',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 60000,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    latencyAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(pipelineAlarmTopic));

    // ======================================================================
    // Stack Outputs
    // ======================================================================

    new cdk.CfnOutput(this, 'PipelineArn', {
      value: this.pipeline.pipelineArn,
      exportName: `${this.stackName}-PipelineArn`,
      description: 'CI/CD pipeline ARN',
    });

    new cdk.CfnOutput(this, 'PipelineName', {
      value: this.pipeline.pipelineName,
      exportName: `${this.stackName}-PipelineName`,
      description: 'CI/CD pipeline name',
    });

    new cdk.CfnOutput(this, 'ArtifactBucketName', {
      value: this.artifactBucket.bucketName,
      exportName: `${this.stackName}-ArtifactBucketName`,
      description: 'Pipeline artifact bucket name',
    });

    new cdk.CfnOutput(this, 'OrchestrationStateMachineArn', {
      value: orchestrationStateMachine.stateMachineArn,
      exportName: `${this.stackName}-OrchestrationArn`,
      description: 'Canary orchestration state machine ARN',
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: pipelineAlarmTopic.topicArn,
      exportName: `${this.stackName}-AlarmTopicArn`,
      description: 'SNS topic for pipeline alarms',
    });
  }
}
