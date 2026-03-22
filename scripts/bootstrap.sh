#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# AWS Chimera Bootstrap Script
# ============================================================================
#
# Prepares a new AWS account for Chimera deployment by:
# - Checking prerequisites (AWS CLI, CDK, Bun, Docker)
# - Configuring environment variables
# - Bootstrapping CDK
# - Creating required secrets
# - Deploying all 11 CDK stacks
# - Running post-deployment verification
#
# Usage:
#   ./scripts/bootstrap.sh [environment] [region]
#
# Examples:
#   ./scripts/bootstrap.sh dev us-west-2
#   ./scripts/bootstrap.sh prod us-east-1
#
# Prerequisites:
#   - AWS credentials configured (aws configure or AWS_ACCESS_KEY_ID/SECRET)
#   - AWS CLI v2.15+
#   - Node.js 20.x
#   - Bun 1.0.30+
#   - aws-cdk in devDependencies (used via bunx, not globally installed)
#   - Docker 24+ (optional - only needed for ChatStack deployment)
#
# ============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="${1:-dev}"
AWS_REGION="${2:-us-west-2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ============================================================================
# Helper Functions
# ============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    local cmd="$1"
    local required_version="${2:-}"

    if ! command -v "$cmd" &> /dev/null; then
        log_error "$cmd is not installed"
        return 1
    fi

    local installed_version
    installed_version=$("$cmd" --version 2>&1 | head -n1 || echo "unknown")
    log_success "$cmd found: $installed_version"

    if [[ -n "$required_version" ]]; then
        log_info "Required: $required_version"
    fi

    return 0
}

prompt_continue() {
    local message="$1"
    echo -e "${YELLOW}$message${NC}"
    read -p "Continue? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warn "Bootstrap cancelled by user"
        exit 0
    fi
}

# ============================================================================
# Step 1: Check Prerequisites
# ============================================================================

log_info "=========================================="
log_info "Chimera Bootstrap - Environment: $ENVIRONMENT"
log_info "=========================================="
echo

log_info "Step 1: Checking prerequisites..."
echo

PREREQ_FAILED=0

check_command "aws" "v2.15+" || PREREQ_FAILED=1
check_command "node" "20.x" || PREREQ_FAILED=1
check_command "bun" "1.0.30+" || PREREQ_FAILED=1

# Docker is optional - only required for container stacks (ChatStack)
DOCKER_AVAILABLE=0
if check_command "docker" "24+"; then
    DOCKER_AVAILABLE=1
    log_info "Docker available - will deploy all stacks including ChatStack"
else
    log_warn "Docker not available - will skip ChatStack (ECS Fargate)"
    log_info "You can deploy infra-only now and add ChatStack later after installing Docker"
fi

if [[ $PREREQ_FAILED -eq 1 ]]; then
    log_error "Prerequisites check failed. Install missing tools and try again."
    echo
    log_info "Installation guides:"
    echo "  AWS CLI:  https://aws.amazon.com/cli/"
    echo "  Node.js:  https://nodejs.org/ or use mise (https://mise.jdx.dev/)"
    echo "  Bun:      https://bun.sh/docs/installation"
    echo "  Docker:   https://docs.docker.com/get-docker/ (optional, only needed for ChatStack)"
    exit 1
fi

log_success "All prerequisites met"
echo

# ============================================================================
# Step 2: Verify AWS Credentials
# ============================================================================

log_info "Step 2: Verifying AWS credentials..."
echo

if ! aws sts get-caller-identity &> /dev/null; then
    log_error "AWS credentials not configured or invalid"
    log_info "Run 'aws configure' or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY"
    exit 1
fi

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_USER_ARN=$(aws sts get-caller-identity --query Arn --output text)

log_success "AWS Account ID: $AWS_ACCOUNT_ID"
log_success "AWS User/Role: $AWS_USER_ARN"
log_success "AWS Region: $AWS_REGION"
echo

prompt_continue "You are about to deploy Chimera to AWS account $AWS_ACCOUNT_ID in region $AWS_REGION."

# ============================================================================
# Step 3: Set Environment Variables
# ============================================================================

log_info "Step 3: Setting environment variables..."
echo

export CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT_ID"
export CDK_DEFAULT_REGION="$AWS_REGION"
export ENVIRONMENT="$ENVIRONMENT"

