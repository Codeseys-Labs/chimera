import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { ChimeraLambda } from '../constructs/chimera-lambda';

export interface GatewayRegistrationStackProps extends cdk.StackProps {
  envName: string;
}

/**
 * Gateway Tool Registration Stack for AWS Chimera.
 *
 * Creates Lambda functions that serve as AgentCore Gateway targets for each
 * tool tier. Enables the Python agent to discover and invoke tools dynamically
 * at runtime instead of hardcoding ~90 tool imports in chimera_agent.py.
 *
 * Tier grouping (mirrors ToolRegistry.getGatewayTargetConfigs()):
 * - Tier 1 (chimera-tools-tier1): Lambda, EC2, S3, CloudWatch, SQS — all tenants
 * - Tier 2 (chimera-tools-tier2): RDS, Redshift, Athena, Glue, OpenSearch — advanced+
 * - Tier 3 (chimera-tools-tier3): StepFunctions, Bedrock, SageMaker, etc. — premium only
 * - Discovery (chimera-tools-discovery): Config, Cost, Tags, Resources — all tenants
 *
 * Each Lambda stores its ARN in SSM Parameter Store so the Python agent can
 * resolve gateway targets at startup without hardcoded ARNs.
 *
 * Architecture reference: docs/architecture/decisions/ADR-009-universal-skill-adapter.md
 */
export class GatewayRegistrationStack extends cdk.Stack {
  /** Gateway target Lambda for Tier 1 tools (Lambda, EC2, S3, CloudWatch, SQS) */
  public readonly tier1ToolsFunction: lambda.Function;

  /** Gateway target Lambda for Tier 2 tools (RDS, Redshift, Athena, Glue, OpenSearch) */
  public readonly tier2ToolsFunction: lambda.Function;

  /** Gateway target Lambda for Tier 3 tools (StepFunctions, Bedrock, SageMaker, etc.) */
  public readonly tier3ToolsFunction: lambda.Function;

  /** Gateway target Lambda for Discovery tools (Config, Cost, Tags, Resource Explorer) */
  public readonly discoveryToolsFunction: lambda.Function;

  /** SSM parameter names for runtime tool target ARN discovery */
  public readonly toolTargetParamNames: {
    tier1: string;
    tier2: string;
    tier3: string;
    discovery: string;
  };

