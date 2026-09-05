<div align="center">

# 🎡 percepteye-agent-flywheel — Node

### **Self-improving agents through continual learning, for OpenClaw and DeepSeek Harness.**

**Your agent keeps running in your harness, behind your firewall, on your credentials — unchanged.**<br/>
One plugin. Zero dependencies. Zero lines changed in your agent.

[![npm](https://img.shields.io/npm/v/percepteye-agent-flywheel?style=for-the-badge&logo=npm&logoColor=white&label=npm&color=3b82f6)](https://www.npmjs.com/package/percepteye-agent-flywheel)
[![node](https://img.shields.io/badge/node-%E2%89%A522.22.3-8b5cf6?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)
[![runtime dependencies](https://img.shields.io/badge/runtime_deps-0-f59e0b?style=for-the-badge)](#dependencies)
[![tests](https://img.shields.io/badge/tests-152-22c55e?style=for-the-badge)](#tests)
[![license](https://img.shields.io/badge/license-MIT-14b8a6?style=for-the-badge)](LICENSE)

**[Install](#install)** · [What it writes](#what-it-writes) · [Why `unknown` is real](#why-unknown-is-a-real-answer) · [Which hook, and why](#which-hook-and-why) · [Python or Node?](#python-or-node)

</div>

---

Records what your agent's tools actually did — `ok`, `failed` or **`unknown`** —
into the trajectory the PerceptEye flywheel trains on.

**It never alters a tool result.** In no mode can this plugin change, block,
delay or replace what your agent's tools return — that is a property of the
hook it uses, not a promise about the code. See
[Which hook, and why](#which-hook-and-why) for the surfaces that *could* have
changed your run, and why each was rejected.

**Beyond that, what it does depends on one setting — `PERCEPTEYE_AGENT_MODE`.**
The guarantee is scoped rather than blanket, because a blanket "observes only"
stopped being true the moment the plugin could claim rollouts, and a promise
about your data that the code does not keep is worse than a narrower one:

| | `production` | `training` (default) |
|---|---|---|
| Records tool outcomes locally | yes | yes |
| Alters a tool result | **never** | **never** |
| Claims rollouts from the control plane | **no** | yes |
| Puts a task into your agent's context | **no** | yes |
| Uploads production turns | [not yet — see below](#production-capture-is-opt-in) | n/a |

In `production` the rollout hooks **are not registered at all** — the guarantee
is the absence of the subscription, not a branch inside a handler that a later
edit could invert. `PERCEPTEYE_AGENT_MODE=production` is what you set on the
process that serves your users.

Rollouts are the **OpenClaw** lane. DeepSeek Harness exposes no seam for
handing a task to a running agent, so on dsh this plugin records outcomes and
nothing else, in every mode.

## Install

One package, two harnesses:

```bash
openclaw plugins install percepteye-agent-flywheel          # OpenClaw
dsh plugin --profile <name> add percepteye-agent-flywheel   # DeepSeek Harness
```

Then set one environment variable on the process running your agent:

```bash
export PERCEPTEYE_TRAJECTORY_DIR=/path/to/this/rollout
```

With the variable unset the plugin does nothing at all — no file, no writes, no
overhead. That is what lets you leave it installed permanently and have it
record only while a rollout is running.

## Python or Node?

**Pick one.** These are two implementations of the same flywheel for two
different homes, and a customer installs whichever matches the harness their
agent already runs in — never both.

| | this package | [`percepteye-agent-flywheel`](https://github.com/percepteye-ai/agent-flywheel) (PyPI) |
|---|---|---|
| **you have** | an OpenClaw or DeepSeek Harness agent | a Python agent, or a CLI agent you launch yourself |
| **you install** | a harness plugin | a pip package |
| **you change** | nothing — the harness loads it | nothing — one import, one call |
| **runtime deps** | none | one (`httpx`) |

The two are kept honest against each other by a shared contract schema
([`schema/flywheel-1.json`](schema/flywheel-1.json)) and a test that asserts
this package's wire types match it — because a comment saying "keep these in
sync" is not a mechanism.

## Rollouts, in training mode

A rollout is a graded task the control plane hands out. In `training` mode this
plugin claims one, delivers it into your agent's context, and reports what the
agent did — which is what produces the trajectories the model is fine-tuned on.

```bash
export PERCEPTEYE_AGENT_MODE=training     # the default
export PERCEPTEYE_API_KEY=pefw_...
```

and, in your OpenClaw config, the one host setting it needs:

```json
{ "plugins": { "entries": { "percepteye-agent-flywheel": {
    "hooks": { "allowConversationAccess": true } } } } }
```

**Why that setting is required, and why nothing is claimed without it.** The
agent's *answer* arrives on the `agent_end` hook, which OpenClaw classifies as
a conversation hook and drops for any non-bundled plugin unless you opt in.
Without it the plugin could claim work and never report it — and a claimed
rollout is a lease nobody else can take, so the queue would look busy while
nothing progressed. It therefore refuses to claim at all and prints the setting
to add. Delivery itself needs no opt-in: next-turn injection is allowed by
default.

**Today the plugin does not start the turn — you or your harness do.** The task
is placed in the *next* turn your agent takes. The Python SDK's CLI-hook lane
has the same shape (there the task is written into the working directory), so
the two are at parity; this lane simply delivers into the agent's real context,
exactly once, and can tell whether delivery succeeded.

That is a **choice, not a limit**. OpenClaw restricts its documented
`scheduleSessionTurn` API to plugins bundled with the host, but the underlying
cron service is handed to every plugin regardless of origin, and a job carrying
an `agentTurn` payload does start a turn. Reaching past a restriction the host
states explicitly, using a seam it leaves open elsewhere, is not something this
package does quietly inside your agent — it could be closed in any patch
release. If you want unattended rollouts, that is the mechanism, and it should
be a decision you make rather than a default you inherit.

### Production capture is opt-in

**This package does not upload production turns today.** In `production` mode
it records tool outcomes locally and sends nothing. The Python SDK's `attach()`
does upload them, and that is the one capability where the two are not yet at
parity; it is the next piece of work here.

Worth knowing before it lands, because it governs whether anything will arrive
when it does: uploading production turns is **off until an operator turns it on,
per agent**. That is a deliberate exception to this project's default-on rule —
a production turn carries *your end users'* own messages, so a default that
starts sending them is a disclosure nobody made. The control plane answers the
question when an agent registers, so a client never learns its permission by
uploading and finding out.

Local recording is unaffected by any of this. It never leaves the machine, and
it works with no account at all.

## What it writes

One JSON object per executed tool call, appended to
`$PERCEPTEYE_TRAJECTORY_DIR/tool_calls.jsonl`:

```json
{"name":"exec","arguments":{"command":"exit 3"},"outcome":"failed","status_code":null,"error":"(Command exited with code 3)","error_class":"ToolError","latency_ms":155,"agent_name":"main","tool_call_id":"call_percepteye_1"}
```

That line is real output from a live OpenClaw run, and it is the same format
the Python SDK writes and reads. Two implementations, one on-disk format —
which is what lets a Python parent read a Node agent's outcomes, and what the
shared contract schema exists to keep true.

## Why `unknown` is a real answer

`unknown` means the call executed and the host did not tell us whether it
worked. It is never rounded up to `ok`, because a tool call scored as a success
when nobody said so is training data that teaches the model a failure was fine.

The distinction is not academic here. In a real run OpenClaw reports
`details.status: "completed"` for a command that exited **3** — `completed`
means the process finished, not that it worked. A classifier keying on that
field would grade every failed command as a success. So this plugin reads the
exit code, and where it cannot read one it says `unknown`:

| what we see | outcome |
|---|---|
| host sets `error` | `failed` |
| `exec`/`bash` with exit 0 | `ok` |
| `exec`/`bash` with non-zero exit | `failed` |
| `exec`/`bash`, exit code unreadable | `unknown` |
| `read`, `write`, `edit`, `ls`, `grep`, `find` with no error | `ok` |
| anything else — MCP tools, third-party plugin tools | `unknown` |

The last row is the important one. An MCP server that returns `{"error": ...}`
as ordinary content looks identical to success from here, so the honest answer
is that we did not observe the verdict. Tools move out of that row when a
fixture proves how they report failure — promotion is earned, never assumed.

## Which hook, and why

### OpenClaw

OpenClaw exposes three places to see a tool result. Only one is both complete
and structurally incapable of changing the run:

| surface | can it alter the result? | |
|---|---|---|
| `registerAgentToolResultMiddleware` | **yes** — its return value replaces what the model reads | rejected |
| `registerAgentEventSubscription` | no, but the payload is split across two events and exec results are capped before dispatch | rejected |
| `api.on("after_tool_call", …)` | no — returns `void` | **used** |

`after_tool_call` carries the whole call in one event — `params`, `result`,
`error`, `durationMs`, `toolCallId`, plus agent and session identity — so the
safer hook is also the more complete one. It costs nothing to be unable to
break your agent.

The rule behind it: capturing evidence must never be able to change the
behaviour being measured. A collector that can corrupt the run it is measuring
is worse than no collector.

`openclaw plugins doctor` reports this plugin as *hook-only*, which is correct
— an observer claims no capability seam, and the manifest declares no
`contracts` because there is none to declare.

### DeepSeek Harness

dsh's tool pipeline is mostly waterfalls: `tools/execute` wraps dispatch,
`tools/post` can accept, replace or **block** a result, and
`tools/code-dispatch-log` rewrites what gets logged. A listener on any of them
can change what the model sees.

`tools/result` is declared `@mode emit` and typed to return `undefined`, and
the registry **deep-freezes** both the execution and the result before
publishing them — with an invariant that fails the harness if it ever publishes
something unfrozen. So this plugin cannot alter a tool result even by accident:
there is no return channel, and the object it receives is immutable.

dsh's exec tools also declare a real output schema — `kind`, `exitCode`,
`signal`, `timedOut`, `aborted` — which lets three cases be told apart that a
cruder reading merges:

| what dsh reports | outcome |
|---|---|
| `isError: true` | `failed` (with its own error class) |
| foreground, exit 0 | `ok` |
| foreground, non-zero exit | `failed` |
| killed by a signal, or timed out | `failed` |
| **`kind: "background"`** | **`unknown`** — launched, not finished |
| **`aborted: true`** | **`unknown`** — cancelled, which is not the agent's mistake |
| exit unreadable | `unknown` |

A backgrounded command has no exit code because nothing has exited; grading it
`ok` would claim a result for work still running. An aborted one never got to
say what it would have done.

The two entries are separate modules on purpose. Cordis normalises a plugin
with `exports.default ?? exports`, so a `default` export would be handed to it
*instead of* `apply` — the OpenClaw entry needs a default and the dsh entry
must not have one.

## Dependencies

None. `node:fs` and `node:path` only. This runs inside someone else's agent
process, and every dependency added here is a version conflict imposed on a
customer who did not ask for it.

## Tests

```bash
npm test
```

The suite includes payloads captured verbatim from a live OpenClaw run
(`test/host-fixtures.test.js`). If a future OpenClaw changes the shape, those
fail — and someone re-reads the payload, rather than discovering it months
later from bad training data.

## License

MIT — see [LICENSE](LICENSE). Same licence as the Python SDK.
