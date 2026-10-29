import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recoveryPrompt } from './incident-prompt.ts'
import { panePath, resultPath, runDir, runsDir } from './paths.ts'
import { renderPrompt } from './prompt.ts'
import type { Config, Run } from './types.ts'

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

export function runTitle(run: Pick<Run, 'rule' | 'kindName' | 'items' | 'recovery'>): string {
  if (run.recovery !== undefined) return `${run.kindName} ${run.recovery.sourceRunId.slice(-6)}`
  const [first] = run.items
  if (run.rule.batch === 'each' && first !== undefined) return `#${first.number} ${run.kindName}`
  return `${run.kindName} ×${run.items.length}`
}

export type RunDirMode = 'create' | 'reuse-relaunch'

export function prepareRun(home: string, run: Run, config: Config, mode: RunDirMode = 'create'): { launchScript: string; title: string; command: string } {
  const promptKey = `${run.rule.kind}.${run.rule.ai}`
  const template = config.prompts.get(promptKey)
  if (template === undefined && run.recovery === undefined) throw new Error(`prompts/${promptKey}.md is missing`)

  const dir = runDir(home, run.id)
  mkdirSync(runsDir(home), { recursive: true })
  mkdirSync(dir, { recursive: mode === 'reuse-relaunch' })

  const promptFile = join(dir, 'prompt.md')
  const launchScript = join(dir, 'launch.sh')
  writeFileSync(promptFile, run.recovery === undefined ? renderPrompt(template!, {
    projectName: run.project,
    projectPath: run.target.path,
    repo: run.target.repo,
    kindName: run.kindName,
    items: run.items,
    runId: run.id,
    resultPath: resultPath(home, run.id),
  }) : recoveryPrompt(home, run))
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(run, null, 2)}\n`)
  writeFileSync(launchScript, launchScriptBody({
    paneFile: panePath(home, run.id),
    githubAccount: run.target.githubAccount,
    projectPath: run.target.path,
    launchCommand: config.settings.launch[run.rule.ai],
    ai: run.rule.ai,
    promptFile,
  }))
  return { launchScript, title: runTitle(run), command: `bash ${shellQuote(launchScript)}` }
}

function launchScriptBody(input: { paneFile: string; githubAccount: string; projectPath: string; launchCommand: string; ai: Run['rule']['ai']; promptFile: string }): string {
  // Codex's shared app-server keeps the environment of the first tab, so Codex hook notifications are isolated per run.
  const command = input.ai === 'codex' ? `orcapod_launch_codex() {
  local orcapod_prompt="\${!#}"
  set -- "\${@:1:$#-1}"
  local orcapod_no_daemon=false orcapod_option_end=1 orcapod_arg orcapod_cli=1
  if [ "\${1##*/}" = env ]; then
    local orcapod_env_options=true orcapod_short orcapod_skip
    orcapod_cli=2
    while [ "$orcapod_cli" -le "$#" ]; do
      orcapod_arg="\${!orcapod_cli}"
      if [ "$orcapod_env_options" = true ]; then
        case "$orcapod_arg" in
          --) orcapod_env_options=false; orcapod_cli=$((orcapod_cli + 1)); continue ;;
          --unset|--chdir|--argv0|--split-string) orcapod_cli=$((orcapod_cli + 2)); continue ;;
          --*) orcapod_cli=$((orcapod_cli + 1)); continue ;;
          -*)
            orcapod_short="\${orcapod_arg#-}"
            orcapod_skip=1
            while [ -n "$orcapod_short" ]; do
              case "$orcapod_short" in
                [uCPSa]*)
                  if [ "\${#orcapod_short}" -eq 1 ]; then orcapod_skip=2; fi
                  break ;;
              esac
              orcapod_short="\${orcapod_short#?}"
            done
            orcapod_cli=$((orcapod_cli + orcapod_skip)); continue ;;
        esac
      fi
      case "$orcapod_arg" in
        *=*) orcapod_env_options=false; orcapod_cli=$((orcapod_cli + 1)) ;;
        *) break ;;
      esac
    done
  fi
  orcapod_option_end=$orcapod_cli
  for orcapod_arg in "\${@:orcapod_cli}"; do
    if [ "$orcapod_arg" = '--' ]; then break; fi
    if [ "$orcapod_arg" = '--no-daemon' ]; then orcapod_no_daemon=true; fi
    orcapod_option_end=$((orcapod_option_end + 1))
  done
  if [ "$orcapod_no_daemon" = false ]; then
    set -- "\${@:1:orcapod_option_end-1}" --no-daemon "\${@:orcapod_option_end}"
  fi
  exec "$@" "$orcapod_prompt"
}
orcapod_launch_codex ${input.launchCommand}` : `exec ${input.launchCommand}`
  return `#!/bin/bash
set -euo pipefail
printf '{"handle":"%s","tabId":"%s","paneKey":"%s"}\\n' "\${ORCA_TERMINAL_HANDLE-}" "\${ORCA_TAB_ID-}" "\${ORCA_PANE_KEY-}" > ${shellQuote(input.paneFile)}
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
GH_TOKEN="$(gh auth token -u ${shellQuote(input.githubAccount)} -h github.com)"
[ -n "$GH_TOKEN" ] || { echo 'orcapod: cannot obtain GH_TOKEN' >&2; exit 1; }
export GH_TOKEN
cd ${shellQuote(input.projectPath)}
${command} "$(cat ${shellQuote(input.promptFile)})"
`
}
