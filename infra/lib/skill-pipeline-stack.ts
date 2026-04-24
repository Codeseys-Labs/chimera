import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { ChimeraLambda } from '../constructs/chimera-lambda';
import { logRetentionFor } from '../constructs/log-retention';

export interface SkillPipelineStackProps extends cdk.StackProps {
  envName: string;
  skillsTable: dynamodb.ITable;
  skillsBucket: s3.IBucket;
}

/**
 * Skill security scanning pipeline.
 *
 * Implements the 7-stage security pipeline from Chimera-Skill-Ecosystem-Design.md:
 * 1. Static Analysis (regex/AST pattern detection)
 * 2. Dependency Audit (OSV database checks)
 * 3. Sandbox Run (isolated subprocess execution)
 * 4. Signature Verification (Ed25519 sign + verify)
 * 5. Performance Testing (token cost, latency, CloudWatch anomaly detectors)
 * 6. Manual Review (permission validation, auto-approve or queue)
 * 7. Skill Deployment (publish to DynamoDB registry + S3)
 *
 * Plus a failure notification handler (SNS + DDB status update).
 * All Lambdas use ChimeraLambda for mandatory X-Ray tracing, log retention, DLQ.
 *
 * Reference: docs/research/architecture-reviews/Chimera-Skill-Ecosystem-Design.md § 4.2
 */
export class SkillPipelineStack extends cdk.Stack {
  public readonly stateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: SkillPipelineStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // Supporting resources
    // ======================================================================

    const failureNotificationTopic = new sns.Topic(this, 'ScanFailureTopic', {
      topicName: `chimera-skill-scan-failures-${props.envName}`,
      displayName: 'Chimera Skill Pipeline Failure Notifications',
    });

