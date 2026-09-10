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
 *   the user's message  `message_received`   UNGATED, void-returning. Also
 *                                            carries the UPLOAD CADENCE, for
 *                                            exactly the reason below.
 *   the tool calls      `after_tool_call`    UNGATED, void-returning. Already
 *                                            recorded; only the routing is new.
 *   the answer          `agent_end`          CONVERSATION-GATED. Dropped for a
 *                                            non-bundled plugin unless the
 *                                            operator sets
 *                                            `allowConversationAccess=true`.
 *
 * NOTHING PERIODIC MAY HANG OFF THE GATED HOOK. The cadence counter used to
 * live on `agent_end`, which meant that in the default install -- the one this
 * file spends two paragraphs describing -- it never advanced, and the only
 * other trigger is shutdown, which a gateway that keeps running never reaches.
 * A long-lived install uploaded nothing, ever, while the startup log told the
 * operator its turns were being uploaded. Python counts in `turn()`, the
 * turn-OPENING path, and this now matches it.
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
 * And such a turn IS UPLOADED. "Hold back a turn with no answer, one may still
 * be coming" is only true where answers come at all; where the host drops
 * `agent_end` there is no answer coming for any turn, and holding them back is
 * holding them back forever. See `createTurnUploader({answersExpected})`.
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
import { ControlPlaneClient, SDK_UA } from "./http.js";
import { percepteyeHome, safeSegment } from "./session.js";
import { AttachTransport } from "./transport.js";
import { CONTRACT_VERSION } from "./wire.js";
import {
  listTurnDirs, readConversationId, recordConversationId, recordTurnText,
  recordExecutionFingerprint, recordExecutionFingerprintConflict, safeTurnId,
  turnDir, turnIndexOf, turnWire,
} from "./turns.js";

/** Turns between automatic upload attempts. The Python SDK's `_FLUSH_EVERY`. */
export const FLUSH_EVERY = 32;

/** Turns per request. The intake's `TURN_BATCH_MAX`. */
export const BATCH_SIZE = 64;

/**
 * How long an unanswered turn must sit UNTOUCHED before the cadence will send
 * it.
 *
 * Only consulted when no answer is coming at all (see `answersExpected`).
 * `final_text` is otherwise the signal that a turn is FINISHED -- the answer is
 * written after the last tool call -- so without it there is nothing left to
 * say "this one is done" except quiescence. And the cadence fires from inside
 * the handler for the NEWEST turn, whose tool calls have not been made yet: a
 * flush with no settle window would upload that turn with `tool_calls: null`,
 * mark it sent, and never send the calls it went on to make. That is a worse
 * loss than the one the cadence exists to fix.
 *
 * Shutdown does NOT wait: nothing more is coming for anything by then.
 */
export const UNANSWERED_SETTLE_MS = 5 * 60_000;

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
  // `Array.isArray` beside the `typeof` check, because `typeof [] === "object"`
  // in JavaScript: without it a JSON ARRAY is accepted as a capture block,
  // finds no `turns` on it, and falls through to "production capture is not
  // enabled for this agent" -- naming a switch an operator can flip when what
  // actually happened is that the control plane sent something that is not an
  // answer. Both branches refuse, so consent was never at risk; the defect was
  // that the refusal named the wrong cause. Python has always said "the
  // control plane did not answer" for this body, and the two SDKs owe the same
  // sentence to the same input.
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) {
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

  /** Bind a reconciled identity to this exact host-declared turn. */
  function onExecutionIdentity(event, ctx = {}, observation) {
    const runId = event?.runId ?? ctx?.runId;
    if (!runId || !observation) return false;
    const dir = turnDir(root, runId);
    if (observation.conflict) return recordExecutionFingerprintConflict(dir);
    if (!observation.fingerprint) return false;
    return recordExecutionFingerprint(dir, observation.fingerprint);
  }

  return { onMessageReceived, onAgentEnd, onExecutionIdentity, resolveToolDir };
}

/**
 * Uploads captured turns. Periodic while traffic arrives, and once at shutdown.
 *
 * TWO TRIGGERS, because neither covers the other's case -- the same pair the
 * Python SDK needed, arrived at the same way. The cadence only runs while
 * requests are arriving; shutdown knows nothing more is coming, but never
 * fires for a gateway that keeps running.
 *
 * `answersExpected` IS THE HOST'S ANSWER, PASSED IN. The cadence holds back a
 * turn with no `final_text` because an answer may still be coming -- but that
 * is only true when this host actually delivers `agent_end` to this plugin.
 * When it does not (the default install; see `host.js`), NO turn ever gets an
 * answer, "may still be coming" is false for every one of them, and holding
 * them back holds them back forever: a long-lived gateway would upload
 * literally nothing while telling the operator its turns were being uploaded.
 * The question is asked once, at registration, by the one predicate that owns
 * it, and the verdict is handed here rather than re-derived.
 */
