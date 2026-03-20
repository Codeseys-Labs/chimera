/**
 * CDK Code Generation
 *
 * Generates AWS CDK TypeScript code from natural language requirements.
 * Supports template-based generation for common patterns and LLM-assisted
 * generation for novel infrastructure requests.
 */

import type { IaCChangeType } from '../evolution/types';

/**
 * CDK generation request
 */
export interface CDKGenerationRequest {
  tenantId: string;
  changeType: IaCChangeType;
  description: string;
  parameters: Record<string, unknown>;
  requirementText?: string; // Natural language requirements for LLM generation
}

/**
 * CDK generation result
 */
export interface CDKGenerationResult {
  cdkCode: string;
  language: 'typescript';
  estimatedCostDelta: number;
  generationMethod: 'template' | 'llm-assisted' | 'l3-construct';
  resourcesAffected: string[];
  warnings?: string[];
}

/**
 * L3 construct composition request
 */
export interface L3ConstructRequest {
  pattern: string;
  sources?: string[];
  processors?: string[];
  destination?: string;
  metadata: Record<string, unknown>;
}

/**
 * CDK code generator
 */
export class CDKGenerator {
  /**
   * Generate CDK code from a change request
   */
  async generateCDKCode(
    request: CDKGenerationRequest
  ): Promise<CDKGenerationResult> {
    // Template-based generation for known change types
    if (this.isTemplateBased(request.changeType)) {
      return this.generateFromTemplate(request);
    }

    // L3 construct composition for patterns
    if (request.parameters.pattern) {
      return this.generateFromL3Constructs(request);
    }

    // LLM-assisted generation for novel requirements
    if (request.requirementText) {
      return this.generateFromLLM(request);
    }

    throw new Error('Unable to determine generation method for request');
  }

  /**
   * Template-based generation for common operations
   */
  private generateFromTemplate(
    request: CDKGenerationRequest
  ): CDKGenerationResult {
    const templates: Record<IaCChangeType, (p: any) => string> = {
      scale_horizontal: (p) => `
// Scale ECS service horizontally
import * as ecs from 'aws-cdk-lib/aws-ecs';

const service = stack.node.findChild('EcsService') as ecs.FargateService;
service.desiredCount = ${p.desiredCount || 2};

// Auto-scaling configuration
service.scaleOnCpuUtilization('CpuScaling', {
  targetUtilizationPercent: 70,
  scaleInCooldown: cdk.Duration.seconds(60),
  scaleOutCooldown: cdk.Duration.seconds(60),
});
`,

      scale_vertical: (p) => `
// Update instance type for vertical scaling
import * as ecs from 'aws-cdk-lib/aws-ecs';

const taskDef = stack.node.findChild('TaskDefinition') as ecs.TaskDefinition;
taskDef.cpu = ${p.cpu || 512};
taskDef.memoryMiB = ${p.memory || 1024};
`,

      update_env_var: (p) => `
// Update environment variable
import * as ecs from 'aws-cdk-lib/aws-ecs';

const taskDef = stack.node.findChild('TaskDefinition') as ecs.TaskDefinition;
const container = taskDef.defaultContainer;
container?.addEnvironment('${p.key}', '${p.value}');
`,

      rotate_secret: (p) => `
// Rotate secret with automatic rotation enabled
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

const secret = new secretsmanager.Secret(stack, 'RotatedSecret', {
  secretName: '${p.secretName}',
  generateSecretString: {
    secretStringTemplate: JSON.stringify({ username: '${p.username}' }),
    generateStringKey: 'password',
    excludePunctuation: true,
    passwordLength: 32,
  },
});

// Enable automatic rotation (30 days)
secret.addRotationSchedule('RotationSchedule', {
  automaticallyAfter: cdk.Duration.days(30),
});
`,

      add_tool: (p) => `
// Add new tool infrastructure
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';

// Tool-specific DynamoDB table
const toolTable = new dynamodb.Table(stack, '${p.toolName}Table', {
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  pointInTimeRecovery: true,
});

// Tool Lambda function
const toolFunction = new lambda.Function(stack, '${p.toolName}Function', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('lambda/${p.toolName}'),
  environment: {
    TABLE_NAME: toolTable.tableName,
    TENANT_ID: '${request.tenantId}',
  },
  timeout: cdk.Duration.seconds(30),
  memorySize: 512,
});

toolTable.grantReadWriteData(toolFunction);

// Tool artifact bucket (if needed)
const toolBucket = new s3.Bucket(stack, '${p.toolName}Bucket', {
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  lifecycleRules: [
    {
      expiration: cdk.Duration.days(90),
    },
  ],
});

toolBucket.grantReadWrite(toolFunction);
`,

      update_config: (p) => `
// Update SSM Parameter Store configuration
import * as ssm from 'aws-cdk-lib/aws-ssm';

const config = new ssm.StringParameter(stack, 'Config', {
  parameterName: '/chimera/${request.tenantId}/config',
  stringValue: JSON.stringify(${JSON.stringify(p.config)}),
  tier: ssm.ParameterTier.STANDARD,
  description: 'Tenant configuration (agent-managed)',
});
`,
    };

    const template = templates[request.changeType];
    if (!template) {
      throw new Error(`No template found for change type: ${request.changeType}`);
    }

    const cdkCode = template(request.parameters);
    const costDelta = this.estimateCostFromTemplate(request.changeType, request.parameters);

    return {
      cdkCode,
      language: 'typescript',
      estimatedCostDelta: costDelta,
      generationMethod: 'template',
      resourcesAffected: this.extractResourceTypes(cdkCode),
    };
  }