    const signingKeySecret = new secretsmanager.Secret(this, 'SkillSigningKey', {
      secretName: `chimera/skill-pipeline/signing-key-${props.envName}`,
      description: 'Ed25519 key pair used by the SkillPipeline signature-verification Lambda',
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ======================================================================
    // Lambda Functions — all Node.js 20.x, code loaded from asset directories
    // ChimeraLambda adds: X-Ray tracing, log retention, DLQ, NODE_OPTIONS env var
    // ======================================================================

    const assetPath = (stage: string) =>
      path.join(__dirname, '../lambdas/skill-pipeline', stage);

    const commonEnv = {
      SKILLS_TABLE: props.skillsTable.tableName,
      SKILLS_BUCKET: props.skillsBucket.bucketName,
    };

    // Stage 1: Static Analysis
    const staticAnalysisChimera = new ChimeraLambda(this, 'StaticAnalysisFunction', {
      functionName: `chimera-skill-static-analysis-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(assetPath('static-analysis')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: commonEnv,
    });

    // Stage 2: Dependency Audit
    const dependencyAuditChimera = new ChimeraLambda(this, 'DependencyAuditFunction', {
      functionName: `chimera-skill-dependency-audit-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(assetPath('dependency-audit')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
    });

    // Stage 3: Sandbox Run
    const sandboxRunChimera = new ChimeraLambda(this, 'SandboxRunFunction', {
      functionName: `chimera-skill-sandbox-test-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(assetPath('sandbox-run')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
    });

    // Stage 4: Signature Verification (Ed25519 sign + verify)
    const signatureVerificationChimera = new ChimeraLambda(this, 'SignatureVerificationFunction', {
      functionName: `chimera-skill-signature-verification-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(assetPath('signature-verification')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ...commonEnv,
        SIGNING_KEY_SECRET_ARN: signingKeySecret.secretArn,
      },
    });

    // Stage 5: Performance Testing (CloudWatch metrics + anomaly detectors)
    const performanceTestingChimera = new ChimeraLambda(this, 'PerformanceTestingFunction', {
      functionName: `chimera-skill-performance-testing-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(assetPath('performance-testing')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: commonEnv,
    });

    // Stage 6: Manual Review (permission validation)
    const manualReviewChimera = new ChimeraLambda(this, 'ManualReviewFunction', {
      functionName: `chimera-skill-manual-review-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(assetPath('manual-review')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { SKILLS_TABLE: props.skillsTable.tableName },
    });

    // Stage 7: Skill Deployment (S3 + DynamoDB publish)
    const skillDeploymentChimera = new ChimeraLambda(this, 'SkillDeploymentFunction', {
      functionName: `chimera-skill-deployment-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(assetPath('skill-deployment')),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: commonEnv,
    });

    // Scan Failure Notification (error path)
    const scanFailureChimera = new ChimeraLambda(this, 'ScanFailureFunction', {
      functionName: `chimera-skill-scan-notify-failure-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(assetPath('scan-failure')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        SKILLS_TABLE: props.skillsTable.tableName,
        NOTIFICATION_TOPIC_ARN: failureNotificationTopic.topicArn,
      },
    });

    // ======================================================================
    // IAM permissions
    // ======================================================================

    props.skillsTable.grantReadWriteData(staticAnalysisChimera.fn);
    props.skillsBucket.grantRead(staticAnalysisChimera.fn);

    props.skillsTable.grantReadWriteData(signatureVerificationChimera.fn);
    props.skillsBucket.grantRead(signatureVerificationChimera.fn);
    signingKeySecret.grantRead(signatureVerificationChimera.fn);
    signingKeySecret.grantWrite(signatureVerificationChimera.fn);

    props.skillsTable.grantReadWriteData(performanceTestingChimera.fn);
    props.skillsBucket.grantRead(performanceTestingChimera.fn);
    // PutMetricData requires '*' (AWS limitation). PutAnomalyDetector can be
    // ARN-scoped; we narrow it to alarms under our own namespace+region+account.
    // Wave-14 H4.
    performanceTestingChimera.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'cloudwatch:namespace': 'Chimera/Skills' },
      },
    }));
    performanceTestingChimera.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutAnomalyDetector', 'cloudwatch:DeleteAnomalyDetector'],
      resources: [
        `arn:aws:cloudwatch:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:*`,
      ],
    }));

    props.skillsTable.grantReadWriteData(manualReviewChimera.fn);

    props.skillsTable.grantReadWriteData(skillDeploymentChimera.fn);
    props.skillsBucket.grantReadWrite(skillDeploymentChimera.fn);

    // TODO(spike): narrow resources once RegistryStack emits a concrete registry ARN.
    // Conditions currently limit blast radius to the deploy region only.
    // These permissions are additive and inert: the skill-deployment Lambda only
    // invokes bedrock-agentcore-control when the Registry feature flag is flipped
    // in the tenant config (chimera-tenants table, FEATURE_FLAG items). With the
    // flag off (default), none of these API calls are made.
    // See ADR-034 and docs/designs/agentcore-registry-spike.md.
    skillDeploymentChimera.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore-control:CreateRegistryRecord',
        'bedrock-agentcore-control:UpdateRegistryRecord',
        'bedrock-agentcore-control:UpdateRegistryRecordStatus',
        'bedrock-agentcore-control:SubmitRegistryRecordForApproval',
        'bedrock-agentcore-control:GetRegistryRecord',
      ],
      resources: ['*'], // Registry-specific ARNs not yet known (spike output)
      conditions: {
        // Prevent any accidental cross-region / cross-account blast radius
        StringEquals: {
          'aws:RequestedRegion': cdk.Stack.of(this).region,
        },
      },
    }));

    props.skillsTable.grantReadWriteData(scanFailureChimera.fn);
    failureNotificationTopic.grantPublish(scanFailureChimera.fn);

    // ======================================================================
    // Step Functions State Machine
    // ======================================================================

    const catchOpts: stepfunctions.CatchProps = {
      errors: ['States.ALL'],
      resultPath: '$.error',
    };
    const retryOpts: stepfunctions.RetryProps = {
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    };

    const mkTask = (id: string, fn: lambda.IFunction) => {
      const t = new tasks.LambdaInvoke(this, id, { lambdaFunction: fn, outputPath: '$.Payload' });
      t.addRetry(retryOpts);
      return t;
    };

    const staticAnalysisTask       = mkTask('StaticAnalysis',       staticAnalysisChimera.fn);
    const dependencyAuditTask      = mkTask('DependencyAudit',      dependencyAuditChimera.fn);
    const sandboxRunTask           = mkTask('SandboxRun',           sandboxRunChimera.fn);
    const signatureVerificationTask = mkTask('SignatureVerification', signatureVerificationChimera.fn);
    const performanceTestingTask   = mkTask('PerformanceTesting',   performanceTestingChimera.fn);
    const manualReviewTask         = mkTask('ManualReview',         manualReviewChimera.fn);
    const skillDeploymentTask      = mkTask('SkillDeployment',      skillDeploymentChimera.fn);
    const scanFailureTask          = mkTask('NotifyScanFailure',    scanFailureChimera.fn);

    const scanPassed = new stepfunctions.Succeed(this, 'ScanPassed');
    const scanRejected = new stepfunctions.Fail(this, 'ScanRejected', {
      error: 'SkillScanFailed',
      cause: 'Skill failed security scanning pipeline',
    });

    const failureChain = scanFailureTask.next(scanRejected);

    const checkStaticResult = new stepfunctions.Choice(this, 'CheckStaticResult')
      .when(stepfunctions.Condition.stringEquals('$.static_result', 'FAIL'), failureChain)
      .otherwise(dependencyAuditTask);

    const checkDependencyResult = new stepfunctions.Choice(this, 'CheckDependencyResult')
      .when(stepfunctions.Condition.stringEquals('$.dependency_result', 'FAIL'), failureChain)
      .otherwise(sandboxRunTask);

    const checkSandboxResult = new stepfunctions.Choice(this, 'CheckSandboxResult')
      .when(stepfunctions.Condition.stringEquals('$.sandbox_result', 'FAIL'), failureChain)
      .otherwise(signatureVerificationTask);

    const checkSignatureResult = new stepfunctions.Choice(this, 'CheckSignatureResult')
      .when(stepfunctions.Condition.stringEquals('$.signature_result', 'FAIL'), failureChain)
      .otherwise(performanceTestingTask);

    const checkPerformanceResult = new stepfunctions.Choice(this, 'CheckPerformanceResult')
      .when(stepfunctions.Condition.stringEquals('$.performance_result', 'FAIL'), failureChain)
      .otherwise(manualReviewTask);

    const checkManualReviewResult = new stepfunctions.Choice(this, 'CheckManualReviewResult')
      .when(stepfunctions.Condition.stringEquals('$.review_result', 'FAIL'), failureChain)
      .otherwise(skillDeploymentTask);

    const checkDeploymentResult = new stepfunctions.Choice(this, 'CheckDeploymentResult')
      .when(stepfunctions.Condition.stringEquals('$.deployment_result', 'FAIL'), failureChain)
      .otherwise(scanPassed);

    staticAnalysisTask.addCatch(failureChain, catchOpts);
    dependencyAuditTask.addCatch(failureChain, catchOpts);
    sandboxRunTask.addCatch(failureChain, catchOpts);
    signatureVerificationTask.addCatch(failureChain, catchOpts);
    performanceTestingTask.addCatch(failureChain, catchOpts);
    manualReviewTask.addCatch(failureChain, catchOpts);
    skillDeploymentTask.addCatch(failureChain, catchOpts);

    const definition = staticAnalysisTask.next(checkStaticResult);
    dependencyAuditTask.next(checkDependencyResult);
    sandboxRunTask.next(checkSandboxResult);
    signatureVerificationTask.next(checkSignatureResult);
    performanceTestingTask.next(checkPerformanceResult);
    manualReviewTask.next(checkManualReviewResult);
    skillDeploymentTask.next(checkDeploymentResult);

    const logGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
      logGroupName: `/aws/states/chimera-skill-pipeline-${props.envName}`,
      retention: logRetentionFor('debug', isProd),
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.stateMachine = new stepfunctions.StateMachine(this, 'SkillSecurityPipeline', {
      stateMachineName: `chimera-skill-pipeline-${props.envName}`,
      definition,
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      logs: {
        destination: logGroup,
        level: stepfunctions.LogLevel.ALL,
        includeExecutionData: true,
      },
      tracingEnabled: true,
    });

    // ======================================================================
    // Stack Outputs
    // ======================================================================

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      exportName: `${this.stackName}-StateMachineArn`,
      description: 'Skill security scanning pipeline state machine ARN',
    });

    new cdk.CfnOutput(this, 'StateMachineName', {
      value: this.stateMachine.stateMachineName,
      exportName: `${this.stackName}-StateMachineName`,
      description: 'Skill security scanning pipeline state machine name',
    });

    new cdk.CfnOutput(this, 'FailureNotificationTopicArn', {
      value: failureNotificationTopic.topicArn,
      exportName: `${this.stackName}-FailureTopicArn`,
      description: 'SNS topic ARN for skill pipeline failure notifications',
    });
  }
}
