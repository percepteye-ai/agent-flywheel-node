<div align="center">

# <img src="docs/assets/flywheel-spinner.gif" height="44" alt="" align="absmiddle"> percepteye-agent-flywheel — Node

### **Your agent gets better at its own job, every day, without you writing a training pipeline.**

**It keeps running in your harness, behind your firewall, on your credentials — unchanged.**<br/>
One plugin. Zero runtime dependencies. Zero lines changed in your agent.

[![npm](https://img.shields.io/npm/v/percepteye-agent-flywheel?style=for-the-badge&logo=npm&logoColor=white&label=npm&color=3b82f6)](https://www.npmjs.com/package/percepteye-agent-flywheel)
[![node](https://img.shields.io/badge/node-%E2%89%A522.22.3-8b5cf6?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json)
[![runtime dependencies](https://img.shields.io/badge/runtime_deps-0-f59e0b?style=for-the-badge)](#-why-it-earns-its-place)
[![lines changed in your agent](https://img.shields.io/badge/lines_changed_in_your_agent-0-ec4899?style=for-the-badge)](#-install-in-one-call)
[![tests](https://img.shields.io/badge/tests-281_·_0_skips-22c55e?style=for-the-badge)](#-develop)
[![license](https://img.shields.io/badge/license-MIT-14b8a6?style=for-the-badge)](LICENSE)

<img src="docs/assets/flywheel-overview.gif"
     width="1040"
     alt="Your agent — prompt, tools and model — sits inside your infrastructure. The plugin wraps it from the outside with zero lines changed inside. Rollouts and observed outcomes go out; a trained policy comes back. The model row flips from your-model to a policy trained on this agent's own work, while the prompt and tools rows stay untouched.">

**[Install](#-install-in-one-call)** · [How the loop closes](#-how-the-loop-closes) · [Modes](#-two-modes-one-switch) · [Production observability](#-production-observability) · [Harnesses](#-harnesses) · [Python or Node?](#-python-or-node)

</div>

---

**Your agent already does real work. This turns that work into training data, and hands back a model trained on it.**

No container to build. No cluster to run. No GPU to provision. No inbound port to open. No labelling team. No eval suite to write. Your agent does not move — a plugin loads beside it, watches what its tools actually did, and feeds a control plane that does the post-training for you.

<br/>

## 🎯 What you get

| | |
|:--|:--|
| 🔁 **A continual-learning loop** | your agent runs graded tasks, its real outcomes go back, and the next model is trained on *this agent's* work — not a generic benchmark |
| 🤖 **Autonomous post-training** | task generation, grading, dataset construction, training and promotion happen on our side. You build none of it |
| 🧪 **Tasks from your real tool surface** | the plugin reads the system prompt your host actually assembled and the tool list actually sent to the model, so the work you're graded on is work you can actually do |
| 📈 **Honest telemetry on day one** | your agent's true tool-failure rate, recorded locally, with **no account and no network** |
| 📡 **Production observability** | capture the turns you actually serve — the user's message, the tool calls, the answer — and turn live traffic into evidence |
| 🛡️ **It cannot break your agent** | the hook it uses returns `void`. It can never change, block, delay or replace what a tool returns |

<br/>

## ⚡ Install in one call

One package, two harnesses. Pick your line:

```bash
openclaw plugins install percepteye-agent-flywheel          # OpenClaw
dsh plugin --profile <name> add percepteye-agent-flywheel   # DeepSeek Harness
```

**That's the integration.** No import, no wrapper process, no sidecar. Start your agent exactly the way you always did.

Want it to start contributing? Add a key and one host setting:

```bash
export PERCEPTEYE_API_KEY=pefw_...        # optional — without it, nothing leaves the machine
```

```jsonc
// your OpenClaw config
{ "plugins": { "entries": { "percepteye-agent-flywheel": {
    "hooks": { "allowConversationAccess": true } } } } }
```

That setting is what lets the plugin read your agent's answer and describe your agent, and it **refuses to claim work without it** rather than half-working. The agent's *answer* arrives on the `agent_end` hook, which OpenClaw drops for non-bundled plugins unless you opt in — and a claimed rollout nobody can report is a lease that just expires. It prints the exact line to add.

> [!TIP]
> Everything here is also settable in your OpenClaw config — `apiKey`, `agentId`, `mode`, `capture`, `controlPlaneUrl` — where it lives under the host's own secret handling. Config wins over the environment.

<br/>

## 🔁 How the loop closes

<p align="center">
  <img src="docs/assets/flywheel-loop.gif" width="980"
       alt="The SDK inside the customer's agent, talking to the control plane. On the left, inside your infrastructure: install the plugin, your harness loads it, your agent runs unchanged, and its trajectory is recorded. A dashed trust boundary splits the picture. On the right, the control plane: it generates tasks from your tool surface, scores every rollout, trains the policy, and hands a candidate back as an endpoint you can call. A return arrow closes the ring — the better agent runs the next lap.">
</p>

| beat | what happens | who does the work |
|:--|:--|:--|
| **⓪ Describe** | the plugin reads the fully assembled system prompt and the real tool list, and writes `discovered_agent.json` into the rollout's trajectory | automatic |
| **① Claim** | training mode claims one graded task at a time from the control plane | you dial out — no inbound port |
| **② Run** | the task is delivered into your agent's context, in a dedicated `percepteye-rollout-*` session | your agent, unchanged |
| **③ Record** | every executed tool call lands as `ok` / `failed` / **`unknown`** | the `after_tool_call` hook |
| **④ Report** | the trajectory and the agent's answer go back | the plugin |
| **⑤ Train** | tasks generated, rollouts graded, dataset built, policy trained and promoted | **Percepteye — you build none of it** |
| **⑥ Serve** | the trained candidate comes back as an endpoint you can point your agent at | your config, your call |

That last beat is what makes it a flywheel rather than a pipeline: **the better agent generates the better evidence.**

<br/>

## 🎚 Two modes, one switch

Everything the plugin does beyond local recording is decided by `PERCEPTEYE_AGENT_MODE`.

```bash
export PERCEPTEYE_AGENT_MODE=training     # the default — claim rollouts and run them
export PERCEPTEYE_AGENT_MODE=production   # observe only — for the process serving your users
```

| | `training` (default) | `production` |
|---|---|---|
| Records tool outcomes locally | yes | yes |
| Alters a tool result | **never** | **never** |
| Claims rollouts | yes | **no** |
| Puts a task into your agent's context | yes | **no** |
| Starts turns by itself | yes | **no** |
| Captures the turns you serve | n/a | yes |
| Uploads them | n/a | only once an operator enables it |

**In `production` the rollout hooks are not registered at all** — the guarantee is the absence of the subscription, not a branch inside a handler that a later edit could invert.

**In `training` the plugin works the flywheel on its own**, starting each rollout's turn in its own `percepteye-rollout-*` session — never one you are using. If the host closes that seam, it says so once and falls back to delivering the task into the next turn you start; rollouts keep working either way.

`PERCEPTEYE_TRAJECTORY_DIR` names where a **training** rollout's outcomes are written, and the rollout driver sets it per rollout. It is not an off switch. This is:

```bash
export PERCEPTEYE_CAPTURE=0   # register nothing, record nothing, claim nothing
```

<br/>

## 📡 Production observability

In `production` mode the plugin records the turns your agent is already serving — one directory per turn, in the same on-disk format the Python SDK writes:

```
$PERCEPTEYE_CAPTURE_DIR/<runId>/       # default ~/.percepteye/captured
    turns.jsonl        {"kind":"task"|"answer","text","turn_id","conversation_id"}
    conversation_id
    tool_calls.jsonl
```

**Uploading is off until an operator turns it on, per agent.** A production turn carries *your end users'* messages, so the default cannot be to send them. With a key set, the plugin registers this agent with the control plane at startup — that is what makes it appear so an operator can enable capture — then asks a plain read whether it may upload. It never learns its permission by uploading and finding out. Once enabled, turns go up every 32 turns and again at gateway shutdown.

Recording itself is unaffected by any of that: it never leaves the machine, and works with no account at all.

<br/>

## 🧩 Harnesses

| harness | records outcomes | rollouts | production turn capture |
|:--|:--|:--|:--|
| **OpenClaw** | ✅ `after_tool_call` | ✅ training mode | ✅ |
| **DeepSeek Harness** | ✅ `tools/result` | — | — |

**Rollouts are the OpenClaw lane.** DeepSeek Harness exposes no seam for handing a task to a running agent, so on dsh this plugin records outcomes and nothing else, in every mode — it writes to `PERCEPTEYE_TRAJECTORY_DIR` and with that unset it writes nothing.

Both hooks are structurally incapable of altering a run: OpenClaw's `after_tool_call` returns `void`, and dsh's `tools/result` is `@mode emit` over deep-frozen objects. The mutation seams both harnesses expose — result middleware, `tools/post` — are deliberately unused. A collector that can corrupt the run it is measuring is worse than no collector.

<br/>

## 📄 What it writes

One JSON object per executed tool call, appended to `tool_calls.jsonl`:

```json
{"name":"exec","arguments":{"command":"exit 3"},"outcome":"failed","status_code":null,"error":"(Command exited with code 3)","error_class":"ToolError","latency_ms":155,"agent_name":"main","tool_call_id":"call_percepteye_1"}
```

That line is real output from a live OpenClaw run, and it is the same format the Python SDK writes and reads.

<br/>

## ✨ Why it earns its place

- 🪶 **Zero runtime dependencies.** Node builtins only — no version conflict imposed on a customer who did not ask for one, enforced by a CI job.
- 🔌 **A kill switch that really is one.** `PERCEPTEYE_CAPTURE=0` subscribes no hooks and records nothing, which is what lets it stay installed on a process serving users.
- 🎯 **`unknown` is a real answer** — a tool call whose verdict nobody stated is never rounded up to `ok`, because a failure scored as a success is training data that teaches the model the failure was fine.
- 🤝 **One on-disk format across both SDKs**, kept honest by a shared contract schema ([`schema/flywheel-1.json`](schema/flywheel-1.json)) and a test that asserts this package's wire types match it.
- 🧯 **It degrades, it doesn't fail.** A missing key, an unreachable control plane, a closed host seam — each costs the feature that needed it and says so once. Local recording keeps running.
- 🔒 **Every lane is opened from your side.** There is no listening socket anywhere in this package.

<br/>

## 🐍 Python or Node?

**Pick one.** Two implementations of the same flywheel for two different homes — install whichever matches the harness your agent already runs in, never both.

| | this package | [`percepteye-agent-flywheel`](https://github.com/percepteye-ai/agent-flywheel) (PyPI) |
|---|---|---|
| **you have** | an OpenClaw or DeepSeek Harness agent | a Python agent, or a CLI agent you launch yourself |
| **you install** | a harness plugin | a pip package |
| **you change** | nothing — the harness loads it | nothing — one import, one call |

<br/>

## 🛠 Develop

```bash
npm test     # 281 tests, no install step — node:test, zero dependencies
```

The suite includes payloads captured verbatim from a live OpenClaw run (`test/host-fixtures.test.js`). If a future OpenClaw changes the shape, those fail — rather than someone discovering it months later from bad training data.

---

MIT — see [LICENSE](LICENSE) · security reports: **security@percepteye.ai** · issues and PRs welcome at [agent-flywheel-node](https://github.com/percepteye-ai/agent-flywheel-node/issues).
