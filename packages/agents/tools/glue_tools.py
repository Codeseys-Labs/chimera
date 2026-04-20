"""
AWS Glue Tools - ETL and data catalog management for Chimera agent

Provides Glue operations for ETL jobs and data catalog management.
All operations respect IAM policies enforced at the tenant level.
"""
import boto3
from botocore.config import Config
from typing import Optional, Dict
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def list_glue_databases(
    region: str = "us-east-1",
    catalog_id: Optional[str] = None,
    max_results: int = 50
) -> str:
    """
    List AWS Glue Data Catalog databases.

    Args:
        region: AWS region (default: us-east-1)
        catalog_id: Catalog ID (defaults to account ID)
        max_results: Maximum number of results (default: 50)

    Returns:
        Formatted list of databases with metadata.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        glue_client = boto3.client('glue', region_name=region, config=_BOTO_CONFIG)

        params = {'MaxResults': max_results}
        if catalog_id:
            params['CatalogId'] = catalog_id

        response = glue_client.get_databases(**params)

        databases = response.get('DatabaseList', [])

        if not databases:
            return "No Glue databases found in this catalog."

        result = f"Found {len(databases)} Glue database(s):\n\n"

        for db in databases:
            name = db['Name']
            description = db.get('Description', 'No description')
            location = db.get('LocationUri', 'N/A')
            created = db.get('CreateTime', 'N/A')

            result += f"• {name}\n"
            if description != 'No description':
                result += f"  Description: {description}\n"
            result += f"  Location: {location}\n"
            if created != 'N/A':
                result += f"  Created: {created}\n"
            result += "\n"

        return result

    except Exception as e:
        return f"Error listing Glue databases: {str(e)}"


@tool
def list_glue_tables(
    database_name: str,
    region: str = "us-east-1",
    catalog_id: Optional[str] = None,
    max_results: int = 50
) -> str:
    """
    List tables in an AWS Glue Data Catalog database.

    Args:
        database_name: Database name
        region: AWS region (default: us-east-1)
        catalog_id: Catalog ID (defaults to account ID)
        max_results: Maximum number of results (default: 50)

    Returns:
        Formatted list of tables with metadata.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        glue_client = boto3.client('glue', region_name=region, config=_BOTO_CONFIG)

        params = {
            'DatabaseName': database_name,
            'MaxResults': max_results
        }
        if catalog_id:
            params['CatalogId'] = catalog_id

        response = glue_client.get_tables(**params)

        tables = response.get('TableList', [])

        if not tables:
            return f"No tables found in database '{database_name}'."

        result = f"Found {len(tables)} table(s) in database '{database_name}':\n\n"

        for table in tables:
            name = table['Name']
            table_type = table.get('TableType', 'N/A')
            description = table.get('Description', '')
            created = table.get('CreateTime', 'N/A')
            updated = table.get('UpdateTime', 'N/A')

            result += f"• {name} (Type: {table_type})\n"
            if description:
                result += f"  Description: {description}\n"

            # Storage info
            storage = table.get('StorageDescriptor', {})
            if storage:
                location = storage.get('Location', 'N/A')
                input_format = storage.get('InputFormat', 'N/A')
                output_format = storage.get('OutputFormat', 'N/A')

                result += f"  Location: {location}\n"
                result += f"  Input Format: {input_format}\n"
                result += f"  Output Format: {output_format}\n"

            # Partition keys
            partition_keys = table.get('PartitionKeys', [])
            if partition_keys:
                part_names = [pk['Name'] for pk in partition_keys]
                result += f"  Partition Keys: {', '.join(part_names)}\n"

            if created != 'N/A':
                result += f"  Created: {created}\n"
            if updated != 'N/A':
                result += f"  Updated: {updated}\n"

            result += "\n"

        return result

    except Exception as e:
        return f"Error listing Glue tables: {str(e)}"


