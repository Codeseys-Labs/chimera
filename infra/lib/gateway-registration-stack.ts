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
      description:
        'ARN of Gateway Tier 2 tool target Lambda (RDS, Redshift, Athena, Glue, OpenSearch)',
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
      description:
        'ARN of Gateway Tier 3 tool target Lambda (StepFunctions, Bedrock, SageMaker, etc.)',
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
      description:
        'ARN of Gateway Discovery tool target Lambda (Config, Cost, Tags, Resource Explorer)',
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
// Lambda handler code — Phase 2: Real boto3 implementations
//
// Each handler accepts { tool_name, tool_input, tenant_id } from AgentCore
// Gateway and routes to the appropriate AWS service via boto3.
//
// tool_input must contain an "action" field plus action-specific parameters.
// Results are JSON-serialized with default=str for datetime handling.
// Max result size: 50000 chars. Structured JSON logging on every invocation.
// =============================================================================

const TIER1_HANDLER = `
import json,os,logging,time,boto3
L=logging.getLogger()
L.setLevel(os.environ.get('LOG_LEVEL','INFO'))
T=os.environ.get('TOOL_TIER','1')
MR=50000
A={'lambda':['list_functions','invoke_function','get_function'],'ec2':['describe_instances','start_instances','stop_instances'],'s3':['list_buckets','list_objects','get_object','put_object'],'cloudwatch':['get_metric_statistics','describe_alarms','put_metric_data'],'sqs':['send_message','receive_message','list_queues']}
def _ok(n,r):
 s=json.dumps(r,default=str)[:MR]
 return {'statusCode':200,'tool_name':n,'tier':T,'result':s,'cost_estimate':0.001}
def _err(n,t,e):return {'statusCode':500,'error':str(e),'tool_name':n,'tenant_id':t}
def _lam(p):
 c=boto3.client('lambda');a=p['action']
 if a=='list_functions':return c.list_functions(MaxItems=50)
 if a=='invoke_function':return c.invoke(FunctionName=p['function_name'],InvocationType=p.get('invocation_type','RequestResponse'),Payload=json.dumps(p.get('payload',{})))
 return c.get_function(FunctionName=p['function_name'])
def _ec2(p):
 c=boto3.client('ec2');a=p['action']
 if a=='describe_instances':return c.describe_instances(Filters=p.get('filters',[]),MaxResults=50)
 if a=='start_instances':return c.start_instances(InstanceIds=p['instance_ids'])
 return c.stop_instances(InstanceIds=p['instance_ids'])
def _s3(p):
 c=boto3.client('s3');a=p['action']
 if a=='list_buckets':return c.list_buckets()
 if a=='list_objects':return c.list_objects_v2(Bucket=p['bucket'],Prefix=p.get('prefix',''),MaxKeys=p.get('max_keys',50))
 if a=='get_object':
  r=c.get_object(Bucket=p['bucket'],Key=p['key']);r['Body']=r['Body'].read().decode('utf-8',errors='replace')[:MR];return r
 return c.put_object(Bucket=p['bucket'],Key=p['key'],Body=p.get('body','').encode(),ContentType=p.get('content_type','application/octet-stream'))
def _cw(p):
 c=boto3.client('cloudwatch');a=p['action']
 if a=='get_metric_statistics':return c.get_metric_statistics(Namespace=p['namespace'],MetricName=p['metric_name'],StartTime=p['start_time'],EndTime=p['end_time'],Period=p.get('period',300),Statistics=p.get('statistics',['Average']))
 if a=='describe_alarms':return c.describe_alarms(MaxRecords=50)
 return c.put_metric_data(Namespace=p['namespace'],MetricData=p['metric_data'])
def _sqs(p):
 c=boto3.client('sqs');a=p['action']
 if a=='list_queues':return c.list_queues(MaxResults=50)
 if a=='send_message':return c.send_message(QueueUrl=p['queue_url'],MessageBody=p['message_body'],MessageAttributes=p.get('message_attributes',{}))
 return c.receive_message(QueueUrl=p['queue_url'],MaxNumberOfMessages=p.get('max_messages',10),WaitTimeSeconds=p.get('wait_seconds',0))
D={'lambda':_lam,'ec2':_ec2,'s3':_s3,'cloudwatch':_cw,'sqs':_sqs}
def handler(event,context):
 n=event.get('tool_name','');ti=event.get('tool_input',{});tid=event.get('tenant_id','unknown');t0=time.time();act=ti.get('action','')
 L.info(json.dumps({'event':'tool_call','tool_name':n,'tenant_id':tid,'tier':T,'action':act}))
 if n not in A:return {'statusCode':400,'error':f'Tool {n!r} not in Tier 1. Supported: {list(A)}'}
 if act not in A[n]:return {'statusCode':400,'error':f'Action {act!r} invalid for {n}. Valid: {A[n]}'}
 try:
  r=D[n](ti);ms=int((time.time()-t0)*1000)
  L.info(json.dumps({'event':'tool_done','tool_name':n,'tenant_id':tid,'action':act,'latency_ms':ms}))
  return _ok(n,r)
 except Exception as e:
  L.error(json.dumps({'event':'tool_error','tool_name':n,'tenant_id':tid,'action':act,'error':str(e),'latency_ms':int((time.time()-t0)*1000)}))
  return _err(n,tid,e)
`;

