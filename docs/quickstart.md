# Quickstart

Connect your agent, let it send us its real conversations, and start improving it. Your agent keeps running where it runs today, and its code does not change.

## What you need

<!-- lang -->
- Node 22.22.3 or later, and an agent written in JavaScript or TypeScript: with the Vercel AI SDK, LangChain.js or LangGraph.js, Mastra, the OpenAI SDK, or your own code. An OpenClaw or DeepSeek Harness agent uses the same package as a plugin instead: see [OpenClaw and DeepSeek Harness](harnesses.md). An agent that already exports OpenTelemetry traces can [send us those](otlp.md) instead.
<!-- /lang -->
- A free sign-in at [launch.percepteye.ai](https://launch.percepteye.ai).

## Install

<!-- lang -->
```bash
npm install @percepteye/agent-flywheel
```

Zero runtime dependencies, with TypeScript declarations included.
<!-- /lang -->

## Get your key

[Get your key](dashboard.md#get-your-key) in the dashboard, then put it, and the control-plane URL shown with it, in your agent's environment:

```bash
export PERCEPTEYE_CONTROL_PLANE_URL=https://launch.percepteye.ai/api/flywheel/v1
export PERCEPTEYE_API_KEY=pefw_...
```

<!-- lang -->
Set them where your agent's process starts. The URL is also the SDK's default. Without a key the SDK records on your disk and sends nothing.
<!-- /lang -->

## Record its conversations

<!-- lang -->
Name the agent, and wrap each turn it serves:

```ts
import { flywheel } from "@percepteye/agent-flywheel";

const fw = flywheel({ agentId: "support-agent" });   // the name you gave the agent in the dashboard

const answer = await fw.turn(userMessage, (t) => runAgent(t), { conversationId });
```

`fw.turn` runs your agent and returns its answer. It records the user's message, the tool calls and the answer, under `~/.percepteye/captured/<agentId>` first; that directory is yours. The tool calls come from the adapter for your framework (`@percepteye/agent-flywheel/ai-sdk` or `/langchain`) or from `recordToolCall` where your tools run. The [README](../README.md#-install) shows both. The SDK registers the agent at startup, which is how the dashboard sees it connect.
<!-- /lang -->

## Allow us to learn from them

Once the dashboard has seen your agent connect, give it [permission](dashboard.md#allow-us-to-learn-from-its-conversations) to learn from its conversations. Until you do, no conversation leaves your machine. You do not need to restart your agent: it asks again before each batch it would send.

## See your first trace

The SDK sends turns in batches, so a turn does not appear the moment it happens.

<!-- lang -->
It sends every 32 turns, and the rest when you call `fw.close()`. The startup log says whether it may: `production capture is ENABLED for 'support-agent'`, or `capturing locally; turns will NOT be uploaded:` followed by why.
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
In production mode, with a key, each turn hands your agent the approved version: `t.systemPrompt(yours)` returns the approved system prompt, and `t.model` is the approved model's endpoint (`null` until there is one, so your agent keeps its own). Use both, and the approved version runs. A newly approved prompt reaches the next turn; a new model is read once, at startup, so restart to pick it up. The startup log says when both are available, and names the one that is not.
<!-- /lang -->

Until you approve a new version, your agent keeps the one it has. The details are in [Production](production.md#run-the-approved-version).

## Next

- [Production](production.md): what is sent and when, retries, rate limits and personal data.
- [OpenTelemetry push](otlp.md): send the traces your agent already exports.
- [FAQ](faq.md) and [Troubleshooting](troubleshooting.md).
<!-- lang -->
- [Reference](reference.md): every setting, and practice tasks in training mode.
<!-- /lang -->
