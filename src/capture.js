/**
 * PRODUCTION MODE: capture the turns this agent is already serving, and -- with
 * the operator's consent -- upload them.
 *
 * This is the production half of the package, and it is the mirror of the
 * Python SDK's `attach()`. Same on-disk format (see `turns.js`), same wire
 * shape, same consent rule, same cadence. A customer runs one package or the
 * other, so "same" has to mean the same, not similar.
 *
 * ── WHAT A TURN IS BUILT FROM, AND WHAT EACH PART COSTS ───────────────────
 *
 *   the user's message  `message_received`   UNGATED, void-returning.
 *   the tool calls      `after_tool_call`    UNGATED, void-returning. Already
 *                                            recorded; only the routing is new.
 *   the answer          `agent_end`          CONVERSATION-GATED. Dropped for a
 *                                            non-bundled plugin unless the
 *                                            operator sets
 *                                            `allowConversationAccess=true`.
 *
 * `before_agent_finalize` carries more -- sessionKey, turnId and
 * lastAssistantMessage in one event -- and is deliberately NOT used. Its result
 * type accepts `action: "revise"` and a `retry` instruction, so it is a
 * MUTATION seam: a handler there can send the agent round again. This package's
 * first rule is that capturing evidence must never be able to change the
 * behaviour being measured, and a recorder on a mutation seam breaks it whether
 * or not it currently returns undefined.
 *
 * SO A DEFAULT INSTALL CAPTURES A TURN WITHOUT ITS ANSWER, and that is a
 * designed-for state rather than a gap: the intake documents `final_text: null`
 * as "an ordinary state, not an error", stores the turn, grades it advisory
 * with an explicit reason, and excludes it from objectives that need a
 * completion. The plugin says once, at startup, which half it is missing and
 * what to set -- because a customer who sees turns arriving with no answers
 * deserves the cause, not a mystery.
 *
 * ── WHERE `message_received` DOES AND DOES NOT FIRE ───────────────────────
 *
 * It is emitted from the inbound CHANNEL dispatch path
 * (`dispatch-DnzGTpPs.js:1436`), so it covers an agent served over Slack,
 * WhatsApp, Discord and the like -- which is the population production turn
 * capture is for. It does NOT fire for a local terminal session. A turn with
 * tool calls and an answer but no `input_text` is still uploaded: the intake
 * accepts a null input for the same reason it accepts a null answer, and
 * inventing the user's message from the model's prompt would be manufacturing
 * the one field we cannot observe.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { conversationAccessGranted, lastAssistantText } from "./host.js";
import { ControlPlaneClient } from "./http.js";
import { percepteyeHome, safeSegment } from "./session.js";
import { AttachTransport } from "./transport.js";
import {
  listTurnDirs, readConversationId, recordConversationId, recordTurnText,
  safeTurnId, turnDir, turnIndexOf, turnWire,
} from "./turns.js";

/** Turns between automatic upload attempts. The Python SDK's `_FLUSH_EVERY`. */
export const FLUSH_EVERY = 32;

/** Turns per request. The intake's `TURN_BATCH_MAX`. */
export const BATCH_SIZE = 64;

/**
 * Which turns have already been sent.
 *
 * A FILE AT THE ROOT, never inside a turn directory. Writing a marker into a
 * turn's own directory bumps that directory's MTIME -- and mtime is the
 * ordering key for `turn_index`. Uploading would have silently reordered every
 * conversation it touched. The Python SDK carries the same file for the same
 * reason; this is not a coincidence to be tidied away.
 */
export const UPLOADED_INDEX = ".uploaded";

/** Where captured production turns live when nothing else says. */
export function captureRoot(env = process.env) {
  return env.PERCEPTEYE_CAPTURE_DIR || join(percepteyeHome(env), "captured");
}

/**
 * May captured turns be uploaded, per the control plane's own answer?
 *
 * THE SERVER DECIDES; this only reads the verdict. `capture.turns` is computed
 * in Mission Control from BOTH the per-agent consent flag
 * (`production_capture_enabled`, opt-in, NULL is not consent) AND whether this
 * flywheel key carries the `turn.report` scope. Re-deriving either half here
 * would be a second answer to a settled question, and it fails in the one
 * direction that costs a debugging session: the client believing it may upload
 * while every batch 403s, or the reverse.
 *
 * ABSENCE IS NOT CONSENT. A registration that failed, or a control plane too
 * old to send `capture` at all, yields `false` with a reason saying so.
 */
