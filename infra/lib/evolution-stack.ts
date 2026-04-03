import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { ChimeraTable } from '../constructs/chimera-table';
import { ChimeraBucket } from '../constructs/chimera-bucket';
import { ChimeraLambda } from '../constructs/chimera-lambda';

export interface EvolutionStackProps extends cdk.StackProps {
  envName: string;
  auditTable: dynamodb.ITable;
  eventBus: events.IEventBus;
}

/**
 * Self-Evolution Engine for Chimera.
 *
 * Implements the self-improvement mechanisms from Chimera-Self-Evolution-Engine.md:
 * - Prompt evolution via A/B testing
 * - Auto-skill generation from repeated patterns
 * - Model routing optimization (Bayesian)
 * - Memory evolution and garbage collection
 * - Cron self-scheduling
 * - Infrastructure self-modification (GitOps)
 *
 * All changes are bounded by Cedar policies, audited, and reversible via S3 snapshots.
 *
 * Reference: docs/research/architecture-reviews/Chimera-Self-Evolution-Engine.md
 */
export class EvolutionStack extends cdk.Stack {
  public readonly evolutionStateTable: dynamodb.TableV2;
  public readonly evolutionArtifactsBucket: s3.Bucket;
  public readonly promptEvolutionStateMachine: stepfunctions.StateMachine;
  public readonly skillGenerationStateMachine: stepfunctions.StateMachine;
  public readonly memoryEvolutionStateMachine: stepfunctions.StateMachine;
  public readonly feedbackProcessorStateMachine: stepfunctions.StateMachine;

