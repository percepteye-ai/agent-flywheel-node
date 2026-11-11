# Releasing

The release runbook for both Agent Flywheel SDKs lives in the Python
repository, which leads the release train: it owns the wire schema and renders
this README's figures.

**[percepteye-ai/agent-flywheel → docs/RELEASING.md](https://github.com/percepteye-ai/agent-flywheel/blob/main/docs/RELEASING.md)**

- **§1a is the Mission Control gate, and no tag goes out without it.** It
  checks that the Mission Control the release targets publishes at least the
  customer contract `src/customer-api.js` declares (`CUSTOMER_CONTRACT_VERSION`,
  read off `GET /api/v2/contract`'s `info.version`) and answers every Flywheel
  route this release calls, `POST /api/flywheel/v1/outcomes` among them, as a
  route. Run its Node command from this repository's root; it exits non-zero
  naming what is missing. Tagged before that route was deployed, every
  reported outcome would have been refused for a week and then dropped.
- **§1** covers the checks before any release. That includes re-syncing
  `schema/flywheel-1.json` and the four figures from the Python repository,
  and merging this repository's PR first whenever either changed.
- **§3** is this package's npm release: the version rules (`package.json`, with
  `openclaw.plugin.json` held equal by `test/version.test.js`), the manual
  first publish, and what to restore in the README afterwards.
- **§4** is making both repositories public, which is what lets the README's
  figures render on npm and PyPI.

It is kept in one place so the two SDKs' steps cannot drift apart.
