# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 - 2026-09-14

First usable release. The package stays `private: true` and is not published to a registry.

### Added

- Quickstart in the README that takes a clean checkout to a running router.
- `CHANGELOG.md` and [docs/RELEASING.md](docs/RELEASING.md).
- Regression test locking the version the CLI prints to the version `package.json` declares.

### Changed

- `config check` now runs the same snapshot source validation `serve` runs before it binds a port.
  A snapshot fingerprinted against a different gateway, or written by a different `sourceId`, is now
  a problem with exit code 2 instead of a clean check followed by a `serve` that refuses to start.
  This also surfaces in the web console, which mirrors `config check`.
- `tests/probes/native-claude-run.sh` accepts `PROBE_CHILD_READ_ROUNDS` and
  `PROBE_CHILD_USAGE_RAMP_AFTER_ROUNDS` from the environment. Defaults are unchanged.

### Verified

Measured against the installed Claude Code 2.1.270 binary, driven through the packaged
`dist/cli.js serve` and a loopback test gateway. Each claim below is a model observed on the
gateway side, not a client-side report.

- Two children of one parent take different upstream models while the parent keeps its own.
- A child keeps its model on its second request in the same session.
- Two children run in parallel and neither takes the other's model.
- A grandchild carrying `x-claude-code-parent-agent-id` is routed.
- A real resume of the same session routes the same child identities to the same models.

### Known limits

- OpenCode and Codex adapters are present but unmeasured. No support is claimed.
- The web console is read-only.
- Compaction is unproven on this platform. The client's autocompact decision fires, but its
  reactive compactor bailed with "no assistant messages in summarize set" in every local run, so no
  compaction boundary was produced to route across.
- Correlation bindings live in the serving process's memory. They expire after inactivity and do
  not survive a router restart.
