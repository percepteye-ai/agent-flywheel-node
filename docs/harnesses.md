# The OpenClaw and DeepSeek Harness plugin

`@percepteye/agent-flywheel` also loads as a plugin into **OpenClaw** and
**DeepSeek Harness**. There the harness fires the hooks, so the integration is
the install line plus one host setting, with no code in your agent.

This page covers that use only. For any other JavaScript or TypeScript agent
(the Vercel AI SDK, LangChain.js, LangGraph.js, Mastra, the OpenAI SDK, or
plain code), use the framework API in the [README](../README.md). Everything
not specific to a harness lives there too: modes, production observability,
the approved prompt and model, prompt optimization, approval, configuration,
and OpenTelemetry push.

Both use the same lanes. The framework API is a small in-process host for the
same plugin, so the plugin and your own code capture, train and apply in the
same way.

## Install the plugin

One package, two harnesses. Pick your line:

```bash
openclaw plugins install @percepteye/agent-flywheel          # OpenClaw
dsh plugin --profile <name> add @percepteye/agent-flywheel   # DeepSeek Harness
```

**That's the integration.** No import, no wrapper process, no sidecar. Start your agent exactly the way you always did.

**Want it to start contributing?** Get its key at **[launch.percepteye.ai](https://launch.percepteye.ai/onboard/agent-sdk)**. Sign up, name the agent, and pick *Node (OpenClaw)*: the key is shown once and scoped to that one agent, beside the exact commands for this plugin. Then add the key and one host setting:

```bash
export PERCEPTEYE_API_KEY=pefw_...        # from https://launch.percepteye.ai/onboard/agent-sdk
```

**Or get the key without leaving your terminal:**

```bash
npx @percepteye/agent-flywheel login                     # for agentId "openclaw"
npx @percepteye/agent-flywheel login --agent-id my-agent # for another agent
```

It prints a short code and opens launch.percepteye.ai with the code filled in. Sign up or sign in, check that the code matches, and click **Approve**. The key comes back to the terminal and is stored in `~/.percepteye/credentials.json` (or `$PERCEPTEYE_HOME/credentials.json`), readable only by you, for that one agent on that one control plane. Restart OpenClaw: when neither the plugin's `apiKey` nor `PERCEPTEYE_API_KEY` is set, the plugin uses the stored key for its `agentId` and logs once that it is doing so. A stored key is consent to send, exactly as the variable is. `npx @percepteye/agent-flywheel logout` forgets it here; revoking it in Mission Control (Settings) stops it everywhere. The Python SDK's `agent-flywheel login` writes the same file, so either one serves both.

Without a key nothing leaves the machine: local recording of your agent's real tool-failure rate works without one, forever. The startup line says so, and names the page where a key comes from.

<!-- THE KEY ROUTE, confirmed by the owner 2026-09-14 and re-pointed
     2026-10-20: PerceptEye operates the control plane, and sign-up is free and
     self-serve. Every link on this page that asks for a key goes to
     https://launch.percepteye.ai/onboard/agent-sdk, the dashboard's screen for
     connecting an agent with the SDK, which is also the SIGN_UP_URL this
     plugin's own missing-key lines print (src/config.js). The Python README
     says the same; keep the two in step. -->

```jsonc
// your OpenClaw config
{ "plugins": { "entries": { "agent-flywheel": {
    "hooks": { "allowConversationAccess": true } } } } }
```

That setting does **three** jobs, and every one of them is dropped without it. It lets the plugin read your agent's answer (`agent_end`), describe your agent (`llm_input`), and **point your agent at the approved model** — or, in training mode, a rollout at its own gateway (`before_model_resolve`) — OpenClaw classes all three as conversation hooks and drops them for non-bundled plugins unless you opt in. The plugin **refuses to claim work without it** rather than half-working, and says once, at startup, which capability it is missing and why. Applying the approved *prompt* is the one thing that does **not** need it.

> [!TIP]
> Scalar settings have both an OpenClaw config key and an environment variable, and config wins over the environment. Exact execution evidence is a nested, config-only adapter snapshot. The full table is under [Configuration](../README.md#%EF%B8%8F-configuration).

> [!NOTE]
> **Set `agentId` to the OpenClaw agent this install serves** if your host runs more than one. That name is how the control plane knows the agent *and* how the plugin decides whose approved prompt and model to apply. On a host running a single agent — the ordinary install — there is nothing to disambiguate and you can leave it alone. On a host running several with none of them named, the plugin applies **nothing** and says so at startup, because guessing would swap a bystander's prompt.

## How the loop closes in OpenClaw

| beat | what happens | who does the work |
|:--|:--|:--|
| **⓪ Describe** | the plugin records the assembled prompt and effective model; tools remain `null` on the current host API unless an adapter supplies them | automatic, honestly incomplete |
| **① Claim** | training mode registers this exact worker, then claims one graded task at a time; an exact startup snapshot binds claims to that execution | you dial out — no inbound port |
| **② Run** | the task is delivered into your agent's context, in a dedicated `percepteye-rollout-*` session | your agent, unchanged |
| **③ Record** | every executed tool call lands as `ok` / `failed` / **`unknown`** | the `after_tool_call` hook |
| **④ Report** | the trajectory and answer go back; unsupported evidence stays absent | the plugin |
| **⑤ Train** | tasks generated, rollouts graded, dataset built, policy trained and promoted | **PerceptEye — you build none of it** |
| **⑥ Serve** | the approved system prompt **and** the model it was certified with are applied to your production install automatically, once a person has approved each | the plugin |

That last beat is what makes it a flywheel rather than a pipeline: **the better agent generates the better evidence.**

> [!IMPORTANT]
> **Beat ⑥ closes the pair.** A production install reads `GET /policy/current` and `GET /prompt/current` at startup and applies **both** halves: the prompt, by replacing the one your host assembled, and the model, by naming a provider this plugin registers whose transport points at the served `base_url`. That matters because they were certified *together* — a prompt applied over some other checkpoint is not the combination anybody evaluated, and the startup log says so plainly whenever only one half lands.
>
> **The prompt keeps improving after you approve it.** Mission Control goes on evolving the system prompt from the traces your agent keeps producing, including while a person has not yet decided the last improvement. Each round has to beat the candidate already waiting, so whatever is approved next is the best prompt found so far, and the older waiting one is retired from your queue. So the prompt half does not stop at its startup answer. At most once per `ttl_s` (never faster than 30 s), the prompt or model hook re-reads `/policy/current` without making the turn wait. Only when its `prompt_generation` names a newer approval does it fetch the text. The turn that noticed keeps its prompt; the next turn runs the new one, and the log says so. An empty or failed read never takes an applied prompt away. The model half is re-decided on the same read: a new endpoint (or the key the control plane sends for it) applies from the next turn, a withdrawal hands the agent back to the model its host configures, and an empty or failed read keeps what is applied. `PERCEPTEYE_APPLY_PROMPT=0` still turns the prompt half off entirely.
>
> The model half needs two things from your host, and says at startup if it is missing either: `hooks.allowConversationAccess: true`, and a host that accepts the provider registration — the registered provider is the only thing that can supply the served `base_url`, so if the id is refused the model half is refused with it rather than pointing your agent at a provider your host does not know. The plugin's own key (`PERCEPTEYE_API_KEY`) opens an endpoint the control plane names `PERCEPTEYE_API_KEY` for only at the control plane's own address, never as a fallback; any other endpoint's credential comes from your own `models.providers.percepteye-flywheel.apiKey`.

## What each harness supports

| harness | records outcomes | rollouts | production turn capture | applies the approved prompt | applies the approved model |
|:--|:--|:--|:--|:--|:--|
| **OpenClaw** | ✅ `after_tool_call` | ✅ training mode | ✅ | ✅ `before_prompt_build` | ✅ `before_model_resolve` + a registered provider (needs `allowConversationAccess`) |
| **DeepSeek Harness** | ✅ `tools/result` | — | — | — | — |

**Rollouts are the OpenClaw lane.** DeepSeek Harness exposes no seam for handing a task to a running agent, so on dsh this plugin records outcomes and nothing else, in every mode — it writes to `PERCEPTEYE_TRAJECTORY_DIR` and with that unset it writes nothing.

**This OpenClaw adapter does not claim `llm_call_count`.** The host's public `llm_input` / `llm_output` hooks bracket a whole attempt and expose no provider-call id; one attempt may contain tool loops, retries, or compaction and therefore several provider calls. Counting those hooks or assistant messages would be a guess. The plugin reports no count, and Mission Control excludes the rollout from verified on-policy training even when its gateway has its own count. A future host adapter may use the framework-neutral counter only when its host exposes independently identified per-call start and terminal evidence. DeepSeek Harness also makes no model-call-count claim. A subagent the rollout spawns is not routed to the rollout's model — OpenClaw names a subagent's parent only after its run has started — so it samples your configured model; the plugin logs that once per rollout and the counter, under any adapter, reports no count for it, which keeps the rollout out of training.

**Every recording hook is structurally incapable of altering a run**: OpenClaw's `after_tool_call` returns `void`, and dsh's `tools/result` is `@mode emit` over deep-frozen objects. The tool-result mutation seams both harnesses expose — result middleware, `tools/post` — are deliberately unused, in every mode. A collector that can corrupt the run it is measuring is worse than no collector.

**The behavior-changing seams are separate from recording.** In production,
`before_prompt_build` returns the approved system prompt and
`before_model_resolve` returns the approved provider and model — beat ⑥ of the
loop rather than telemetry. In training, `before_agent_run` blocks a queued
turn if its lease expired before model submission, and `before_tool_call`
blocks any later side effects after an active lease is revoked. OpenClaw does
not expose an ordinary-plugin API for aborting an already-active model loop,
so that loop may wind down, but it cannot start another tool call or report a
stale result. None of these gates is registered by the production rollout
lane, because that lane does not exist in production mode.

**The registered provider answers for its own id and nothing else.** OpenClaw asks every registered provider plugin to normalise a transport when the matched one declines, so a provider that answered unconditionally would silently redirect your Anthropic or OpenAI traffic. This one returns nothing unless the provider being assembled is `percepteye-flywheel` — the id it registers, and the id it names in `before_model_resolve`.

## Two modes, one switch, in a harness

Everything the plugin does beyond local recording is decided by `PERCEPTEYE_AGENT_MODE`.

```bash
export PERCEPTEYE_AGENT_MODE=training     # claim rollouts and run them
export PERCEPTEYE_AGENT_MODE=production   # the default — for the process serving your users
```


**Training is always an explicit choice, and it takes two switches.** `PERCEPTEYE_AGENT_MODE=training` here says this install may run practice tasks; **Allow practice runs** on the agent in Mission Control (an org admin) says the platform may send them. With either off, no practice task runs. A training install runs our tasks through your agent's real tools, so point it at a test or sandbox backend.

| | `training` | `production` (default) |
|---|---|---|
| Records tool outcomes locally | yes | yes |
| Alters a tool result | **never** | **never** |
| Claims rollouts | yes | **no** |
| Puts a task into your agent's context | yes | **no** |
| Starts turns by itself | yes | **no** |
| Captures the turns you serve | n/a | yes |
| Uploads them | n/a | only once an operator enables it |
| **Applies your approved system prompt** | **no** | **yes** — off with `PERCEPTEYE_APPLY_PROMPT=0` |
| **Points your agent at the approved model** | **no** | **yes**, with `hooks.allowConversationAccess: true` — off with `PERCEPTEYE_APPLY_MODEL=0` |

**In `production` the rollout hooks are not registered at all** — the guarantee is the absence of the subscription, not a branch inside a handler that a later edit could invert. **`production` is not "observe-only"**, and this README used to say it was: applying a system prompt and a model changes what the agent does, which is the whole point of beat ⑥. What production mode still guarantees absolutely is that it **claims no work and starts no turn**.

**Both halves apply to this agent's own served turns and to nothing else.** Not to a subagent it spawns, not to a scheduled (cron) turn, and not to another agent in the same gateway. Those are ordinary runs distinguished only by their session key, and the plugin reads the `agentId` and `sessionKey` OpenClaw puts on every hook context to tell them apart. If it cannot tell, it applies nothing.

**In `training` neither half is applied**, deliberately. A rollout is evidence about the agent *as configured*; changing its prompt or its model mid-flight moves the behaviour with no weight change behind it, and the loop would attribute the difference to training.

**In `training` the plugin works the flywheel on its own**, starting each rollout's turn in its own `percepteye-rollout-*` session — never one you are using. If the host closes that seam, it says so once and falls back to delivering the task into the next turn you start; rollouts keep working either way.

**An agent whose own environment grades the episode says so in a file.** When the plugin drives a rollout it reads `outcome.json` from `PERCEPTEYE_TRAJECTORY_DIR` as the agent's run ends: one JSON object, every key optional — `reward` (a finite number), `success` (`true` or `false`), and `checks`, `termination` and `seeds` as the report carries them. These are the Python runner's rules for the same file, and the Python SDK's suite drives one table of files through both readers. Nothing is coerced, and a part that is malformed is ignored alone: the rollout is still reported. More than 200 checks is not malformed — the first 200 are reported and the report says how many were not (`checks_dropped`); the same count says so when a report's checks could not be sent at all. `NaN` and `Infinity` are read as `null`. The file is read once and removed, and one left by an earlier run is discarded when a rollout starts, so no episode is graded by another's file. A success the host itself reported is never taken back by the file.

`PERCEPTEYE_TRAJECTORY_DIR` names where a **training** rollout's outcomes are written, and the rollout driver sets it per rollout. It is not an off switch. These are:

```bash
export PERCEPTEYE_CAPTURE=0        # register nothing, record nothing, claim nothing
export PERCEPTEYE_APPLY_PROMPT=0   # keep recording, but leave the system prompt alone
export PERCEPTEYE_APPLY_MODEL=0    # keep recording, but leave the model alone
```

All three are also OpenClaw config settings (`capture`, `applyPrompt`, `applyModel`), where config wins over the environment. `PERCEPTEYE_APPLY_PROMPT=0` subscribes no prompt hook at all and does not even fetch the prompt text; `PERCEPTEYE_APPLY_MODEL=0` subscribes no model hook and registers no provider. Your host can also block them from the outside: `plugins.entries.agent-flywheel.hooks.allowPromptInjection: false` stops the prompt half, and simply not setting `allowConversationAccess` stops the model half.

## Outcomes and feedback from the plugin

The plugin's handle carries the same calls the framework API has, with the
same rules (see [Production observability](../README.md#-production-observability)):

```js
const { capture, currentRolloutId } = register(api, pluginConfig);

capture.reportOutcome("resolved", { turnId: runId });       // a production turn, by its run id
capture.reportTurnFeedback("corrected", { turnId: runId });
const episodeId = currentRolloutId(ctx);                    // in a training session, the episode's id
```

`capture` is `null` in a training install. Outcomes travel with production
capture, so report an episode's outcome from the production install with
`{ episodeId }`.

## The approved pair, applied by the plugin

With a key set, a `production` install also asks the control plane, **once at startup**, what this agent should be running:

- `GET /policy/current` — which model. **Applied**: the plugin registers a provider (`percepteye-flywheel`), returns it from `before_model_resolve` as the provider and model for the turn, and supplies the served `base_url` through that provider's transport. The startup line still names the `base_url`, model and `serving_generation`, because that is what a fleet cycles a replica on.
- `GET /prompt/current` — the approved system prompt. **Applied**, by replacing the prompt your host assembled, for every attempt. Re-read when `/policy/current`'s `prompt_generation` names a newer approval (below).

The model is read once, not per turn: a model that moves under a running agent splits a process's traffic across two behaviours with nothing recording where the seam was. Restart to pick up a new one — `serving_generation` changes when and only when the answer does. The prompt is the exception: at most once per `ttl_s` (never faster than 30 s) the plugin re-reads `/policy/current` in the background of a turn, and only a changed `prompt_generation` fetches new text. The turn that noticed keeps its prompt, the next turn runs the new one, and the log names the switch, so the seam is recorded.

**What stops the prompt being applied**, each logged with its own reason:

| | |
|:--|:--|
| no API key | the ordinary first install: the control plane is never asked and no hook is subscribed |
| `PERCEPTEYE_APPLY_PROMPT=0` | you switched it off — the hook is not subscribed and the prompt text is not even fetched |
| an empty answer | nothing has passed the approval gate — your prompt stands. It never means "run with no prompt" |
| `withdrawn` | a person withdrew the approved prompt and none is approved in its place — your prompt stands, and one already applied is taken away from the next turn |
| `stale_baseline` | your own baseline prompt changed after the pair was certified, so the approved text was shaped against a prompt you no longer ship |
| a status that is not `approved`/`delivered` | a draft or pending bundle never serves |
| the bundle disagreeing with itself | its prompt checksum and the checkpoint it was certified against differ — that is not the pair anybody approved |

**And what stops the model being applied**, each with its own reason too:

| | |
|:--|:--|
| no API key | as above — the same one cause, said the same way |
| `PERCEPTEYE_APPLY_MODEL=0` | you switched it off |
| the conversation opt-in missing | `before_model_resolve` is a conversation hook; without `hooks.allowConversationAccess: true` this host never delivers it |
| no provider could be registered | the registered provider is the only thing that can supply the served `base_url`, so if your host has no provider surface or refuses the id, the model half is refused rather than pointing your agent at a provider the host does not know |
| the model withdrawn | the control plane took the approved model away (`withdrawn: true`), so the model your host configures stands from the next start |
| no endpoint served | this agent is on the champion arm, or its candidate is not deployed anywhere — nothing to point at |
| an archive reference as the model | a `gs://` or `s3://` path is a stored artifact, not a name an endpoint can serve; sending it would 404 every completion |

**And either half can be refused for one run rather than for the process** — a subagent turn, a scheduled turn, another agent in the same gateway, or a host that named no agent for the run. Each of those is logged too, once per distinct reason, naming which half and which run.

**The pair check is the line worth reading.** When both halves land, the startup log confirms it: the approved prompt is running on the checkpoint it was certified with, which is the combination that was evaluated. When only one lands, it *warns* and names **which** half is missing and why — because half of a validated combination is not the improvement anybody measured, and an operator who is not told will read the behaviour change as the certified one.

A control plane that is unreachable costs the improvement and nothing else: no answer, no change, no error.

## Configuring the plugin

Every setting in the README's [Configuration](../README.md#%EF%B8%8F-configuration)
table is also an OpenClaw config key under
`plugins.entries.agent-flywheel.config`, with the same name. **Config wins over
the environment**: OpenClaw hot-reloads config and keeps a secret under its own
secret handling, while a gateway reads its environment once, at launch. The
nested execution snapshot is config-only, so component names and completeness
stay typed instead of being parsed from a shell string. `agentId` defaults to
`openclaw` here; set it if your host runs more than one agent.

```json
"plugins": { "entries": { "agent-flywheel": { "config": {
  "agentId": "support-agent",
  "describe": { "system_prompt": "You triage support tickets.",
                "tools": [{ "name": "lookup_ticket", "description": "Read one ticket.",
                            "input_schema": { "type": "object", "properties": { "id": { "type": "string" } } },
                            "read_only": true }] },
  "rules": ["Before issuing a refund, confirm the order number with the customer."]
} } } }
```

`describe` matters more here than in the framework API: OpenClaw's
`llm_input` carries no tool list, so without it the plugin registers an agent
whose tools are unknown, and no task can be generated for it. With nothing
observed, the record names the host, `framework: "openclaw"`.

One host setting is not ours and has no environment form:
`plugins.entries.agent-flywheel.hooks.allowConversationAccess`. OpenClaw
requires it before it delivers conversation hooks to a plugin it did not
bundle. See [Install the plugin](#install-the-plugin).

## Fixtures from a live host

The suite includes payloads captured verbatim from a live OpenClaw run
(`test/host-fixtures.test.js`). If a future OpenClaw changes the shape, those
tests fail, rather than someone discovering it months later from bad training
data.