export function captureVerdict(registration) {
  const capture = registration && typeof registration === "object"
    ? registration.capture : null;
  if (!capture || typeof capture !== "object") {
    return {
      mayUpload: false,
      reason:
        "the control plane did not answer whether this agent may upload " +
        "production turns, so nothing is uploaded. Turns are still captured " +
        "locally.",
    };
  }
  // `=== true`, not truthiness: a consent question is answered by the exact
  // value. `turns: "false"` is truthy.
  const mayUpload = capture.turns === true;
  return {
    mayUpload,
    // The server's own sentence when it sent one -- it names the switch and
    // who can flip it, which anything written here could only paraphrase.
    reason: mayUpload ? null
      : (typeof capture.reason === "string" && capture.reason.trim()
        ? capture.reason
        : "production capture is not enabled for this agent."),
  };
}

/**
 * The turn store: three hooks in, turn directories out.
 *
 * Holds no per-turn state. Everything a turn needs is on the event that
 * carries it, keyed by `runId`, so there is no pending map to leak in a
 * long-lived gateway and nothing to lose if the process restarts mid-turn --
 * the directory is already on disk.
 */
export function createTurnCapture({ root, logger = null }) {
  let warned = false;
  const warnOnce = (err) => {
    if (warned) return;
    warned = true;
    logger?.warn?.(
      `[percepteye] could not write a captured turn; production capture is ` +
      `not recording for this run: ${err?.message ?? err}`,
    );
  };

  /** The end user's message. */
  function onMessageReceived(event, ctx = {}) {
    const runId = event?.runId ?? ctx?.runId;
    const text = event?.content;
    if (!runId || typeof text !== "string" || !text.trim()) return false;
    const conversationId = safeSegment(event?.sessionKey ?? ctx?.sessionKey ?? "");
    const dir = turnDir(root, runId);
    try {
      if (conversationId && conversationId !== "unknown") {
        recordConversationId(dir, conversationId);
      }
      return recordTurnText(dir, "task", text, {
        turn_id: safeTurnId(runId),
        conversation_id: conversationId,
      });
    } catch (err) {
      warnOnce(err);
      return false;
    }
  }

  /** The agent's answer. */
  function onAgentEnd(event, ctx = {}) {
    const runId = event?.runId ?? ctx?.runId;
    if (!runId) return false;
    const text = lastAssistantText(event?.messages);
    if (!text) return false;
    try {
      return recordTurnText(turnDir(root, runId), "answer", text, {
        turn_id: safeTurnId(runId),
        conversation_id: readConversationId(turnDir(root, runId)) || "",
      });
    } catch (err) {
      warnOnce(err);
      return false;
    }
  }

  /**
   * Where a tool call belongs. Passed to `createWriter({resolveDir})`.
   *
   * `null` for a call with no run id, which DROPS the record rather than
   * putting it in a shared directory. An unattributable call landing in some
   * other turn's trajectory is the misattribution this package refuses
   * everywhere else.
   */
  function resolveToolDir(callCtx) {
    const runId = callCtx?.runId;
    return runId ? turnDir(root, runId) : null;
  }

  return { onMessageReceived, onAgentEnd, resolveToolDir };
}

/**
 * Uploads captured turns. Periodic while traffic arrives, and once at shutdown.
 *
 * TWO TRIGGERS, because neither covers the other's case -- the same pair the
 * Python SDK needed, arrived at the same way. The cadence only runs while
 * requests are arriving, and it holds back turns that have no answer because
 * one may still be coming. Shutdown knows nothing more is coming, but never
 * fires for a gateway that keeps running.
 */
