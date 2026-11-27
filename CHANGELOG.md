# Changelog

What changed in `@percepteye/agent-flywheel`, by release. It ships the same
version number in the same release as the Python SDK, `agent-flywheel`, whose
CHANGELOG.md is the full history; this file records the Node SDK's own entries
from here on.

## Unreleased

### Added

- **`opsd_base_needs_dequantization`** joins `TRAINING_REFUSAL_CODES`: a base
  stored in a format the GPU host trains only once dequantized (NVIDIA ModelOpt
  NVFP4 / FP8), reached before its conversion -- 409, retryable, the
  platform's. The hill climb door converts such a base first (control plane
  1.58.0).

### Changed

- **`CUSTOMER_CONTRACT_VERSION` is 1.58.0**, with the Python SDK. 1.55.0-1.57.0
  add only response fields this SDK already passes through as returned; 1.58.0
  adds a model selection's `base_treatment` and the refusal above.
