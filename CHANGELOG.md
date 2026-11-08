# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Optional `retryAt` (ISO 8601 with a timezone) in `result.json`. When it is reached, a new `rearm` tick step makes the still-open items of that run eligible for detection again, which starts a new run. `orcapod status` shows `retry at <retryAt>` on done and failed runs. An invalid `retryAt` makes the result invalid.
- The Dependabot example prompt asks the AI to write `retryAt` when it holds a pull request for the release-age wait.

### Fixed

- The same pull request is no longer added to a rule's pending list twice.

### Changed

- Monitor lists omit completion and failure summaries; the full result remains available in the run detail view.
- Widened the monitor title column to 26 display columns (20 on narrow terminals) to show longer task names.
- Failed runs appear in the monitor's Attention only while their Orca tab remains open.
- Removed the `Unresolved` section from `status`. `status --json` no longer includes `incident`, `recovery` or `recoveryResult`; unfinished investigation and application child runs are loaded as failed.
- Prompt closing instructions require failed summaries to include the reason and a concrete next action for a human.

### Removed

- The `incident`, `investigate` and `approve` commands and the incident layer.

### Added

- Initial public release of the daemon, the `orcapod` CLI and the example configuration.
