# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

orcapod is a resident CLI for macOS. It detects GitHub issues / PRs by label and author rules, waits a configurable delay, launches Claude Code / Codex CLI in an Orca tab, decides completion from the `runs/<id>/result.json` the AI writes, and closes the tab. orcapod itself never writes to GitHub (the AI CLI does, following the prompt).

There is no specification document. The source of truth is the code and the tests (the `describe` / `it` names in `test/*.test.ts` enumerate the contract). Installation and daily operation are in `README.md`; the configuration shape is in `examples/config.yaml` and `src/config.ts`.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm check                    # typecheck → lint → test (same as make check)
pnpm typecheck                # tsc --noEmit
pnpm lint                     # eslint .
pnpm test                     # vitest run (everything)
pnpm test test/tick.test.ts   # one file. `pnpm test -- <file>` passes `--` to vitest and runs everything
node bin/orcapod.js           # prints usage (all commands)
```

CLI subcommands: `validate` `doctor [--probe]` `status [--json] [--history]` `up` `start` `stop [<run.id>]` `run` `rerun` `incident` `investigate` `approve` `logs [-f]` `monitor`. `make start` calls `up`, `make daemon` calls `start`; every other `make` target calls the subcommand of the same name.

Running `monitor` as if on a real terminal needs a screen size (`monitor.ts` uses `stdout.columns ?? 0`, so a non-TTY gets 0×0 and draws nothing):

```bash
printf q | ORCAPOD_HOME=<temporary home> script -q /dev/null sh -c 'stty rows 40 cols 126; node bin/orcapod.js monitor'
```

## Execution model

There is no build step. `bin/orcapod.js` imports `src/cli.ts` and Node 24 type stripping runs the `.ts` files directly. The tsconfig flags `erasableSyntaxOnly` / `verbatimModuleSyntax` / `allowImportingTsExtensions` enforce that: imports carry the `.ts` extension, type-only imports use `import type`, and enum / namespace / parameter properties are not allowed. The only runtime dependency is `yaml`.

## Architecture

### One cycle (`daemon.ts`)

The daemon runs `runCycle` every 20 seconds. The order is fixed:

1. Reload the configuration (if it is broken, keep the previous one and notify once)
2. `observe`: poll GitHub at 60-second intervals, read Orca's `worktree ps` / `terminal list` / hooks, `result.json`, `pane.json`, and `state/requests/`
3. `tick` (pure) → deliver notify effects → save `state.json`
4. Execute launch / close / writeLastMessage / log effects → save again → consume request files → update `runs/<id>/meta.json` for runs that changed

The only contact with the outside world is `CycleDeps` (`home, orca, github, ghAccounts, notify, now`). Tests replace it.

### State transitions are a pure function (`tick.ts`)

`tick(state, obs)` passes a `structuredClone` of the state through `serve → detect → fire → advanceIncidents → schedule → recover → track → watchOrca` and returns `{ state, effects }`. It does no I/O. Only `applyLaunch` / `applyClose` feed effect results back into the state. To add behaviour, add a step and an `Effect` variant; `daemon.ts` only executes I/O.

### Single writer

Only the daemon writes `state/state.json` (one process via `state/daemon.lock`, written to a temporary file and `renameSync`d). The CLI commands `run` / `stop` / `rerun` / `investigate` / `approve` only drop `state/requests/<ISO time>-<hex>.json`; the daemon reads and deletes them on its next cycle. `status` / `monitor` are read-only. `up` forks `start` detached and confirms a successful start through the IPC startup notification (output goes to `logs/daemon.log`).

### Adapters

- `orca.ts`: the only place that execs `orca … --json`. `ExecFile` is injectable; responses are validated by `parse*` into `OrcaError(code)`. If Orca's response shape changes, fix it here only
- `github.ts`: reads all open issues / PRs every time with `gh api --paginate` (`per_page=100`). `GH_TOKEN` comes from `gh auth token -u` for the project's `githubAccount`
- `notify.ts`: `osascript`'s `display notification`

### From detection to launch

- Author filter: `isAllowedAuthor`. Humans need an `author_association` in `project.authors` (default OWNER / MEMBER / COLLABORATOR); bots need a login in `project.bots` (default `dependabot[bot]`). A rule's own `authors` narrows it further
- Processed items are tracked locally per `(item, label)` (`state.processed`); nothing is attached on GitHub. `label: "*"` matches any label
- When a rule is watched for the first time (not in `watchedRules`), `bootstrap: skip` marks the current matches as processed without launching
- Detections accumulate in the rule's `pending`; `fireAt = last detection + delayMinutes` is extended on every detection. On expiry, `batch: together` is one run and `each` is one run per item
- Runs beyond `maxConcurrentPerProject` are `queued`. Only a manual `--now` run ignores the limit

### Run lifecycle

The `RunPhase` union is the state machine: `queued → launching → starting → running → done | failed | aborted`. Invariants to keep:

- The command given to Orca is always `bash '<runs/<id>/launch.sh>'` (enforced by `test/launch.test.ts` C30). `launch.sh` first writes its own pane to `pane.json` and exits without starting the AI when it cannot obtain `GH_TOKEN`
- Save the state in `launching` before calling `terminal create`. If the result of create is unknown, mark `launchUncertain` and wait for `pane.json`; if it does not appear within 5 minutes (`LAUNCH_RECOVERY_MS`), mark failed and do not relaunch (avoids double execution)
- Completion is decided only from `result.json` (`{"status":"done"|"failed","summary":"…","links":[…]}`); Orca's agent state `done` is not a completion signal. `terminal close` is issued only when a `done` result exists and an agent `done` that started after the mtime of `result.json` has been observed
- Only `ptyKilled: true` counts as a successful close; after `MAX_CLOSE_ATTEMPTS` (3) failures the tab is left open and the run becomes done
- `status: failed`, and broken JSON that is not repaired within 60 seconds (`INVALID_RESULT_GRACE_MS`), are failed. Failed tabs are not closed
- `starting` for 90 seconds notifies once about the launch wait (with the tail of the screen). If both the pane and the tab disappear from a complete listing, the run is aborted. An incomplete `terminal list` is never treated as disappearance
- Notifications are once per run × event (`notified`). Thresholds for waiting for input, missing result and long runs are in `settings.notify`

### Failure-path problem solving (`incidents.ts` / `incident-contract.ts` / `approval.ts`)

A failed run gets an `incident`. `investigate` launches a child run with `recovery.stage: 'prepare'`, and `approve <revision>` a child run with `'apply'`, under the same rule. Children do not recurse. Investigations are limited to `MAX_INVESTIGATIONS` (3), and a re-investigation needs evidence different from the previous one. `revision` is the sha256 of the whole proposal; at `apply` launch time `checkProposal` re-validates the approval. Whether the same fix / operation proposal is being applied again is decided by `fingerprint` (a hash of the changed files and operations only).

### Home and prompts

The home is `ORCAPOD_HOME` (non-empty value) or, if unset, the repository root (`paths.ts`; it does not depend on cwd). Prompts are `prompts/<kind>.<ai>.md` templates with `{{variable}}` placeholders. `config.ts` rejects unknown variables and each-only variables (`item.*`) in a `batch: together` rule; `prompt.ts` appends the closing instructions that tell the AI how to write `result.json`.

### Monitor

`monitor-model.ts` (state → display model, pure) → `monitor-layout.ts` (model + keys → screen lines, pure) → `monitor.ts` (terminal I/O). Display width and control characters are handled in `terminal-text.ts`.

## Tests

- Every test uses an `mkdtempSync` temporary home and injects `CycleDeps` / `ExecFile`. `daemon.test.ts` `vi.mock`s `node:timers/promises`
- The real orca / gh / osascript / claude / codex are never started. Child processes are `git` (temporary repositories), `bash` (the generated `launch.sh`, with fake `gh` and AI commands on PATH), `/bin/sh` (the README copy steps), and `bin/orcapod.js` (CLI process tests under `test/helpers/` and `test/fixtures/`, plus `logs` in `home.test.ts`)
- Test fixtures use neutral names only (user `alice` / `taylor`, organisation `acme-corp`, repository `todos`). `test/examples.test.ts` X5a rejects the current machine's home directory, the origin owner and any `/Users/<name>` other than `/Users/you` inside `examples/`

## Operational data

`config.yaml`, `prompts/`, `state/`, `runs/` and `logs/` are gitignored but hold this environment's configuration and run records. They are not test leftovers: do not delete or bulk-replace them. When orcapod watches its own repository, keep them outside the repository with `ORCAPOD_HOME`.

## Branches and PRs

- Work on `<prefix>/<topic>` branches (`codex/`, `chore/`, `docs/`, …) and merge into main through a PR. Merges are merge commits (no squash)
- CI (`.github/workflows/ci.yml`) runs `pnpm check` on macOS for pushes to main and for PRs. The merge condition is a passing `pnpm check`