export function createTurnUploader({
  transport, agentId, root, logger = null, flushEvery = FLUSH_EVERY,
}) {
  let since = 0;
  let inFlight = false;
  let mayUpload = false;
  let refusal = null;

  function uploadedIds() {
    try {
      return new Set(
        readFileSync(join(root, UPLOADED_INDEX), "utf8")
          .split("\n").map((l) => l.trim()).filter(Boolean),
      );
    } catch {
      return new Set();
    }
  }

  function markUploaded(ids) {
    if (!ids.length) return;
    try {
      mkdirSync(root, { recursive: true });
      const all = uploadedIds();
      for (const id of ids) all.add(id);
      writeFileSync(join(root, UPLOADED_INDEX),
                    [...all].join("\n") + "\n", "utf8");
    } catch {
      // A marker we could not write means the turn is retried next flush. The
      // intake dedupes on turn_id, so a resend is answered as a duplicate --
      // which is why failing to mark is safe and failing to SEND is the thing
      // this ordering protects.
    }
  }

  /** Collect the turns worth sending right now. */
  function pending({ includeUnanswered }) {
    const already = uploadedIds();
    const out = [];
    for (const d of listTurnDirs(root)) {
      if (already.has(d.name)) continue;
      let wire;
      try {
        const cid = readConversationId(d.path);
        wire = turnWire(d.path, {
          turnIndex: cid ? turnIndexOf(root, d.name, cid) : 0,
        });
      } catch {
        // One unreadable turn costs that turn. A truncated trajectory is the
        // EXPECTED case here, not an exotic one.
        continue;
      }
      if (!wire) continue;
      if (wire.final_text === null && !includeUnanswered) continue;
      out.push(wire);
    }
    return out;
  }

  /**
   * Send. Never rejects: a control plane that cannot be reached must not break
   * an agent that is serving users, and the turns stay on disk for next time.
   */
  async function flush({ includeUnanswered = false } = {}) {
    if (!mayUpload) return { sent: 0, notPermitted: true };
    if (inFlight) return { sent: 0, skipped: true };
    inFlight = true;
    try {
      const turns = pending({ includeUnanswered });
      if (!turns.length) return { sent: 0 };
      let sent = 0;
      for (let i = 0; i < turns.length; i += BATCH_SIZE) {
        const chunk = turns.slice(i, i + BATCH_SIZE);
        try {
          await transport.reportTurns(agentId, chunk);
        } catch (err) {
          // Whole chunk unacknowledged: leave every marker unwritten so the
          // next flush retries it.
          logger?.warn?.(
            `[percepteye] could not upload ${chunk.length} captured turn(s); ` +
            `they stay on disk and are retried: ${err?.message ?? err}`);
          continue;
        }
        markUploaded(chunk.map((t) => t.turn_id));
        sent += chunk.length;
      }
      return { sent };
    } finally {
      inFlight = false;
    }
  }

  return {
    get mayUpload() { return mayUpload; },
    get refusal() { return refusal; },
    /** Record the control plane's verdict. Until this runs, nothing uploads. */
    setVerdict(v) {
      mayUpload = Boolean(v?.mayUpload);
      refusal = v?.reason ?? null;
    },
    /**
     * One turn happened. Kicks a flush when the cadence is due.
     *
     * Deliberately NOT awaited by its caller: the hook that calls this is on
     * the path of a turn the customer's user is waiting for, and an upload
     * must never be between them and their answer.
     */
    note() {
      since += 1;
      if (since < flushEvery) return null;
      since = 0;
      return flush().catch(() => ({ sent: 0 }));
    },
    flush,
  };
}

export const MESSAGE_RECEIVED = "message_received";
export const AGENT_END = "agent_end";
export const GATEWAY_STOP = "gateway_stop";

/**
 * Subscribe production turn capture. Called only in production mode.
 *
 * Returns `{turns, uploader, root}`, or `null` when nothing was wired.
 *
 * CAPTURE RUNS WITHOUT A KEY; only UPLOADING needs one. That is the ordinary
 * first install -- local recording, no account, no traffic -- which is why the
 * message hook is subscribed before any control-plane call is attempted.
 */
