# AWS Chimera - Local Development Makefile
# Common tasks for local development, testing, and deployment

.PHONY: help install start stop restart logs clean seed test lint typecheck build

# Default target - show help
help:
	@echo "AWS Chimera - Local Development Commands"
	@echo ""
	@echo "Getting Started:"
	@echo "  make install          Install all dependencies"
	@echo "  make start            Start local dev stack (Docker Compose)"
	@echo "  make seed             Seed local databases with test data"
	@echo "  make dev              Run chat-gateway with hot reload"
	@echo ""
	@echo "Development:"
	@echo "  make logs             Follow logs from all services"
	@echo "  make logs-gateway     Follow chat-gateway logs"
	@echo "  make logs-dynamodb    Follow DynamoDB Local logs"
	@echo "  make logs-localstack  Follow LocalStack logs"
	@echo "  make restart          Restart all services"
	@echo "  make stop             Stop all services"
	@echo "  make clean            Stop services and remove volumes"
	@echo ""
	@echo "Testing:"
	@echo "  make test             Run all tests"
	@echo "  make test-unit        Run unit tests only"
	@echo "  make test-integration Run integration tests"
	@echo "  make test-e2e         Run end-to-end tests"
	@echo ""
	@echo "Quality Gates:"
	@echo "  make lint             Run ESLint"
	@echo "  make typecheck        Run TypeScript compiler"
	@echo "  make build            Build all packages"
	@echo "  make check            Run all quality gates (lint + typecheck + test)"
	@echo ""
	@echo "Database:"
	@echo "  make db-admin         Open DynamoDB Admin UI (http://localhost:8001)"
	@echo "  make db-tables        List all DynamoDB tables"
	@echo "  make db-reset         Delete and recreate all tables"
	@echo ""
	@echo "AWS LocalStack:"
	@echo "  make aws-buckets      List all S3 buckets"
	@echo "  make aws-queues       List all SQS queues"
	@echo "  make aws-events       List EventBridge event buses"
	@echo ""
	@echo "Utilities:"
	@echo "  make env              Create .env from .env.example (if missing)"
	@echo "  make doctor           Run health checks"
	@echo "  make version          Show version info"

# ============================================================================
# Installation
# ============================================================================

install:
	@echo "📦 Installing dependencies..."
	bun install
	@echo "✅ Dependencies installed"

env:
	@if [ ! -f .env ]; then \
		echo "📝 Creating .env from .env.example..."; \
		cp .env.example .env; \
		echo "✅ .env created - edit as needed"; \
	else \
		echo "⚠️  .env already exists - not overwriting"; \
	fi

# ============================================================================
# Docker Services
# ============================================================================

start: env
	@echo "🚀 Starting local dev stack..."
	docker-compose up -d
	@echo "⏳ Waiting for services to be healthy..."
	@sleep 5
	@docker-compose ps
	@echo ""
	@echo "✅ Services started:"
	@echo "   DynamoDB Local:  http://localhost:8000"
	@echo "   DynamoDB Admin:  http://localhost:8001"
	@echo "   LocalStack:      http://localhost:4566"
	@echo ""
	@echo "Next steps:"
	@echo "  make seed        # Seed databases with test data"
	@echo "  make dev         # Run chat-gateway with hot reload"

stop:
	@echo "🛑 Stopping local dev stack..."
	docker-compose down
	@echo "✅ Services stopped"

restart: stop start

clean:
	@echo "🗑️  Stopping services and removing volumes..."
	docker-compose down -v
	@echo "✅ Clean complete"

logs:
	docker-compose logs -f

logs-gateway:
	docker-compose logs -f chat-gateway

logs-dynamodb:
	docker-compose logs -f dynamodb-local

logs-localstack:
	docker-compose logs -f localstack

# ============================================================================
# Development
# ============================================================================

dev:
	@echo "🔥 Starting chat-gateway with hot reload..."
	@echo "   Server: http://localhost:8080"
	@echo "   Health: http://localhost:8080/health"
	@echo ""
	cd packages/chat-gateway && bun run dev

