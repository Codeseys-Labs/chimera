#!/usr/bin/env bun
/**
 * AWS Chimera - DynamoDB Local Seeder
 *
 * Creates tables and seeds initial test data for local development.
 *
 * Usage:
 *   bun run seed.ts --create-tables     # Create all 6 DynamoDB tables
 *   bun run seed.ts --seed-data         # Seed test data
 *   bun run seed.ts --delete-tables     # Delete all tables
 *   bun run seed.ts                     # Create tables + seed data (default)
 */

import { DynamoDBClient, CreateTableCommand, DeleteTableCommand, ListTablesCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import tenantsData from './tenants.json';
import skillsData from './skills.json';

// DynamoDB Local configuration
const DYNAMODB_ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const dynamoClient = new DynamoDBClient({
  endpoint: DYNAMODB_ENDPOINT,
  region: AWS_REGION,
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
});

// Table definitions (from canonical-data-model.md)
const TABLE_DEFINITIONS = [
  {
    name: 'chimera-tenants-local',
    schema: {
      TableName: 'chimera-tenants-local',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },   // TENANT#{tenantId}
        { AttributeName: 'SK', KeyType: 'RANGE' },  // PROFILE | CONFIG#* | BILLING#* | QUOTA#*
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'tier', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' },
        { AttributeName: 'tenantId', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'tier-index',
          KeySchema: [
            { AttributeName: 'tier', KeyType: 'HASH' },
            { AttributeName: 'tenantId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
        },
        {
          IndexName: 'status-index',
          KeySchema: [
            { AttributeName: 'status', KeyType: 'HASH' },
            { AttributeName: 'tenantId', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
        },
      ],
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
    },
  },
  {
    name: 'chimera-sessions-local',
    schema: {
      TableName: 'chimera-sessions-local',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },   // TENANT#{tenantId}
        { AttributeName: 'SK', KeyType: 'RANGE' },  // SESSION#{sessionId}
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'agentId', AttributeType: 'S' },
        { AttributeName: 'lastActivity', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'agent-activity-index',
          KeySchema: [
            { AttributeName: 'agentId', KeyType: 'HASH' },
            { AttributeName: 'lastActivity', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
        },
      ],
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
      TimeToLiveSpecification: {
        Enabled: true,
        AttributeName: 'ttl',
      },
    },
  },
  {
    name: 'chimera-skills-local',
    schema: {
      TableName: 'chimera-skills-local',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },   // TENANT#{tenantId}
        { AttributeName: 'SK', KeyType: 'RANGE' },  // SKILL#{skillName}
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'skillType', AttributeType: 'S' },
        { AttributeName: 'trustLevel', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'skill-type-index',
          KeySchema: [
            { AttributeName: 'skillType', KeyType: 'HASH' },
            { AttributeName: 'trustLevel', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
        },
      ],
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
    },
  },
  {
    name: 'chimera-rate-limits-local',
    schema: {
      TableName: 'chimera-rate-limits-local',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },   // TENANT#{tenantId}
        { AttributeName: 'SK', KeyType: 'RANGE' },  // LIMIT#{limitType}
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 },
      TimeToLiveSpecification: {
        Enabled: true,
        AttributeName: 'ttl',
      },
    },
  },
  {
    name: 'chimera-cost-tracking-local',
    schema: {
      TableName: 'chimera-cost-tracking-local',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },   // TENANT#{tenantId}
        { AttributeName: 'SK', KeyType: 'RANGE' },  // COST#{YYYY-MM}
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      TimeToLiveSpecification: {
        Enabled: true,
        AttributeName: 'ttl',
      },
    },
  },
  {
    name: 'chimera-audit-local',
    schema: {
      TableName: 'chimera-audit-local',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },   // TENANT#{tenantId}
        { AttributeName: 'SK', KeyType: 'RANGE' },  // AUDIT#{timestamp}#{eventId}
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'eventType', AttributeType: 'S' },
        { AttributeName: 'timestamp', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'event-type-index',
          KeySchema: [
            { AttributeName: 'eventType', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
        },
      ],
      BillingMode: 'PROVISIONED',
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 2 },
      TimeToLiveSpecification: {
        Enabled: true,
        AttributeName: 'ttl',
      },
    },
  },
];

