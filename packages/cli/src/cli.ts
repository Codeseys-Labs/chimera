#!/usr/bin/env node
/**
 * Chimera CLI - Main entry point
 *
 * Provides commands for managing tenants, sessions, skills, and deployments
 * in the AWS Chimera multi-tenant agent platform.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { registerTenantCommands } from './commands/tenant';
import { registerSessionCommands } from './commands/session';
import { registerSkillCommands } from './commands/skill';
import { registerDeployCommands } from './commands/deploy';

const program = new Command();

program
  .name('chimera')
  .description('AWS Chimera multi-tenant agent platform CLI')
  .version('0.1.0');

// Register command groups
registerTenantCommands(program);
registerSessionCommands(program);
registerSkillCommands(program);
registerDeployCommands(program);

// Error handling
program.exitOverride();

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

process.on('unhandledRejection', (err: Error) => {
  console.error(chalk.red('Error:'), err.message);
  process.exit(1);
});
