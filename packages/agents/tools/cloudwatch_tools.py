"""
CloudWatch Tools - AWS CloudWatch operations for Chimera agent

Provides CloudWatch monitoring and logging operations for metrics,
alarms, and log queries.
"""
import boto3
import json
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from datetime import datetime
from typing import List, Dict, Any, Optional
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def put_cloudwatch_metric_data(
    namespace: str,
    metric_name: str,
    value: float,
    dimensions: Optional[str] = None,
    unit: str = "None",
    region: str = "us-east-1"
) -> str:
    """
    Publish custom metric data to CloudWatch for monitoring and alarming.

    Args:
        namespace: Custom namespace for metrics (e.g., MyApp/Production)
        metric_name: Metric name
        value: Single metric value
        dimensions: JSON string of dimensions list [{"name": "dim1", "value": "val1"}] (optional)
        unit: Unit of measurement (Count, Seconds, Bytes, etc.)
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        cloudwatch = boto3.client('cloudwatch', region_name=region, config=_BOTO_CONFIG)

        metric_data = {
            'MetricName': metric_name,
            'Value': value,
            'Timestamp': datetime.utcnow(),
            'Unit': unit
        }

        if dimensions:
            dims_list = json.loads(dimensions)
            metric_data['Dimensions'] = [
                {'Name': d['name'], 'Value': d['value']}
                for d in dims_list
            ]

        cloudwatch.put_metric_data(
            Namespace=namespace,
            MetricData=[metric_data]
        )

        return f"""Metric Published:
Namespace: {namespace}
Metric: {metric_name}
Value: {value} {unit}
Region: {region}"""

    except (ClientError, BotoCoreError) as e:
        return f"Error publishing metric: {str(e)}"


@tool
def start_cloudwatch_query(
    log_group_names: str,
    query_string: str,
    start_time: int,
    end_time: int,
    region: str = "us-east-1"
) -> str:
    """
    Start a CloudWatch Logs Insights query to analyze log data.

    Args:
        log_group_names: JSON array of log group names ["group1", "group2"]
        query_string: CloudWatch Logs Insights query (e.g., "fields @timestamp, @message | limit 20")
        start_time: Query start time (Unix timestamp in seconds)
        end_time: Query end time (Unix timestamp in seconds)
        region: AWS region (default: us-east-1)

    Returns:
        Query ID to use with get_cloudwatch_query_results.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        logs = boto3.client('logs', region_name=region, config=_BOTO_CONFIG)

        log_groups = json.loads(log_group_names)

        response = logs.start_query(
            logGroupNames=log_groups,
            startTime=start_time,
            endTime=end_time,
            queryString=query_string
        )

        query_id = response['queryId']

        return f"""Query Started:
Query ID: {query_id}
Log Groups: {len(log_groups)}
Time Range: {datetime.fromtimestamp(start_time)} to {datetime.fromtimestamp(end_time)}

Use get_cloudwatch_query_results with this Query ID to retrieve results."""

    except (ClientError, BotoCoreError) as e:
        return f"Error starting query: {str(e)}"


@tool
def get_cloudwatch_query_results(
    query_id: str,
    region: str = "us-east-1"
) -> str:
    """
    Retrieve results from a CloudWatch Logs Insights query.

    Args:
        query_id: Query ID from start_cloudwatch_query
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with query status and results.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        logs = boto3.client('logs', region_name=region, config=_BOTO_CONFIG)

        response = logs.get_query_results(queryId=query_id)

        status = response['status']
        results = response.get('results', [])
        stats = response.get('statistics', {})

        result = f"""Query Status: {status}\n"""

        if status == 'Complete':
            result += f"Results: {len(results)} record(s)\n"
            result += f"Records Matched: {stats.get('recordsMatched', 0)}\n"
            result += f"Records Scanned: {stats.get('recordsScanned', 0)}\n"
            result += f"Bytes Scanned: {stats.get('bytesScanned', 0)}\n\n"

            if results:
                result += "Sample Results:\n"
                for i, record in enumerate(results[:5], 1):
                    result += f"\nRecord {i}:\n"
                    for field in record:
                        field_name = field.get('field', '')
                        field_value = field.get('value', '')
                        if len(field_value) > 100:
                            field_value = field_value[:100] + '...'
                        result += f"  {field_name}: {field_value}\n"
        else:
            result += f"Query still running. Poll again to get results."

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error getting query results: {str(e)}"


@tool
def put_cloudwatch_metric_alarm(
    alarm_name: str,
    metric_name: str,
    namespace: str,
    comparison_operator: str,
    threshold: float,
    evaluation_periods: int,
    period: int,
    statistic: str = "Average",
    region: str = "us-east-1"
) -> str:
    """
    Create or update a CloudWatch metric alarm to trigger actions based on thresholds.

    Args:
        alarm_name: Alarm name (unique within account)
        metric_name: Metric name to monitor
        namespace: Metric namespace
        comparison_operator: Comparison operator (GreaterThanThreshold, LessThanThreshold, etc.)
        threshold: Threshold value for comparison
        evaluation_periods: Number of periods to evaluate
        period: Period in seconds over which statistic is applied
        statistic: Statistic to apply (Average, Sum, Minimum, Maximum, SampleCount)
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        cloudwatch = boto3.client('cloudwatch', region_name=region, config=_BOTO_CONFIG)

        cloudwatch.put_metric_alarm(
            AlarmName=alarm_name,
            ComparisonOperator=comparison_operator,
            EvaluationPeriods=evaluation_periods,
            MetricName=metric_name,
            Namespace=namespace,
            Period=period,
            Statistic=statistic,
            Threshold=threshold,
            ActionsEnabled=True
        )

        return f"""Alarm Created:
Name: {alarm_name}
Metric: {namespace}/{metric_name}
Condition: {statistic} {comparison_operator} {threshold}
Evaluation: {evaluation_periods} period(s) of {period}s
Region: {region}"""

    except (ClientError, BotoCoreError) as e:
        return f"Error creating alarm: {str(e)}"


@tool
def describe_cloudwatch_alarms(
    alarm_names: Optional[str] = None,
    state_value: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    List and query CloudWatch alarms with optional filtering.

    Args:
        alarm_names: JSON array of specific alarm names to query (optional)
        state_value: Filter by alarm state (OK, ALARM, INSUFFICIENT_DATA) (optional)
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with alarm details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        cloudwatch = boto3.client('cloudwatch', region_name=region, config=_BOTO_CONFIG)

        kwargs = {}
        if alarm_names:
            kwargs['AlarmNames'] = json.loads(alarm_names)
        if state_value:
            kwargs['StateValue'] = state_value

        response = cloudwatch.describe_alarms(**kwargs)

        alarms = response.get('MetricAlarms', [])

        if not alarms:
            return f"No alarms found matching criteria in region {region}."

        result = f"Found {len(alarms)} alarm(s):\n\n"

        for alarm in alarms:
            name = alarm['AlarmName']
            state = alarm['StateValue']
            reason = alarm.get('StateReason', 'N/A')
            metric = alarm.get('MetricName', 'N/A')

            result += f"• {name}\n"
            result += f"  State: {state}\n"
            result += f"  Metric: {metric}\n"
            result += f"  Reason: {reason[:100]}\n\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error describing alarms: {str(e)}"