  /**
   * Generate CDK code from L3 constructs
   */
  private generateFromL3Constructs(
    request: CDKGenerationRequest
  ): CDKGenerationResult {
    const pattern = request.parameters.pattern as string;

    // Example: Data lake ingestion pipeline
    if (pattern === 'data-lake-ingestion') {
      const cdkCode = `
// Data Lake Ingestion Pipeline (L3 Construct)
import { DataLakeIngestionPipeline } from '@chimera/constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

const sourceBucket = s3.Bucket.fromBucketName(
  stack,
  'SourceBucket',
  '${request.parameters.sources?.[0] || 'source-bucket'}'
);

const pipeline = new DataLakeIngestionPipeline(stack, 'DataPipeline', {
  sources: [sourceBucket],
  processors: ${JSON.stringify(request.parameters.processors || [])},
  destination: '${request.parameters.destination || 'data-lake-bucket'}',
  tenantId: '${request.tenantId}',
  encryption: true,
  monitoring: true,
});
`;

      return {
        cdkCode,
        language: 'typescript',
        estimatedCostDelta: 150, // Data pipeline baseline
        generationMethod: 'l3-construct',
        resourcesAffected: [
          'AWS::Glue::Crawler',
          'AWS::Glue::Database',
          'AWS::Lambda::Function',
          'AWS::S3::Bucket',
        ],
      };
    }

    throw new Error(`Unknown L3 construct pattern: ${pattern}`);
  }

  /**
   * LLM-assisted CDK generation for novel requirements
   */
  private async generateFromLLM(
    request: CDKGenerationRequest
  ): Promise<CDKGenerationResult> {
    // Placeholder: In production, would call Bedrock with CDK schema context
    // and generate TypeScript code from natural language requirements

    const prompt = `Generate AWS CDK TypeScript code for the following requirement:
${request.requirementText}

Constraints:
- Tenant ID: ${request.tenantId}
- Change type: ${request.changeType}
- Must follow AWS Well-Architected Framework
- Include encryption, logging, and tagging
- Use least-privilege IAM policies

Return only the CDK code without explanations.`;

    // Mock LLM response for now
    const cdkCode = `
// LLM-generated CDK code
// Requirement: ${request.requirementText}
import * as cdk from 'aws-cdk-lib';

// Placeholder: Production would generate actual CDK code here
console.log('LLM-generated infrastructure for tenant ${request.tenantId}');
`;

    return {
      cdkCode,
      language: 'typescript',
      estimatedCostDelta: 0, // Would analyze generated code for cost estimate
      generationMethod: 'llm-assisted',
      resourcesAffected: [],
      warnings: [
        'LLM-generated code requires validation',
        'Cost estimate unavailable until CDK synth',
      ],
    };
  }