export function registerTurnCapture(api, {
  config, turns, pluginId, logger = null, env = process.env,
  makeTransport = defaultTransport,
}) {
  if (!turns || typeof api?.on !== "function") return null;
  const root = captureRoot(env);

  api.on(MESSAGE_RECEIVED, (event, ctx) => {
    try {
      turns.onMessageReceived(event, ctx ?? {});
    } catch { /* one lost observation, never a failed turn */ }
  });

  let uploader = null;
  let transport = null;
  if (config.apiKey) {
    try {
      transport = makeTransport(config);
      uploader = createTurnUploader({
        transport, agentId: config.agentId, root, logger,
      });
    } catch (err) {
      // `new ControlPlaneClient` refuses a missing key or base URL by design.
      // A misconfigured control plane must not take local recording down with
      // it, and `register` must not throw -- the host treats that as a failed
      // plugin load.
      logger?.warn?.(
        `[${pluginId}] captured turns will not be uploaded: ` +
        `${err?.message ?? err}. Local recording is unaffected.`);
    }
  }

  // THE ANSWER, and the one part that needs the operator's opt-in. Subscribed
  // regardless: if the host drops it, `api.on` reports nothing either way, and
  // a turn without its answer is still stored and graded advisory.
  api.on(AGENT_END, (event, ctx) => {
    try {
      turns.onAgentEnd(event, ctx ?? {});
    } catch { /* one lost observation */ }
    // NOT AWAITED. This hook sits on the path of a turn whose user is waiting;
    // an upload must never be between them and their answer.
    uploader?.note();
  });

  if (uploader) {
    api.on(GATEWAY_STOP, () => {
      // LAST CHANCE, and the only place turns with no answer are sent: nothing
      // more is coming for them after this.
      uploader.flush({ includeUnanswered: true }).catch(() => {});
    });
    announce({ transport, uploader, config, pluginId, logger, env });
  } else {
    logger?.info?.(
      `[${pluginId}] capturing production turns to ${root}. No API key is ` +
      `configured, so nothing is uploaded.`);
  }

  if (!conversationAccessGranted(api, pluginId)) {
    logger?.info?.(
      `[${pluginId}] capturing production turns WITHOUT the agent's answers: ` +
      `'${AGENT_END}' is a conversation hook and this host drops it for ` +
      `non-bundled plugins unless you set ` +
      `plugins.entries.${pluginId}.hooks.allowConversationAccess=true. Turns ` +
      `are still recorded and uploaded with their tool calls, and the control ` +
      `plane stores them with an explicit 'no answer' reason -- but nothing ` +
      `that needs a completion can use them.`);
  }

  return { turns, uploader, root };
}

/** The real control-plane transport. Replaced in tests, never in production. */
function defaultTransport(config) {
  return new AttachTransport(
    new ControlPlaneClient(config.controlPlaneUrl, config.apiKey),
    { agentId: config.agentId },
  );
}

/**
 * Ask the control plane whether this agent may upload, and say so once.
 *
 * The registration response carries the verdict precisely so a client never
 * learns its permission BY uploading -- i.e. by sending the data whose
 * permission is in question. Until it answers, `uploader.mayUpload` is false
 * and nothing leaves the machine.
 *
 * `discovered_agent` IS SENT, and its value matters. Mission Control reads an
 * ABSENT key as "the customer opted out of introspection", which flips that
 * agent's `introspection_state` to `disabled` and stops its description
 * driving workflow generation -- a real side effect for a call made only to
 * read a verdict. An explicit `null` means "introspection ran and could not
 * describe this agent", which leaves both stored columns alone. The second is
 * harmless AND true here: without the conversation opt-in the describer cannot
 * read the agent at all.
 */
export function announce({ transport, uploader, config, pluginId, logger, env }) {
  return Promise.resolve()
    .then(() => transport.register({
      agent_id: config.agentId,
      mode: "production",
      reports_tool_calls: true,
      discovered_agent: readDescribedAgent(env),
    }))
    .then((response) => {
      const v = captureVerdict(response);
      uploader.setVerdict(v);
      logger?.info?.(v.mayUpload
        ? `[${pluginId}] production capture is ENABLED for '${config.agentId}'; ` +
          `turns upload every ${FLUSH_EVERY} turns and at shutdown.`
        : `[${pluginId}] capturing locally; turns will NOT be uploaded: ${v.reason}`);
      return v;
    })
    .catch((err) => {
      logger?.info?.(
        `[${pluginId}] could not read the production-capture verdict ` +
        `(${err?.message ?? err}); nothing is uploaded and turns stay on disk.`);
      return { mayUpload: false, reason: String(err?.message ?? err) };
    });
}

/** The describer's payload, when it wrote one. `null` means it could not. */
export function readDescribedAgent(env = process.env) {
  const dir = env.PERCEPTEYE_TRAJECTORY_DIR;
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, "discovered_agent.json"), "utf8"));
  } catch {
    return null;
  }
}

// Re-exported so this lane's tests pin the behaviour where it is used.
export { conversationAccessGranted, lastAssistantText };
