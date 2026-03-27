#!/usr/bin/env node
/**
 * Chimera CLI - Main entry point
 *
 * Provides commands for managing tenants, sessions, skills, and deployments
 * in the AWS Chimera multi-tenant agent platform.
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { registerTenantCommands } from './commands/tenant';
import { registerSessionCommands } from './commands/session';
import { registerSkillCommands } from './commands/skill';
import { registerDeployCommands } from './commands/deploy';
import { registerDestroyCommands } from './commands/destroy';
import { registerConnectCommand } from './commands/connect';
import { registerStatusCommand } from './commands/status';
import { registerSyncCommand } from './commands/sync';
import { registerUpgradeCommand } from './commands/upgrade';
import { registerInitCommand } from './commands/init';
import { registerLoginCommand } from './commands/login';
import { registerChatCommand } from './commands/chat';
import { registerDoctorCommand } from './commands/doctor';
import { color } from './lib/color';

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const program = new Command();

program
  .name('chimera')
  .description('AWS Chimera multi-tenant agent platform CLI')
  .version(getVersion());

// Register command groups
registerTenantCommands(program);
registerSessionCommands(program);
registerSkillCommands(program);
registerDeployCommands(program);
registerDestroyCommands(program);
registerConnectCommand(program);
registerStatusCommand(program);
registerSyncCommand(program);
registerUpgradeCommand(program);
registerInitCommand(program);
registerLoginCommand(program);
registerChatCommand(program);
registerDoctorCommand(program);

// Error handling
program.exitOverride();

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

process.on('unhandledRejection', (err: Error) => {
  console.error(color.red('Error:'), err.message);
  process.exit(1);
});
