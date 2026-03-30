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

// Groups used by configureHelp to render chimera --help in logical sections.
const COMMAND_GROUPS: Record<string, string[]> = {
  'Setup':       ['init', 'deploy', 'endpoints', 'setup'],
  'Operations':  ['status', 'sync', 'upgrade', 'destroy', 'cleanup', 'redeploy', 'monitor'],
  'Auth':        ['login'],
  'Agent':       ['chat', 'session'],
  'Admin':       ['tenant', 'skill'],
  'Diagnostic':  ['doctor', 'completion'],
};

const program = new Command();

program
  .name('chimera')
  .description('AWS Chimera multi-tenant agent platform CLI')
  .version(getVersion())
  .option('--verbose', 'Enable verbose/debug output')
  .option('--debug', 'Alias for --verbose');

// Group help output into logical sections.
program.configureHelp({
  formatHelp: (cmd, helper) => {
    const cmds = helper.visibleCommands(cmd);
    const opts = helper.visibleOptions(cmd);

    // Compute column width so all terms align to the same indent.
    // All term strings are ASCII-only, so .length gives the correct visual width.
    const termWidth = Math.max(
      ...cmds.map(c => helper.subcommandTerm(c).length),
      ...opts.map(o => helper.optionTerm(o).length),
      0,
    ) + 4;

    const fmt = (term: string, desc: string): string =>
      `  ${term.padEnd(termWidth)}${desc}`;

    const lines: string[] = [];

    lines.push(`Usage: ${helper.commandUsage(cmd)}\n`);

    const description = helper.commandDescription(cmd);
    if (description) lines.push(`${description}\n`);

    if (opts.length > 0) {
      lines.push('Options:');
      opts.forEach(o => lines.push(fmt(helper.optionTerm(o), helper.optionDescription(o))));
      lines.push('');
    }

    // Render each group, skipping groups whose commands are not registered.
    const cmdMap = new Map(cmds.map(c => [c.name(), c]));
    const grouped = new Set<string>();

    for (const [groupName, names] of Object.entries(COMMAND_GROUPS)) {
      const groupCmds = names.map(n => cmdMap.get(n)).filter((c): c is Command => !!c);
      if (groupCmds.length === 0) continue;
      groupCmds.forEach(c => grouped.add(c.name()));
      lines.push(`${groupName}:`);
      groupCmds.forEach(c =>
        lines.push(fmt(helper.subcommandTerm(c), helper.commandDescription(c))),
      );
      lines.push('');
    }

    // Any commands not in COMMAND_GROUPS fall through to an "Other" section.
    const ungrouped = cmds.filter(c => !grouped.has(c.name()));
    if (ungrouped.length > 0) {
      lines.push('Other:');
      ungrouped.forEach(c =>
        lines.push(fmt(helper.subcommandTerm(c), helper.commandDescription(c))),
      );
      lines.push('');
    }

    lines.push('Run "chimera [command] --help" for more information about a command.\n');

    return lines.join('\n');
  },
});

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
// Hide deprecated 'connect' alias from help output; 'endpoints' is the canonical command.
// Commander v11 uses ._hidden (checked by Help.visibleCommands); there is no public API.
const connectCmd = program.commands.find(c => c.name() === 'connect');
if (connectCmd) (connectCmd as unknown as { _hidden: boolean })._hidden = true;
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