const TIER2_HANDLER = `
import json,os,logging,time,boto3
L=logging.getLogger()
L.setLevel(os.environ.get('LOG_LEVEL','INFO'))
T=os.environ.get('TOOL_TIER','2')
MR=50000
A={'rds':['describe_db_instances','describe_db_clusters'],'redshift':['describe_clusters','execute_statement'],'athena':['start_query_execution','get_query_results'],'glue':['get_databases','get_tables','start_crawler'],'opensearch':['describe_domains','list_domain_names']}
def _ok(n,r):
 s=json.dumps(r,default=str)[:MR]
 return {'statusCode':200,'tool_name':n,'tier':T,'result':s,'cost_estimate':0.002}
def _err(n,t,e):return {'statusCode':500,'error':str(e),'tool_name':n,'tenant_id':t}
def _rds(p):
 c=boto3.client('rds');a=p['action']
 if a=='describe_db_instances':
  kw={};
  if 'db_instance_id' in p:kw['DBInstanceIdentifier']=p['db_instance_id']
  return c.describe_db_instances(**kw)
 kw={}
 if 'db_cluster_id' in p:kw['DBClusterIdentifier']=p['db_cluster_id']
 return c.describe_db_clusters(**kw)
def _red(p):
 a=p['action']
 if a=='describe_clusters':
  c=boto3.client('redshift');kw={}
  if 'cluster_id' in p:kw['ClusterIdentifier']=p['cluster_id']
  return c.describe_clusters(**kw)
 c=boto3.client('redshift-data')
 return c.execute_statement(ClusterIdentifier=p['cluster_id'],Database=p['database'],Sql=p['sql'],DbUser=p.get('db_user','admin'))
def _ath(p):
 c=boto3.client('athena');a=p['action']
 if a=='start_query_execution':
  kw={'QueryString':p['query_string'],'ResultConfiguration':{'OutputLocation':p['output_location']}}
  if 'database' in p:kw['QueryExecutionContext']={'Database':p['database']}
  return c.start_query_execution(**kw)
 return c.get_query_results(QueryExecutionId=p['query_execution_id'],MaxResults=p.get('max_results',100))
def _glu(p):
 c=boto3.client('glue');a=p['action']
 if a=='get_databases':return c.get_databases(MaxResults=50)
 if a=='get_tables':return c.get_tables(DatabaseName=p['database_name'],MaxResults=50)
 return c.start_crawler(Name=p['crawler_name'])
def _os(p):
 c=boto3.client('opensearch');a=p['action']
 if a=='list_domain_names':return c.list_domain_names()
 return c.describe_domains(DomainNames=p['domain_names'])
D={'rds':_rds,'redshift':_red,'athena':_ath,'glue':_glu,'opensearch':_os}
def handler(event,context):
 n=event.get('tool_name','');ti=event.get('tool_input',{});tid=event.get('tenant_id','unknown');t0=time.time();act=ti.get('action','')
 L.info(json.dumps({'event':'tool_call','tool_name':n,'tenant_id':tid,'tier':T,'action':act}))
 if n not in A:return {'statusCode':400,'error':f'Tool {n!r} not in Tier 2. Supported: {list(A)}'}
 if act not in A[n]:return {'statusCode':400,'error':f'Action {act!r} invalid for {n}. Valid: {A[n]}'}
 try:
  r=D[n](ti);ms=int((time.time()-t0)*1000)
  L.info(json.dumps({'event':'tool_done','tool_name':n,'tenant_id':tid,'action':act,'latency_ms':ms}))
  return _ok(n,r)
 except Exception as e:
  L.error(json.dumps({'event':'tool_error','tool_name':n,'tenant_id':tid,'action':act,'error':str(e),'latency_ms':int((time.time()-t0)*1000)}))
  return _err(n,tid,e)
`;

