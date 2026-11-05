# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Monitor lists omit quoted completion summaries; the full result remains available in the run detail view.
- Failed runs appear in the monitor's Attention only while their Orca tab remains open.
- Removed the `Unresolved` section from `status`. `status --json` no longer includes `incident`, `recovery` or `recoveryResult`; unfinished investigation and application child runs are loaded as failed.
- Prompt closing instructions require failed summaries to include the reason and a concrete next action for a human.

### Removed

- The `incident`, `investigate` and `approve` commands and the incident layer.

### Added

- Initial public release of the daemon, the `orcapod` CLI and the example configuration.
