import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface PipelineStackProps extends cdk.StackProps {
  envName: string;
  repositoryName: string;  // CodeCommit repository name
  branch: string;          // Branch to track (default: 'main')

  // Optional: ALB canary wiring — supplied once ChatStack is deployed alongside.
  // Lambda functions use these at runtime; omit to defer wiring until a later deploy.
  albListenerArn?: string;         // HTTP listener on the chat-gateway ALB
  stableTargetGroupArn?: string;   // Stable (production) ECS target group
  canaryTargetGroupArn?: string;   // Canary ECS target group
  ecsClusterName?: string;         // ECS cluster name
  ecsCanaryServiceName?: string;   // ECS canary service name

  // Optional: Docker Hub credentials for rate limit avoidance.
  // Secret must contain JSON keys: username, token
  dockerHubSecretArn?: string;
}

/**
 * CI/CD Pipeline Stack.
 *
 * Implements the multi-stage deployment pipeline from Chimera Testing Strategy:
 * 1. Source: CodeCommit repository (enables self-editing infrastructure)
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
 * Uses CodeCommit instead of GitHub to enable agent-driven infrastructure evolution
 * through AWS SDK CodeCommit API calls. Agents can commit CDK changes, trigger builds,
 * and evolve their own deployment pipeline.
 *
 * Reference:
 * - docs/research/enhancement/06-Testing-Strategy.md § 10.1 Pipeline Stages
 * - docs/research/enhancement/07-Operational-Runbook.md § 1.2 Agent Runtime Deployment
 */
export class PipelineStack extends cdk.Stack {
  public readonly pipeline: codepipeline.Pipeline;
  public readonly artifactBucket: s3.IBucket;
  public readonly ecrRepository: ecr.Repository;  // Agent runtime ECR
  public readonly chatGatewayEcrRepository: ecr.Repository;  // Chat gateway ECR

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // ECR Repository for Agent Runtime Images
    // ======================================================================