dev-all:
	@echo "🔥 Starting all services with hot reload..."
	@echo "   This will run: make start + make dev in parallel"
	@make start
	@make dev

# ============================================================================
# Database Seeding
# ============================================================================

seed: seed-tables seed-data

seed-tables:
	@echo "📊 Creating DynamoDB tables..."
	@cd seed-data && bun run seed.ts --create-tables
	@echo "✅ Tables created"

seed-data:
	@echo "📝 Seeding test data..."
	@cd seed-data && bun run seed.ts --seed-data
	@echo "✅ Test data seeded"

seed-reset: db-reset seed

# ============================================================================
# Database Management
# ============================================================================

db-admin:
	@echo "🌐 Opening DynamoDB Admin UI..."
	@open http://localhost:8001 || xdg-open http://localhost:8001 2>/dev/null || echo "Open http://localhost:8001 in your browser"

db-tables:
	@echo "📊 Listing DynamoDB tables..."
	@aws dynamodb list-tables --endpoint-url http://localhost:8000 --output table

db-reset:
	@echo "🗑️  Deleting all tables..."
	@cd seed-data && bun run seed.ts --delete-tables
	@echo "✅ Tables deleted"

# ============================================================================
# AWS LocalStack Management
# ============================================================================

aws-buckets:
	@echo "🪣 Listing S3 buckets..."
	@aws s3 ls --endpoint-url http://localhost:4566

aws-queues:
	@echo "📬 Listing SQS queues..."
	@aws sqs list-queues --endpoint-url http://localhost:4566 --output table

aws-events:
	@echo "📡 Listing EventBridge event buses..."
	@aws events list-event-buses --endpoint-url http://localhost:4566 --output table

# ============================================================================
# Testing
# ============================================================================

test: test-unit

test-unit:
	@echo "🧪 Running unit tests..."
	bun test

test-integration:
	@echo "🔗 Running integration tests..."
	cd tests && bun run test:integration

test-e2e:
	@echo "🌐 Running end-to-end tests..."
	cd tests && bun run test:e2e

test-load:
	@echo "⚡ Running load tests..."
	cd tests && bun run test:load

# ============================================================================
# Quality Gates
# ============================================================================

lint:
	@echo "🔍 Running ESLint..."
	bun run lint

typecheck:
	@echo "🔧 Running TypeScript compiler..."
	bun run typecheck

build:
	@echo "🏗️  Building all packages..."
	bun run build

check: lint typecheck test
	@echo "✅ All quality gates passed"

# ============================================================================
# Utilities
# ============================================================================

doctor:
	@echo "🩺 Running health checks..."
	@echo ""
	@echo "Docker services:"
	@docker-compose ps
	@echo ""
	@echo "DynamoDB Local:"
	@curl -s http://localhost:8000/ > /dev/null && echo "  ✅ Healthy" || echo "  ❌ Not reachable"
	@echo ""
	@echo "LocalStack:"
	@curl -s http://localhost:4566/_localstack/health | grep -q '"dynamodb": "available"' && echo "  ✅ Healthy" || echo "  ❌ Not reachable"
	@echo ""
	@echo "Environment:"
	@test -f .env && echo "  ✅ .env exists" || echo "  ⚠️  .env missing (run: make env)"
	@echo ""
	@echo "Dependencies:"
	@test -d node_modules && echo "  ✅ node_modules exists" || echo "  ⚠️  node_modules missing (run: make install)"

version:
	@echo "AWS Chimera Local Development Stack"
	@echo ""
	@echo "Versions:"
	@echo "  Bun:        $(shell bun --version)"
	@echo "  Node:       $(shell node --version)"
	@echo "  TypeScript: $(shell bunx tsc --version)"
	@echo "  Docker:     $(shell docker --version)"
	@echo ""
	@echo "Package version: $(shell cat package.json | grep '"version"' | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')"

.DEFAULT_GOAL := help