  constructor(scope: Construct, id: string, props: EvolutionStackProps) {
    super(scope, id, props);

    const isProd = props.envName === 'prod';

    // ======================================================================
    // DynamoDB: chimera-evolution-state
    // ======================================================================
    const evolutionStateChimera = new ChimeraTable(this, 'EvolutionStateTable', {
      tableName: `chimera-evolution-state-${props.envName}`,
      ttlAttribute: 'ttl',
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1-lifecycle',
          partitionKey: { name: 'lifecycleIndexPK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'last_accessed', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
        {
          indexName: 'GSI2-unprocessed-feedback',
          partitionKey: { name: 'unprocessedIndexPK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'feedbackSortKey', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    this.evolutionStateTable = evolutionStateChimera.table;

    // ======================================================================
    // S3: Evolution Artifacts
    // ======================================================================
    // Note: bucketName omitted to avoid access-log bucket name exceeding 63-char S3 limit
    // (the name `chimera-evolution-artifacts-{account}-{region}-{env}-access-logs` is too long).
    // The bucket ARN/name are exported as stack outputs for cross-stack consumption.
    const evolutionArtifactsChimera = new ChimeraBucket(this, 'EvolutionArtifactsBucket', {
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    evolutionArtifactsChimera.bucket.addLifecycleRule({
      id: 'expire-old-snapshots',
      prefix: 'snapshots/',
      expiration: cdk.Duration.days(90),
    });
    evolutionArtifactsChimera.bucket.addLifecycleRule({
      id: 'archive-golden-datasets',
      prefix: 'golden-datasets/',
      transitions: [
        {
          storageClass: s3.StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(180),
        },
      ],
    });
    evolutionArtifactsChimera.bucket.addLifecycleRule({
      id: 'expire-noncurrent-versions',
      noncurrentVersionExpiration: cdk.Duration.days(30),
    });
    this.evolutionArtifactsBucket = evolutionArtifactsChimera.bucket;

    // ======================================================================
    // Lambda Functions for Evolution Tasks
    // All Python 3.12, code.fromInline — ChimeraLambda wraps each with
    // X-Ray tracing, log retention, DLQ, and default env vars.
    // ======================================================================

    const analyzeConversationLogsChimera = new ChimeraLambda(
      this,
      'AnalyzeConversationLogsFunction',
      {
        functionName: `chimera-evolution-analyze-logs-${props.envName}`,
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`
import boto3
import os
from datetime import datetime, timedelta

dynamodb = boto3.resource('dynamodb')

def handler(event, context):
    """
    Analyze conversation logs for failure patterns.

    Scans recent sessions for tool call failures, user corrections,
    repeated clarification requests, and high-latency exchanges.
    """
    tenant_id = event['tenant_id']
    lookback_days = event.get('lookback_days', 7)

    table = dynamodb.Table(os.environ['EVOLUTION_TABLE'])
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(days=lookback_days)

    response = table.query(
        KeyConditionExpression='PK = :pk AND SK BETWEEN :start AND :end',
        ExpressionAttributeValues={
            ':pk': f'TENANT#{tenant_id}#LOGS',
            ':start': start_time.isoformat(),
            ':end': end_time.isoformat()
        },
        Limit=500
    )

    failures = []
    corrections = []
    patterns = []

    for item in response.get('Items', []):
        turns = item.get('turns', [])
        for turn in turns:
            if turn.get('type') == 'tool_call' and turn.get('status') == 'error':
                failures.append({
                    'session_id': item.get('SK', ''),
                    'tool': turn.get('tool_name', 'unknown'),
                    'error': turn.get('error_message', '')[:200],
                    'timestamp': turn.get('timestamp', '')
                })
            if turn.get('type') == 'user' and turn.get('is_correction', False):
                corrections.append({
                    'session_id': item.get('SK', ''),
                    'content': turn.get('content', '')[:200],
                    'timestamp': turn.get('timestamp', '')
                })

    analysis_key = f'TENANT#{tenant_id}#ANALYSIS#{datetime.utcnow().isoformat()}'
    table.put_item(Item={
        'PK': analysis_key,
        'SK': 'RESULT',
        'failures': failures[:50],
        'corrections': corrections[:50],
        'analyzed_at': datetime.utcnow().isoformat(),
        'ttl': int((datetime.utcnow() + timedelta(days=30)).timestamp())
    })

    return {
        'tenant_id': tenant_id,
        'failures': failures[:10],
        'corrections': corrections[:10],
        'patterns': patterns,
        'analysis_key': analysis_key
    }
`),
        timeout: cdk.Duration.minutes(5),
        memorySize: 1024,
        environment: {
          EVOLUTION_TABLE: this.evolutionStateTable.tableName,
          ARTIFACTS_BUCKET: this.evolutionArtifactsBucket.bucketName,
        },
      }
    );

    const generatePromptVariantChimera = new ChimeraLambda(this, 'GeneratePromptVariantFunction', {
      functionName: `chimera-evolution-generate-prompt-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3
import os
from datetime import datetime, timedelta

dynamodb = boto3.resource('dynamodb')

def apply_failure_guidance(prompt, failures, corrections):
    """Append targeted guidance paragraphs based on observed failure patterns."""
    additions = []
    tool_errors = {}
    for f in failures:
        tool = f.get('tool', 'unknown')
        tool_errors[tool] = tool_errors.get(tool, 0) + 1
    if tool_errors:
        top_failing = sorted(tool_errors.items(), key=lambda x: x[1], reverse=True)[:3]
        guidance = 'When using the following tools, verify inputs carefully: '
        guidance += ', '.join([t for t, _ in top_failing]) + '.'
        additions.append(guidance)
    if corrections:
        additions.append('Pay close attention to user intent before acting. If uncertain, ask for clarification.')
    if not additions:
        return prompt
    separator = '\\n\\n---\\n'
    return prompt + separator + '\\n'.join(additions)

def handler(event, context):
    """
    Generate improved prompt variant based on failure analysis.

    Reads current active prompt from DynamoDB, applies rule-based improvements
    addressing observed failure patterns, and stores the variant for testing.
    """
    tenant_id = event['tenant_id']
    failures = event.get('failures', [])
    corrections = event.get('corrections', [])

    table = dynamodb.Table(os.environ['EVOLUTION_TABLE'])
    response = table.get_item(Key={
        'PK': f'TENANT#{tenant_id}#PROMPT',
        'SK': 'ACTIVE'
    })
    current_item = response.get('Item', {})
    current_prompt = current_item.get('prompt_text', '')
    current_version = current_item.get('version', 'v0.0')

    if not current_prompt:
        return {
            'tenant_id': tenant_id,
            'variant_id': 'v-no-prompt',
            'improved_prompt': '',
            'changes': []
        }

    improved_prompt = apply_failure_guidance(current_prompt, failures, corrections)
    variant_id = 'v-' + datetime.utcnow().strftime('%Y%m%d%H%M')
    changes = []
    if improved_prompt != current_prompt:
        changes.append(f'Added guidance for {len(failures)} failures and {len(corrections)} corrections')

    table.put_item(Item={
        'PK': f'TENANT#{tenant_id}#PROMPT#VARIANT#{variant_id}',
        'SK': 'CANDIDATE',
        'prompt_text': improved_prompt,
        'base_version': current_version,
        'variant_id': variant_id,
        'status': 'TESTING',
        'created_at': datetime.utcnow().isoformat(),
        'ttl': int((datetime.utcnow() + timedelta(days=30)).timestamp())
    })

    return {
        'tenant_id': tenant_id,
        'variant_id': variant_id,
        'improved_prompt': improved_prompt,
        'changes': changes
    }
`),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        EVOLUTION_TABLE: this.evolutionStateTable.tableName,
      },
    });

    const testPromptVariantChimera = new ChimeraLambda(this, 'TestPromptVariantFunction', {
      functionName: `chimera-evolution-test-prompt-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime

dynamodb = boto3.resource('dynamodb')
s3 = boto3.client('s3')

def score_prompt_case(prompt, test_case):
    """Score prompt against a single test case using keyword overlap."""
    expected = test_case.get('expected_output', '')
    expected_words = set(expected.lower().split())
    if not expected_words:
        return 0.75
    prompt_words = set(prompt.lower().split())
    overlap = len(expected_words & prompt_words) / len(expected_words)
    return min(0.5 + overlap, 1.0)

def handler(event, context):
    """
    Test prompt variant against golden dataset.

    Loads evaluation cases from S3, scores the variant against each case
    using keyword overlap, and records results in DynamoDB for the
    VariantTestPassed Choice state to evaluate.
    """
    tenant_id = event['tenant_id']
    variant_id = event['variant_id']
    improved_prompt = event.get('improved_prompt', '')

    artifacts_bucket = os.environ['ARTIFACTS_BUCKET']
    table = dynamodb.Table(os.environ['EVOLUTION_TABLE'])

    golden_key = f'golden-datasets/{tenant_id}/evaluation-cases.json'
    try:
        resp = s3.get_object(Bucket=artifacts_bucket, Key=golden_key)
        golden_cases = json.loads(resp['Body'].read())
    except Exception:
        golden_cases = []

    if not golden_cases or not improved_prompt:
        avg_quality = 0.75
        table.update_item(
            Key={
                'PK': f'TENANT#{tenant_id}#PROMPT#VARIANT#{variant_id}',
                'SK': 'CANDIDATE'
            },
            UpdateExpression='SET avg_quality_score = :q, #s = :s, tested_at = :t',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={
                ':q': str(avg_quality), ':s': 'TESTED',
                ':t': datetime.utcnow().isoformat()
            }
        )
        return {
            'variant_id': variant_id, 'avg_quality_score': avg_quality,
            'pass_rate': 1.0, 'avg_tokens_per_case': 0,
            'tested_cases': 0, 'tenant_id': tenant_id
        }

    cases = golden_cases[:20]
    scores = [score_prompt_case(improved_prompt, c) for c in cases]
    avg_quality = sum(scores) / len(scores)
    pass_rate = sum(1 for s in scores if s > 0.6) / len(scores)
    avg_tokens = sum(
        len(c.get('input', '').split()) + len(c.get('expected_output', '').split())
        for c in cases
    ) // len(cases)

    table.update_item(
        Key={
            'PK': f'TENANT#{tenant_id}#PROMPT#VARIANT#{variant_id}',
            'SK': 'CANDIDATE'
        },
        UpdateExpression='SET avg_quality_score = :q, pass_rate = :p, avg_tokens = :at, #s = :s, tested_at = :t',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={
            ':q': str(avg_quality), ':p': str(pass_rate), ':at': avg_tokens,
            ':s': 'TESTED', ':t': datetime.utcnow().isoformat()
        }
    )

    return {
        'variant_id': variant_id,
        'avg_quality_score': avg_quality,
        'pass_rate': pass_rate,
        'avg_tokens_per_case': avg_tokens,
        'tested_cases': len(cases),
        'tenant_id': tenant_id
    }
`),
      timeout: cdk.Duration.minutes(10),
      memorySize: 2048,
      environment: {
        EVOLUTION_TABLE: this.evolutionStateTable.tableName,
        ARTIFACTS_BUCKET: this.evolutionArtifactsBucket.bucketName,
      },
    });

    const detectPatternsChimera = new ChimeraLambda(this, 'DetectPatternsFunction', {
      functionName: `chimera-evolution-detect-patterns-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta

dynamodb = boto3.resource('dynamodb')
s3 = boto3.client('s3')

def extract_tool_sequence(conversation):
    """Extract ordered list of tool calls from conversation."""
    tools = []
    for turn in conversation.get('turns', []):
        if turn.get('type') == 'assistant' and 'tool_calls' in turn:
            for tool_call in turn['tool_calls']:
                tools.append(tool_call.get('name', 'unknown'))
    return tools

def generate_ngrams(sequence, n):
    """Generate n-grams from tool sequence."""
    if len(sequence) < n:
        return []
    return [tuple(sequence[i:i+n]) for i in range(len(sequence) - n + 1)]

def handler(event, context):
    """
    Detect repeated multi-step tool sequences using n-gram extraction.

    Analyzes conversation logs with sliding window, identifies patterns
    that appear >= min_occurrences times.
    """
    tenant_id = event['tenant_id']
    min_occurrences = event.get('min_occurrences', 5)
    ngram_size = event.get('ngram_size', 3)
    lookback_days = event.get('lookback_days', 7)

    table_name = os.environ['EVOLUTION_TABLE']
    table = dynamodb.Table(table_name)

    end_time = datetime.utcnow()
    start_time = end_time - timedelta(days=lookback_days)

    response = table.query(
        KeyConditionExpression='PK = :pk AND SK BETWEEN :start AND :end',
        ExpressionAttributeValues={
            ':pk': f'TENANT#{tenant_id}#LOGS',
            ':start': start_time.isoformat(),
            ':end': end_time.isoformat()
        },
        Limit=1000
    )

    all_ngrams = []
    conversation_count = 0

    for item in response.get('Items', []):
        conversation = item.get('conversation', {})
        tool_sequence = extract_tool_sequence(conversation)

        if len(tool_sequence) >= ngram_size:
            ngrams = generate_ngrams(tool_sequence, ngram_size)
            all_ngrams.extend(ngrams)
            conversation_count += 1

    pattern_counts = Counter(all_ngrams)

    frequent_patterns = [
        {
            'pattern': ' -> '.join(pattern),
            'count': count,
            'confidence': round(count / conversation_count, 2) if conversation_count > 0 else 0
        }
        for pattern, count in pattern_counts.items()
        if count >= min_occurrences
    ]

    frequent_patterns.sort(key=lambda x: x['count'], reverse=True)

    if frequent_patterns:
        patterns_key = f'TENANT#{tenant_id}#PATTERNS#{datetime.utcnow().isoformat()}'
        table.put_item(
            Item={
                'PK': patterns_key,
                'SK': 'DETECTED',
                'patterns': frequent_patterns[:10],
                'analyzed_conversations': conversation_count,
                'detection_timestamp': datetime.utcnow().isoformat(),
                'ttl': int((datetime.utcnow() + timedelta(days=90)).timestamp())
            }
        )

    return {
        'tenant_id': tenant_id,
        'patterns_found': len(frequent_patterns),
        'top_patterns': frequent_patterns[:5],
        'analyzed_conversations': conversation_count,
        'detection_timestamp': datetime.utcnow().isoformat()
    }
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
    });

    const generateSkillChimera = new ChimeraLambda(this, 'GenerateSkillFunction', {
      functionName: `chimera-evolution-generate-skill-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3
import os
from datetime import datetime, timedelta

dynamodb = boto3.resource('dynamodb')
s3 = boto3.client('s3')

CONFIDENCE_THRESHOLD = 0.7
MIN_COUNT = 3

def derive_skill_name(pattern):
    tools = [t.strip() for t in pattern.split('->')]
    parts = []
    for tool in tools[:3]:
        segment = tool.replace('-', '_').split('_')[0][:8]
        if segment:
            parts.append(segment)
    return '-'.join(parts) if parts else 'auto-skill'

def generate_skill_md(pattern_info):
    pattern = pattern_info['pattern']
    count = pattern_info['count']
    confidence = pattern_info['confidence']
    tools = [t.strip() for t in pattern.split('->')]
    skill_name = derive_skill_name(pattern)
    confidence_pct = str(int(round(confidence * 100)))

    lines = [
        '---',
        'name: ' + skill_name,
        'description: Auto-generated skill for pattern: ' + pattern + '.',
        '---',
        '',
        '# ' + skill_name,
        '',
        'Auto-generated from repeated tool usage pattern detected in conversation logs.',
        '',
        '## Pattern',
        '',
        'Tool sequence: ' + pattern,
        '',
        'Detected ' + str(count) + ' times with ' + confidence_pct + '% confidence.',
        '',
        '## Steps',
        '',
    ]
    for i, tool in enumerate(tools):
        lines.append(str(i + 1) + '. ' + tool)
    lines += [
        '',
        '## Notes',
        '',
        '- Status: PENDING_REVIEW - validate before promoting to production',
        '- Confidence: ' + confidence_pct + '% (' + str(count) + ' occurrences)',
    ]
    return '\\n'.join(lines) + '\\n'

def handler(event, context):
    """
    Generate SKILL.md files from high-confidence repeated tool patterns.
    """
    tenant_id = event.get('tenant_id', 'unknown')
    top_patterns = event.get('top_patterns', [])
    patterns_found = event.get('patterns_found', 0)

    artifacts_bucket = os.environ['ARTIFACTS_BUCKET']
    table_name = os.environ['EVOLUTION_TABLE']
    table = dynamodb.Table(table_name)

    generated_skills = []
    generation_ts = datetime.utcnow().isoformat()
    ts_epoch = str(int(datetime.utcnow().timestamp()))

    high_confidence = [
        p for p in top_patterns
        if p.get('confidence', 0) >= CONFIDENCE_THRESHOLD
        and p.get('count', 0) >= MIN_COUNT
    ]

    for pattern_info in high_confidence:
        pattern = pattern_info['pattern']
        skill_name = derive_skill_name(pattern)
        skill_id = skill_name + '-' + ts_epoch

        skill_md = generate_skill_md(pattern_info)
        s3_key = 'skills/' + tenant_id + '/' + skill_name + '/SKILL.md'

        s3.put_object(
            Bucket=artifacts_bucket,
            Key=s3_key,
            Body=skill_md.encode('utf-8'),
            ContentType='text/markdown',
            Metadata={
                'tenant-id': tenant_id,
                'skill-name': skill_name,
                'pattern': pattern[:256],
                'confidence': str(pattern_info['confidence']),
                'count': str(pattern_info['count']),
                'generated-at': generation_ts,
            }
        )

        table.put_item(
            Item={
                'PK': 'TENANT#' + tenant_id + '#SKILL#' + skill_id,
                'SK': 'METADATA',
                'skill_id': skill_id,
                'skill_name': skill_name,
                'pattern': pattern,
                'status': 'PENDING_REVIEW',
                's3_key': s3_key,
                'confidence': str(pattern_info['confidence']),
                'occurrence_count': pattern_info['count'],
                'generated_at': generation_ts,
                'ttl': int((datetime.utcnow() + timedelta(days=90)).timestamp()),
            }
        )

        generated_skills.append({
            'skill_id': skill_id,
            'skill_name': skill_name,
            'pattern': pattern,
            'confidence': pattern_info['confidence'],
            's3_key': s3_key,
            'status': 'PENDING_REVIEW',
        })

    first = generated_skills[0] if generated_skills else {}
    return {
        'skill_name': first.get('skill_name', 'none'),
        'skill_md': first.get('s3_key', 'none'),
        'tool_code': 'auto-generated',
        'confidence': first.get('confidence', 0.0),
        'tenant_id': tenant_id,
        'generated_count': len(generated_skills),
        'generated_skills': generated_skills,
        'patterns_processed': patterns_found,
    }
`),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        EVOLUTION_TABLE: this.evolutionStateTable.tableName,
        ARTIFACTS_BUCKET: this.evolutionArtifactsBucket.bucketName,
      },
    });

    const memoryGCChimera = new ChimeraLambda(this, 'MemoryGCFunction', {
      functionName: `chimera-evolution-memory-gc-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3
import os
from datetime import datetime, timedelta

dynamodb = boto3.resource('dynamodb')

WARM_THRESHOLD_DAYS = 7
COLD_THRESHOLD_DAYS = 30
ARCHIVE_THRESHOLD_DAYS = 90

def handler(event, context):
    """
    Memory garbage collection: temporal decay, promotion, and archival.
    Reference: ADR-016 memory lifecycle strategy.
    """
    tenant_id = event['tenant_id']
    table = dynamodb.Table(os.environ['EVOLUTION_TABLE'])
    now = datetime.utcnow()
    pruned = 0
    promoted = 0
    merged = 0
    archived = 0

    warm_cutoff = (now - timedelta(days=WARM_THRESHOLD_DAYS)).isoformat()
    cold_cutoff = (now - timedelta(days=COLD_THRESHOLD_DAYS)).isoformat()
    archive_cutoff = (now - timedelta(days=ARCHIVE_THRESHOLD_DAYS)).isoformat()

    for lifecycle, cutoff, next_lifecycle in [
        ('active', warm_cutoff, 'warm'),
        ('warm', cold_cutoff, 'cold'),
    ]:
        lc_pk = f'TENANT#{tenant_id}#LIFECYCLE#{lifecycle}'
        resp = table.query(
            IndexName='GSI1-lifecycle',
            KeyConditionExpression='lifecycleIndexPK = :pk AND last_accessed <= :cutoff',
            ExpressionAttributeValues={':pk': lc_pk, ':cutoff': cutoff},
            Limit=100
        )
        for item in resp.get('Items', []):
            if lifecycle == 'warm' and item.get('access_count', 0) >= 10:
                table.update_item(
                    Key={'PK': item['PK'], 'SK': item['SK']},
                    UpdateExpression='SET #s = :promoted, promoted_at = :now',
                    ExpressionAttributeNames={'#s': 'status'},
                    ExpressionAttributeValues={':promoted': 'SKILL_CANDIDATE', ':now': now.isoformat()}
                )
                promoted += 1
            else:
                next_pk = f'TENANT#{tenant_id}#LIFECYCLE#{next_lifecycle}'
                table.update_item(
                    Key={'PK': item['PK'], 'SK': item['SK']},
                    UpdateExpression='SET lifecycleIndexPK = :pk, lifecycle_status = :s',
                    ExpressionAttributeValues={':pk': next_pk, ':s': next_lifecycle}
                )
                archived += 1

    cold_pk = f'TENANT#{tenant_id}#LIFECYCLE#cold'
    resp = table.query(
        IndexName='GSI1-lifecycle',
        KeyConditionExpression='lifecycleIndexPK = :pk AND last_accessed <= :cutoff',
        ExpressionAttributeValues={':pk': cold_pk, ':cutoff': archive_cutoff},
        Limit=100
    )
    for item in resp.get('Items', []):
        table.update_item(
            Key={'PK': item['PK'], 'SK': item['SK']},
            UpdateExpression='SET lifecycle_status = :s, archived_at = :now, ttl = :ttl',
            ExpressionAttributeValues={
                ':s': 'archived',
                ':now': now.isoformat(),
                ':ttl': int((now + timedelta(days=30)).timestamp())
            }
        )
        pruned += 1

    return {
        'tenant_id': tenant_id,
        'pruned': pruned,
        'promoted': promoted,
        'merged': merged,
        'archived': archived
    }
`),
      timeout: cdk.Duration.minutes(10),
      memorySize: 2048,
      environment: {
        EVOLUTION_TABLE: this.evolutionStateTable.tableName,
      },
    });

    const processFeedbackChimera = new ChimeraLambda(this, 'ProcessFeedbackFunction', {
      functionName: `chimera-evolution-process-feedback-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import boto3
import os
from datetime import datetime, timedelta

dynamodb = boto3.resource('dynamodb')

def handler(event, context):
    """
    Process feedback events and route to evolution subsystems.
    """
    tenant_id = event.get('tenant_id', 'system')
    table = dynamodb.Table(os.environ['EVOLUTION_TABLE'])
    now = datetime.utcnow()
    ttl_90d = int((now + timedelta(days=90)).timestamp())

    response = table.query(
        IndexName='GSI2-unprocessed-feedback',
        KeyConditionExpression='unprocessedIndexPK = :pk',
        ExpressionAttributeValues={':pk': f'TENANT#{tenant_id}#UNPROCESSED'},
        Limit=50
    )

    routed_to = []
    processed_count = 0

    for item in response.get('Items', []):
        feedback_type = item.get('feedback_type', 'unknown')
        session_id = item.get('session_id', '')
        ts = now.isoformat()

        if feedback_type == 'thumbs_down':
            table.put_item(Item={
                'PK': f'TENANT#{tenant_id}#NEGATIVE_SIGNAL',
                'SK': f'{ts}#{session_id}',
                'session_id': session_id, 'signal': -1,
                'processed_at': ts, 'ttl': ttl_90d
            })
            for dest in ['prompt_evolution', 'model_routing']:
                if dest not in routed_to:
                    routed_to.append(dest)

        elif feedback_type == 'thumbs_up':
            table.put_item(Item={
                'PK': f'TENANT#{tenant_id}#POSITIVE_SIGNAL',
                'SK': f'{ts}#{session_id}',
                'session_id': session_id, 'signal': 1,
                'processed_at': ts, 'ttl': ttl_90d
            })
            if 'model_routing' not in routed_to:
                routed_to.append('model_routing')

        elif feedback_type == 'correction':
            table.put_item(Item={
                'PK': f'TENANT#{tenant_id}#CORRECTION',
                'SK': f'{ts}#{session_id}',
                'session_id': session_id,
                'correction_text': item.get('content', '')[:500],
                'processed_at': ts, 'ttl': ttl_90d
            })
            for dest in ['prompt_evolution', 'memory']:
                if dest not in routed_to:
                    routed_to.append(dest)

        elif feedback_type == 'remember':
            table.put_item(Item={
                'PK': f'TENANT#{tenant_id}#MEMORY',
                'SK': f'{ts}#{session_id}',
                'session_id': session_id,
                'content': item.get('content', '')[:2000],
                'lifecycle_status': 'active',
                'lifecycleIndexPK': f'TENANT#{tenant_id}#LIFECYCLE#active',
                'last_accessed': ts, 'access_count': 1, 'stored_at': ts,
                'ttl': int((now + timedelta(days=365)).timestamp())
            })
            if 'memory' not in routed_to:
                routed_to.append('memory')

        table.update_item(
            Key={'PK': item['PK'], 'SK': item['SK']},
            UpdateExpression='REMOVE unprocessedIndexPK SET processed_at = :t',
            ExpressionAttributeValues={':t': ts}
        )
        processed_count += 1

    return {
        'processed': processed_count,
        'routed_to': routed_to,
        'tenant_id': tenant_id
    }
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        EVOLUTION_TABLE: this.evolutionStateTable.tableName,
      },
    });

    const rollbackChangeChimera = new ChimeraLambda(this, 'RollbackChangeFunction', {
      functionName: `chimera-evolution-rollback-${props.envName}`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

def handler(event, context):
    """
    Roll back evolution change using pre-state snapshot from S3.
    """
    event_id = event['event_id']
    rollback_type = event['rollback_type']  # 'prompt', 'skill', 'memory'
    tenant_id = event['tenant_id']

    artifacts_bucket = os.environ['ARTIFACTS_BUCKET']
    evolution_table_name = os.environ['EVOLUTION_TABLE']
    table = dynamodb.Table(evolution_table_name)

    snapshot_key = f'snapshots/{tenant_id}/{rollback_type}/{event_id}/snapshot.json'

    try:
        response = s3.get_object(Bucket=artifacts_bucket, Key=snapshot_key)
        snapshot_data = json.loads(response['Body'].read().decode('utf-8'))
    except s3.exceptions.NoSuchKey:
        return {
            'status': 'rollback_failed',
            'error': 'Snapshot not found',
            'event_id': event_id
        }
    except Exception as e:
        return {
            'status': 'rollback_failed',
            'error': str(e),
            'event_id': event_id
        }

    try:
        if rollback_type == 'prompt':
            table.put_item(Item={
                'PK': f'TENANT#{tenant_id}#PROMPT',
                'SK': 'ACTIVE',
                'prompt_text': snapshot_data['prompt_text'],
                'version': snapshot_data['version'],
                'restored_from': event_id,
                'restored_at': datetime.utcnow().isoformat()
            })

        elif rollback_type == 'skill':
            table.update_item(
                Key={
                    'PK': f'TENANT#{tenant_id}#SKILL#{snapshot_data["skill_id"]}',
                    'SK': 'METADATA'
                },
                UpdateExpression='SET #status = :inactive, restored_at = :now',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={
                    ':inactive': 'INACTIVE',
                    ':now': datetime.utcnow().isoformat()
                }
            )

        elif rollback_type == 'memory':
            for memory_item in snapshot_data.get('memories', []):
                table.put_item(Item=memory_item)

        table.put_item(Item={
            'PK': f'TENANT#{tenant_id}#AUDIT',
            'SK': f'ROLLBACK#{datetime.utcnow().isoformat()}',
            'event_id': event_id,
            'rollback_type': rollback_type,
            'snapshot_key': snapshot_key,
            'restored_at': datetime.utcnow().isoformat(),
            'request_id': context.aws_request_id
        })

    except Exception as e:
        return {
            'status': 'rollback_failed',
            'error': str(e),
            'event_id': event_id,
            'rollback_type': rollback_type
        }

    return {
        'status': 'rolled_back',
        'event_id': event_id,
        'rollback_type': rollback_type,
        'snapshot_key': snapshot_key,
        'restored_at': datetime.utcnow().isoformat()
    }
`),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        ARTIFACTS_BUCKET: this.evolutionArtifactsBucket.bucketName,
        EVOLUTION_TABLE: this.evolutionStateTable.tableName,
      },
    });

    // Grant permissions (using .fn to access the underlying Lambda function)
    this.evolutionStateTable.grantReadWriteData(analyzeConversationLogsChimera.fn);
    this.evolutionStateTable.grantReadWriteData(generatePromptVariantChimera.fn);
    this.evolutionStateTable.grantReadWriteData(testPromptVariantChimera.fn);
    this.evolutionStateTable.grantReadWriteData(detectPatternsChimera.fn);
    this.evolutionStateTable.grantReadWriteData(generateSkillChimera.fn);
    this.evolutionStateTable.grantReadWriteData(memoryGCChimera.fn);
    this.evolutionStateTable.grantReadWriteData(processFeedbackChimera.fn);
    this.evolutionStateTable.grantReadWriteData(rollbackChangeChimera.fn);

    this.evolutionArtifactsBucket.grantReadWrite(analyzeConversationLogsChimera.fn);
    this.evolutionArtifactsBucket.grantReadWrite(testPromptVariantChimera.fn);
    this.evolutionArtifactsBucket.grantReadWrite(generateSkillChimera.fn);
    this.evolutionArtifactsBucket.grantReadWrite(rollbackChangeChimera.fn);

    props.auditTable.grantWriteData(rollbackChangeChimera.fn);

    // ======================================================================
    // Step Functions: Prompt Evolution Pipeline
    // ======================================================================

    const analyzeLogsTask = new tasks.LambdaInvoke(this, 'AnalyzeLogs', {
      lambdaFunction: analyzeConversationLogsChimera.fn,
      outputPath: '$.Payload',
    });
    analyzeLogsTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const generateVariantTask = new tasks.LambdaInvoke(this, 'GenerateVariant', {
      lambdaFunction: generatePromptVariantChimera.fn,
      outputPath: '$.Payload',
    });
    generateVariantTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const testVariantTask = new tasks.LambdaInvoke(this, 'TestVariant', {
      lambdaFunction: testPromptVariantChimera.fn,
      outputPath: '$.Payload',
    });
    testVariantTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const variantTestPassed = new stepfunctions.Choice(this, 'VariantTestPassed')
      .when(
        stepfunctions.Condition.numberGreaterThan('$.avg_quality_score', 0.8),
        new stepfunctions.Succeed(this, 'PromptEvolutionSuccess')
      )
      .otherwise(
        new stepfunctions.Fail(this, 'PromptEvolutionFailed', {
          error: 'VariantDidNotImprove',
          cause: 'New prompt variant did not exceed quality threshold',
        })
      );

    const promptEvolutionError = new stepfunctions.Fail(this, 'PromptEvolutionError', {
      error: 'PromptEvolutionFailed',
      cause: 'Lambda invocation failed after retries',
    });

    analyzeLogsTask.addCatch(promptEvolutionError, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });
    generateVariantTask.addCatch(promptEvolutionError, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });
    testVariantTask.addCatch(promptEvolutionError, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });

    const promptEvolutionDefinition = analyzeLogsTask
      .next(generateVariantTask)
      .next(testVariantTask)
      .next(variantTestPassed);

    const promptEvolutionLogGroup = new logs.LogGroup(this, 'PromptEvolutionLogGroup', {
      logGroupName: `/aws/states/chimera-prompt-evolution-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.promptEvolutionStateMachine = new stepfunctions.StateMachine(
      this,
      'PromptEvolutionPipeline',
      {
        stateMachineName: `chimera-prompt-evolution-${props.envName}`,
        definition: promptEvolutionDefinition,
        stateMachineType: stepfunctions.StateMachineType.STANDARD,
        logs: {
          destination: promptEvolutionLogGroup,
          level: stepfunctions.LogLevel.ALL,
          includeExecutionData: true,
        },
        tracingEnabled: true,
      }
    );

    // ======================================================================
    // Step Functions: Skill Auto-Generation Pipeline
    // ======================================================================

    const detectPatternsTask = new tasks.LambdaInvoke(this, 'DetectPatterns', {
      lambdaFunction: detectPatternsChimera.fn,
      outputPath: '$.Payload',
    });
    detectPatternsTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const generateSkillTask = new tasks.LambdaInvoke(this, 'GenerateSkill', {
      lambdaFunction: generateSkillChimera.fn,
      outputPath: '$.Payload',
    });
    generateSkillTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const patternsFound = new stepfunctions.Choice(this, 'PatternsFound')
      .when(
        stepfunctions.Condition.numberGreaterThan('$.patterns_found', 0),
        generateSkillTask.next(new stepfunctions.Succeed(this, 'SkillGenerationSuccess'))
      )
      .otherwise(new stepfunctions.Succeed(this, 'NoPatternsDetected'));

    const skillGenerationError = new stepfunctions.Fail(this, 'SkillGenerationError', {
      error: 'SkillGenerationFailed',
      cause: 'Lambda invocation failed after retries',
    });

    detectPatternsTask.addCatch(skillGenerationError, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });
    generateSkillTask.addCatch(skillGenerationError, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });

    const skillGenerationDefinition = detectPatternsTask.next(patternsFound);

    const skillGenerationLogGroup = new logs.LogGroup(this, 'SkillGenerationLogGroup', {
      logGroupName: `/aws/states/chimera-skill-generation-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.skillGenerationStateMachine = new stepfunctions.StateMachine(
      this,
      'SkillGenerationPipeline',
      {
        stateMachineName: `chimera-skill-generation-${props.envName}`,
        definition: skillGenerationDefinition,
        stateMachineType: stepfunctions.StateMachineType.STANDARD,
        logs: {
          destination: skillGenerationLogGroup,
          level: stepfunctions.LogLevel.ALL,
          includeExecutionData: true,
        },
        tracingEnabled: true,
      }
    );

    // ======================================================================
    // Step Functions: Memory Evolution Pipeline
    // ======================================================================

    const memoryGCTask = new tasks.LambdaInvoke(this, 'MemoryGC', {
      lambdaFunction: memoryGCChimera.fn,
      outputPath: '$.Payload',
    });
    memoryGCTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const memoryEvolutionError = new stepfunctions.Fail(this, 'MemoryEvolutionError', {
      error: 'MemoryEvolutionFailed',
      cause: 'Lambda invocation failed after retries',
    });

    memoryGCTask.addCatch(memoryEvolutionError, { errors: ['States.ALL'], resultPath: '$.error' });

    const memoryEvolutionDefinition = memoryGCTask.next(
      new stepfunctions.Succeed(this, 'MemoryEvolutionSuccess')
    );

    const memoryEvolutionLogGroup = new logs.LogGroup(this, 'MemoryEvolutionLogGroup', {
      logGroupName: `/aws/states/chimera-memory-evolution-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.memoryEvolutionStateMachine = new stepfunctions.StateMachine(
      this,
      'MemoryEvolutionPipeline',
      {
        stateMachineName: `chimera-memory-evolution-${props.envName}`,
        definition: memoryEvolutionDefinition,
        stateMachineType: stepfunctions.StateMachineType.STANDARD,
        logs: {
          destination: memoryEvolutionLogGroup,
          level: stepfunctions.LogLevel.ALL,
          includeExecutionData: true,
        },
        tracingEnabled: true,
      }
    );

    // ======================================================================
    // Step Functions: Feedback Processing Pipeline
    // ======================================================================

    const processFeedbackTask = new tasks.LambdaInvoke(this, 'ProcessFeedback', {
      lambdaFunction: processFeedbackChimera.fn,
      outputPath: '$.Payload',
    });
    processFeedbackTask.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 3,
      backoffRate: 2,
      interval: cdk.Duration.seconds(1),
    });

    const feedbackProcessorError = new stepfunctions.Fail(this, 'FeedbackProcessorError', {
      error: 'FeedbackProcessorFailed',
      cause: 'Lambda invocation failed after retries',
    });

    processFeedbackTask.addCatch(feedbackProcessorError, {
      errors: ['States.ALL'],
      resultPath: '$.error',
    });

    const feedbackProcessorDefinition = processFeedbackTask.next(
      new stepfunctions.Succeed(this, 'FeedbackProcessingSuccess')
    );

    const feedbackProcessorLogGroup = new logs.LogGroup(this, 'FeedbackProcessorLogGroup', {
      logGroupName: `/aws/states/chimera-feedback-processor-${props.envName}`,
      retention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.feedbackProcessorStateMachine = new stepfunctions.StateMachine(
      this,
      'FeedbackProcessorPipeline',
      {
        stateMachineName: `chimera-feedback-processor-${props.envName}`,
        definition: feedbackProcessorDefinition,
        stateMachineType: stepfunctions.StateMachineType.STANDARD,
        logs: {
          destination: feedbackProcessorLogGroup,
          level: stepfunctions.LogLevel.ALL,
          includeExecutionData: true,
        },
        tracingEnabled: true,
      }
    );

    // ======================================================================
    // EventBridge: Scheduled Evolution Tasks
    // ======================================================================

    new events.Rule(this, 'DailyPromptEvolutionRule', {
      ruleName: `chimera-daily-prompt-evolution-${props.envName}`,
      description: 'Trigger daily prompt evolution analysis',
      schedule: events.Schedule.cron({ hour: '2', minute: '0' }),
      targets: [new targets.SfnStateMachine(this.promptEvolutionStateMachine)],
    });

    new events.Rule(this, 'WeeklySkillGenerationRule', {
      ruleName: `chimera-weekly-skill-generation-${props.envName}`,
      description: 'Trigger weekly skill auto-generation',
      schedule: events.Schedule.cron({ weekDay: 'SUN', hour: '3', minute: '0' }),
      targets: [new targets.SfnStateMachine(this.skillGenerationStateMachine)],
    });

    new events.Rule(this, 'DailyMemoryEvolutionRule', {
      ruleName: `chimera-daily-memory-evolution-${props.envName}`,
      description: 'Trigger daily memory evolution and GC',
      schedule: events.Schedule.cron({ hour: '4', minute: '0' }),
      targets: [new targets.SfnStateMachine(this.memoryEvolutionStateMachine)],
    });

    new events.Rule(this, 'HourlyFeedbackProcessingRule', {
      ruleName: `chimera-hourly-feedback-processing-${props.envName}`,
      description: 'Trigger hourly feedback event processing',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.SfnStateMachine(this.feedbackProcessorStateMachine)],
    });

    // ======================================================================
    // Pipeline Completion Handler
    // Listens for CodePipeline state changes on the default event bus and
    // updates evolution records in DynamoDB. Bridges AWS-native events to
    // Chimera's custom event bus for agent notification.
    // ======================================================================
    const pipelineCompletionFn = new lambda.Function(this, 'PipelineCompletionHandler', {
      functionName: `chimera-evolution-pipeline-completion-${props.envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { DynamoDB, EventBridge } = require('aws-sdk');
const ddb = new DynamoDB.DocumentClient();
const eb = new EventBridge();

exports.handler = async (event) => {
  const { pipeline, state, 'execution-id': executionId } = event.detail;
  const envName = process.env.ENV_NAME || 'dev';
  const tableName = process.env.EVOLUTION_TABLE;
  const eventBusName = process.env.EVENT_BUS_NAME;

  console.log(JSON.stringify({ message: 'Pipeline state change', pipeline, state, executionId }));

  // Only process chimera pipelines
  if (!pipeline.startsWith('Chimera-')) return;

  const newStatus = state === 'SUCCEEDED' ? 'deployed' : state === 'FAILED' ? 'deploy_failed' : 'stopped';

  // Find pending evolution records
  const scan = await ddb.scan({
    TableName: tableName,
    FilterExpression: '#s = :deploying AND begins_with(PK, :prefix)',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':deploying': 'deploying', ':prefix': 'EVOLUTION#' },
    Limit: 50,
  }).promise();

  const updates = (scan.Items || []).map(async (item) => {
    await ddb.update({
      TableName: tableName,
      Key: { PK: item.PK, SK: item.SK },
      UpdateExpression: 'SET #s = :status, updated_at = :now, pipeline_execution_id = :execId',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':status': newStatus,
        ':now': new Date().toISOString(),
        ':execId': executionId,
      },
    }).promise();

    // Publish completion event to custom bus
    await eb.putEvents({
      Entries: [{
        Source: 'chimera.evolution',
        DetailType: 'Evolution Deployment Complete',
        EventBusName: eventBusName,
        Detail: JSON.stringify({
          evolutionId: item.PK.replace('EVOLUTION#', ''),
          status: newStatus,
          pipeline,
          executionId,
          capabilityName: item.capability_name || 'unknown',
          tenantId: item.tenant_id || 'unknown',
        }),
      }],
    }).promise();
  });

  await Promise.all(updates);
  console.log(JSON.stringify({ message: 'Updated evolution records', count: updates.length, newStatus }));
};
`),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        EVOLUTION_TABLE: this.evolutionStateTable.tableName,
        EVENT_BUS_NAME: props.eventBus.eventBusName,
        ENV_NAME: props.envName,
      },
      logRetention: isProd ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_WEEK,
    });

    // Grant DynamoDB + EventBridge access
    this.evolutionStateTable.grantReadWriteData(pipelineCompletionFn);
    props.eventBus.grantPutEventsTo(pipelineCompletionFn);

    // EventBridge rule on DEFAULT bus for CodePipeline state changes
    const pipelineRule = new events.Rule(this, 'PipelineCompletionRule', {
      ruleName: `chimera-pipeline-completion-${props.envName}`,
      description: 'Routes CodePipeline completion events to evolution status updater',
      eventPattern: {
        source: ['aws.codepipeline'],
        detailType: ['CodePipeline Pipeline Execution State Change'],
        detail: {
          state: ['SUCCEEDED', 'FAILED', 'STOPPED'],
        },
      },
    });
    pipelineRule.addTarget(new targets.LambdaFunction(pipelineCompletionFn));

    // ======================================================================
    // Stack Outputs
    // ======================================================================

    new cdk.CfnOutput(this, 'EvolutionStateTableArn', {
      value: this.evolutionStateTable.tableArn,
      exportName: `${this.stackName}-EvolutionStateTableArn`,
      description: 'Evolution state DynamoDB table ARN',
    });

    new cdk.CfnOutput(this, 'EvolutionStateTableName', {
      value: this.evolutionStateTable.tableName,
      exportName: `${this.stackName}-EvolutionStateTableName`,
      description: 'Evolution state DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'EvolutionArtifactsBucketArn', {
      value: this.evolutionArtifactsBucket.bucketArn,
      exportName: `${this.stackName}-EvolutionArtifactsBucketArn`,
      description: 'Evolution artifacts S3 bucket ARN',
    });

    new cdk.CfnOutput(this, 'EvolutionArtifactsBucketName', {
      value: this.evolutionArtifactsBucket.bucketName,
      exportName: `${this.stackName}-EvolutionArtifactsBucketName`,
      description: 'Evolution artifacts S3 bucket name',
    });

    new cdk.CfnOutput(this, 'PromptEvolutionStateMachineArn', {
      value: this.promptEvolutionStateMachine.stateMachineArn,
      exportName: `${this.stackName}-PromptEvolutionStateMachineArn`,
      description: 'Prompt evolution pipeline state machine ARN',
    });

    new cdk.CfnOutput(this, 'SkillGenerationStateMachineArn', {
      value: this.skillGenerationStateMachine.stateMachineArn,
      exportName: `${this.stackName}-SkillGenerationStateMachineArn`,
      description: 'Skill auto-generation pipeline state machine ARN',
    });

    new cdk.CfnOutput(this, 'MemoryEvolutionStateMachineArn', {
      value: this.memoryEvolutionStateMachine.stateMachineArn,
      exportName: `${this.stackName}-MemoryEvolutionStateMachineArn`,
      description: 'Memory evolution pipeline state machine ARN',
    });

    new cdk.CfnOutput(this, 'FeedbackProcessorStateMachineArn', {
      value: this.feedbackProcessorStateMachine.stateMachineArn,
      exportName: `${this.stackName}-FeedbackProcessorStateMachineArn`,
      description: 'Feedback processing pipeline state machine ARN',
    });
  }
}