@tool
def get_glue_table_schema(
    database_name: str,
    table_name: str,
    region: str = "us-east-1",
    catalog_id: Optional[str] = None
) -> str:
    """
    Get detailed table metadata and schema from AWS Glue Data Catalog.

    Args:
        database_name: Database name
        table_name: Table name
        region: AWS region (default: us-east-1)
        catalog_id: Catalog ID (defaults to account ID)

    Returns:
        Detailed table schema with columns, partition keys, and storage info.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        glue_client = boto3.client('glue', region_name=region, config=_BOTO_CONFIG)

        params = {
            'DatabaseName': database_name,
            'Name': table_name
        }
        if catalog_id:
            params['CatalogId'] = catalog_id

        response = glue_client.get_table(**params)

        table = response['Table']

        result = f"""Glue Table Schema: {table_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Database: {database_name}
Table Type: {table.get('TableType', 'N/A')}
Owner: {table.get('Owner', 'N/A')}
"""

        if 'Description' in table:
            result += f"Description: {table['Description']}\n"

        if 'CreateTime' in table:
            result += f"Created: {table['CreateTime']}\n"

        if 'UpdateTime' in table:
            result += f"Updated: {table['UpdateTime']}\n"

        # Storage descriptor
        storage = table.get('StorageDescriptor', {})
        if storage:
            result += f"\nStorage:\n"
            result += f"  Location: {storage.get('Location', 'N/A')}\n"
            result += f"  Input Format: {storage.get('InputFormat', 'N/A')}\n"
            result += f"  Output Format: {storage.get('OutputFormat', 'N/A')}\n"
            result += f"  Compressed: {storage.get('Compressed', False)}\n"

            # Columns
            columns = storage.get('Columns', [])
            if columns:
                result += f"\nColumns ({len(columns)}):\n"
                for col in columns:
                    col_name = col.get('Name', 'N/A')
                    col_type = col.get('Type', 'N/A')
                    col_comment = col.get('Comment', '')
                    result += f"  • {col_name}: {col_type}"
                    if col_comment:
                        result += f" — {col_comment}"
                    result += "\n"

        # Partition keys
        partition_keys = table.get('PartitionKeys', [])
        if partition_keys:
            result += f"\nPartition Keys ({len(partition_keys)}):\n"
            for pk in partition_keys:
                pk_name = pk.get('Name', 'N/A')
                pk_type = pk.get('Type', 'N/A')
                pk_comment = pk.get('Comment', '')
                result += f"  • {pk_name}: {pk_type}"
                if pk_comment:
                    result += f" — {pk_comment}"
                result += "\n"

        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        return result

    except Exception as e:
        return f"Error getting table schema: {str(e)}"


@tool
def start_glue_job(
    job_name: str,
    region: str = "us-east-1",
    arguments: Optional[Dict[str, str]] = None,
    timeout: Optional[int] = None,
    max_capacity: Optional[float] = None,
    number_of_workers: Optional[int] = None,
    worker_type: Optional[str] = None
) -> str:
    """
    Start an AWS Glue ETL job run with optional arguments.

    Args:
        job_name: Glue job name
        region: AWS region (default: us-east-1)
        arguments: Job arguments as key-value pairs (optional)
        timeout: Job timeout in minutes (optional)
        max_capacity: Number of DPUs to allocate (optional)
        number_of_workers: Number of workers for G.1X/G.2X worker types (optional)
        worker_type: Worker type: Standard, G.1X, G.2X, G.025X (optional)

    Returns:
        Job run ID to track execution.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        glue_client = boto3.client('glue', region_name=region, config=_BOTO_CONFIG)

        params = {'JobName': job_name}

        if arguments:
            params['Arguments'] = arguments
        if timeout:
            params['Timeout'] = timeout
        if max_capacity:
            params['MaxCapacity'] = max_capacity
        if number_of_workers:
            params['NumberOfWorkers'] = number_of_workers
        if worker_type:
            params['WorkerType'] = worker_type

        response = glue_client.start_job_run(**params)

        job_run_id = response['JobRunId']

        result = f"""Glue job started successfully!

Job Name: {job_name}
Job Run ID: {job_run_id}

Use get_glue_job_status() to check progress."""

        return result

    except Exception as e:
        return f"Error starting Glue job: {str(e)}"


@tool
def get_glue_job_status(
    job_name: str,
    run_id: str,
    region: str = "us-east-1"
) -> str:
    """
    Get AWS Glue ETL job run status, metrics, and error details.

    Args:
        job_name: Glue job name
        run_id: Job run ID from start_glue_job
        region: AWS region (default: us-east-1)

    Returns:
        Formatted job run status with timing and error information.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        glue_client = boto3.client('glue', region_name=region, config=_BOTO_CONFIG)

        response = glue_client.get_job_run(
            JobName=job_name,
            RunId=run_id
        )

        job_run = response['JobRun']

        result = f"""Glue Job Run Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Job Name: {job_name}
Run ID: {run_id}
State: {job_run.get('JobRunState', 'N/A')}
"""

        if 'StartedOn' in job_run:
            result += f"Started: {job_run['StartedOn']}\n"

        if 'CompletedOn' in job_run:
            result += f"Completed: {job_run['CompletedOn']}\n"

        if 'ExecutionTime' in job_run:
            exec_time = job_run['ExecutionTime']
            result += f"Execution Time: {exec_time} seconds\n"

        if 'ErrorMessage' in job_run:
            result += f"\nError: {job_run['ErrorMessage']}\n"

        # Resource configuration
        result += f"\nResources:\n"
        if 'MaxCapacity' in job_run:
            result += f"  Max Capacity: {job_run['MaxCapacity']} DPUs\n"
        if 'NumberOfWorkers' in job_run:
            result += f"  Workers: {job_run['NumberOfWorkers']}\n"
        if 'WorkerType' in job_run:
            result += f"  Worker Type: {job_run['WorkerType']}\n"

        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        return result

    except Exception as e:
        return f"Error getting job status: {str(e)}"


@tool
def get_glue_crawler_status(
    crawler_name: str,
    region: str = "us-east-1"
) -> str:
    """
    Get AWS Glue crawler configuration and status.

    Args:
        crawler_name: Crawler name
        region: AWS region (default: us-east-1)

    Returns:
        Crawler configuration, schedule, and last run details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        glue_client = boto3.client('glue', region_name=region, config=_BOTO_CONFIG)

        response = glue_client.get_crawler(Name=crawler_name)

        crawler = response['Crawler']

        result = f"""Glue Crawler: {crawler_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
State: {crawler.get('State', 'N/A')}
Role: {crawler.get('Role', 'N/A')}
Database: {crawler.get('DatabaseName', 'N/A')}
"""

        if 'CreationTime' in crawler:
            result += f"Created: {crawler['CreationTime']}\n"

        if 'LastUpdated' in crawler:
            result += f"Last Updated: {crawler['LastUpdated']}\n"

        # Schedule
        schedule = crawler.get('Schedule', {})
        if schedule:
            result += f"\nSchedule:\n"
            result += f"  Expression: {schedule.get('ScheduleExpression', 'N/A')}\n"
            result += f"  State: {schedule.get('State', 'N/A')}\n"

        # Last crawl
        last_crawl = crawler.get('LastCrawl', {})
        if last_crawl:
            result += f"\nLast Crawl:\n"
            result += f"  Status: {last_crawl.get('Status', 'N/A')}\n"
            if 'StartTime' in last_crawl:
                result += f"  Start Time: {last_crawl['StartTime']}\n"
            if 'ErrorMessage' in last_crawl:
                result += f"  Error: {last_crawl['ErrorMessage']}\n"

        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        return result

    except Exception as e:
        return f"Error getting crawler status: {str(e)}"