export function createTurnUploader({
  transport, agentId, root, logger = null, flushEvery = FLUSH_EVERY,
  answersExpected = true,
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

  /**
   * Collect the turns worth sending right now.
   *
   * `quietBefore` is an mtime cutoff applied ONLY to unanswered turns: a turn
   * touched more recently than that may still be accruing tool calls, and
   * sending it now would mark it uploaded before it finished being written.
   * `null` means send them regardless, which is what shutdown wants.
   */
  function pending({ includeUnanswered, quietBefore = null }) {
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
      if (wire.final_text === null) {
        if (!includeUnanswered) continue;
        if (quietBefore !== null && d.mtime > quietBefore) continue;
      }
      out.push(wire);
    }
    return out;
  }

  /**
   * Send. Never rejects: a control plane that cannot be reached must not break
   * an agent that is serving users, and the turns stay on disk for next time.
   */
  async function flush({ includeUnanswered = false, settleMs = 0 } = {}) {
    if (!mayUpload) return { sent: 0, notPermitted: true };
    if (inFlight) return { sent: 0, skipped: true };
    inFlight = true;
    try {
      const turns = pending({
        includeUnanswered,
        quietBefore: settleMs > 0 ? Date.now() - settleMs : null,
      });
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
    /** Whether this host delivers `agent_end`, i.e. whether answers arrive. */
    get answersExpected() { return answersExpected; },
    /** Record the control plane's verdict. Until this runs, nothing uploads. */
    setVerdict(v) {
      mayUpload = Boolean(v?.mayUpload);
      refusal = v?.reason ?? null;
    },
    /**
     * One turn happened. Kicks a flush when the cadence is due.
     *
     * Called from the turn's OPENING, which is the ungated half -- the mirror
     * of Python's `turn()`, which increments `_turns_since_flush` there and
     * not in `record_answer`. Counting on the answer instead would put the
     * whole cadence behind a hook the host drops by default.
     *
     * Deliberately NOT awaited by its caller: the hook that calls this is on
     * the path of a turn the customer's user is waiting for, and an upload
     * must never be between them and their answer.
     */
    note() {
      since += 1;
      if (since < flushEvery) return null;
      since = 0;
      return flush({
        includeUnanswered: !answersExpected,
        settleMs: UNANSWERED_SETTLE_MS,
      }).catch(() => ({ sent: 0 }));
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
 * Returns `{turns, uploader, root, transport, started}`, or `null` when
 * nothing was wired. `transport` is null without an API key; `started` is the
 * registration chain, or null when there was nothing to register.
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

  // ASKED ONCE, HERE, and handed to everything that needs it. Whether this
  // host will deliver `agent_end` decides two things at once -- whether the
  // operator is told answers are missing, and whether the cadence may ever
  // send a turn that has none -- and those must not be able to disagree.
  const answersExpected = conversationAccessGranted(api, pluginId);

  let uploader = null;
  let transport = null;
  // The startup chain, EXPOSED rather than fire-and-forget. `policy.js` reads
  // the control plane too, and its read is sequenced behind this one for the
  // same reason `announce` is sequenced behind `enrol`: three calls racing at
  // plugin load is three chances to be rate-limited on a cold start, and the
  // policy answer is not needed until the first turn arrives.
  let started = null;

  // THE TURN OPENS, and this is the UNGATED half -- the only hook of the three
  // the host is guaranteed to deliver. It carries the cadence for that reason:
  // `agent_end` used to, and `agent_end` is dropped for a non-bundled plugin
  // unless the operator opts in, so in the default install the counter never
  // advanced and a gateway that never stops uploaded nothing, ever. Python
  // counts in `turn()` for the same reason. Subscribed before any
  // control-plane call is attempted, because capture runs without a key.
  api.on(MESSAGE_RECEIVED, (event, ctx) => {
    try {
      turns.onMessageReceived(event, ctx ?? {});
    } catch { /* one lost observation, never a failed turn */ }
    // NOT AWAITED. This hook sits on the path of a turn whose user is waiting;
    // an upload must never be between them and their answer.
    uploader?.note();
  });

  if (config.apiKey) {
    try {
      transport = makeTransport(config);
      uploader = createTurnUploader({
        transport, agentId: config.agentId, root, logger, answersExpected,
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
  //
  // It does NOT drive the cadence. It cannot: it is the hook that may not
  // arrive. And it must not count a second time when it does, or a granted
  // install would flush at twice the rate this package documents and the
  // Python SDK uses.
  api.on(AGENT_END, (event, ctx) => {
    try {
      turns.onAgentEnd(event, ctx ?? {});
    } catch { /* one lost observation */ }
  });

  if (uploader) {
    api.on(GATEWAY_STOP, () => {
      // LAST CHANCE: nothing more is coming for anything after this, so every
      // unanswered turn goes regardless of how recently it was written.
      uploader.flush({ includeUnanswered: true }).catch(() => {});
    });
    // REGISTER, THEN ASK -- in that order, and the order is the point. The
    // verdict is computed FROM the agent row, so asking first, on a first
    // start, spends the read on a question whose only possible answer is "not
    // registered". Chained rather than run alongside for the same reason:
    // concurrent calls race, and half the starts would still get that answer.
    // Neither rejects, so a refused registration still reaches the read --
    // which matters, because an operator may have consented long ago and the
    // registration may be refused for something else entirely.
    //
    // NOT AWAITED: `register()` must return to the host synchronously, and a
    // control plane that is slow or down must not delay a plugin load.
    started = enrol({ transport, config, pluginId, logger })
      .then(() => announce({ transport, uploader, config, pluginId, logger, env }));
  } else {
    logger?.info?.(
      `[${pluginId}] capturing production turns to ${root}. No API key is ` +
      `configured, so nothing is uploaded.`);
  }

  if (!answersExpected) {
    logger?.info?.(
      `[${pluginId}] capturing production turns WITHOUT the agent's answers: ` +
      `'${AGENT_END}' is a conversation hook and this host drops it for ` +
      `non-bundled plugins unless you set ` +
      `plugins.entries.${pluginId}.hooks.allowConversationAccess=true. Turns ` +
      `are still recorded and uploaded with their tool calls -- the cadence ` +
      `sends them once they stop changing, since no answer is coming -- and ` +
      `the control plane stores them with an explicit 'no answer' reason, but ` +
      `nothing that needs a completion can use them.`);
  }

  // `transport` is handed out so the serving-policy read reuses THIS client
  // rather than constructing a second one against the same base URL and key.
  return { turns, uploader, root, transport, started };
}

/** The real control-plane transport. Replaced in tests, never in production. */
function defaultTransport(config) {
  return new AttachTransport(
    new ControlPlaneClient(config.controlPlaneUrl, config.apiKey),
    { agentId: config.agentId },
  );
}

/**
 * Create this agent's row, so an operator has something to switch capture ON.
 *
 * THE OTHER HALF OF THE PERMISSION STORY, and it went missing. `POST /agents`
 * is the ONLY producer of a `FlywheelAgent` row anywhere in the control plane.
 * With no row the operator's consent control
 * (`POST /flywheel-agents/{agent_id}/production-capture`) answers 404, and the
 * verdict `announce()` reads below is permanently "this agent is not
 * registered, so no operator has been able to enable production capture for
 * it. Register it first." -- a remedy naming the exact call this package had
 * stopped making. Uploading was structurally unreachable for every install.
 *
 * Replacing the permission PROBE with `GET /agents/{id}/capture` was right,
 * and it stands: asking a permission question must not write. What went with
 * it by accident was the REGISTRATION -- two different jobs that happened to
 * share one route, and only one of them survived the split. This is the other
 * one, back as its own call, which is why `announce()` still performs no write.
 *
 * `discovered_agent: null` -- INTROSPECTION_UNREADABLE. It is the TRUE state of
 * the three rather than the convenient one, and the other two are wrong for
 * different reasons:
 *
 *   OMITTING the key records `disabled`, which means "the customer opted out
 *   of introspection". Nothing here offers them that choice -- this package
 *   has no `introspect` setting and reads no PERCEPTEYE_INTROSPECT -- so it
 *   would assert a decision nobody made. It is also the DESTRUCTIVE state:
 *   `FlywheelAgentRepository.upsert` writes `disabled` onto the row
 *   unconditionally, which stops that agent's description driving workflow
 *   generation. That is precisely the side effect `announce()` describes and
 *   the reason the old registration had to go, so re-creating it here would
 *   undo one fix while claiming another.
 *
 *   A DESCRIPTION cannot honestly be sent. `describe.js` is the only source of
 *   one and it writes into PERCEPTEYE_TRAJECTORY_DIR, which production mode
 *   does not set -- so the describer is inert here -- and even where it is
 *   active `llm_input` first fires on the first model call, strictly after
 *   this. Waiting for one would put registration behind a CONVERSATION hook
 *   the host drops for a non-bundled plugin by default, i.e. this same defect
 *   again for the majority of installs.
 *
 *   NULL is what is left and what is true: we looked, and we have no
 *   description. It is also the one state `upsert` treats as a fact about the
 *   control plane's framework coverage rather than a retraction by the
 *   customer -- a row that already holds a tool catalogue keeps BOTH the
 *   catalogue and its state -- so a production process re-registering on every
 *   restart cannot erase what a training run established.
 *
 * NEVER REJECTS, and never throws into its caller. A refused or unreachable
 * control plane must not cost the verdict read, local capture (which needs no
 * account at all), or the plugin load -- the host treats a throw from
 * `register()` as a failed plugin load. The Python SDK's `attach()` splits the
 * same two calls for the same reason: a registration intake dislikes must not
 * also cost that process its policy read.
 *
 * NOT EXPORTED, unlike `announce` beside it. Its tests drive it through
 * `registerTurnCapture`, which is the path a customer actually gets, and this
 * package has already paid for one exported control-plane call that nothing
 * called: `AttachTransport.register` itself, which is the defect above.
 */
function enrol({ transport, config, pluginId, logger = null }) {
  return Promise.resolve()
    .then(() => transport.register({
      agent_id: config.agentId,
      // The WIRE value, which is not this package's mode vocabulary. The
      // server accepts ("rollout", "production") only, so `config.mode` --
      // whose training spelling is "training" -- would 422. A literal is safe
      // because this function is reached from the production lane alone;
      // `index.js` never constructs turn capture in training mode.
      mode: "production",
      sdk: SDK_UA,
      contract_version: CONTRACT_VERSION,
      // TRUE, and getting it wrong costs a grade reason
      // (`flywheel_does_not_report_tool_outcomes`): `after_tool_call` is
      // subscribed unconditionally and every captured call goes up in the
      // turn's `tool_calls`.
      reports_tool_calls: true,
      // This runs INSIDE the customer's own OpenClaw process; nothing is
      // spawned. The same value Python's `attach()` sends, for the same
      // reason.
      isolation: "inprocess",
      // Production mode claims no rollouts, so this reports no capacity. One
      // is what `attach()` sends.
      concurrency: 1,
      input_shape: "text",
      entrypoint: "openclaw-plugin",
      // See the docstring. `null`, never omitted and never invented.
      discovered_agent: null,
    }))
    .then(() => true)
    .catch((err) => {
      logger?.info?.(
        `[${pluginId}] could not register '${config.agentId}' with the ` +
        `control plane (${err?.message ?? err}); turns are still captured ` +
        `locally. Until a registration lands, no operator can enable upload ` +
        `for this agent, because the control has no agent to act on.`);
      return false;
    });
}

/**
 * Ask the control plane whether this agent may upload, and say so once.
 *
 * A READ. The verdict carries BOTH halves -- the per-agent consent an operator
 * grants in Mission Control, and whether this key carries the `turn.report`
 * scope -- so a client never learns its permission BY uploading, i.e. by
 * sending the data whose permission is in question. Until it answers,
 * `uploader.mayUpload` is false and nothing leaves the machine.
 *
 * IT USED TO BE A REGISTRATION, and that was a workaround this route removed.
 * `POST /agents` is an upsert, and a registration omitting `discovered_agent`
 * is recorded as introspection `disabled` -- which stops that agent's
 * description driving workflow generation. So asking a permission question
 * changed an unrelated column.
 *
 * THE WORKAROUND IS GONE; THE REGISTRATION IS NOT. Nothing on this path
 * writes -- re-asking costs a read and nothing else, which is the whole point
 * of the route -- but the row the verdict is computed from still has to be
 * created by somebody, and `enrol()` above is now the one that does it. When
 * that was left out, this read answered "not registered" forever. The explicit
 * `discovered_agent: null` it sends is no longer a workaround for a side
 * effect: it is the honest state, for the reasons `enrol()` gives.
 */
export function announce({ transport, uploader, config, pluginId, logger }) {
  return Promise.resolve()
    .then(() => transport.captureCurrent(config.agentId))
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

export { conversationAccessGranted, lastAssistantText };
