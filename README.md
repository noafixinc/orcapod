# orcapod

Watch GitHub issue and pull request labels and launch AI CLIs in Orca.

[![CI](https://github.com/noafixinc/orcapod/actions/workflows/ci.yml/badge.svg)](https://github.com/noafixinc/orcapod/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)

日本語版は [README.ja.md](README.ja.md) にあります。

orcapod is a resident CLI for macOS. It polls GitHub for open issues and pull requests that match a label and an author rule, waits a configurable delay, then opens a tab in [Orca](https://www.onorca.dev/) and starts Claude Code or Codex CLI with a prompt rendered from your template. The AI reports back by writing `runs/<id>/result.json`; orcapod reads it, closes the tab on success and sends a desktop notification on failure or when the AI is waiting for input. orcapod itself never writes to GitHub: whatever gets committed, commented or merged is done by the AI CLI following your prompt.

```
$ node bin/orcapod.js
Usage:
  orcapod validate
  orcapod doctor [--probe]
  orcapod status [--json] [--history]
  orcapod up
  orcapod start
  orcapod run --project <name> (--issue <n> | --pr <n>) --kind <id> [--ai claude|codex] [--now]
  orcapod stop [<run.id>]
  orcapod rerun <run.id>
  orcapod incident <run.id>
  orcapod investigate <run.id> [--evidence <text>]
  orcapod approve <run.id> <revision>
  orcapod logs [-f]
  orcapod monitor [--interval <seconds>] [--log-lines <N>]
```

## Highlights

- **Label-driven.** A rule is `target` (issue or pr) + `label` + `kind` + `ai`. Matching items are collected per rule, the timer is extended on every new match, and on expiry they start as one run (`batch: together`) or one run per item (`batch: each`) (`src/config.ts`, `src/tick.ts`).
- **Author filter.** Humans need an `author_association` in `project.authors` (default OWNER, MEMBER, COLLABORATOR); bots need a login in `project.bots` (default `dependabot[bot]`). Nothing else triggers a run.
- **Nothing is written to GitHub.** Processed items are tracked locally in `state/state.json` per `(item, label)`; no label is added or removed on GitHub.
- **Completion by contract, not by guessing.** A run is done or failed only when the AI writes `{"status":"done"|"failed","summary":"…","links":[…]}` to `runs/<id>/result.json`. The closing instructions that tell the AI to do so are appended to every prompt (`src/prompt.ts`).
- **Safe restarts.** The daemon persists state before every `terminal create`, recovers uncertain launches by waiting for the tab's `pane.json`, and never starts a run twice (`test/launch.test.ts`, `test/daemon.test.ts`).
- **Incident workflow for failed runs.** `investigate` starts a child run that only diagnoses and proposes a fix; `approve <revision>` applies exactly the proposal you reviewed (`src/incidents.ts`, `src/approval.ts`).
- **Pure state machine, tested.** `tick(state, observation)` is a pure function with no I/O; the vitest suite in `test/` describes the contract.

Status: experimental; the configuration format and the `result.json` contract may still change. Issues and pull requests are welcome.

## Requirements

- macOS (desktop notifications use `osascript`, tabs are driven through the `orca` CLI)
- Node.js 24 or newer (the `.ts` sources run directly through Node's type stripping; there is no build step)
- pnpm
- [Orca](https://www.onorca.dev/) with agent hooks enabled: open Orca, register each repository you want to watch as a worktree, and run `orca agent hooks on`
- GitHub CLI (`gh`) logged in to the account(s) named in `config.yaml`
- The AI CLI(s) you plan to use: Claude Code and/or Codex CLI, each having already accepted the trust dialog for every watched repository (`orcapod doctor` checks this). Codex is started with `--no-daemon`, which `launch.sh` adds, so it must be a Codex CLI version that accepts that flag

## Install

orcapod is not published to npm; it runs from a clone of this repository.

```sh
git clone https://github.com/noafixinc/orcapod.git
cd orcapod
pnpm install --frozen-lockfile
```

Create your configuration from the examples. `cp -n` never overwrites an existing file and exits with status 1 when it skips one, so run each line on its own:

```sh
cp -n examples/config.yaml config.yaml
mkdir -p prompts
cp -n examples/prompts/*.md prompts/
```

Edit `config.yaml`: set the project `name`, `path`, `repo`, `githubAccount` and the rules you want, and make sure a prompt template `prompts/<kind>.<ai>.md` exists for every `kind` / `ai` pair your rules use. Then check the setup and start the daemon:

```sh
make validate   # parse config.yaml and the prompt templates
make doctor     # Orca running, hooks enabled, gh accounts, trust dialogs (node bin/orcapod.js doctor --probe also opens and closes a test tab)
make start      # start the daemon in the background and open the monitor (q closes the monitor only)
```

`validate` and `doctor` fail until `config.yaml` points at a real repository and a `gh` account that exists on this machine.

## Usage

Everyday operations are `make` targets that call `node bin/orcapod.js`:

| Command | What it does |
| :--- | :--- |
| `make start` | Start the daemon in the background and open the monitor |
| `make daemon` | Run the daemon in the foreground (Ctrl-C stops it) |
| `make stop` | Stop the daemon; running AI tabs keep going |
| `make monitor` | Open the monitor only |
| `make status` | Print the state once |
| `make logs` | Follow the log |
| `make validate` | Check the configuration |
| `make doctor` | Diagnose the environment |
| `make check` | Typecheck, lint and run all tests |

Start a run by hand, bypassing the label rules and the delay:

```sh
node bin/orcapod.js run --project your-project --issue 42 --kind feature --ai claude --now
```

Stop one run (this closes its tab), rerun it, or walk through a failed run:

```sh
node bin/orcapod.js stop 20261023-0917-3f9a1c
node bin/orcapod.js rerun 20261023-0917-3f9a1c
node bin/orcapod.js incident 20261023-0917-3f9a1c
node bin/orcapod.js investigate 20261023-0917-3f9a1c
node bin/orcapod.js approve 20261023-0917-3f9a1c <revision>
```

Run IDs look like `20261023-0917-3f9a1c` and are shown by `status` and `monitor`. `run`, `stop`, `rerun`, `investigate` and `approve` only drop a request file into `state/requests/`; the daemon picks it up on its next 20-second cycle, so they return immediately.

### How a run proceeds

1. GitHub is polled every 60 seconds with `gh api --paginate`. Items that pass the author filter and match a rule are added to that rule's pending set; the fire time is `last match + delayMinutes`.
2. When the timer expires the run is created (`queued`, then `launching`). Runs above `settings.maxConcurrentPerProject` wait in `queued`.
3. orcapod writes `runs/<id>/prompt.md` and `runs/<id>/launch.sh`, then asks Orca for a new tab in the project's worktree running `bash launch.sh`. The script records its pane, obtains `GH_TOKEN` through `gh auth token -u <githubAccount>` and starts the AI with the launch command from `settings.launch`. For Codex, `--no-daemon` is added unless already present.
4. The AI works and finally writes `runs/<id>/result.json`. On `done` orcapod closes the tab; on `failed` it leaves the tab open and attaches an incident.
5. If the AI is waiting for input, has produced no result for too long, or the run exceeds `settings.notify.maxRunMinutes`, you get one desktop notification per event.

## Configuration

`config.yaml` (see [examples/config.yaml](examples/config.yaml)):

```yaml
version: 1

settings:
  maxConcurrentPerProject: 2
  launch:
    claude: claude --dangerously-skip-permissions
    codex: codex --dangerously-bypass-approvals-and-sandbox
  notify:
    desktop: true
    waitingMinutes: 10
    maxRunMinutes: 120
    queuedMinutes: 30

kinds:
  - id: feature
    name: Feature development

projects:
  - name: your-project
    path: /Users/you/git/your-repo      # must be a git repository registered in Orca
    repo: your-org/your-repo            # optional; derived from the origin remote when omitted
    githubAccount: your-github-login    # an account known to `gh auth status`
    enabled: true
    rules:
      - target: issue                   # issue | pr
        label: impl                     # "*" matches any label
        kind: feature                   # must exist in kinds
        ai: claude                      # claude | codex
        batch: each                     # each | together
        delayMinutes: 5
        bootstrap: skip                 # skip (default) | process: what to do with items that already match when a rule is first seen
```

Optional per-project `authors` / `bots` lists and per-rule `authors` narrow who can trigger a run. Every field is validated by `src/config.ts`; `make validate` prints the exact path of anything wrong.

Prompt templates live in `prompts/<kind>.<ai>.md`. A placeholder is the variable name wrapped in double curly braces; `make validate` rejects unknown names and `item.*` names in a `batch: together` rule (`src/prompt.ts`, `src/config.ts`):

| Variable | Value |
| :--- | :--- |
| `project.name`, `project.path`, `repo` | Project fields from `config.yaml` |
| `kind.name` | Display name of the kind |
| `items`, `items.count` | Bullet list of `#number title (url)` and the count |
| `run.id`, `result.path` | Run ID and the path the AI must write its result to |
| `item.number`, `item.title`, `item.url`, `item.target` | The single item; only valid with `batch: each` |

Environment variables read by the code:

| Variable | Read in | Effect |
| :--- | :--- | :--- |
| `ORCAPOD_HOME` | `src/paths.ts` | Directory holding `config.yaml`, `prompts/`, `state/`, `runs/`, `logs/`. Defaults to the repository root. Set it when orcapod watches its own repository. |
| `CLAUDE_CONFIG_DIR` | `src/paths.ts` | Where `doctor` looks for `.claude.json` to check the trust dialog |
| `CODEX_HOME` | `src/paths.ts` | Where `doctor` looks for `config.toml` to check Codex trust |

`config.yaml`, `prompts/`, `state/`, `runs/` and `logs/` are ignored by git. `state/` and `runs/` hold the processed-item index and run records; do not delete them by hand while the daemon runs.

### Security note

The default launch commands run the AI CLIs with their permission prompts disabled (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`), because nobody is watching the tab. Everything the AI does in that tab happens with your local credentials and the `GH_TOKEN` of the configured account. Keep the author filter tight, review the prompt templates, and only point orcapod at repositories you trust.

## Development

```sh
pnpm check                    # typecheck → lint → test
pnpm test test/tick.test.ts   # one file
```

There is no build. Imports use `.ts` extensions, type-only imports use `import type`, and `enum` / `namespace` / parameter properties are not allowed (`tsconfig.json`). The test names in `test/*.test.ts` are the behavioural specification. `CLAUDE.md` describes the architecture for AI coding agents and is a good map for humans too.

## Getting help

- `node bin/orcapod.js` prints the command list; `make` prints the targets.
- `make doctor` explains what is missing in the environment; `make validate` names the exact field that is wrong in `config.yaml`.
- The architecture is described in [CLAUDE.md](CLAUDE.md); the behaviour is specified by the test names in `test/`.
- Questions and bug reports: [GitHub issues](https://github.com/noafixinc/orcapod/issues).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through [SECURITY.md](SECURITY.md).

## License

MIT © 2026 Noafix, Inc. See [LICENSE](LICENSE).
