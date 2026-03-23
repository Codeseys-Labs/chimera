"""
AWS Athena Tools - Serverless SQL query engine for Chimera agent

Provides Athena operations for querying data in S3 using SQL.
All operations respect IAM policies enforced at the tenant level.
"""
import boto3
from typing import Optional
from strands.tools import tool


@tool
def start_athena_query(
    database: str,
    query_string: str,
    output_location: str,
    region: str = "us-east-1",
    catalog: str = "AwsDataCatalog",
    workgroup: Optional[str] = None
) -> str:
    """
    Execute SQL query on data in S3 using AWS Athena serverless query engine.

    Args:
        database: Database name to use for query
        query_string: SQL query to execute
        output_location: S3 location for query results (s3://bucket/path/)
        region: AWS region (default: us-east-1)
        catalog: Data catalog name (default: AwsDataCatalog)
        workgroup: Athena workgroup name (optional)

    Returns:
        Query execution ID to check status and retrieve results.
    """
    try:
        athena_client = boto3.client('athena', region_name=region)

        params = {
            'QueryString': query_string,
            'QueryExecutionContext': {
                'Database': database,
                'Catalog': catalog
            },
            'ResultConfiguration': {
                'OutputLocation': output_location
            }
        }

        if workgroup:
            params['WorkGroup'] = workgroup

        response = athena_client.start_query_execution(**params)
        query_execution_id = response['QueryExecutionId']

        return f"""Query started successfully!

Query Execution ID: {query_execution_id}
Database: {database}
Output Location: {output_location}

Use get_athena_query_status() to check progress."""

    except Exception as e:
        return f"Error starting Athena query: {str(e)}"


@tool
def get_athena_query_status(
    query_execution_id: str,
    region: str = "us-east-1"
) -> str:
    """
    Get AWS Athena query execution status, statistics, and error details.

    Args:
        query_execution_id: Query execution ID from start_athena_query
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with query status, statistics, and timing information.
    """
    try:
        athena_client = boto3.client('athena', region_name=region)
        response = athena_client.get_query_execution(QueryExecutionId=query_execution_id)

        execution = response['QueryExecution']
        status = execution['Status']
        state = status['State']

        result = f"""Query Execution Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Query ID: {query_execution_id}
State: {state}
"""

        if 'StateChangeReason' in status:
            result += f"Reason: {status['StateChangeReason']}\n"

        if 'SubmissionDateTime' in status:
            result += f"Submitted: {status['SubmissionDateTime']}\n"

        if 'CompletionDateTime' in status:
            result += f"Completed: {status['CompletionDateTime']}\n"

        # Statistics (if available)
        if 'Statistics' in execution:
            stats = execution['Statistics']
            result += "\nStatistics:\n"

            if 'EngineExecutionTimeInMillis' in stats:
                result += f"  Engine Execution: {stats['EngineExecutionTimeInMillis']} ms\n"

            if 'DataScannedInBytes' in stats:
                data_scanned = stats['DataScannedInBytes']
                if data_scanned < 1024:
                    size_str = f"{data_scanned} bytes"
                elif data_scanned < 1024 * 1024:
                    size_str = f"{data_scanned / 1024:.2f} KB"
                elif data_scanned < 1024 * 1024 * 1024:
                    size_str = f"{data_scanned / (1024 * 1024):.2f} MB"
                else:
                    size_str = f"{data_scanned / (1024 * 1024 * 1024):.2f} GB"
                result += f"  Data Scanned: {size_str}\n"

        # Output location
        if 'ResultConfiguration' in execution:
            output_loc = execution['ResultConfiguration'].get('OutputLocation', 'N/A')
            result += f"\nOutput Location: {output_loc}\n"

        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        return result

    except Exception as e:
        return f"Error getting query status: {str(e)}"