const TIER3_HANDLER = `
import json,os,logging,time,boto3
L=logging.getLogger()
L.setLevel(os.environ.get('LOG_LEVEL','INFO'))
T=os.environ.get('TOOL_TIER','3')
MR=50000
A={'stepfunctions':['start_execution','describe_execution','list_state_machines'],'bedrock':['invoke_model','list_foundation_models'],'sagemaker':['list_endpoints','describe_endpoint'],'rekognition':['detect_labels','detect_text'],'textract':['detect_document_text'],'transcribe':['start_transcription_job','get_transcription_job'],'codebuild':['start_build','batch_get_builds'],'codecommit':['get_repository','list_branches'],'codepipeline':['start_pipeline_execution','get_pipeline_state']}
def _ok(n,r):
 s=json.dumps(r,default=str)[:MR]
 return {'statusCode':200,'tool_name':n,'tier':T,'result':s,'cost_estimate':0.005}
def _err(n,t,e):return {'statusCode':500,'error':str(e),'tool_name':n,'tenant_id':t}
def _img(p):
 if 's3_bucket' in p:return {'S3Object':{'Bucket':p['s3_bucket'],'Name':p['s3_key']}}
 if 'bytes' in p:
  import base64;return {'Bytes':base64.b64decode(p['bytes'])}
 return {}
def _sfn(p):
 c=boto3.client('stepfunctions');a=p['action']
 if a=='list_state_machines':return c.list_state_machines(maxResults=50)
 if a=='start_execution':
  kw={'stateMachineArn':p['state_machine_arn']}
  if 'input' in p:kw['input']=json.dumps(p['input'])
  if 'name' in p:kw['name']=p['name']
  return c.start_execution(**kw)
 return c.describe_execution(executionArn=p['execution_arn'])
def _br(p):
 a=p['action']
 if a=='list_foundation_models':return boto3.client('bedrock').list_foundation_models()
 c=boto3.client('bedrock-runtime')
 r=c.invoke_model(modelId=p['model_id'],body=json.dumps(p['body']),contentType=p.get('content_type','application/json'),accept=p.get('accept','application/json'))
 r['body']=json.loads(r['body'].read());return r
def _sm(p):
 c=boto3.client('sagemaker')
 if p['action']=='list_endpoints':return c.list_endpoints(MaxResults=50)
 return c.describe_endpoint(EndpointName=p['endpoint_name'])
def _rek(p):
 c=boto3.client('rekognition');i=_img(p)
 if p['action']=='detect_labels':return c.detect_labels(Image=i,MaxLabels=p.get('max_labels',20))
 return c.detect_text(Image=i)
def _txt(p):return boto3.client('textract').detect_document_text(Document=_img(p))
def _tr(p):
 c=boto3.client('transcribe')
 if p['action']=='start_transcription_job':return c.start_transcription_job(TranscriptionJobName=p['job_name'],Media={'MediaFileUri':p['media_uri']},LanguageCode=p.get('language_code','en-US'))
 return c.get_transcription_job(TranscriptionJobName=p['job_name'])
def _cb(p):
 c=boto3.client('codebuild')
 if p['action']=='start_build':return c.start_build(projectName=p['project_name'])
 return c.batch_get_builds(ids=p['build_ids'])
def _cc(p):
 c=boto3.client('codecommit')
 if p['action']=='get_repository':return c.get_repository(repositoryName=p['repository_name'])
 return c.list_branches(repositoryName=p['repository_name'])
def _cp(p):
 c=boto3.client('codepipeline')
 if p['action']=='start_pipeline_execution':return c.start_pipeline_execution(name=p['pipeline_name'])
 return c.get_pipeline_state(name=p['pipeline_name'])
D={'stepfunctions':_sfn,'bedrock':_br,'sagemaker':_sm,'rekognition':_rek,'textract':_txt,'transcribe':_tr,'codebuild':_cb,'codecommit':_cc,'codepipeline':_cp}
def handler(event,context):
 n=event.get('tool_name','');ti=event.get('tool_input',{});tid=event.get('tenant_id','unknown');t0=time.time();act=ti.get('action','')
 L.info(json.dumps({'event':'tool_call','tool_name':n,'tenant_id':tid,'tier':T,'action':act}))
 if n not in A:return {'statusCode':400,'error':f'Tool {n!r} not in Tier 3. Supported: {list(A)}'}
 if act not in A[n]:return {'statusCode':400,'error':f'Action {act!r} invalid for {n}. Valid: {A[n]}'}
 try:
  r=D[n](ti);ms=int((time.time()-t0)*1000)
  L.info(json.dumps({'event':'tool_done','tool_name':n,'tenant_id':tid,'action':act,'latency_ms':ms}))
  return _ok(n,r)
 except Exception as e:
  L.error(json.dumps({'event':'tool_error','tool_name':n,'tenant_id':tid,'action':act,'error':str(e),'latency_ms':int((time.time()-t0)*1000)}))
  return _err(n,tid,e)
`;