// Helper functions
async function createTables() {
  console.log('🏗️  Creating DynamoDB tables...\n');

  for (const table of TABLE_DEFINITIONS) {
    try {
      await dynamoClient.send(new CreateTableCommand(table.schema));
      console.log(`✅ Created table: ${table.name}`);
    } catch (error: any) {
      if (error.name === 'ResourceInUseException') {
        console.log(`⚠️  Table already exists: ${table.name}`);
      } else {
        console.error(`❌ Failed to create table ${table.name}:`, error.message);
        throw error;
      }
    }
  }

  console.log('\n✅ All tables created successfully\n');
}

async function deleteTables() {
  console.log('🗑️  Deleting DynamoDB tables...\n');

  for (const table of TABLE_DEFINITIONS) {
    try {
      await dynamoClient.send(new DeleteTableCommand({ TableName: table.name }));
      console.log(`✅ Deleted table: ${table.name}`);
    } catch (error: any) {
      if (error.name === 'ResourceNotFoundException') {
        console.log(`⚠️  Table not found: ${table.name}`);
      } else {
        console.error(`❌ Failed to delete table ${table.name}:`, error.message);
      }
    }
  }

  console.log('\n✅ All tables deleted\n');
}

async function listTables() {
  try {
    const result = await dynamoClient.send(new ListTablesCommand({}));
    console.log('\n📊 Current tables:');
    result.TableNames?.forEach((name) => console.log(`  - ${name}`));
    console.log();
  } catch (error: any) {
    console.error('❌ Failed to list tables:', error.message);
  }
}

async function seedTenants() {
  console.log('👥 Seeding tenants...\n');

  for (const tenant of tenantsData) {
    // Create PROFILE item
    const profileItem = {
      PK: `TENANT#${tenant.tenantId}`,
      SK: 'PROFILE',
      tenantId: tenant.tenantId,
      name: tenant.profile.name,
      tier: tenant.profile.tier,
      status: tenant.profile.status,
      billingEmail: tenant.profile.billingEmail,
      technicalContact: tenant.profile.technicalContact,
      createdAt: tenant.profile.createdAt,
    };

    try {
      await dynamoClient.send(
        new PutItemCommand({
          TableName: 'chimera-tenants-local',
          Item: marshall(profileItem),
        })
      );
      console.log(`✅ Seeded tenant profile: ${tenant.profile.name} (${tenant.tenantId})`);
    } catch (error: any) {
      console.error(`❌ Failed to seed tenant ${tenant.tenantId}:`, error.message);
    }

    // Create CONFIG#features item
    const configItem = {
      PK: `TENANT#${tenant.tenantId}`,
      SK: 'CONFIG#features',
      ...tenant.config.features,
      defaultModel: tenant.config.defaultModel,
      memoryStrategy: tenant.config.memoryStrategy,
      rateLimitRpm: tenant.config.rateLimitRpm,
      monthlyQuotaUsd: tenant.config.monthlyQuotaUsd,
      regions: tenant.config.regions,
    };

    try {
      await dynamoClient.send(
        new PutItemCommand({
          TableName: 'chimera-tenants-local',
          Item: marshall(configItem),
        })
      );
    } catch (error: any) {
      console.error(`❌ Failed to seed tenant config ${tenant.tenantId}:`, error.message);
    }

    // Create BILLING#current item
    const billingItem = {
      PK: `TENANT#${tenant.tenantId}`,
      SK: 'BILLING#current',
      plan: tenant.billing.plan,
      monthlySpend: tenant.billing.monthlySpend,
      spendLimit: tenant.billing.spendLimit,
      alertThresholds: tenant.billing.alertThresholds,
      paymentMethod: tenant.billing.paymentMethod,
    };

    try {
      await dynamoClient.send(
        new PutItemCommand({
          TableName: 'chimera-tenants-local',
          Item: marshall(billingItem),
        })
      );
    } catch (error: any) {
      console.error(`❌ Failed to seed tenant billing ${tenant.tenantId}:`, error.message);
    }

    // Create QUOTA items
    const quotaItems = [
      {
        PK: `TENANT#${tenant.tenantId}`,
        SK: 'QUOTA#monthly-tokens',
        resource: 'monthly-tokens',
        limit: tenant.quota.monthlyTokens,
        current: tenant.quota.tokensUsed,
        resetAt: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
        period: 'monthly',
      },
      {
        PK: `TENANT#${tenant.tenantId}`,
        SK: 'QUOTA#concurrent-sessions',
        resource: 'concurrent-sessions',
        limit: tenant.quota.concurrentSessions,
        current: tenant.quota.activeSessions,
        resetAt: null,
        period: 'concurrent',
      },
    ];

    for (const quotaItem of quotaItems) {
      try {
        await dynamoClient.send(
          new PutItemCommand({
            TableName: 'chimera-tenants-local',
            Item: marshall(quotaItem, { removeUndefinedValues: true }),
          })
        );
      } catch (error: any) {
        console.error(`❌ Failed to seed quota for ${tenant.tenantId}:`, error.message);
      }
    }
  }

  console.log('\n✅ All tenants seeded\n');
}