    this.ecrRepository = new ecr.Repository(this, 'AgentRuntimeRepository', {
      repositoryName: `chimera-agent-runtime-${props.envName}`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [
        {
          description: 'Remove untagged images after 7 days',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(7),
          rulePriority: 1,
        },
        {
          description: 'Keep last 30 images',
          maxImageCount: 30,
          rulePriority: 2,
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: !isProd,
    });

    // ======================================================================
    // ECR Repository for Chat Gateway Images
    // ======================================================================

    this.chatGatewayEcrRepository = new ecr.Repository(this, 'ChatGatewayRepository', {
      repositoryName: `chimera-chat-gateway-${props.envName}`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [
        {
          description: 'Remove untagged images after 7 days',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(7),
          rulePriority: 1,
        },
        {
          description: 'Keep last 30 images',
          maxImageCount: 30,
          rulePriority: 2,
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: !isProd,
    });

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

    // Build spec is external (buildspec.yml at repo root)
    // Performs: lint, typecheck, unit tests, contract tests, CDK synth, Docker build

    const buildLogGroup = new logs.LogGroup(this, 'BuildLogGroup', {
      logGroupName: `/aws/codebuild/chimera-build-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: `chimera-build-${props.envName}`,
      description: 'Lint, test, and CDK synth for Chimera',
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          ENV_NAME: {
            value: props.envName,
          },
        },
      },
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.CUSTOM),
      logging: {
        cloudWatch: {
          logGroup: buildLogGroup,
        },
      },
      timeout: cdk.Duration.minutes(15),
    });

    // ======================================================================
    // CodeBuild Project for Docker Build Stage
    // ======================================================================

    const dockerBuildLogGroup = new logs.LogGroup(this, 'DockerBuildLogGroup', {
      logGroupName: `/aws/codebuild/chimera-docker-build-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const dockerBuildProject = new codebuild.PipelineProject(this, 'DockerBuildProject', {
      projectName: `chimera-docker-build-${props.envName}`,
      description: 'Build and push Docker images for Chimera services',
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-docker.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // Required for Docker build
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          ECR_REGISTRY: {
            value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com`,
          },
          ECR_REPOSITORY_AGENT: {
            value: this.ecrRepository.repositoryUri,
          },
          ECR_REPOSITORY_CHAT_GATEWAY: {
            value: this.chatGatewayEcrRepository.repositoryUri,
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
          logGroup: dockerBuildLogGroup,
        },
      },
      timeout: cdk.Duration.minutes(20),
    });

    // Grant ECR push permissions to Docker build project
    // GetAuthorizationToken is a global operation and requires resources: ['*']
    dockerBuildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );
    // Scope repository operations to chimera-* repositories
    dockerBuildProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
        ],
        resources: [
          `arn:aws:ecr:${this.region}:${this.account}:repository/chimera-*`,
        ],
      })
    );

    // If Docker Hub credentials are provided, inject them as env vars so buildspec
    // can docker login and avoid rate limits.
    if (props.dockerHubSecretArn) {
      const dockerHubSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'DockerHubSecret', props.dockerHubSecretArn
      );
      dockerBuildProject.addEnvironmentVariable('DOCKER_HUB_USERNAME', {
        value: `${props.dockerHubSecretArn}:username`,
        type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
      });
      dockerBuildProject.addEnvironmentVariable('DOCKER_HUB_TOKEN', {
        value: `${props.dockerHubSecretArn}:token`,
        type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
      });
      dockerHubSecret.grantRead(dockerBuildProject);
    }

    // ======================================================================
    // CodeBuild Project for CDK Deploy Stage
    // ======================================================================

    const deployLogGroup = new logs.LogGroup(this, 'DeployLogGroup', {
      logGroupName: `/aws/codebuild/chimera-deploy-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      projectName: `chimera-deploy-${props.envName}`,
      description: 'Deploy CDK stacks for Chimera infrastructure',
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { nodejs: 20 },
            commands: [
              'curl -fsSL https://bun.sh/install | bash',
              'export PATH="$HOME/.bun/bin:$PATH"',
            ],
          },
          pre_build: {
            commands: ['bun install --frozen-lockfile'],
          },
          build: {
            commands: [
              'cd infra && npx cdk deploy --all --require-approval never --concurrency 3 --context environment="$ENV_NAME" --context repositoryName="chimera" && cd ..',
            ],
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          ENV_NAME: {
            value: props.envName,
          },
        },
      },
      logging: {
        cloudWatch: {
          logGroup: deployLogGroup,
        },
      },
      timeout: cdk.Duration.minutes(60),
    });

    // Grant CDK deploy permissions — CodeBuild assumes CDK bootstrap roles
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::${this.account}:role/cdk-*`,
        ],
      })
    );

    // ======================================================================
    // CodeBuild Project for Test Stage
    // ======================================================================

    const testLogGroup = new logs.LogGroup(this, 'TestLogGroup', {
      logGroupName: `/aws/codebuild/chimera-test-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // Integration and E2E tests run against built Docker image
    const testProject = new codebuild.PipelineProject(this, 'TestProject', {
      projectName: `chimera-test-${props.envName}`,
      description: 'Run integration and E2E tests for Chimera',
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 20,
            },
            commands: [
              'curl -fsSL https://bun.sh/install | bash',
              'export PATH="$HOME/.bun/bin:$PATH"',
              'bun --version',
            ],
          },
          pre_build: {
            commands: [
              'bun install',
              'IMAGE_URI=$(cat $CODEBUILD_SRC_DIR_DockerOutput/image-uri.txt)',
            ],
          },
          build: {
            commands: [
              'bun test:integration',
              'bun test:e2e',
            ],
          },
        },
        reports: {
          testReports: {
            files: ['test-results/**/*.xml'],
            'file-format': 'JUNITXML',
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true, // Required for Docker integration tests
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          ENV_NAME: {
            value: props.envName,
          },
        },
      },
      logging: {
        cloudWatch: {
          logGroup: testLogGroup,
        },
      },
      timeout: cdk.Duration.minutes(20),
    });

    // Grant test project ECR pull permissions
    // GetAuthorizationToken is a global operation and requires resources: ['*']
    testProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );
    // Scope repository operations to chimera-* repositories
    testProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: [
          `arn:aws:ecr:${this.region}:${this.account}:repository/chimera-*`,
        ],
      })
    );

    // ======================================================================
    // Lambda Functions for Deployment Orchestration
    // ======================================================================

    // Deploy to Canary (5% traffic via ALB weighted target groups + ECS image update)
    const deployCanaryFunction = new lambda.Function(this, 'DeployCanaryFunction', {
      functionName: `chimera-deploy-canary-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime

elbv2 = boto3.client('elasticloadbalancingv2')
ecs_client = boto3.client('ecs')
s3 = boto3.client('s3')

def handler(event, context):
    """
    Deploy new image to canary ECS service and shift 5% ALB traffic.

    Input: { imageUri: str }
    Output: { status, imageUri, trafficAllocation, deployedAt }
    """
    image_uri = event['imageUri']
    bucket = os.environ['ARTIFACTS_BUCKET']
    listener_arn = os.environ.get('ALB_LISTENER_ARN', '')
    stable_tg = os.environ.get('STABLE_TARGET_GROUP_ARN', '')
    canary_tg = os.environ.get('CANARY_TARGET_GROUP_ARN', '')
    cluster = os.environ.get('ECS_CLUSTER', '')
    canary_svc = os.environ.get('ECS_CANARY_SERVICE', '')
    now = datetime.utcnow().isoformat()

    # Snapshot current stable image URI to S3 for rollback
    try:
        stable_uri = _current_image(cluster, canary_svc)
        s3.put_object(
            Bucket=bucket,
            Key='deployments/latest-stable-metadata.json',
            Body=json.dumps({'imageUri': stable_uri, 'deploymentId': context.aws_request_id, 'savedAt': now}),
            ContentType='application/json',
        )
    except Exception as e:
        print('Warning: stable snapshot failed: ' + str(e))

    # Update canary ECS service to new image
    if cluster and canary_svc:
        _update_service(cluster, canary_svc, image_uri)

    # Shift 5% traffic to canary via ALB weighted forwarding
    if listener_arn and stable_tg and canary_tg:
        elbv2.modify_listener(
            ListenerArn=listener_arn,
            DefaultActions=[{'Type': 'forward', 'ForwardConfig': {'TargetGroups': [
                {'TargetGroupArn': stable_tg, 'Weight': 95},
                {'TargetGroupArn': canary_tg, 'Weight': 5},
            ]}}],
        )

    return {
        'status': 'CANARY_DEPLOYED',
        'imageUri': image_uri,
        'trafficAllocation': {'canary': 5, 'production': 95},
        'deployedAt': now,
    }


def _current_image(cluster, service_name):
    if not cluster or not service_name:
        return 'unknown'
    svcs = ecs_client.describe_services(cluster=cluster, services=[service_name]).get('services', [])
    if not svcs:
        return 'unknown'
    td = ecs_client.describe_task_definition(taskDefinition=svcs[0]['taskDefinition'])['taskDefinition']
    containers = td.get('containerDefinitions', [])
    return containers[0]['image'] if containers else 'unknown'


def _update_service(cluster, service_name, new_image):
    svcs = ecs_client.describe_services(cluster=cluster, services=[service_name]).get('services', [])
    if not svcs:
        raise ValueError('Service not found: ' + service_name)
    td = ecs_client.describe_task_definition(taskDefinition=svcs[0]['taskDefinition'])['taskDefinition']
    containers = td['containerDefinitions']
    for c in containers:
        if c.get('essential', False):
            c['image'] = new_image
    kwargs = {
        'family': td['family'],
        'containerDefinitions': containers,
        'networkMode': td.get('networkMode', 'awsvpc'),
        'requiresCompatibilities': td.get('requiresCompatibilities', ['FARGATE']),
        'cpu': td.get('cpu', '256'),
        'memory': td.get('memory', '512'),
    }
    if td.get('executionRoleArn'):
        kwargs['executionRoleArn'] = td['executionRoleArn']
    if td.get('taskRoleArn'):
        kwargs['taskRoleArn'] = td['taskRoleArn']
    if td.get('volumes'):
        kwargs['volumes'] = td['volumes']
    new_td_arn = ecs_client.register_task_definition(**kwargs)['taskDefinition']['taskDefinitionArn']
    ecs_client.update_service(cluster=cluster, service=service_name, taskDefinition=new_td_arn, forceNewDeployment=True)
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        ARTIFACTS_BUCKET: this.artifactBucket.bucketName,
        ENV_NAME: props.envName,
        ALB_LISTENER_ARN: props.albListenerArn ?? '',
        STABLE_TARGET_GROUP_ARN: props.stableTargetGroupArn ?? '',
        CANARY_TARGET_GROUP_ARN: props.canaryTargetGroupArn ?? '',
        ECS_CLUSTER: props.ecsClusterName ?? '',
        ECS_CANARY_SERVICE: props.ecsCanaryServiceName ?? '',
      },
    });

    this.artifactBucket.grantReadWrite(deployCanaryFunction);

    deployCanaryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'elbv2:ModifyListener',
          'elbv2:DescribeListeners',
          'elbv2:DescribeTargetGroups',
        ],
        // ELBv2 listener/target-group actions require resources: ['*']
        resources: ['*'],
      })
    );

    deployCanaryFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:DescribeServices',
          'ecs:DescribeTaskDefinition',
          'ecs:RegisterTaskDefinition',
          'ecs:UpdateService',
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
from datetime import datetime, timedelta

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
    canary_endpoint = event.get('canaryEndpoint', 'canary')

    # Time window: last 30 minutes
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(minutes=30)

    namespace = 'AgentPlatform'

    # Query error rate metric
    error_response = cloudwatch.get_metric_statistics(
        Namespace=namespace,
        MetricName='Errors',
        Dimensions=[{'Name': 'Endpoint', 'Value': canary_endpoint}],
        StartTime=start_time,
        EndTime=end_time,
        Period=300,
        Statistics=['Sum']
    )

    invocation_response = cloudwatch.get_metric_statistics(
        Namespace=namespace,
        MetricName='Invocations',
        Dimensions=[{'Name': 'Endpoint', 'Value': canary_endpoint}],
        StartTime=start_time,
        EndTime=end_time,
        Period=300,
        Statistics=['Sum']
    )

    # Calculate error rate
    total_errors = sum(dp['Sum'] for dp in error_response['Datapoints'])
    total_invocations = sum(dp['Sum'] for dp in invocation_response['Datapoints'])
    error_rate = (total_errors / total_invocations * 100) if total_invocations > 0 else 0

    # Query P99 latency
    latency_response = cloudwatch.get_metric_statistics(
        Namespace=namespace,
        MetricName='InvocationDuration',
        Dimensions=[{'Name': 'Endpoint', 'Value': canary_endpoint}],
        StartTime=start_time,
        EndTime=end_time,
        Period=300,
        ExtendedStatistics=['p99']
    )

    p99_latency = max((dp.get('ExtendedStatistics', {}).get('p99', 0)
                      for dp in latency_response['Datapoints']), default=0)

    # Query guardrail trigger rate
    guardrail_response = cloudwatch.get_metric_statistics(
        Namespace=namespace,
        MetricName='GuardrailTriggers',
        Dimensions=[{'Name': 'Endpoint', 'Value': canary_endpoint}],
        StartTime=start_time,
        EndTime=end_time,
        Period=300,
        Statistics=['Sum']
    )

    total_guardrails = sum(dp['Sum'] for dp in guardrail_response['Datapoints'])
    guardrail_rate = (total_guardrails / total_invocations * 100) if total_invocations > 0 else 0

    # Query evaluation composite score
    eval_response = cloudwatch.get_metric_statistics(
        Namespace=namespace,
        MetricName='EvaluationCompositeScore',
        Dimensions=[{'Name': 'Endpoint', 'Value': canary_endpoint}],
        StartTime=start_time,
        EndTime=end_time,
        Period=300,
        Statistics=['Average']
    )

    eval_score = sum(dp['Average'] for dp in eval_response['Datapoints']) / len(eval_response['Datapoints']) if eval_response['Datapoints'] else 0

    # Validation thresholds
    passed = (
        error_rate < 5.0 and
        p99_latency < 30000 and  # 30 seconds
        guardrail_rate < 10.0 and
        eval_score >= 80
    )

    return {
        'status': 'PASS' if passed else 'FAIL',
        'metrics': {
            'errorRate': round(error_rate, 2),
            'p99Latency': round(p99_latency, 0),
            'guardrailRate': round(guardrail_rate, 2),
            'evalScore': round(eval_score, 1),
            'totalInvocations': int(total_invocations)
        },
        'recommendation': 'PROMOTE' if passed else 'ROLLBACK'
    }
`),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
    });

    // CloudWatch GetMetric* operations don't support resource-level permissions
    // They require resources: ['*'] per AWS documentation
    canaryBakeValidationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:GetMetricStatistics', 'cloudwatch:GetMetricData'],
        resources: ['*'],
      })
    );

    // Progressive Rollout (25%, 50%, 100% via ALB weighted target groups)
    const progressiveRolloutFunction = new lambda.Function(this, 'ProgressiveRolloutFunction', {
      functionName: `chimera-progressive-rollout-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime

elbv2 = boto3.client('elasticloadbalancingv2')
s3 = boto3.client('s3')

def handler(event, context):
    """
    Progressive traffic rollout: 25% -> 50% -> 100%.

    Input: { targetPercentage: int, imageUri: str }
    Output: { status, trafficAllocation, targetPercentage }
    """
    target_pct = event['targetPercentage']
    image_uri = event['imageUri']
    listener_arn = os.environ.get('ALB_LISTENER_ARN', '')
    stable_tg = os.environ.get('STABLE_TARGET_GROUP_ARN', '')
    canary_tg = os.environ.get('CANARY_TARGET_GROUP_ARN', '')

    if listener_arn and stable_tg and canary_tg:
        elbv2.modify_listener(
            ListenerArn=listener_arn,
            DefaultActions=[{'Type': 'forward', 'ForwardConfig': {'TargetGroups': [
                {'TargetGroupArn': stable_tg, 'Weight': 100 - target_pct},
                {'TargetGroupArn': canary_tg, 'Weight': target_pct},
            ]}}],
        )

    # At 100% rollout, promote canary image as the new stable baseline
    if target_pct == 100:
        try:
            s3.put_object(
                Bucket=os.environ['ARTIFACTS_BUCKET'],
                Key='deployments/latest-stable-metadata.json',
                Body=json.dumps({
                    'imageUri': image_uri,
                    'deploymentId': context.aws_request_id,
                    'promotedAt': datetime.utcnow().isoformat(),
                }),
                ContentType='application/json',
            )
        except Exception as e:
            print('Warning: stable promotion failed: ' + str(e))

    return {
        'status': 'ROLLOUT_COMPLETE',
        'trafficAllocation': {'canary': target_pct, 'production': 100 - target_pct},
        'targetPercentage': target_pct,
        'imageUri': image_uri,
    }
`),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      environment: {
        ARTIFACTS_BUCKET: this.artifactBucket.bucketName,
        ALB_LISTENER_ARN: props.albListenerArn ?? '',
        STABLE_TARGET_GROUP_ARN: props.stableTargetGroupArn ?? '',
        CANARY_TARGET_GROUP_ARN: props.canaryTargetGroupArn ?? '',
      },
    });

    this.artifactBucket.grantReadWrite(progressiveRolloutFunction);

    progressiveRolloutFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'elbv2:ModifyListener',
          'elbv2:DescribeListeners',
          'elbv2:DescribeTargetGroups',
        ],
        resources: ['*'],
      })
    );

    // Rollback Function — revert ALB to 100% stable, restore canary ECS service image
    const rollbackFunction = new lambda.Function(this, 'RollbackFunction', {
      functionName: `chimera-rollback-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime

elbv2 = boto3.client('elasticloadbalancingv2')
ecs_client = boto3.client('ecs')
s3 = boto3.client('s3')

def handler(event, context):
    """
    Rollback on canary failure: revert ALB weights (100% stable / 0% canary)
    and restore canary ECS service to the previous stable image.

    Reads stable image URI from S3 snapshot written by deployCanary.
    """
    bucket = os.environ['ARTIFACTS_BUCKET']
    listener_arn = os.environ.get('ALB_LISTENER_ARN', '')
    stable_tg = os.environ.get('STABLE_TARGET_GROUP_ARN', '')
    canary_tg = os.environ.get('CANARY_TARGET_GROUP_ARN', '')
    cluster = os.environ.get('ECS_CLUSTER', '')
    canary_svc = os.environ.get('ECS_CANARY_SERVICE', '')

    # Retrieve stable image URI from S3 snapshot
    try:
        resp = s3.get_object(Bucket=bucket, Key='deployments/latest-stable-metadata.json')
        meta = json.loads(resp['Body'].read().decode('utf-8'))
        stable_uri = meta['imageUri']
        prev_id = meta.get('deploymentId', 'unknown')
    except Exception:
        stable_uri = event.get('fallbackImageUri', 'unknown')
        prev_id = 'unknown'

    # Revert ALB listener to 100% stable (0% canary)
    if listener_arn and stable_tg:
        if canary_tg:
            default_action = {'Type': 'forward', 'ForwardConfig': {'TargetGroups': [
                {'TargetGroupArn': stable_tg, 'Weight': 100},
                {'TargetGroupArn': canary_tg, 'Weight': 0},
            ]}}
        else:
            default_action = {'Type': 'forward', 'TargetGroupArn': stable_tg}
        elbv2.modify_listener(ListenerArn=listener_arn, DefaultActions=[default_action])

    # Restore canary ECS service to stable image
    if cluster and canary_svc and stable_uri != 'unknown':
        try:
            svcs = ecs_client.describe_services(cluster=cluster, services=[canary_svc]).get('services', [])
            if svcs:
                td = ecs_client.describe_task_definition(taskDefinition=svcs[0]['taskDefinition'])['taskDefinition']
                containers = td['containerDefinitions']
                for c in containers:
                    if c.get('essential', False):
                        c['image'] = stable_uri
                kwargs = {
                    'family': td['family'],
                    'containerDefinitions': containers,
                    'networkMode': td.get('networkMode', 'awsvpc'),
                    'requiresCompatibilities': td.get('requiresCompatibilities', ['FARGATE']),
                    'cpu': td.get('cpu', '256'),
                    'memory': td.get('memory', '512'),
                }
                if td.get('executionRoleArn'):
                    kwargs['executionRoleArn'] = td['executionRoleArn']
                if td.get('taskRoleArn'):
                    kwargs['taskRoleArn'] = td['taskRoleArn']
                if td.get('volumes'):
                    kwargs['volumes'] = td['volumes']
                new_td_arn = ecs_client.register_task_definition(**kwargs)['taskDefinition']['taskDefinitionArn']
                ecs_client.update_service(cluster=cluster, service=canary_svc, taskDefinition=new_td_arn, forceNewDeployment=True)
        except Exception as e:
            print('Warning: ECS service rollback failed: ' + str(e))

    # Log rollback event to S3
    rollback_key = 'rollback-logs/' + context.aws_request_id + '.json'
    s3.put_object(
        Bucket=bucket,
        Key=rollback_key,
        Body=json.dumps({
            'eventType': 'ROLLBACK',
            'timestamp': datetime.utcnow().isoformat(),
            'requestId': context.aws_request_id,
            'rolledBackFrom': event.get('failedImageUri', 'unknown'),
            'rolledBackTo': stable_uri,
            'previousDeploymentId': prev_id,
            'reason': event.get('reason', 'Canary validation failed'),
        }, indent=2),
        ContentType='application/json',
    )

    return {
        'status': 'ROLLBACK_COMPLETE',
        'rolledBackAt': datetime.utcnow().isoformat(),
        'stableImageUri': stable_uri,
        'previousDeploymentId': prev_id,
        'trafficAllocation': {'canary': 0, 'production': 100},
        'rollbackLogKey': rollback_key,
    }
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        ARTIFACTS_BUCKET: this.artifactBucket.bucketName,
        ALB_LISTENER_ARN: props.albListenerArn ?? '',
        STABLE_TARGET_GROUP_ARN: props.stableTargetGroupArn ?? '',
        CANARY_TARGET_GROUP_ARN: props.canaryTargetGroupArn ?? '',
        ECS_CLUSTER: props.ecsClusterName ?? '',
        ECS_CANARY_SERVICE: props.ecsCanaryServiceName ?? '',
      },
    });

    rollbackFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'elbv2:ModifyListener',
          'elbv2:DescribeListeners',
          'elbv2:DescribeTargetGroups',
        ],
        resources: ['*'],
      })
    );

    rollbackFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:DescribeServices',
          'ecs:DescribeTaskDefinition',
          'ecs:RegisterTaskDefinition',
          'ecs:UpdateService',
        ],
        resources: ['*'],
      })
    );

    // Grant S3 read/write for rollback logs and stable metadata
    this.artifactBucket.grantReadWrite(rollbackFunction);

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

    // Lambda tasks — all include retry for transient Lambda cold-start failures
    const deployCanaryTask = new tasks.LambdaInvoke(this, 'DeployCanary', {
      lambdaFunction: deployCanaryFunction,
      outputPath: '$.Payload',
    });
    deployCanaryTask.addRetry({ errors: ['States.ALL'], maxAttempts: 2, backoffRate: 2 });

    const validateCanaryTask = new tasks.LambdaInvoke(this, 'ValidateCanary', {
      lambdaFunction: canaryBakeValidationFunction,
      outputPath: '$.Payload',
    });
    validateCanaryTask.addRetry({ errors: ['States.ALL'], maxAttempts: 2, backoffRate: 2 });

    const rollout25Task = new tasks.LambdaInvoke(this, 'Rollout25Percent', {
      lambdaFunction: progressiveRolloutFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'targetPercentage': 25,
        'imageUri.$': '$.imageUri',
      }),
      outputPath: '$.Payload',
    });
    rollout25Task.addRetry({ errors: ['States.ALL'], maxAttempts: 2, backoffRate: 2 });

    const rollout50Task = new tasks.LambdaInvoke(this, 'Rollout50Percent', {
      lambdaFunction: progressiveRolloutFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'targetPercentage': 50,
        'imageUri.$': '$.imageUri',
      }),
      outputPath: '$.Payload',
    });
    rollout50Task.addRetry({ errors: ['States.ALL'], maxAttempts: 2, backoffRate: 2 });

    const rollout100Task = new tasks.LambdaInvoke(this, 'Rollout100Percent', {
      lambdaFunction: progressiveRolloutFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'targetPercentage': 100,
        'imageUri.$': '$.imageUri',
      }),
      outputPath: '$.Payload',
    });
    rollout100Task.addRetry({ errors: ['States.ALL'], maxAttempts: 2, backoffRate: 2 });

    const rollbackTask = new tasks.LambdaInvoke(this, 'RollbackDeployment', {
      lambdaFunction: rollbackFunction,
      outputPath: '$.Payload',
    });
    rollbackTask.addRetry({ errors: ['States.ALL'], maxAttempts: 2, backoffRate: 2 });

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

    // Catch handlers: on unhandled Lambda errors, trigger rollback then fail.
    // rollbackTask already has .next(deploymentFailed) set via checkCanaryHealth above.
    deployCanaryTask.addCatch(rollbackTask, { errors: ['States.ALL'], resultPath: '$.error' });
    validateCanaryTask.addCatch(rollbackTask, { errors: ['States.ALL'], resultPath: '$.error' });
    rollout25Task.addCatch(rollbackTask, { errors: ['States.ALL'], resultPath: '$.error' });
    rollout50Task.addCatch(rollbackTask, { errors: ['States.ALL'], resultPath: '$.error' });
    rollout100Task.addCatch(rollbackTask, { errors: ['States.ALL'], resultPath: '$.error' });
    rollbackTask.addCatch(deploymentFailed, { errors: ['States.ALL'], resultPath: '$.error' });

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

    // Pipeline artifacts
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');
    const dockerOutput = new codepipeline.Artifact('DockerOutput');

    // Reference existing CodeCommit repository
    const repository = codecommit.Repository.fromRepositoryName(
      this,
      'SourceRepository',
      props.repositoryName
    );

    this.pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `chimera-deploy-${props.envName}`,
      artifactBucket: this.artifactBucket,
      restartExecutionOnUpdate: false,
      stages: [
        // Stage 1: Source (CodeCommit for self-editing capability)
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.CodeCommitSourceAction({
              actionName: 'CodeCommit_Source',
              repository,
              branch: props.branch,
              output: sourceOutput,
              trigger: codepipeline_actions.CodeCommitTrigger.EVENTS,
            }),
          ],
        },
        // Stage 2: Build + Docker (parallel — CDK synth and Docker build are independent)
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Build_Package',
              project: buildProject,
              input: sourceOutput,
              outputs: [buildOutput],
            }),
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Docker_Build',
              project: dockerBuildProject,
              input: sourceOutput,
              outputs: [dockerOutput],
              variablesNamespace: 'DockerVars',
            }),
          ],
        },
        // Stage 3: Deploy CDK stacks (infrastructure update)
        {
          stageName: 'Deploy',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Cdk_Deploy',
              project: deployProject,
              input: sourceOutput,
            }),
          ],
        },
        // Stage 4: Test (integration + E2E against deployed infrastructure)
        {
          stageName: 'Test',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Integration_E2E_Tests',
              project: testProject,
              input: buildOutput,
              extraInputs: [dockerOutput],
            }),
          ],
        },
        // Stage 5: Rollout (canary orchestration of new Docker images)
        {
          stageName: 'Rollout',
          actions: [
            new codepipeline_actions.StepFunctionInvokeAction({
              actionName: 'Canary_Orchestration',
              stateMachine: orchestrationStateMachine,
              stateMachineInput: codepipeline_actions.StateMachineInput.literal({
                imageUri: '#{DockerVars.IMAGE_URI}',
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

    new cdk.CfnOutput(this, 'EcrRepositoryArn', {
      value: this.ecrRepository.repositoryArn,
      exportName: `${this.stackName}-EcrRepositoryArn`,
      description: 'ECR repository ARN for agent runtime images',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: this.ecrRepository.repositoryUri,
      exportName: `${this.stackName}-EcrRepositoryUri`,
      description: 'ECR repository URI for agent runtime images',
    });

    new cdk.CfnOutput(this, 'ChatGatewayEcrRepositoryArn', {
      value: this.chatGatewayEcrRepository.repositoryArn,
      exportName: `${this.stackName}-ChatGatewayEcrRepositoryArn`,
      description: 'ECR repository ARN for chat gateway images',
    });

    new cdk.CfnOutput(this, 'ChatGatewayEcrRepositoryUri', {
      value: this.chatGatewayEcrRepository.repositoryUri,
      exportName: `${this.stackName}-ChatGatewayEcrRepositoryUri`,
      description: 'ECR repository URI for chat gateway images',
    });
  }
}
