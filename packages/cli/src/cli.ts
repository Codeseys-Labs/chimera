#!/usr/bin/env node
/**
 * Chimera CLI - Main entry point
 *
 * Provides commands for managing tenants, sessions, skills, and deployments
 * in the AWS Chimera multi-tenant agent platform.
 */

import { Command, CommanderError } from 'commander';
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
import { registerSetupCommand } from './commands/setup';
import { registerLoginCommand } from './commands/login';
import { registerChatCommand } from './commands/chat';
import { registerDoctorCommand } from './commands/doctor';
import { registerMonitorCommand } from './commands/monitor';
import { registerCompletionCommand } from './commands/completion';
import { color } from './lib/color';

// Version embedded at build time via `bun build --define '__CHIMERA_VERSION__="x.y.z"'`.
// Falls back to reading package.json in dev mode (bun run src/cli.ts).
declare const __CHIMERA_VERSION__: string | undefined;

function getVersion(): string {
  if (typeof __CHIMERA_VERSION__ !== 'undefined') {
    return __CHIMERA_VERSION__;
  }
  try {
    const pkgPath = path.join(import.meta.dir, '../package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Command groups for grouped help output
const COMMAND_GROUPS: Array<{ label: string; names: string[] }> = [
  { label: 'Setup', names: ['init', 'deploy', 'endpoints', 'setup'] },
  { label: 'Operations', names: ['status', 'sync', 'upgrade', 'destroy', 'monitor'] },
  { label: 'Auth', names: ['login'] },
  { label: 'Data', names: ['tenant', 'session', 'skill', 'chat'] },
  { label: 'Diagnostic', names: ['doctor', 'completion'] },
];

const program = new Command();

program
  .name('chimera')
  .description('AWS Chimera multi-tenant agent platform CLI')
  .version(getVersion())
  .option('--verbose', 'Enable verbose/debug output')
  .option('--debug', 'Alias for --verbose');

// Propagate verbose/debug to CHIMERA_DEBUG before each command runs.
// api-client.ts and other modules gate debug stderr on process.env.CHIMERA_DEBUG.
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts() as { verbose?: boolean; debug?: boolean };
  if (opts.verbose ?? opts.debug) {
    process.env.CHIMERA_DEBUG = '1';
  }
});

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
registerSetupCommand(program);
registerLoginCommand(program);
registerChatCommand(program);
registerDoctorCommand(program);
registerMonitorCommand(program);
registerCompletionCommand(program);

// Custom grouped help formatter (Commander v11 compatible)
program.configureHelp({
  formatHelp(cmd, helper) {
    const width = helper.helpWidth ?? process.stdout.columns ?? 80;

    // Build a map of visible commands by name
    const cmdMap = new Map<string, Command>(
      helper.visibleCommands(cmd).map((c) => [c.name(), c]),
    );

    // Compute column width: longest visible subcommand term + padding
    let maxTerm = 0;
    for (const c of cmdMap.values()) {
      const t = helper.subcommandTerm(c);
      if (t.length > maxTerm) maxTerm = t.length;
    }
    // Also account for option terms
    for (const o of helper.visibleOptions(cmd)) {
      const t = helper.optionTerm(o);
      if (t.length > maxTerm) maxTerm = t.length;
    }
    const col = Math.min(maxTerm + 2, Math.floor(width / 3));
    const indent = '  ';
    const gap = '  ';

    const line = (term: string, desc: string): string => {
      const padded = term.padEnd(col);
      // Wrap description if it would exceed terminal width
      const available = width - indent.length - col - gap.length;
      if (available > 0 && desc.length > available) {
        return `${indent}${padded}${gap}${desc.slice(0, available - 3)}...`;
      }
      return `${indent}${padded}${gap}${desc}`;
    };

    const parts: string[] = [];

    // Usage
    parts.push(`Usage: ${helper.commandUsage(cmd)}\n`);

    // Description
    const desc = helper.commandDescription(cmd);
    if (desc) parts.push(`${desc}\n`);

    // Options
    const opts = helper.visibleOptions(cmd);
    if (opts.length) {
      parts.push('Options:');
      for (const o of opts) {
        parts.push(line(helper.optionTerm(o), helper.optionDescription(o)));
      }
      parts.push('');
    }

    // Grouped commands
    const placed = new Set<string>();
    for (const group of COMMAND_GROUPS) {
      const cmds = group.names
        .map((n) => cmdMap.get(n))
        .filter((c): c is Command => !!c);
      if (!cmds.length) continue;

      parts.push(`${group.label}:`);
      for (const c of cmds) {
        parts.push(line(helper.subcommandTerm(c), helper.subcommandDescription(c)));
        placed.add(c.name());
      }
      parts.push('');
    }

    // Safety net: any ungrouped visible commands
    const ungrouped = [...cmdMap.values()].filter((c) => !placed.has(c.name()));
    if (ungrouped.length) {
      parts.push('Other:');
      for (const c of ungrouped) {
        parts.push(line(helper.subcommandTerm(c), helper.subcommandDescription(c)));
      }
      parts.push('');
    }

    parts.push('Run "chimera [command] --help" for more information about a command.\n');

    return parts.join('\n');
  },
});

// exitOverride() converts Commander's process.exit() into thrown CommanderError.
// Exit code semantics: 0 = success (help/version), 2 = usage error, 1 = runtime.
program.exitOverride();

try {
  program.parse(process.argv);
} catch (err) {
  if (err instanceof CommanderError) {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      process.exit(0);
    }
    process.exit(err.exitCode ?? 2);
  }
  throw err;
}

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

process.on('unhandledRejection', (err: Error) => {
  console.error(color.red('Error:'), err.message);
  process.exit(1);
});
