# Reference

Everything the Node SDK does, in detail, lives in two places, one per way of
using it. This page points at both, so neither is copied here to drift.

**The SDK, for any JavaScript or TypeScript agent** — the [README](../README.md):

- [Install](../README.md#-install), and the two calls: `fw.turn()` in production, `fw.serve()` in training
- [Frameworks](../README.md#-frameworks): the Vercel AI SDK and LangChain.js adapters, and `recordToolCall`
- [How the loop closes](../README.md#-how-the-loop-closes), including the model-call count
- [Two modes, one switch](../README.md#-two-modes-one-switch)
- [Production observability](../README.md#-production-observability): capture, consent, outcomes and feedback
- [The approved pair, applied](../README.md#the-approved-pair-applied), and what stops each half
- [What it writes](../README.md#-what-it-writes), on disk and in the outbox
- [Runs, eligibility and evaluation sets](../README.md#-runs-eligibility-and-evaluation-sets)
- [Configuration](../README.md#%EF%B8%8F-configuration): every option and environment variable, `describe` and `rules`

**The plugin, in OpenClaw or DeepSeek Harness** — [OpenClaw and DeepSeek Harness](harnesses.md):

- [Install the plugin](harnesses.md#install-the-plugin) and `allowConversationAccess`
- [What each harness supports](harnesses.md#what-each-harness-supports)
- [Two modes, one switch, in a harness](harnesses.md#two-modes-one-switch-in-a-harness)
- [The approved pair, applied by the plugin](harnesses.md#the-approved-pair-applied-by-the-plugin)
- [Configuring the plugin](harnesses.md#configuring-the-plugin) in the OpenClaw config
