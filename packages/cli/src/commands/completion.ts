/**
 * Shell completion command — generate tab-completion scripts for bash/zsh/fish
 *
 * Usage:
 *   chimera completion bash   >> ~/.bashrc
 *   chimera completion zsh    >> ~/.zshrc
 *   chimera completion fish   > ~/.config/fish/completions/chimera.fish
 */

import { Command } from 'commander';
import { color } from '../lib/color.js';

const TOP_LEVEL_COMMANDS = [
  'init', 'deploy', 'endpoints', 'setup',
  'status', 'sync', 'upgrade', 'destroy', 'monitor',
  'login', 'tenant', 'session', 'skill', 'chat',
  'doctor', 'completion',
];

const BASH_SCRIPT = `
# chimera bash completion
_chimera_completions() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  }

  local commands="${TOP_LEVEL_COMMANDS.join(' ')}"

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi

  case "$prev" in
    tenant)
      COMPREPLY=( $(compgen -W "create list switch delete" -- "$cur") )
      ;;
    session)
      COMPREPLY=( $(compgen -W "create list get delete" -- "$cur") )
      ;;
    skill)
      COMPREPLY=( $(compgen -W "list install enable disable uninstall" -- "$cur") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      ;;
    --region)
      COMPREPLY=( $(compgen -W "us-east-1 us-west-2 eu-west-1 ap-southeast-1" -- "$cur") )
      ;;
    *)
      COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
      ;;
  esac
}

complete -F _chimera_completions chimera
`.trimStart();

const ZSH_SCRIPT = `
# chimera zsh completion
#compdef chimera

_chimera() {
  local state

  _arguments \\
    '(-V --version)'{-V,--version}'[output the version number]' \\
    '(-h --help)'{-h,--help}'[display help for command]' \\
    '1: :_chimera_commands' \\
    '*::arg:->args'

  case $state in
    args)
      case $words[1] in
        tenant)
          _arguments '1: :(create list switch delete)'
          ;;
        session)
          _arguments '1: :(create list get delete)'
          ;;
        skill)
          _arguments '1: :(list install enable disable uninstall)'
          ;;
        completion)
          _arguments '1: :(bash zsh fish)'
          ;;
      esac
      ;;
  esac
}

_chimera_commands() {
  local commands
  commands=(
    'init:Create a chimera.toml workspace configuration file'
    'deploy:Deploy Chimera to AWS account'
    'endpoints:Fetch deployed API endpoints and save to local config'
    'setup:Provision admin user in Cognito after infrastructure deployment'
    'status:Check Chimera deployment health and status'
    'sync:Bidirectional sync between local workspace and CodeCommit'
    'upgrade:Apply upstream GitHub changes to CodeCommit'
    'destroy:Tear down Chimera infrastructure'
    'monitor:Watch active CloudFormation stack operations in real-time'
    'login:Authenticate with the Chimera platform'
    'tenant:Manage Chimera tenants'
    'session:Manage agent sessions'
    'skill:Manage agent skills'
    'chat:Start an interactive chat session'
    'doctor:Run pre-flight checks for the Chimera platform'
    'completion:Generate shell completion scripts'
  )
  _describe 'command' commands
}

_chimera
`.trimStart();

const FISH_SCRIPT = `
# chimera fish completion

set -l chimera_commands ${TOP_LEVEL_COMMANDS.join(' ')}

# Disable file completions for all subcommands
complete -c chimera -f

# Top-level commands
complete -c chimera -n "__fish_use_subcommand" -a "init"       -d "Create a chimera.toml workspace configuration file"
complete -c chimera -n "__fish_use_subcommand" -a "deploy"     -d "Deploy Chimera to AWS account"
complete -c chimera -n "__fish_use_subcommand" -a "endpoints"  -d "Fetch deployed API endpoints and save to local config"
complete -c chimera -n "__fish_use_subcommand" -a "setup"      -d "Provision admin user in Cognito"
complete -c chimera -n "__fish_use_subcommand" -a "status"     -d "Check Chimera deployment health and status"
complete -c chimera -n "__fish_use_subcommand" -a "sync"       -d "Bidirectional sync with CodeCommit"
complete -c chimera -n "__fish_use_subcommand" -a "upgrade"    -d "Apply upstream changes to CodeCommit"
complete -c chimera -n "__fish_use_subcommand" -a "destroy"    -d "Tear down Chimera infrastructure"
complete -c chimera -n "__fish_use_subcommand" -a "monitor"    -d "Watch CloudFormation stack operations"
complete -c chimera -n "__fish_use_subcommand" -a "login"      -d "Authenticate with the Chimera platform"
complete -c chimera -n "__fish_use_subcommand" -a "tenant"     -d "Manage Chimera tenants"
complete -c chimera -n "__fish_use_subcommand" -a "session"    -d "Manage agent sessions"
complete -c chimera -n "__fish_use_subcommand" -a "skill"      -d "Manage agent skills"
complete -c chimera -n "__fish_use_subcommand" -a "chat"       -d "Start an interactive chat session"
complete -c chimera -n "__fish_use_subcommand" -a "doctor"     -d "Run pre-flight checks"
complete -c chimera -n "__fish_use_subcommand" -a "completion" -d "Generate shell completion scripts"

# Subcommand completions
complete -c chimera -n "__fish_seen_subcommand_from tenant"     -a "create list switch delete"
complete -c chimera -n "__fish_seen_subcommand_from session"    -a "create list get delete"
complete -c chimera -n "__fish_seen_subcommand_from skill"      -a "list install enable disable uninstall"
complete -c chimera -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"

# Common flags
complete -c chimera -l "json"   -d "Output result as JSON"
complete -c chimera -l "region" -d "AWS region"            -r
complete -c chimera -l "env"    -d "Environment name"      -r
`.trimStart();

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion')
    .description('Generate shell completion scripts')
    .argument('<shell>', 'Shell type: bash, zsh, or fish')
    .addHelpText('after', `
Examples:
  $ chimera completion bash >> ~/.bashrc
  $ chimera completion zsh  >> ~/.zshrc
  $ chimera completion fish > ~/.config/fish/completions/chimera.fish`)
    .action((shell: string) => {
      switch (shell.toLowerCase()) {
        case 'bash':
          process.stdout.write(BASH_SCRIPT);
          break;
        case 'zsh':
          process.stdout.write(ZSH_SCRIPT);
          break;
        case 'fish':
          process.stdout.write(FISH_SCRIPT);
          break;
        default:
          console.error(color.red(`Unknown shell: ${shell}`));
          console.error(color.gray('Supported shells: bash, zsh, fish'));
          process.exit(1);
      }
    });
}