async function seedSkills() {
  console.log('🔧 Seeding skills...\n');

  // Seed skills for test tenant
  const testTenantId = 'tenant-test-001';

  for (const skill of skillsData) {
    const skillItem = {
      PK: `TENANT#${testTenantId}`,
      SK: `SKILL#${skill.name}`,
      skillId: skill.skillId,
      skillName: skill.name,
      displayName: skill.displayName,
      version: skill.version,
      category: skill.category,
      description: skill.description,
      author: skill.author,
      marketplace: skill.marketplace,
      manifest: skill.manifest,
      s3Location: skill.s3Location,
      skillType: 'marketplace',
      trustLevel: skill.marketplace.tier === 'official' ? 'verified' : skill.marketplace.trustLevel,
      enabled: true,
      installedAt: skill.metadata.createdAt,
      installedBy: 'system',
    };

    try {
      await dynamoClient.send(
        new PutItemCommand({
          TableName: 'chimera-skills-local',
          Item: marshall(skillItem),
        })
      );
      console.log(`✅ Seeded skill: ${skill.displayName} (${skill.name})`);
    } catch (error: any) {
      console.error(`❌ Failed to seed skill ${skill.name}:`, error.message);
    }
  }

  console.log('\n✅ All skills seeded\n');
}

async function seedData() {
  console.log('📝 Seeding test data...\n');
  await seedTenants();
  await seedSkills();
  console.log('✅ All data seeded successfully\n');
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const flags = {
    createTables: args.includes('--create-tables'),
    seedData: args.includes('--seed-data'),
    deleteTables: args.includes('--delete-tables'),
    listTables: args.includes('--list-tables'),
  };

  // Default: create tables + seed data if no flags provided
  if (!flags.createTables && !flags.seedData && !flags.deleteTables && !flags.listTables) {
    flags.createTables = true;
    flags.seedData = true;
  }

  console.log('🚀 AWS Chimera - DynamoDB Local Seeder\n');
  console.log(`Endpoint: ${DYNAMODB_ENDPOINT}`);
  console.log(`Region: ${AWS_REGION}\n`);

  try {
    if (flags.deleteTables) {
      await deleteTables();
    }

    if (flags.createTables) {
      await createTables();
      // Wait for tables to be ready
      console.log('⏳ Waiting for tables to be ready...');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (flags.seedData) {
      await seedData();
    }

    if (flags.listTables) {
      await listTables();
    }

    console.log('✅ Done!\n');
    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

main();