  /**
   * Check if change type uses template-based generation
   */
  private isTemplateBased(changeType: IaCChangeType): boolean {
    const templateTypes: IaCChangeType[] = [
      'scale_horizontal',
      'scale_vertical',
      'update_env_var',
      'rotate_secret',
      'add_tool',
      'update_config',
    ];
    return templateTypes.includes(changeType);
  }

  /**
   * Estimate cost delta from template parameters
   */
  private estimateCostFromTemplate(
    changeType: IaCChangeType,
    parameters: Record<string, unknown>
  ): number {
    const baseCosts: Record<IaCChangeType, number> = {
      scale_horizontal: 50,  // $50/month per additional ECS task
      scale_vertical: 30,    // $30/month for instance size upgrade
      update_env_var: 0,
      rotate_secret: 0,
      add_tool: 10,          // $10/month for tool infrastructure baseline
      update_config: 0,
    };

    let cost = baseCosts[changeType] || 0;

    // Adjust based on parameters
    if (changeType === 'scale_horizontal' && parameters.desiredCount) {
      const additionalTasks = (parameters.desiredCount as number) - 1;
      cost = additionalTasks * 50;
    }

    return cost;
  }

  /**
   * Extract CloudFormation resource types from CDK code
   */
  private extractResourceTypes(cdkCode: string): string[] {
    const resources: string[] = [];
    const resourcePatterns = [
      /new\s+(?:ecs|lambda|dynamodb|s3|secretsmanager|ssm)\.(\w+)/g,
    ];

    for (const pattern of resourcePatterns) {
      const matches = Array.from(cdkCode.matchAll(pattern));
      for (const match of matches) {
        const resourceType = match[1];
        // Map CDK construct to CloudFormation type
        if (resourceType === 'FargateService') resources.push('AWS::ECS::Service');
        if (resourceType === 'TaskDefinition') resources.push('AWS::ECS::TaskDefinition');
        if (resourceType === 'Function') resources.push('AWS::Lambda::Function');
        if (resourceType === 'Table') resources.push('AWS::DynamoDB::Table');
        if (resourceType === 'Bucket') resources.push('AWS::S3::Bucket');
        if (resourceType === 'Secret') resources.push('AWS::SecretsManager::Secret');
        if (resourceType === 'StringParameter') resources.push('AWS::SSM::Parameter');
      }
    }

    return Array.from(new Set(resources));
  }

  /**
   * Validate generated CDK code
   */
  async validateCDKCode(cdkCode: string): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for forbidden operations
    const forbiddenPatterns = [
      { pattern: /new\s+iam\.Role/, message: 'Direct IAM role creation not allowed' },
      { pattern: /new\s+iam\.Policy/, message: 'Direct IAM policy creation not allowed' },
      { pattern: /new\s+ec2\.Vpc/, message: 'VPC creation not allowed' },
      { pattern: /new\s+ec2\.SecurityGroup/, message: 'Security group creation not allowed' },
      { pattern: /\.grantFullAccess\(/, message: 'Full access grants not allowed' },
    ];

    for (const { pattern, message } of forbiddenPatterns) {
      if (pattern.test(cdkCode)) {
        errors.push(message);
      }
    }

    // Check for best practices
    if (!cdkCode.includes('encryption')) {
      warnings.push('No explicit encryption configuration found');
    }

    if (!cdkCode.includes('Tags.of')) {
      warnings.push('Resource tagging not implemented');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

/**
 * Create a CDK generator instance
 */
export function createCDKGenerator(): CDKGenerator {
  return new CDKGenerator();
}
