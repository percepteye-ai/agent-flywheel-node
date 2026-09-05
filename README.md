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

**Observes only.** It cannot alter, block, delay or replace a tool result — and
that is a property of the hooks it uses, not a promise about the code. See
[Which hook, and why](#which-hook-and-why) for the surfaces that *could* have
changed your run, and why each was rejected.

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
