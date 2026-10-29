# Contributing to orcapod

Thanks for taking the time to contribute. This document explains how to report problems, propose changes and get a pull request merged.

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/noafixinc/orcapod/issues) first.
- Use the issue forms: **Bug report** needs a minimal reproduction and the version you ran; **Feature request** needs the problem you are solving, not only the solution.
- Security issues: see [SECURITY.md](SECURITY.md) and do not open a public issue.

## Development setup

```sh
git clone https://github.com/noafixinc/orcapod.git
cd orcapod
pnpm install --frozen-lockfile
```

You need Node.js 24 or newer and pnpm; there is no build step, Node runs the `.ts` sources directly. Run the checks before you push (typecheck, lint and the full test suite, the same as CI):

```sh
pnpm check
```

To run one test file: `pnpm test test/tick.test.ts` (without `--`; `pnpm test -- <file>` runs everything).

## Pull requests

1. Open an issue or discussion first for anything larger than a bug fix, so the design is agreed before you write code.
2. Fork, create a branch named `<prefix>/<topic>` (for example `fix/launch-recovery`), keep the change focused on one topic.
3. Add or update tests for behaviour you change; add a line under `Unreleased` in `CHANGELOG.md` when the change is user-visible.
4. Make sure CI is green. Address review feedback by pushing new commits; pull requests are merged with a merge commit, not squashed.
5. No CLA or sign-off is required; by submitting a pull request you agree to the project license.

## Code style

Follow the existing style; `eslint` and `tsc` are the source of truth. Imports use `.ts` extensions and type-only imports use `import type`; `enum`, `namespace` and parameter properties are rejected by `tsconfig.json`. Keep comments for things the code cannot say. The `describe` / `it` names in `test/*.test.ts` are the behavioural specification, so a behaviour change comes with a test change.

## License

By contributing, you agree that your contributions will be licensed under the MIT license that covers this project.
