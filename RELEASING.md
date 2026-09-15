# Releasing

The release runbook for both Agent Flywheel SDKs lives in the Python
repository, which leads the release train: it owns the wire schema and renders
this README's figures.

**[percepteye-ai/agent-flywheel → RELEASING.md](https://github.com/percepteye-ai/agent-flywheel/blob/main/RELEASING.md)**

- **§1** covers the checks before any release. That includes re-syncing
  `schema/flywheel-1.json` and the four figures from the Python repository,
  and merging this repository's PR first whenever either changed.
- **§3** is this package's npm release: the version rules (`package.json`, with
  `openclaw.plugin.json` held equal by `test/version.test.js`), the manual
  first publish, and what to restore in the README afterwards.
- **§4** is making both repositories public, which is what lets the README's
  figures render on npm and PyPI.

It is kept in one place so the two SDKs' steps cannot drift apart.