  constructor(scope: Construct, id: string, props: GatewayRegistrationStackProps) {
    super(scope, id, props);

    const { envName } = props;
    const ssmPrefix = `/chimera/gateway/tool-targets/${envName}`;

    // IAM role: AgentCore Gateway assumes this role to invoke tool target Lambdas
    const agentCoreInvokeRole = new iam.Role(this, 'AgentCoreInvokeRole', {
      roleName: `chimera-agentcore-invoke-${envName}`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: 'Allows AgentCore Gateway to invoke Chimera tool target Lambdas',
    });

    // =========================================================================
    // Tier 1: Core Compute & Storage — available to basic, advanced, premium
    // Tools: Lambda, EC2, S3, CloudWatch, SQS
    // =========================================================================
    const tier1 = new ChimeraLambda(this, 'Tier1ToolsFunction', {
      functionName: `chimera-gateway-tools-tier1-${envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(TIER1_HANDLER),
      environment: {
        TOOL_TIER: '1',
        TOOL_TARGET: 'chimera-tools-tier1',
        ENV_NAME: envName,
      },
    });
    this.tier1ToolsFunction = tier1.fn;
    tier1.fn.grantInvoke(agentCoreInvokeRole);

    new ssm.StringParameter(this, 'Tier1ArnParam', {
      parameterName: `${ssmPrefix}/tier1`,
      stringValue: tier1.fn.functionArn,
      description: 'ARN of Gateway Tier 1 tool target Lambda (Lambda, EC2, S3, CloudWatch, SQS)',
    });

    // =========================================================================
    // Tier 2: Database & Analytics — available to advanced, premium
    // Tools: RDS, Redshift, Athena, Glue, OpenSearch
    // =========================================================================
    const tier2 = new ChimeraLambda(this, 'Tier2ToolsFunction', {
      functionName: `chimera-gateway-tools-tier2-${envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(TIER2_HANDLER),
      environment: {
        TOOL_TIER: '2',
        TOOL_TARGET: 'chimera-tools-tier2',
        ENV_NAME: envName,
      },
    });
    this.tier2ToolsFunction = tier2.fn;
    tier2.fn.grantInvoke(agentCoreInvokeRole);

    new ssm.StringParameter(this, 'Tier2ArnParam', {
      parameterName: `${ssmPrefix}/tier2`,
      stringValue: tier2.fn.functionArn,
      description: 'ARN of Gateway Tier 2 tool target Lambda (RDS, Redshift, Athena, Glue, OpenSearch)',
    });

    // =========================================================================
    // Tier 3: Orchestration & ML — available to premium only
    // Tools: StepFunctions, Bedrock, SageMaker, Rekognition, Textract, Transcribe,
    //        CodeBuild, CodeCommit, CodePipeline
    // =========================================================================
    const tier3 = new ChimeraLambda(this, 'Tier3ToolsFunction', {
      functionName: `chimera-gateway-tools-tier3-${envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(TIER3_HANDLER),
      environment: {
        TOOL_TIER: '3',
        TOOL_TARGET: 'chimera-tools-tier3',
        ENV_NAME: envName,
      },
    });
    this.tier3ToolsFunction = tier3.fn;
    tier3.fn.grantInvoke(agentCoreInvokeRole);

    new ssm.StringParameter(this, 'Tier3ArnParam', {
      parameterName: `${ssmPrefix}/tier3`,
      stringValue: tier3.fn.functionArn,
      description: 'ARN of Gateway Tier 3 tool target Lambda (StepFunctions, Bedrock, SageMaker, etc.)',
    });

    // =========================================================================
    // Discovery Tools — available to all tiers
    // Tools: Config Scanner, Cost Analyzer, Tag Organizer, Resource Explorer,
    //        Stack Inventory, Resource Index
    // =========================================================================
    const discovery = new ChimeraLambda(this, 'DiscoveryToolsFunction', {
      functionName: `chimera-gateway-tools-discovery-${envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(DISCOVERY_HANDLER),
      environment: {
        TOOL_TIER: 'discovery',
        TOOL_TARGET: 'chimera-tools-discovery',
        ENV_NAME: envName,
      },
    });
    this.discoveryToolsFunction = discovery.fn;
    discovery.fn.grantInvoke(agentCoreInvokeRole);

    new ssm.StringParameter(this, 'DiscoveryArnParam', {
      parameterName: `${ssmPrefix}/discovery`,
      stringValue: discovery.fn.functionArn,
      description: 'ARN of Gateway Discovery tool target Lambda (Config, Cost, Tags, Resource Explorer)',
    });

    this.toolTargetParamNames = {
      tier1: `${ssmPrefix}/tier1`,
      tier2: `${ssmPrefix}/tier2`,
      tier3: `${ssmPrefix}/tier3`,
      discovery: `${ssmPrefix}/discovery`,
    };

    // Stack outputs — consumed by Python agent at startup for tool discovery
    new cdk.CfnOutput(this, 'Tier1ToolsArn', {
      value: this.tier1ToolsFunction.functionArn,
      description: 'Gateway Tier 1 tool target Lambda ARN',
      exportName: `chimera-gateway-tier1-tools-arn-${envName}`,
    });
    new cdk.CfnOutput(this, 'Tier2ToolsArn', {
      value: this.tier2ToolsFunction.functionArn,
      description: 'Gateway Tier 2 tool target Lambda ARN',
      exportName: `chimera-gateway-tier2-tools-arn-${envName}`,
    });
    new cdk.CfnOutput(this, 'Tier3ToolsArn', {
      value: this.tier3ToolsFunction.functionArn,
      description: 'Gateway Tier 3 tool target Lambda ARN',
      exportName: `chimera-gateway-tier3-tools-arn-${envName}`,
    });
    new cdk.CfnOutput(this, 'DiscoveryToolsArn', {
      value: this.discoveryToolsFunction.functionArn,
      description: 'Gateway Discovery tool target Lambda ARN',
      exportName: `chimera-gateway-discovery-tools-arn-${envName}`,
    });
  }
}

// =============================================================================
// Lambda handler code — Phase 1 stubs
//
// Each handler accepts { tool_name, tool_input, tenant_id } from AgentCore
// Gateway and routes to the appropriate AWS service operation.
//
// Phase 1: Stubs that validate the tool name and log the invocation.
// Phase 2: Wire in TypeScript tool packages via Lambda Layers.
// =============================================================================

const TIER1_HANDLER = `
import json
import os
import logging

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

SUPPORTED_TOOLS = ['lambda', 'ec2', 's3', 'cloudwatch', 'sqs']


def handler(event, context):
    """
    Gateway Tier 1 Tool Target — Core Compute and Storage.

    Handles tool calls for: Lambda, EC2, S3, CloudWatch, SQS.
    Accepts: { tool_name: str, tool_input: dict, tenant_id: str }
    Returns: { result: str, tool_name: str, tier: str }
    """
    tool_name = event.get('tool_name', '')
    tool_input = event.get('tool_input', {})
    tenant_id = event.get('tenant_id', 'unknown')

    logger.info(json.dumps({
        'event': 'tool_call',
        'tool_name': tool_name,
        'tenant_id': tenant_id,
        'tier': os.environ.get('TOOL_TIER'),
    }))

    if tool_name not in SUPPORTED_TOOLS:
        return {
            'statusCode': 400,
            'error': 'Tool ' + repr(tool_name) + ' not available in Tier 1. Supported: ' + str(SUPPORTED_TOOLS),
        }

    # Phase 1 stub: returns structured placeholder until TypeScript tool packages are deployed
    return {
        'statusCode': 200,
        'tool_name': tool_name,
        'tier': os.environ.get('TOOL_TIER'),
        'result': '[Tier 1 stub] ' + tool_name + ' called',
        'input_echo': json.dumps(tool_input)[:500],
    }
`;

const TIER2_HANDLER = `
import json
import os
import logging

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

SUPPORTED_TOOLS = ['rds', 'redshift', 'athena', 'glue', 'opensearch']


def handler(event, context):
    """
    Gateway Tier 2 Tool Target — Database and Analytics.

    Handles tool calls for: RDS, Redshift, Athena, Glue, OpenSearch.
    Requires advanced or premium subscription tier.
    Accepts: { tool_name: str, tool_input: dict, tenant_id: str }
    Returns: { result: str, tool_name: str, tier: str }
    """
    tool_name = event.get('tool_name', '')
    tool_input = event.get('tool_input', {})
    tenant_id = event.get('tenant_id', 'unknown')

    logger.info(json.dumps({
        'event': 'tool_call',
        'tool_name': tool_name,
        'tenant_id': tenant_id,
        'tier': os.environ.get('TOOL_TIER'),
    }))

    if tool_name not in SUPPORTED_TOOLS:
        return {
            'statusCode': 400,
            'error': 'Tool ' + repr(tool_name) + ' not available in Tier 2. Supported: ' + str(SUPPORTED_TOOLS),
        }

    # Phase 1 stub: returns structured placeholder until TypeScript tool packages are deployed
    return {
        'statusCode': 200,
        'tool_name': tool_name,
        'tier': os.environ.get('TOOL_TIER'),
        'result': '[Tier 2 stub] ' + tool_name + ' called',
        'input_echo': json.dumps(tool_input)[:500],
    }
`;

const TIER3_HANDLER = `
import json
import os
import logging

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

SUPPORTED_TOOLS = [
    'stepfunctions', 'bedrock', 'sagemaker', 'rekognition',
    'textract', 'transcribe', 'codebuild', 'codecommit', 'codepipeline',
]


def handler(event, context):
    """
    Gateway Tier 3 Tool Target — Orchestration and ML.

    Handles tool calls for: StepFunctions, Bedrock, SageMaker, Rekognition,
    Textract, Transcribe, CodeBuild, CodeCommit, CodePipeline.
    Requires premium subscription tier.
    Accepts: { tool_name: str, tool_input: dict, tenant_id: str }
    Returns: { result: str, tool_name: str, tier: str }
    """
    tool_name = event.get('tool_name', '')
    tool_input = event.get('tool_input', {})
    tenant_id = event.get('tenant_id', 'unknown')

    logger.info(json.dumps({
        'event': 'tool_call',
        'tool_name': tool_name,
        'tenant_id': tenant_id,
        'tier': os.environ.get('TOOL_TIER'),
    }))

    if tool_name not in SUPPORTED_TOOLS:
        return {
            'statusCode': 400,
            'error': 'Tool ' + repr(tool_name) + ' not available in Tier 3. Supported: ' + str(SUPPORTED_TOOLS),
        }

    # Phase 1 stub: returns structured placeholder until TypeScript tool packages are deployed
    return {
        'statusCode': 200,
        'tool_name': tool_name,
        'tier': os.environ.get('TOOL_TIER'),
        'result': '[Tier 3 stub] ' + tool_name + ' called',
        'input_echo': json.dumps(tool_input)[:500],
    }
`;

const DISCOVERY_HANDLER = `
import json
import os
import logging

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

SUPPORTED_TOOLS = [
    'config-scanner', 'cost-analyzer', 'tag-organizer',
    'resource-explorer', 'stack-inventory', 'resource-index',
]


def handler(event, context):
    """
    Gateway Discovery Tool Target — available to all subscription tiers.

    Handles tool calls for: Config Scanner, Cost Analyzer, Tag Organizer,
    Resource Explorer, Stack Inventory, Resource Index.
    Accepts: { tool_name: str, tool_input: dict, tenant_id: str }
    Returns: { result: str, tool_name: str, tier: str }
    """
    tool_name = event.get('tool_name', '')
    tool_input = event.get('tool_input', {})
    tenant_id = event.get('tenant_id', 'unknown')

    logger.info(json.dumps({
        'event': 'tool_call',
        'tool_name': tool_name,
        'tenant_id': tenant_id,
        'tier': os.environ.get('TOOL_TIER'),
    }))

    if tool_name not in SUPPORTED_TOOLS:
        return {
            'statusCode': 400,
            'error': 'Tool ' + repr(tool_name) + ' not available in Discovery target. Supported: ' + str(SUPPORTED_TOOLS),
        }

    # Phase 1 stub: returns structured placeholder until TypeScript tool packages are deployed
    return {
        'statusCode': 200,
        'tool_name': tool_name,
        'tier': os.environ.get('TOOL_TIER'),
        'result': '[Discovery stub] ' + tool_name + ' called',
        'input_echo': json.dumps(tool_input)[:500],
    }
`;