log_success "CDK_DEFAULT_ACCOUNT=$CDK_DEFAULT_ACCOUNT"
log_success "CDK_DEFAULT_REGION=$CDK_DEFAULT_REGION"
log_success "ENVIRONMENT=$ENVIRONMENT"
echo

# ============================================================================
# Step 4: Install Dependencies
# ============================================================================

log_info "Step 4: Installing dependencies..."
echo

cd "$REPO_ROOT"

if [[ -f ".mise.toml" ]] && command -v mise &> /dev/null; then
    log_info "Installing mise runtimes..."
    mise install
fi

log_info "Installing npm packages with Bun..."
bun install

log_success "Dependencies installed"
echo

# ============================================================================
# Step 5: Bootstrap CDK
# ============================================================================

log_info "Step 5: Bootstrapping CDK..."
echo

cd "$REPO_ROOT/infra"

if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$AWS_REGION" &> /dev/null; then
    log_warn "CDK already bootstrapped in this account/region"
else
    log_info "Bootstrapping CDK in $AWS_ACCOUNT_ID / $AWS_REGION..."
    bunx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}"
    log_success "CDK bootstrap complete"
fi

echo

# ============================================================================
# Step 6: Create Required Secrets
# ============================================================================

log_info "Step 6: Setting up AWS Secrets Manager secrets..."
echo

# GitHub connection token (optional, for CI/CD pipeline)
if ! aws secretsmanager describe-secret --secret-id chimera-github-token --region "$AWS_REGION" &> /dev/null; then
    log_warn "GitHub token secret not found"
    log_info "Skipping GitHub token setup (can be added later for CI/CD pipeline)"
    log_info "To add later: aws secretsmanager create-secret --name chimera-github-token --secret-string 'your-token' --region $AWS_REGION"
else
    log_success "GitHub token secret exists"
fi

echo

# ============================================================================
# Step 7: Synthesize CDK Stacks
# ============================================================================

log_info "Step 7: Synthesizing CDK stacks..."
echo

bunx cdk synth --quiet

log_success "CDK synthesis complete - all stacks validated"
echo

# ============================================================================
# Step 8: Deploy CDK Stacks
# ============================================================================

log_info "Step 8: Deploying CDK stacks (this will take 15-30 minutes)..."
echo

log_info "Deployment order:"
echo "  1. NetworkStack           - VPC, subnets, NAT gateways"
echo "  2. DataStack              - DynamoDB tables, S3 buckets"
echo "  3. SecurityStack          - Cognito, KMS, WAF"
echo "  4. ObservabilityStack     - CloudWatch, alarms"
echo "  5. ApiStack               - API Gateway REST + WebSocket"
echo "  6. SkillPipelineStack     - Skill security scanning"
if [[ $DOCKER_AVAILABLE -eq 1 ]]; then
    echo "  7. ChatStack              - ECS Fargate chat service"
else
    echo "  7. ChatStack              - SKIPPED (Docker not available)"
fi
echo "  8. OrchestrationStack     - EventBridge, SQS queues"
echo "  9. EvolutionStack         - Self-evolution engine"
echo "  10. TenantOnboardingStack - Tenant provisioning"
echo "  11. PipelineStack         - CI/CD pipeline"
echo

if [[ $DOCKER_AVAILABLE -eq 1 ]]; then
    prompt_continue "Ready to deploy all 11 stacks?"
    log_info "Deploying all stacks (--require-approval never)..."
    bunx cdk deploy --all --require-approval never \
        --context environment="$ENVIRONMENT" \
        --context region="$AWS_REGION"
else
    prompt_continue "Ready to deploy 10 stacks (excluding ChatStack)?"
    log_info "Deploying stacks (--require-approval never)..."
    bunx cdk deploy \
        Chimera-${ENVIRONMENT}-Network \
        Chimera-${ENVIRONMENT}-Data \
        Chimera-${ENVIRONMENT}-Security \
        Chimera-${ENVIRONMENT}-Observability \
        Chimera-${ENVIRONMENT}-Api \
        Chimera-${ENVIRONMENT}-SkillPipeline \
        Chimera-${ENVIRONMENT}-Orchestration \
        Chimera-${ENVIRONMENT}-Evolution \
        Chimera-${ENVIRONMENT}-TenantOnboarding \
        Chimera-${ENVIRONMENT}-Pipeline \
        --require-approval never \
        --context environment="$ENVIRONMENT" \
        --context region="$AWS_REGION"
