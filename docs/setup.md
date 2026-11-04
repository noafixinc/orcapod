# Setting up orcapod

This is the setup procedure. It is written for an AI coding agent (Claude Code, Codex CLI) running in a clone of this repository, and a person can follow it by hand just as well. It is in English only; answer the person in their own language.

The setup is done when `node bin/orcapod.js doctor --probe` prints no `NG` line and `node bin/orcapod.js doctor` reports the daemon as running.

## Rules for the agent

- Some steps can only be done by the person (a GUI, an interactive login, a trust dialog). Do not try to work around them. Stop, tell the person exactly what to do (quote the `doctor` line), and continue once they say it is done.
- The decisions under "Decide with the person" belong to the person. Propose values from the facts you collected, but do not write `config.yaml` until the person has confirmed them. Never assume consent to the security trade-off.
- Do not run `validate` or `doctor` against the placeholder values in `examples/config.yaml`; they fail until `config.yaml` points at a real repository and a real `gh` account.

## 1. Check the requirements

Run these and note what is missing. The list of requirements, with the reasons, is in the README's "Requirements" section.

```sh
sw_vers -productVersion
node --version          # 24 or newer
pnpm --version
gh auth status
orca status --json
command -v claude codex
```

Then install the dependencies in the clone:

```sh
pnpm install --frozen-lockfile
```

Hand these to the person when they are missing, because they need a GUI or an interactive session:

| Missing | What the person does |
| :--- | :--- |
| Orca, or Orca not running | Install and open [Orca](https://www.onorca.dev/) |
| No `gh` account | `gh auth login` for the account orcapod should use |
| Claude Code / Codex CLI | Install the AI CLI they want to use |

## 2. Collect the facts

Gather these so that you can propose concrete values in step 3:

- The `gh` accounts on this machine: `gh auth status`
- The repositories the person wants to watch: their local path, and `git -C <path> remote get-url origin`
- Whether each repository is private: `gh repo view <owner>/<repo> --json visibility`
- The labels each repository already uses: `gh label list --repo <owner>/<repo>`

## 3. Decide with the person

Present these as one list, with your proposed value for each, and wait for the answer:

1. **Projects.** For each repository: `name`, `path` (an absolute path to a git repository), `repo` (`owner/name`; may be left out, it is then derived from the origin remote) and `githubAccount` (an account from `gh auth status`; its token is what the AI uses).
2. **Rules.** For each rule: `target` (`issue` or `pr`), `label` (`"*"` matches any label), `kind`, `ai` (`claude` or `codex`), `batch` (`each`: one run per item, `together`: one run for all items) and `delayMinutes`.
3. **Who can trigger a run.** By default humans whose `author_association` is OWNER, MEMBER or COLLABORATOR, and the bot `dependabot[bot]`. Narrow it with `authors` / `bots` on the project or `authors` on a rule. For a public repository, point out that this filter is the only thing that stops outsiders from starting an AI on the person's machine.
4. **Prompts.** What the AI is told to do for each `kind` / `ai` pair. Show the person the matching file in `examples/prompts/` as the starting point.
5. **Unattended permissions.** The default launch commands (`settings.launch`) disable the AI CLIs' permission prompts (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`), and the AI acts with the person's local credentials and the `GH_TOKEN` of `githubAccount`. Quote the README's "Security note" and get an explicit yes, or agree on different launch commands.

Leave `bootstrap` at its default `skip` unless the person asks otherwise: items that already match when a rule is first seen are marked as processed instead of all starting at once.

If orcapod is to watch its own repository, the home must be outside the clone: set `ORCAPOD_HOME` to another directory for every command below (`src/paths.ts`).

## 4. Write the configuration

The home is the clone unless `ORCAPOD_HOME` is set. These lines run in the home; with `ORCAPOD_HOME`, run them there and prefix `examples/` with the clone's path. `cp -n` never overwrites an existing file and exits with status 1 when it skips one, so run each line on its own:

```sh
cp -n examples/config.yaml config.yaml
mkdir -p prompts
cp -n examples/prompts/*.md prompts/
```

Then edit `config.yaml` to the values decided in step 3 (the shape is in the README's "Configuration" section and in `examples/config.yaml`), remove the example projects and rules that were not chosen, and make sure `prompts/<kind>.<ai>.md` exists for every `kind` / `ai` pair an enabled rule uses. Run:

```sh
node bin/orcapod.js validate
```

It prints the exact path of every wrong field; fix them until it prints `OK`.

## 5. Diagnose the environment

```sh
node bin/orcapod.js doctor
```

It exits with status 1 when any line is `NG`. `WARN daemon: not running` is expected at this point. Resolve each `NG` line:

| `NG` line contains | Who | Action |
| :--- | :--- | :--- |
| `Orca: not running` / `not responding` | Person | Open Orca |
| `hooks: … (orca agent hooks on)` | Agent | Run `orca agent hooks on` |
| `gh: no logged-in account` / `githubAccount … is not in gh auth status` | Person | `gh auth login` for that account, or change `githubAccount` (a decision from step 3) |
| `<ai>: … is not on PATH` | Agent, or person if the CLI is not installed | Fix the launch command in `settings.launch` or install the CLI |
| `is not registered in Orca` | Person | Add the folder in Orca |
| `folder trust is not accepted in <ai>` | Person | Open that AI CLI interactively once in the project path and accept the trust dialog |
| `config: …` | Agent | Fix `config.yaml` and run `validate` again |
| `gh: cannot read accounts` / `hooks: cannot read the state` / `Orca registration: cannot read the list` / `<project>: cannot read <repo>` | Agent, then person | The command failed; the reason is in parentheses. Run the same `gh` / `orca` command yourself to see the full error. Hand it to the person when it needs a login, a GUI or repository access |
| `probe: cannot try` | Agent | Make `config.yaml` readable and enable at least one project |
| `probe create: cannot open a tab` | Agent, then person | Resolve the other `NG` lines first; if it still fails, give the person the error in parentheses |
| `probe wait:` / `probe close:` | Person | Look at the tab Orca opened in the first enabled project: it is usually stopped at a dialog. Close it by hand if it is still open |

The `probe …` lines appear only with `--probe` (step 6). `test/doctor.test.ts` checks that every `NG` line `doctor` can print matches a row of this table, so change both together.

A `WARN` about hooks trust (`hasTrustDialogHooksAccepted`) means the launch may stop at a second dialog: ask the person to open Claude Code in that path once and accept it. A `WARN` that the repository is public is a reminder of decision 3.

Repeat `doctor` until it prints no `NG` line.

## 6. Try a tab and start

```sh
node bin/orcapod.js doctor --probe
```

This also opens a tab in the first enabled project, waits for a test command to exit and closes the tab. When it prints no `NG` line, ask the person to start the daemon in their own terminal, in the clone (with `ORCAPOD_HOME` set if it was used):

```sh
make start
```

It starts the daemon in the background and opens the monitor; `q` closes only the monitor. `make start` (`orcapod up`) refuses to run without a terminal, so an agent cannot run it from its own session, and a daemon started in the foreground from an agent session (`orcapod start`) would stop with that session. Once the person has run it, confirm with `node bin/orcapod.js status` and `node bin/orcapod.js doctor`, which now prints `OK daemon: running`.

## 7. Report to the person

Tell the person:

- Which projects and rules are active, and who can trigger them
- That a matching issue or pull request starts a run after `delayMinutes`, and that `node bin/orcapod.js run --project <name> --issue <n> --kind <id> --now` starts one by hand
- That `make monitor` shows the runs, `make stop` stops the daemon, and the README's "Usage" section lists the other commands
