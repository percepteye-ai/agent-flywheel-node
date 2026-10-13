# Production

Your production agent records the conversations it serves, sends them to us once you allow it, and runs the version you approved. This page covers what is sent and when, what happens when a request fails, and what we do with personal data. Setting it up is the [Quickstart](quickstart.md).

## Recording conversations

<!-- lang -->
In production mode the plugin records each turn your agent serves: the user's message, and every tool call and its outcome. With `hooks.allowConversationAccess: true` it also records the answer, and each run's model boundary from OpenClaw's own `llm_input` and `agent_end` events: the assembled system prompt, the history, the tool definitions, every model answer and every tool result. That is what we learn from, and the turn sends it as one [OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) trace. A run it cannot reconstruct faithfully records no model boundary rather than a guessed one: a second `llm_input` in one run, a prompt with images, or a message steered into a run while it was working. In DeepSeek Harness the plugin records tool outcomes only; to learn from such an agent, [push its OpenTelemetry traces](otlp.md).

The recording hooks only observe. No hook can change a tool result, and a recording failure costs the record, never the turn.
<!-- /lang -->

Two [permissions](dashboard.md#allow-us-to-learn-from-its-conversations) decide what leaves your machine: the conversations, and their message text. Without the second, what the model saw is not recorded at all, not even on your disk. Learning needs both.

## When turns are sent

<!-- lang -->
Every 32 turns, without making any turn wait, the plugin sends what is waiting. When the gateway stops, the rest go too, including turns that never recorded an answer. A request carries at most 64 turns.
<!-- /lang -->

A turn that could not be sent stays on disk and goes with a later batch. Each batch carries an idempotency key, so a batch that arrives twice is stored once.

## Retries and rate limits

Every request to the control plane gets up to four attempts, with a 30-second timeout each.

- **`429`** is always retried, after the server's `Retry-After` (at most 8 seconds), or after a short random backoff when there is none.
- **`408`, `500`, `502`, `503` and `504`, and a connection that drops mid-request,** are retried, except for a claim for practice tasks: that is resent only when it never reached us, because a claim that did may already have handed work out.
- **Any other `4xx`** is final; sending it again would get the same answer. A `403` on upload is a refusal, such as a permission switched off or a key that may not carry this agent's conversations: the SDK stops uploading, says why, keeps the turns on disk, and starts again once the permission is back.

The control plane's limits are per organization, per minute: 240 turn uploads (each up to 64 turns), 240 practice-task claims, 600 practice-task results, and 600 [OpenTelemetry pushes](otlp.md). Over a limit, the answer is `429` with `Retry-After`, and the SDK waits as above.

## Personal data

The SDK sends what your agent saw and said as it was; it masks nothing on your side. The control plane scans everything it receives for email addresses, phone numbers, card numbers, US social security numbers and IP addresses before it stores it:

- **In the tool-call records** sent beside each turn, a match is masked, as `[redacted:email]` for example.
- **In the user's message, your agent's answer, and everything the model saw**, a match is kept as sent, because masking would change the conversation. The turn is marked as holding personal data and is never learned from. [Your agent's page](dashboard.md#see-what-arrived) counts these turns.

[Pushed traces](otlp.md) follow the same rule. How long we keep it all is in the [FAQ](faq.md#what-data-do-you-keep-and-for-how-long).

## What stays on your machine

<!-- lang -->
Every turn is a directory under `~/.percepteye/captured` (`PERCEPTEYE_CAPTURE_DIR`, or `$PERCEPTEYE_HOME/captured`), and uploading does not delete it. Nothing does unless you ask: `"retentionTurns": 50000` in the plugin's config keeps the most recent 50,000 turns, pruning every 256 turns, and turns already uploaded go before turns still waiting to be sent. `PERCEPTEYE_CAPTURE=0` records nothing at all.
<!-- /lang -->

## Run the approved version

<!-- lang -->
In production mode, with a key, the plugin applies both halves to this agent's own turns: the approved system prompt replaces the one your host assembled, and the approved model is served through a provider the plugin registers, `percepteye-flywheel`. It asks once, at startup, so restart the gateway to pick up a newly approved version.

- `PERCEPTEYE_APPLY_PROMPT=0` and `PERCEPTEYE_APPLY_MODEL=0` switch each half off.
- The model half needs `hooks.allowConversationAccess: true`, and a host that accepts the plugin's provider.
- Neither half is applied in training mode, or to a subagent, a scheduled turn, or another agent in the same gateway. Set `agentId` when the gateway runs more than one agent.
- The plugin refuses a model whose address is a stored file (`gs://`, `s3://`, `file://`) rather than a running endpoint, and a prompt a person did not approve.
- When only one half lands, the startup log warns and names which, because half of an approved pair is not what was tested.
<!-- /lang -->

Until you approve a new version in [Decisions](dashboard.md#approve-the-winner-in-decisions), your agent keeps the one it has, and you can [try a new version on one agent](dashboard.md#try-a-new-version-on-one-agent) first. An empty answer always means "keep what you run", never "run with nothing".

## When the control plane is unreachable

Your agent keeps serving. Recording carries on to disk, turns wait for a later batch, and your agent keeps the model and prompt it has. Nothing on this page raises into your process because the control plane did not answer.

## Reference

<!-- lang -->
Every setting, and what stops each half of the approved pair, is in the [Reference](reference.md).
<!-- /lang -->