fi

if [[ $DOCKER_AVAILABLE -eq 1 ]]; then
    log_success "All 11 stacks deployed successfully"
else
    log_success "10 stacks deployed successfully (ChatStack skipped - install Docker and run 'bunx cdk deploy ChatStack' to add it later)"
fi
echo

# ============================================================================
# Step 9: Verify Deployment
# ============================================================================

log_info "Step 9: Verifying deployment..."
echo

# Check DynamoDB tables
log_info "Checking DynamoDB tables..."
TABLES=$(aws dynamodb list-tables --region "$AWS_REGION" --query 'TableNames[?contains(@, `chimera-`)]' --output text | wc -w)
if [[ "$TABLES" -eq 6 ]]; then
    log_success "All 6 DynamoDB tables created"
else
    log_warn "Expected 6 DynamoDB tables, found $TABLES"
fi

# Check S3 buckets
log_info "Checking S3 buckets..."
BUCKETS=$(aws s3 ls | grep -c "chimera-" || true)
if [[ "$BUCKETS" -ge 3 ]]; then
    log_success "At least 3 S3 buckets created"
else
    log_warn "Expected at least 3 S3 buckets, found $BUCKETS"
fi

# Check VPC
log_info "Checking VPC..."
VPC_ID=$(aws ec2 describe-vpcs --region "$AWS_REGION" --filters "Name=tag:Project,Values=Chimera" --query 'Vpcs[0].VpcId' --output text)
if [[ "$VPC_ID" != "None" && -n "$VPC_ID" ]]; then
    log_success "VPC created: $VPC_ID"
else
    log_warn "VPC not found"
fi

# Check ECS cluster (only if Docker was available)
if [[ $DOCKER_AVAILABLE -eq 1 ]]; then
    log_info "Checking ECS cluster..."
    ECS_CLUSTER=$(aws ecs describe-clusters --region "$AWS_REGION" --clusters "chimera-${ENVIRONMENT}-chat" --query 'clusters[0].status' --output text 2>/dev/null || echo "NOT_FOUND")
    if [[ "$ECS_CLUSTER" == "ACTIVE" ]]; then
        log_success "ECS cluster is ACTIVE"
    else
        log_warn "ECS cluster not active: $ECS_CLUSTER"
    fi
else
    log_info "Skipping ECS cluster check (ChatStack was not deployed)"
fi

echo

# ============================================================================
# Step 10: Display Stack Outputs
# ============================================================================

log_info "Step 10: Retrieving stack outputs..."
echo

log_info "API Gateway endpoints:"
aws cloudformation describe-stacks --stack-name "Chimera-${ENVIRONMENT}-Api" --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?contains(OutputKey, `Url`)].[OutputKey,OutputValue]' \
    --output table 2>/dev/null || log_warn "Could not retrieve API stack outputs"

echo

log_info "DynamoDB table names:"
aws cloudformation describe-stacks --stack-name "Chimera-${ENVIRONMENT}-Data" --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?contains(OutputKey, `TableName`)].[OutputKey,OutputValue]' \
    --output table 2>/dev/null || log_warn "Could not retrieve Data stack outputs"

echo

# ============================================================================
# Bootstrap Complete
# ============================================================================

log_success "=========================================="
log_success "Bootstrap Complete!"
log_success "=========================================="
echo

log_info "Next steps:"
echo "  1. Create your first tenant:"
echo "     chimera tenant create --name 'Test Tenant' --tier basic --admin-email admin@example.com"
echo
echo "  2. Test the API:"
echo "     curl https://\$(aws cloudformation describe-stacks --stack-name Chimera-${ENVIRONMENT}-Api --query 'Stacks[0].Outputs[?OutputKey==\`RestApiUrl\`].OutputValue' --output text --region $AWS_REGION)/health"
echo
echo "  3. View CloudWatch dashboard:"
echo "     https://console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#dashboards:name=Chimera-Platform"
echo
echo "  4. Run integration tests:"
echo "     cd $REPO_ROOT && bun run test:integration --env $ENVIRONMENT"
echo

log_info "For more information, see:"
echo "  - Deployment Guide: docs/guide/deployment.md"
echo "  - Architecture Overview: docs/guide/architecture.md"
echo "  - Troubleshooting: docs/guide/deployment.md#troubleshooting"
echo

log_success "Chimera is ready! 🔥"
