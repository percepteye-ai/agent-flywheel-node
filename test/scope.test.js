/**
 * WHOSE RUN IS THIS — the predicate both halves of the last mile ask.
 *
 * THE DEFECT THESE HOLD DOWN. The prompt handler took no arguments, so it
 * returned one agent's approved prompt for every `before_prompt_build` in the
 * process. The host runs that hook for every agent, every subagent and every
 * cron turn a gateway serves, and it supplies `agentId` and `sessionKey` on
 * the context of both hooks — the identity was there and was simply not read.
 *
 * So these assert the two things a scope gate has to get right: it must APPLY
 * to the agent's own turns (or the feature is dead), and it must REFUSE
 * everything else (or an operator's approval for one agent becomes a
 * process-wide swap). Refusing everything would pass half of this file.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DEFAULT_HOST_AGENT_ID, hostAgentIds, isCronSessionKey,
  isSubagentSessionKey, normalizeAgentId, parseAgentSessionKey,
  resolveServedAgent, scopeDecision,
} from "../src/scope.js";

/** A single-agent host, which is the ordinary install. */
const SOLO = resolveServedAgent({ agentId: "openclaw", hostConfig: {} });

/** A host running three agents, with this install naming one of them. */
const MULTI = resolveServedAgent({
  agentId: "support",
  hostConfig: { agents: { list: [{ id: "main" }, { id: "support" }, { id: "ops" }] } },
});

describe("session keys, read the way the host reads them", () => {
  it("parses the agent wrapper", () => {
    assert.deepEqual(
      parseAgentSessionKey("agent:main:slack:chat:C123"),
      { agentId: "main", rest: "slack:chat:c123" },
    );
  });

  it("is not fooled by case", () => {
    assert.equal(parseAgentSessionKey("AGENT:Main:x")?.agentId, "main");
  });

  it("refuses anything that is not an agent-scoped key", () => {
    for (const key of ["", null, undefined, "chat:c1", "agent:main", "agent::x",
      "agent:main:", "notagent:main:x"]) {
      assert.equal(parseAgentSessionKey(key), null, JSON.stringify(key));
    }
  });

  it("spots a subagent session, wrapped or bare", () => {
    // `isSubagentSessionKey` accepts both shapes; so does this.
    assert.equal(isSubagentSessionKey("subagent:abc"), true);
    assert.equal(isSubagentSessionKey("agent:main:subagent:abc"), true);
    assert.equal(isSubagentSessionKey("AGENT:MAIN:SUBAGENT:abc"), true);
    assert.equal(isSubagentSessionKey("agent:main:slack:chat:c1"), false);
    assert.equal(isSubagentSessionKey(""), false);
  });

  it("spots a cron session", () => {
    assert.equal(isCronSessionKey("agent:main:cron:job7:run:9"), true);
    assert.equal(isCronSessionKey("agent:main:slack:chat:c1"), false);
    // Bare `cron:` is NOT one: the host's own predicate requires the agent
    // wrapper, and inventing a wider rule here would refuse a channel whose
    // name happened to start with those four letters.
    assert.equal(isCronSessionKey("cron:job7"), false);
  });
});

describe("normalizeAgentId — the host's folding, minus its default", () => {
  it("folds the way the host folds", () => {
    assert.equal(normalizeAgentId(" Support Bot "), "support-bot");
    assert.equal(normalizeAgentId("--x--"), "x");
  });

  it("answers null for nothing, never the default", () => {
    // The host folds "" to `main`. Folding it here would turn "the host named
    // no agent" into "the host named the default agent" — a claim, not an
    // observation, and it is the claim that decides whether a prompt is
    // swapped.
    for (const v of ["", "   ", null, undefined, "---"]) {
      assert.equal(normalizeAgentId(v), null, JSON.stringify(v));
    }
  });
});

