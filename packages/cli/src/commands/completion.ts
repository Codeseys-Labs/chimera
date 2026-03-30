/**
 * chimera completion — Output shell completion scripts for bash, zsh, or fish.
 *
 * Usage:
 *   chimera completion bash   → add to ~/.bashrc or eval "$(chimera completion bash)"
 *   chimera completion zsh    → add to ~/.zshrc or save to ~/.zfunc/_chimera
 *   chimera completion fish   → chimera completion fish | source
 */

import { Command } from 'commander';

const BASH_SCRIPT = `
_chimera_completions() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  local commands="init deploy endpoints setup status sync upgrade destroy cleanup redeploy monitor login chat session tenant skill doctor completion help"

  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  case "\${prev}" in
    session)
      COMPREPLY=( $(compgen -W "create list terminate" -- "\${cur}") )
      ;;
    tenant)
      COMPREPLY=( $(compgen -W "create list use delete" -- "\${cur}") )
      ;;
    skill)
      COMPREPLY=( $(compgen -W "list install enable disable uninstall" -- "\${cur}") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
      ;;
    --region|--env)
      COMPREPLY=()
      ;;
    *)
      COMPREPLY=( $(compgen -W "--help --verbose --debug --version" -- "\${cur}") )
      ;;
  esac
}

complete -F _chimera_completions chimera
`.trim();

const ZSH_SCRIPT = `
#compdef chimera

_chimera() {
  local context state line
  typeset -A opt_args

  _arguments \\
    '(-V --version)'{-V,--version}'[Output the version number]' \\
    '--verbose[Enable verbose/debug output]' \\
    '--debug[Alias for --verbose]' \\
    '(-h --help)'{-h,--help}'[Display help]' \\
    '1:command:_chimera_commands' \\
    '*::args:_chimera_subcommand'
}

_chimera_commands() {
  local -a commands
  commands=(
    'init:Initialize chimera workspace'
    'deploy:Deploy Chimera to AWS'
    'endpoints:Fetch deployed API endpoints and save to config'
    'setup:Provision admin user in Cognito after deployment'
    'status:Check Chimera deployment health and status'
    'sync:Apply upstream GitHub changes to CodeCommit'
    'upgrade:Upgrade CLI to the latest version'
    'destroy:Tear down all Chimera stacks from AWS'
    'cleanup:Delete stacks stuck in ROLLBACK_COMPLETE state'
    'redeploy:Clean up failed stacks then retry CDK deployment'
    'monitor:Watch active CloudFormation stack operations'
    'login:Authenticate with the Chimera platform'
    'chat:Start an interactive chat session'
    'session:Manage agent sessions'
    'tenant:Manage Chimera tenants'
    'skill:Manage agent skills'
    'doctor:Run pre-flight checks for the Chimera platform'
    'completion:Output shell completion script'
  )
  _describe 'command' commands
}

_chimera_subcommand() {
  case "\${words[1]}" in
    session)
      local -a subcmds
      subcmds=(
        'create:Create a new agent session'
        'list:List active sessions'
        'terminate:Terminate an active session'
      )
      _describe 'session subcommand' subcmds
      ;;
    tenant)
      local -a subcmds
      subcmds=(
        'create:Create a new tenant'
        'list:List all tenants'
        'use:Switch to a different tenant'
        'delete:Delete a tenant'
      )
      _describe 'tenant subcommand' subcmds
      ;;
    skill)
      local -a subcmds
      subcmds=(
        'list:List installed skills'
        'install:Install a skill from the marketplace'
        'enable:Enable an installed skill'
        'disable:Disable a skill'
        'uninstall:Uninstall a skill'
      )
      _describe 'skill subcommand' subcmds
      ;;
    completion)
      local -a subcmds
      subcmds=(
        'bash:Output bash completion script'
        'zsh:Output zsh completion script'
        'fish:Output fish completion script'
      )
      _describe 'completion subcommand' subcmds
      ;;
  esac
}

_chimera "$@"
`.trim();

