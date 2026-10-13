# Quickstart

Connect your agent, let it send us its real conversations, and start improving it. Your agent keeps running where it runs today, and its code does not change.

## What you need

<!-- lang -->
- Node 22.22.3 or later, and an OpenClaw agent. OpenClaw is the harness whose model calls the plugin can record, and what the model saw and said is what we learn from. In DeepSeek Harness the plugin records tool outcomes only. Any other agent that already exports OpenTelemetry traces can [send us those](otlp.md) instead.
<!-- /lang -->
- A free sign-in at [launch.percepteye.ai](https://launch.percepteye.ai).

## Install

<!-- lang -->
```bash
openclaw plugins install @percepteye/agent-flywheel
```

Zero runtime dependencies.
<!-- /lang -->

## Get your key

[Get your key](dashboard.md#get-your-key) in the dashboard, then put it, and the control-plane URL shown with it, in your agent's environment:

```bash
export PERCEPTEYE_CONTROL_PLANE_URL=https://launch.percepteye.ai/api/flywheel/v1
export PERCEPTEYE_API_KEY=pefw_...
```

<!-- lang -->
Set them where your OpenClaw gateway starts: it reads its environment once, at launch. The URL is also the plugin's default. Without a key the plugin records on your disk and sends nothing.
<!-- /lang -->

## Record its conversations

<!-- lang -->
Run the plugin in production mode, name the agent, and let it read the conversation:

```bash
export PERCEPTEYE_AGENT_MODE=production
export PERCEPTEYE_AGENT_ID=support-agent      # the name you gave the agent in the dashboard
```

```jsonc
// your OpenClaw config
{ "plugins": { "entries": { "agent-flywheel": {
    "hooks": { "allowConversationAccess": true } } } } }
```

Start OpenClaw as you always do. The plugin registers the agent at startup, which is how the dashboard sees it connect. `allowConversationAccess` is what lets it read your agent's answers and what the model saw; without it, it records only the user's message and the tool calls. Each turn is written under `~/.percepteye/captured` first; that directory is yours.
<!-- /lang -->

## Allow us to learn from them

Once the dashboard has seen your agent connect, give it [permission](dashboard.md#allow-us-to-learn-from-its-conversations) to learn from its conversations. Until you do, no conversation leaves your machine. You do not need to restart your agent: it asks again before each batch it would send.

## See your first trace

The SDK sends turns in batches, so a turn does not appear the moment it happens.

<!-- lang -->
It sends every 32 turns, and the rest when the gateway stops. The startup log says whether it may: `production capture is ENABLED for 'support-agent'`, or `capturing locally; turns will NOT be uploaded:` followed by why.
<!-- /lang -->

Then open [your agent's page](dashboard.md#see-what-arrived) to see it counted. Nothing there? See [Troubleshooting](troubleshooting.md#nothing-arrives-in-the-dashboard).

## Start improving

When conversations have arrived, [start improving](dashboard.md#start-improving). The loop:

1. We learn from your agent's real conversations.
2. Each new version is tested against your agent's current best, on conversations it has never seen.
3. A version that does better comes to you in [Decisions](dashboard.md#approve-the-winner-in-decisions). You approve it or not.
4. The next round starts from the best so far. Run it again whenever new conversations have arrived.

If there is not yet enough to learn from, Start improving says so.

## Run the approved version

<!-- lang -->
Nothing to write. In production mode, with a key, the plugin applies the approved model and prompt to this agent's own turns. It reads them once, at startup, so restart the gateway to pick up a newly approved version. The startup log says when both are applied, and names the one that is not.
<!-- /lang -->

Until you approve a new version, your agent keeps the one it has. The details are in [Production](production.md#run-the-approved-version).

## Next

- [Production](production.md): what is sent and when, retries, rate limits and personal data.
- [OpenTelemetry push](otlp.md): send the traces your agent already exports.
- [FAQ](faq.md) and [Troubleshooting](troubleshooting.md).
<!-- lang -->
- [Reference](reference.md): every setting, and practice tasks in training mode.
<!-- /lang -->
