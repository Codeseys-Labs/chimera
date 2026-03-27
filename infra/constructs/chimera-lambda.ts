import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface ChimeraLambdaProps {
  /** Lambda function name */
  functionName: string;
  /** Lambda runtime */
  runtime: lambda.Runtime;
  /** Handler method */
  handler: string;
  /** Lambda code */
  code: lambda.Code;
  /** Memory in MB (default: 256) */
  memorySize?: number;
  /** Timeout (default: 30 seconds) */
  timeout?: cdk.Duration;
  /** Environment variables — merged with defaults (LOG_LEVEL, NODE_OPTIONS) */
  environment?: Record<string, string>;
  /** Log retention (default: ONE_MONTH = 30 days) */
  logRetention?: logs.RetentionDays;
  /** Reserved concurrency — undefined means no limit */
  reservedConcurrentExecutions?: number;
  /** KMS key for DLQ encryption — if not provided, a new key is created */
  encryptionKey?: kms.IKey;
  /** Lambda layers */
  layers?: lambda.ILayerVersion[];
  /** VPC for the function */
  vpc?: ec2.IVpc;
  /** VPC subnet selection */
  vpcSubnets?: ec2.SubnetSelection;
  /** Security groups */
  securityGroups?: ec2.ISecurityGroup[];
  /** Execution role — if not provided, a default role is created */
  role?: iam.IRole;
}

/**
 * L3 construct for Chimera Lambda functions.
 *
 * Mandatory invariants (cannot be overridden):
 * - X-Ray tracing always ACTIVE
 * - Log retention always set (default ONE_MONTH)
 * - DLQ always created with KMS encryption
 * - Default environment: LOG_LEVEL=INFO, NODE_OPTIONS=--enable-source-maps
 */
export class ChimeraLambda extends Construct {
  readonly fn: lambda.Function;
  readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: ChimeraLambdaProps) {
    super(scope, id);

    const dlqKey = props.encryptionKey ?? new kms.Key(this, 'DlqKey', {
      description: `CMK for ${props.functionName} DLQ`,
      enableKeyRotation: true,
    });

    this.dlq = new sqs.Queue(this, 'DLQ', {
      queueName: `${props.functionName}-dlq`,
      encryptionMasterKey: dlqKey,
      retentionPeriod: cdk.Duration.days(14),
    });

    const defaultEnv: Record<string, string> = {
      LOG_LEVEL: 'INFO',
      NODE_OPTIONS: '--enable-source-maps',
    };

    this.fn = new lambda.Function(this, 'Function', {
      functionName: props.functionName,
      runtime: props.runtime,
      handler: props.handler,
      code: props.code,
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      logRetention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      deadLetterQueue: this.dlq,
      maxEventAge: cdk.Duration.hours(6),
      retryAttempts: 2,
      environment: { ...defaultEnv, ...props.environment },
      reservedConcurrentExecutions: props.reservedConcurrentExecutions,
      layers: props.layers,
      vpc: props.vpc,
      vpcSubnets: props.vpcSubnets,
      securityGroups: props.securityGroups,
      role: props.role,
    });
  }
}