@tool
def get_athena_query_results(
    query_execution_id: str,
    region: str = "us-east-1",
    max_results: int = 100
) -> str:
    """
    Retrieve result rows from a completed AWS Athena query.

    Args:
        query_execution_id: Query execution ID
        region: AWS region (default: us-east-1)
        max_results: Maximum number of rows to return (default: 100)

    Returns:
        Formatted table with query results.
    """
    try:
        athena_client = boto3.client('athena', region_name=region)

        # First check if query is complete
        exec_response = athena_client.get_query_execution(QueryExecutionId=query_execution_id)
        state = exec_response['QueryExecution']['Status']['State']

        if state != 'SUCCEEDED':
            return f"Query is in state '{state}'. Results are only available for SUCCEEDED queries."

        # Get results
        response = athena_client.get_query_results(
            QueryExecutionId=query_execution_id,
            MaxResults=max_results
        )

        result_set = response['ResultSet']
        rows = result_set['Rows']

        if not rows:
            return "Query returned no results."

        # Extract column names from first row (header)
        columns = [col['VarCharValue'] for col in rows[0]['Data']]
        data_rows = rows[1:]  # Skip header row

        result = f"Query Results ({len(data_rows)} rows):\n\n"

        # Format as table
        result += " | ".join(columns) + "\n"
        result += "-" * (sum(len(col) for col in columns) + len(columns) * 3) + "\n"

        for row in data_rows:
            values = [cell.get('VarCharValue', 'NULL') for cell in row['Data']]
            result += " | ".join(values) + "\n"

        if 'NextToken' in response:
            result += f"\n(More results available - use NextToken for pagination)"

        return result

    except Exception as e:
        return f"Error getting query results: {str(e)}"


@tool
def stop_athena_query(
    query_execution_id: str,
    region: str = "us-east-1"
) -> str:
    """
    Cancel a running AWS Athena query execution.

    Args:
        query_execution_id: Query execution ID to cancel
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        athena_client = boto3.client('athena', region_name=region)
        athena_client.stop_query_execution(QueryExecutionId=query_execution_id)

        return f"Query {query_execution_id} has been stopped."

    except Exception as e:
        return f"Error stopping query: {str(e)}"


@tool
def list_athena_databases(
    catalog_name: str = "AwsDataCatalog",
    region: str = "us-east-1",
    max_results: int = 50
) -> str:
    """
    List databases in AWS Athena data catalog.

    Args:
        catalog_name: Data catalog name (default: AwsDataCatalog)
        region: AWS region (default: us-east-1)
        max_results: Maximum number of results (default: 50)

    Returns:
        Formatted list of databases with descriptions.
    """
    try:
        athena_client = boto3.client('athena', region_name=region)

        response = athena_client.list_databases(
            CatalogName=catalog_name,
            MaxResults=max_results
        )

        databases = response.get('DatabaseList', [])

        if not databases:
            return f"No databases found in catalog '{catalog_name}'."

        result = f"Found {len(databases)} database(s) in catalog '{catalog_name}':\n\n"

        for db in databases:
            name = db['Name']
            description = db.get('Description', 'No description')
            result += f"• {name}\n"
            if description != 'No description':
                result += f"  Description: {description}\n"

        return result

    except Exception as e:
        return f"Error listing databases: {str(e)}"


@tool
def list_athena_tables(
    catalog_name: str,
    database_name: str,
    region: str = "us-east-1",
    max_results: int = 50
) -> str:
    """
    List tables in an AWS Athena database.

    Args:
        catalog_name: Data catalog name
        database_name: Database name
        region: AWS region (default: us-east-1)
        max_results: Maximum number of results (default: 50)

    Returns:
        Formatted list of tables with metadata.
    """
    try:
        athena_client = boto3.client('athena', region_name=region)

        response = athena_client.list_table_metadata(
            CatalogName=catalog_name,
            DatabaseName=database_name,
            MaxResults=max_results
        )

        tables = response.get('TableMetadataList', [])

        if not tables:
            return f"No tables found in database '{database_name}'."

        result = f"Found {len(tables)} table(s) in database '{database_name}':\n\n"

        for table in tables:
            name = table['Name']
            table_type = table.get('TableType', 'N/A')
            result += f"• {name} (Type: {table_type})\n"

            # Show columns if available
            columns = table.get('Columns', [])
            if columns:
                result += f"  Columns: {len(columns)}\n"
                for col in columns[:5]:  # Show first 5 columns
                    col_name = col.get('Name', 'N/A')
                    col_type = col.get('Type', 'N/A')
                    result += f"    - {col_name}: {col_type}\n"
                if len(columns) > 5:
                    result += f"    ... and {len(columns) - 5} more columns\n"

            # Show partition keys if available
            partition_keys = table.get('PartitionKeys', [])
            if partition_keys:
                part_names = [pk.get('Name', 'N/A') for pk in partition_keys]
                result += f"  Partition Keys: {', '.join(part_names)}\n"

            result += "\n"

        return result

    except Exception as e:
        return f"Error listing tables: {str(e)}"