const FISH_SCRIPT = `
# chimera shell completions for fish
# Install: chimera completion fish | source
# Or save: chimera completion fish > ~/.config/fish/completions/chimera.fish

# Disable file completion for chimera
complete -c chimera -f

# Helper: true when no subcommand has been given yet
function __chimera_no_subcommand
  set -l cmd (commandline -poc)
  for sub in init deploy endpoints setup status sync upgrade destroy cleanup redeploy monitor login chat session tenant skill doctor completion help
    if contains -- $sub $cmd
      return 1
    end
  end
  return 0
end

# Top-level commands
complete -c chimera -n '__chimera_no_subcommand' -a init       -d 'Initialize chimera workspace'
complete -c chimera -n '__chimera_no_subcommand' -a deploy     -d 'Deploy Chimera to AWS'
complete -c chimera -n '__chimera_no_subcommand' -a endpoints  -d 'Fetch deployed API endpoints'
complete -c chimera -n '__chimera_no_subcommand' -a setup      -d 'Provision admin user after deployment'
complete -c chimera -n '__chimera_no_subcommand' -a status     -d 'Check deployment health and status'
complete -c chimera -n '__chimera_no_subcommand' -a sync       -d 'Apply upstream GitHub changes'
complete -c chimera -n '__chimera_no_subcommand' -a upgrade    -d 'Upgrade CLI to the latest version'
complete -c chimera -n '__chimera_no_subcommand' -a destroy    -d 'Tear down all Chimera stacks'
complete -c chimera -n '__chimera_no_subcommand' -a cleanup    -d 'Delete stacks in ROLLBACK_COMPLETE'
complete -c chimera -n '__chimera_no_subcommand' -a redeploy   -d 'Clean up and retry CDK deployment'
complete -c chimera -n '__chimera_no_subcommand' -a monitor    -d 'Watch CloudFormation stack operations'
complete -c chimera -n '__chimera_no_subcommand' -a login      -d 'Authenticate with the Chimera platform'
complete -c chimera -n '__chimera_no_subcommand' -a chat       -d 'Start an interactive chat session'
complete -c chimera -n '__chimera_no_subcommand' -a session    -d 'Manage agent sessions'
complete -c chimera -n '__chimera_no_subcommand' -a tenant     -d 'Manage Chimera tenants'
complete -c chimera -n '__chimera_no_subcommand' -a skill      -d 'Manage agent skills'
complete -c chimera -n '__chimera_no_subcommand' -a doctor     -d 'Run pre-flight checks'
complete -c chimera -n '__chimera_no_subcommand' -a completion -d 'Output shell completion script'

# Global flags
complete -c chimera -l verbose -d 'Enable verbose/debug output'
complete -c chimera -l debug   -d 'Alias for --verbose'
complete -c chimera -s V -l version -d 'Output the version number'
complete -c chimera -s h -l help    -d 'Display help'

# session subcommands
complete -c chimera -n '__fish_seen_subcommand_from session' -a create    -d 'Create a new agent session'
complete -c chimera -n '__fish_seen_subcommand_from session' -a list      -d 'List active sessions'
complete -c chimera -n '__fish_seen_subcommand_from session' -a terminate -d 'Terminate an active session'

# tenant subcommands
complete -c chimera -n '__fish_seen_subcommand_from tenant' -a create -d 'Create a new tenant'
complete -c chimera -n '__fish_seen_subcommand_from tenant' -a list   -d 'List all tenants'
complete -c chimera -n '__fish_seen_subcommand_from tenant' -a use    -d 'Switch to a different tenant'
complete -c chimera -n '__fish_seen_subcommand_from tenant' -a delete -d 'Delete a tenant'

# skill subcommands
complete -c chimera -n '__fish_seen_subcommand_from skill' -a list      -d 'List installed skills'
complete -c chimera -n '__fish_seen_subcommand_from skill' -a install   -d 'Install a skill'
complete -c chimera -n '__fish_seen_subcommand_from skill' -a enable    -d 'Enable a skill'
complete -c chimera -n '__fish_seen_subcommand_from skill' -a disable   -d 'Disable a skill'
complete -c chimera -n '__fish_seen_subcommand_from skill' -a uninstall -d 'Uninstall a skill'

# completion subcommands
complete -c chimera -n '__fish_seen_subcommand_from completion' -a bash -d 'Output bash completion script'
complete -c chimera -n '__fish_seen_subcommand_from completion' -a zsh  -d 'Output zsh completion script'
complete -c chimera -n '__fish_seen_subcommand_from completion' -a fish -d 'Output fish completion script'
`.trim();

const SHELL_SCRIPTS: Record<string, string> = {
  bash: BASH_SCRIPT,
  zsh: ZSH_SCRIPT,
  fish: FISH_SCRIPT,
};

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion')
    .description('Output shell completion script for bash, zsh, or fish')
    .argument('<shell>', 'Shell type: bash, zsh, or fish')
    .action((shell: string) => {
      const script = SHELL_SCRIPTS[shell];
      if (!script) {
        console.error(`Unknown shell: ${shell}. Supported: bash, zsh, fish`);
        process.exit(1);
      }
      console.log(script);
    });
}
