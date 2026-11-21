# Troubleshooting

Find what you see; each answer names the cause and the fix. When the control plane refuses something it says why, and the SDK passes its words on:

<!-- lang -->
read the SDK's lines in your process's log (warnings go to the console unless you pass a `logger`), or, for the plugin, your OpenClaw log; each starts with `[agent-flywheel]`.
<!-- /lang -->

## The dashboard never sees your agent connect

- **The key is not in your agent's environment, or the URL points somewhere else.**
  <!-- lang -->
  Without a key the SDK never connects: it records on your disk and sends nothing. Set `PERCEPTEYE_API_KEY` where your process starts, or pass `apiKey` to `flywheel()` (for the plugin, `apiKey` in its config, where the gateway starts). A registration that fails is logged as `could not register '<agent>' with the control plane`, with why.
  <!-- /lang -->
- **Your network blocks it.** Every connection is outbound HTTPS to your control-plane URL; allow it.
- **The key was revoked, or is more than 180 days old.** [Replace it](dashboard.md#replace-a-lost-key).

## Nothing arrives in the dashboard

- **Nothing has been sent yet.** Turns go in batches.
  <!-- lang -->
  Every 32 turns, and on `fw.close()` (or when an OpenClaw gateway stops).
  <!-- /lang -->
- **`production capture is not enabled for this agent`** — give the agent [permission](dashboard.md#allow-us-to-learn-from-its-conversations). No restart is needed.
- **`this key is bound to a different flywheel`** — the agent id your code reports and the name the key was made for differ. Use the same id in both, or [get a key](dashboard.md#get-your-key) for this agent.
  <!-- lang -->
  The id is the `agentId` you pass to `flywheel()`, or `PERCEPTEYE_AGENT_ID`. For the plugin it is `agentId` in its config, and defaults to `openclaw`.
  <!-- /lang -->
- **`this agent is not registered`** — the control plane has never heard from this agent, so there is nothing to switch on. Start it once with its key.
  <!-- lang -->
  In production mode with a key, the SDK registers it at startup.
  <!-- /lang -->
- **`this flywheel key does not carry the 'turn.report' scope`** — the key was made before conversations could be uploaded, or without that permission. [Replace it](dashboard.md#replace-a-lost-key).

## Conversations arrive, but there is nothing to learn from

- **No message text was sent.** Learning needs the second [permission](dashboard.md#allow-us-to-learn-from-its-conversations), and the model calls themselves.
  <!-- lang -->
  The model calls are recorded by the adapter for your framework (`flywheelMiddleware()` for the Vercel AI SDK, `flywheelCallbacks()` for LangChain.js); with neither, none are. The plugin records them only with `hooks.allowConversationAccess: true`, and says at startup when that is missing. A run it cannot reconstruct faithfully (a second `llm_input` in one run, a prompt with images, a message steered into the run) records none, and DeepSeek Harness records none.
  <!-- /lang -->
- **`this agent's production turns are attributed to no Product`** — the agent must belong to exactly one agent or product in your dashboard. Add it there once; if two declare it, remove one.
- **Your agent's page says they are kept but not learned from:**
  - *they contain personal data*: see [Personal data](production.md#personal-data).
  - *they hold no final answer*:
    <!-- lang -->
    return the answer from the function you pass to `fw.turn()`. For the plugin, set `hooks.allowConversationAccess: true`: OpenClaw delivers the answer through `agent_end`, a conversation hook.
    <!-- /lang -->
- **Start improving says `flywheel_capture_has_no_decision_points`.** What has arrived holds no decision to learn from yet. Let more conversations arrive.

## Pushed traces are refused

- **`403 production_capture_not_enabled`** or **`403 model_content_capture_not_enabled`** — give the agent [permission](dashboard.md#allow-us-to-learn-from-its-conversations); both of its parts must be on. The rest of the message says which is off.
- **`415`** — send `application/x-protobuf` or `application/json`, and gzip or no compression.
- **`400`** — the body is not an OTLP trace export. A trace file belongs in an upload, not a push.
- **Pushes succeed but the agent's page counts nothing to learn from** — the spans carry no message content. Switch it on in your instrumentation.

Every status is in [OpenTelemetry push](otlp.md#what-the-endpoint-answers).

## Requests fail with `429`

Your organization is over a [rate limit](production.md#retries-and-rate-limits), or is already sending as much at once as it may. The SDK waits and retries on its own. If it keeps happening, send fewer, larger requests: let turns batch, and give a Collector's exporter a batch processor. A Collector that sends several requests at once gets `429` for each one past the first while it is read, and retries them a second later; `sending_queue: num_consumers: 1` on our exporter avoids that.

## Your agent is not running the approved version

- **It has not been approved yet, or is not ready to serve yet.** Approving happens in [Decisions](dashboard.md#approve-the-winner-in-decisions). Until a version is approved and serving, the answer is "keep what you run".
<!-- lang -->
- **Your agent does not use what each turn hands it.** Call your model at `t.model` when it is set, and use `t.systemPrompt(yours)` as the system prompt.
- **The model is read once, at startup.** Restart after you approve a new model; a new prompt reaches the next turn on its own.
- **Only one half was applied.** The startup log names which half is missing and why: `PERCEPTEYE_APPLY_PROMPT=0` or `PERCEPTEYE_APPLY_MODEL=0`, an address that is a stored file rather than a running endpoint, or, for the plugin, no `hooks.allowConversationAccess` for the model half or a host that refused the plugin's provider.
- **Several agents run in one OpenClaw gateway, and none is named.** The plugin applies nothing rather than guess; set `agentId`.
<!-- /lang -->

## The SDK will not start

<!-- lang -->
`flywheel()` refuses only one thing: starting without an agent name (`agentId`, or `PERCEPTEYE_AGENT_ID`). Otherwise the SDK never stops your agent from starting. A mode it cannot read degrades to `production` and says so, and `fw.serve()` in production mode refuses, naming the switch. A `describe` or `rules` value it cannot use is dropped with a warning naming the cause. The plugin, in training mode without `hooks.allowConversationAccess`, claims no practice tasks and says which capability is missing.
<!-- /lang -->
