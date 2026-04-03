#!/usr/bin/env bun
/**
 * AWS Chimera - Production DynamoDB Seeder
 *
 * Seeds a default admin tenant with tier=premium into real AWS DynamoDB tables.
 * Idempotent: uses ConditionExpression to check-before-write.
 *
 * Usage:
 *   bun run seed-production.ts --region us-west-2 --table-prefix chimera
 *   bun run seed-production.ts --region us-east-1 --table-prefix chimera --env prod
 *
 * Options:
 *   --region <region>         AWS region (default: us-west-2)
 *   --table-prefix <prefix>   Table name prefix (default: chimera)
 *   --env <env>               Environment suffix (default: prod)
 *   --dry-run                 Print what would be written without writing
 */

import { DynamoDBClient, PutItemCommand, type PutItemCommandInput } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(): {
  region: string;
  tablePrefix: string;
  env: string;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let region = 'us-west-2';
  let tablePrefix = 'chimera';
  let env = 'prod';
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--region':
        region = args[++i];
        break;
      case '--table-prefix':
        tablePrefix = args[++i];
        break;
      case '--env':
        env = args[++i];
        break;
      case '--dry-run':
        dryRun = true;
        break;
    }
  }

  return { region, tablePrefix, env, dryRun };
}

// ---------------------------------------------------------------------------
// Default admin tenant definition
// ---------------------------------------------------------------------------
const ADMIN_TENANT_ID = 'tenant-admin-000';

function buildAdminTenantItems(now: string) {
  return {
    profile: {
      PK: `TENANT#${ADMIN_TENANT_ID}`,
      SK: 'PROFILE',
      tenantId: ADMIN_TENANT_ID,
      name: 'Chimera Platform Admin',
      tier: 'premium',
      status: 'active',
      billingEmail: 'platform-admin@chimera.internal',
      technicalContact: 'platform-admin@chimera.internal',
      createdAt: now,
      updatedAt: now,
    },
    config: {
      PK: `TENANT#${ADMIN_TENANT_ID}`,
      SK: 'CONFIG#features',
      selfEvolution: true,
      multiAgent: true,
      skillMarketplace: true,
      mediaProcessing: true,
      infraGeneration: true,
      defaultModel: 'anthropic.claude-sonnet-4-20250514',
      memoryStrategy: 'long-term',
      rateLimitRpm: 100000,
      monthlyQuotaUsd: 10000,
      regions: ['us-west-2', 'us-east-1'],
    },
    billing: {
      PK: `TENANT#${ADMIN_TENANT_ID}`,
      SK: 'BILLING#current',
      plan: 'premium',
      monthlySpend: 0,
      spendLimit: 10000,
      alertThresholds: [80, 95, 100],
      paymentMethod: 'internal',
    },
    costTracking: {
      PK: `TENANT#${ADMIN_TENANT_ID}`,
      SK: `PERIOD#${now.slice(0, 7)}`,
      tenantId: ADMIN_TENANT_ID,
      period: now.slice(0, 7),
      current_spend: 0,
      tier: 'premium',
      quota_limit: 10000,
      services: {},
      updatedAt: now,
    },
  };
}

// ---------------------------------------------------------------------------
// Idempotent writer
// ---------------------------------------------------------------------------
async function putIfNotExists(
  client: DynamoDBClient,
  tableName: string,
  item: Record<string, unknown>,
  label: string,
  dryRun: boolean
): Promise<void> {
  const params: PutItemCommandInput = {
    TableName: tableName,
    Item: marshall(item, { removeUndefinedValues: true }),
    ConditionExpression: 'attribute_not_exists(PK)',
  };

  if (dryRun) {
    console.log(`[DRY RUN] Would write ${label} to ${tableName}`);
    return;
  }

  try {
    await client.send(new PutItemCommand(params));
    console.log(`  Created: ${label}`);
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.log(`  Exists:  ${label} (skipped)`);
    } else {
      console.error(`  FAILED:  ${label} — ${error.message}`);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { region, tablePrefix, env, dryRun } = parseArgs();

  const tenantsTable = `${tablePrefix}-tenants-${env}`;
  const costTable = `${tablePrefix}-cost-tracking-${env}`;

  console.log('Chimera Production Seeder');
  console.log(`  Region:       ${region}`);
  console.log(`  Tenants table: ${tenantsTable}`);
  console.log(`  Cost table:    ${costTable}`);
  console.log(`  Dry run:       ${dryRun}`);
  console.log();

  const client = new DynamoDBClient({ region });
  const now = new Date().toISOString();
  const items = buildAdminTenantItems(now);

  console.log(`Seeding admin tenant: ${ADMIN_TENANT_ID}`);

  await putIfNotExists(client, tenantsTable, items.profile, 'PROFILE', dryRun);
  await putIfNotExists(client, tenantsTable, items.config, 'CONFIG#features', dryRun);
  await putIfNotExists(client, tenantsTable, items.billing, 'BILLING#current', dryRun);
  await putIfNotExists(client, costTable, items.costTracking, `PERIOD#${now.slice(0, 7)}`, dryRun);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
