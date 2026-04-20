"""
EC2 Tools - AWS EC2 operations for Chimera agent

Provides EC2 instance management operations with tenant-scoped access control.
All operations respect IAM policies enforced at the tenant level.
"""
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from typing import List, Dict, Any
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def list_ec2_instances(region: str = "us-east-1") -> str:
    """
    List all EC2 instances in the specified region.

    Args:
        region: AWS region to query (default: us-east-1)

    Returns:
        A formatted string listing all EC2 instances with their details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        ec2_client = boto3.client('ec2', region_name=region, config=_BOTO_CONFIG)
        response = ec2_client.describe_instances()

        instances = []
        for reservation in response.get('Reservations', []):
            for instance in reservation.get('Instances', []):
                instances.append(instance)

        if not instances:
            return f"No EC2 instances found in region {region}."

        result = f"Found {len(instances)} EC2 instance(s) in {region}:\n\n"

        for instance in instances:
            instance_id = instance['InstanceId']
            instance_type = instance['InstanceType']
            state = instance['State']['Name']

            # Get instance name from tags
            name = "N/A"
            for tag in instance.get('Tags', []):
                if tag['Key'] == 'Name':
                    name = tag['Value']
                    break

            # Get IP addresses
            private_ip = instance.get('PrivateIpAddress', 'N/A')
            public_ip = instance.get('PublicIpAddress', 'N/A')

            result += f"• {instance_id} ({name})\n"
            result += f"  Type: {instance_type}\n"
            result += f"  State: {state}\n"
            result += f"  Private IP: {private_ip}\n"
            result += f"  Public IP: {public_ip}\n\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error listing EC2 instances in {region}: {str(e)}"


@tool
def get_ec2_instance_details(instance_id: str, region: str = "us-east-1") -> str:
    """
    Get detailed information about a specific EC2 instance.

    Args:
        instance_id: The EC2 instance ID
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with detailed instance information.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        ec2_client = boto3.client('ec2', region_name=region, config=_BOTO_CONFIG)
        response = ec2_client.describe_instances(InstanceIds=[instance_id])

        if not response.get('Reservations'):
            return f"Instance {instance_id} not found in region {region}."

        instance = response['Reservations'][0]['Instances'][0]

        # Extract key information
        instance_id = instance['InstanceId']
        instance_type = instance['InstanceType']
        state = instance['State']['Name']
        launch_time = instance['LaunchTime'].strftime('%Y-%m-%d %H:%M:%S')

        # Get instance name
        name = "N/A"
        for tag in instance.get('Tags', []):
            if tag['Key'] == 'Name':
                name = tag['Value']
                break

        # Network info
        vpc_id = instance.get('VpcId', 'N/A')
        subnet_id = instance.get('SubnetId', 'N/A')
        private_ip = instance.get('PrivateIpAddress', 'N/A')
        public_ip = instance.get('PublicIpAddress', 'N/A')

        # Security groups
        security_groups = [sg['GroupName'] for sg in instance.get('SecurityGroups', [])]
        sg_list = ', '.join(security_groups) if security_groups else 'N/A'

        # AMI and monitoring
        ami_id = instance.get('ImageId', 'N/A')
        monitoring = instance.get('Monitoring', {}).get('State', 'N/A')

        result = f"""Instance Details:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Instance ID: {instance_id}
Name: {name}
Type: {instance_type}
State: {state}
Launch Time: {launch_time}

Network:
  VPC ID: {vpc_id}
  Subnet ID: {subnet_id}
  Private IP: {private_ip}
  Public IP: {public_ip}
  Security Groups: {sg_list}

Configuration:
  AMI ID: {ami_id}
  Monitoring: {monitoring}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error getting instance details for {instance_id}: {str(e)}"