describe("which host agent this install serves", () => {
  it("a host with no agents configured runs exactly one, called main", () => {
    assert.deepEqual(hostAgentIds(undefined), [DEFAULT_HOST_AGENT_ID]);
    assert.deepEqual(hostAgentIds({}), [DEFAULT_HOST_AGENT_ID]);
    assert.deepEqual(hostAgentIds({ agents: { list: [] } }), ["main"]);
  });

  it("takes the host's list, normalised and deduped", () => {
    assert.deepEqual(
      hostAgentIds({ agents: { list: [{ id: "Main" }, { id: "main" }, null, { id: "Ops Bot" }] } }),
      ["main", "ops-bot"],
    );
  });

  it("uses the configured name when the host actually runs that agent", () => {
    assert.equal(MULTI.id, "support");
  });

  it("uses the ONE agent when there is only one — the ordinary install", () => {
    // `agentId` defaults to "openclaw" (the control plane's name for this
    // install) while the host's default agent is "main". Comparing the two
    // raw would refuse every default install and call that safety.
    assert.equal(SOLO.id, "main");
    assert.equal(SOLO.sole, true);
  });

  it("REFUSES when several agents run and none is named", () => {
    const ambiguous = resolveServedAgent({
      agentId: "openclaw",
      hostConfig: { agents: { list: [{ id: "main" }, { id: "support" }] } },
    });
    assert.equal(ambiguous.id, null);
    assert.match(ambiguous.reason, /2 agents/);
    assert.match(ambiguous.reason, /agentId/, "the refusal must name the remedy");
  });
});

describe("scopeDecision — applies to the agent's own turns, and nothing else", () => {
  it("applies to a served turn of the agent it is for", () => {
    const d = scopeDecision(
      { agentId: "main", sessionKey: "agent:main:slack:chat:c1" }, SOLO);
    assert.equal(d.apply, true);
    assert.equal(d.reason, "");
  });

  it("applies with only an agentId — the host may send either", () => {
    assert.equal(scopeDecision({ agentId: "main" }, SOLO).apply, true);
  });

  it("applies with only a session key on a single-agent host", () => {
    assert.equal(
      scopeDecision({ sessionKey: "agent:main:slack:chat:c1" }, SOLO).apply, true);
  });

  it("REFUSES a subagent's session, and names that", () => {
    const d = scopeDecision(
      { agentId: "main", sessionKey: "agent:main:subagent:t9" }, SOLO);
    assert.equal(d.apply, false);
    assert.match(d.reason, /subagent/);
    assert.doesNotMatch(d.reason, /cron/);
  });

  it("REFUSES a cron turn, and names that", () => {
    const d = scopeDecision(
      { agentId: "main", sessionKey: "agent:main:cron:nightly:run:3" }, SOLO);
    assert.equal(d.apply, false);
    assert.match(d.reason, /cron/);
    assert.doesNotMatch(d.reason, /subagent/);
  });

  it("REFUSES another agent's run, and names both agents", () => {
    const d = scopeDecision(
      { agentId: "ops", sessionKey: "agent:ops:slack:chat:c1" }, MULTI);
    assert.equal(d.apply, false);
    assert.match(d.reason, /"ops"/);
    assert.match(d.reason, /"support"/);
  });

  it("REFUSES when the host names no agent and several are running", () => {
    const d = scopeDecision({ sessionKey: "slack:chat:c1" }, MULTI);
    assert.equal(d.apply, false);
    assert.match(d.reason, /runs\s+several/);
  });

  it("FAILS CLOSED with no identity at all", () => {
    for (const ctx of [{}, { agentId: "" }, { sessionKey: "  " }]) {
      const d = scopeDecision(ctx, SOLO);
      assert.equal(d.apply, false, JSON.stringify(ctx));
      assert.match(d.reason, /neither an agent nor a session/);
    }
  });

  it("FAILS CLOSED with no context object at all", () => {
    for (const ctx of [null, undefined, "nonsense", 7]) {
      const d = scopeDecision(ctx, SOLO);
      assert.equal(d.apply, false, JSON.stringify(ctx));
      assert.match(d.reason, /no hook context/);
    }
  });

  it("FAILS CLOSED when no agent could be resolved", () => {
    const ambiguous = resolveServedAgent({
      agentId: "openclaw",
      hostConfig: { agents: { list: [{ id: "main" }, { id: "support" }] } },
    });
    const d = scopeDecision(
      { agentId: "main", sessionKey: "agent:main:slack:chat:c1" }, ambiguous);
    assert.equal(d.apply, false);
    assert.equal(d.reason, ambiguous.reason, "the startup reason is the turn's reason");
  });

  it("prefers ctx.agentId, and reads the key when it is absent", () => {
    // A subagent of ANOTHER agent must be refused for the agent reason too,
    // not silently accepted because the subagent check happened to fire.
    assert.equal(scopeDecision({ sessionKey: "agent:ops:slack:c1" }, MULTI).apply, false);
    assert.equal(scopeDecision({ sessionKey: "agent:support:slack:c1" }, MULTI).apply, true);
  });
});