const DISCOVERY_HANDLER = `
import json,os,logging,time,boto3
L=logging.getLogger()
L.setLevel(os.environ.get('LOG_LEVEL','INFO'))
T=os.environ.get('TOOL_TIER','discovery')
MR=50000
A={'config-scanner':['list_resources','get_resource_config'],'cost-analyzer':['get_cost_and_usage','get_cost_forecast'],'tag-organizer':['get_resources','tag_resources'],'resource-explorer':['search'],'stack-inventory':['list_stacks','describe_stack'],'resource-index':['search']}
def _ok(n,r):
 s=json.dumps(r,default=str)[:MR]
 return {'statusCode':200,'tool_name':n,'tier':T,'result':s,'cost_estimate':0.001}
def _err(n,t,e):return {'statusCode':500,'error':str(e),'tool_name':n,'tenant_id':t}
def _cfg(p):
 c=boto3.client('config');a=p['action']
 if a=='list_resources':return c.list_discovered_resources(resourceType=p['resource_type'],limit=p.get('limit',50))
 return c.get_resource_config_history(resourceType=p['resource_type'],resourceId=p['resource_id'],limit=p.get('limit',10))
def _ce(p):
 c=boto3.client('ce');a=p['action']
 if a=='get_cost_and_usage':return c.get_cost_and_usage(TimePeriod={'Start':p['start'],'End':p['end']},Granularity=p.get('granularity','MONTHLY'),Metrics=p.get('metrics',['UnblendedCost']),GroupBy=p.get('group_by',[{'Type':'DIMENSION','Key':'SERVICE'}]))
 return c.get_cost_forecast(TimePeriod={'Start':p['start'],'End':p['end']},Metric=p.get('metric','UNBLENDED_COST'),Granularity=p.get('granularity','MONTHLY'))
def _tag(p):
 c=boto3.client('resourcegroupstaggingapi');a=p['action']
 if a=='get_resources':
  kw={}
  if 'tag_filters' in p:kw['TagFilters']=p['tag_filters']
  if 'resource_types' in p:kw['ResourceTypeFilters']=p['resource_types']
  return c.get_resources(**kw)
 return c.tag_resources(ResourceARNList=p['resource_arns'],Tags=p['tags'])
def _rex(p):return boto3.client('resource-explorer-2').search(QueryString=p.get('query_string',''),MaxResults=p.get('max_results',50))
def _stk(p):
 c=boto3.client('cloudformation');a=p['action']
 if a=='list_stacks':return c.list_stacks(StackStatusFilter=p.get('status_filter',['CREATE_COMPLETE','UPDATE_COMPLETE']))
 return c.describe_stacks(StackName=p['stack_name'])
D={'config-scanner':_cfg,'cost-analyzer':_ce,'tag-organizer':_tag,'resource-explorer':_rex,'stack-inventory':_stk,'resource-index':_rex}
def handler(event,context):
 n=event.get('tool_name','');ti=event.get('tool_input',{});tid=event.get('tenant_id','unknown');t0=time.time();act=ti.get('action','')
 L.info(json.dumps({'event':'tool_call','tool_name':n,'tenant_id':tid,'tier':T,'action':act}))
 if n not in A:return {'statusCode':400,'error':f'Tool {n!r} not in Discovery. Supported: {list(A)}'}
 if act not in A[n]:return {'statusCode':400,'error':f'Action {act!r} invalid for {n}. Valid: {A[n]}'}
 try:
  r=D[n](ti);ms=int((time.time()-t0)*1000)
  L.info(json.dumps({'event':'tool_done','tool_name':n,'tenant_id':tid,'action':act,'latency_ms':ms}))
  return _ok(n,r)
 except Exception as e:
  L.error(json.dumps({'event':'tool_error','tool_name':n,'tenant_id':tid,'action':act,'error':str(e),'latency_ms':int((time.time()-t0)*1000)}))
  return _err(n,tid,e)
`;
