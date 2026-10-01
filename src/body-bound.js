/**
 * How a captured tool body is shortened. ONE definition for this SDK.
 *
 * Every producer of a tool call's `error` that this SDK observes shortens it
 * here: the OpenClaw classifier (`classify.js`) and the DeepSeek Harness one
 * (`dsh-classify.js`). The Python SDK's `agent_flywheel/_body_bound.py` is the
 * same rule in the other language, and its `tests/test_body_bound_parity.py`
 * drives this module and both classifiers to prove the two SDKs return the
 * same string for the same input. Each classifier used to keep an error's
 * first 1000 characters while the Python parser kept both ends, so one wire
 * field had a shape per SDK -- and a head cut deletes exactly the part of a
 * traceback worth keeping.
 */

/**
 * One budget for an output body and an error body alike. A raw traceback is
 * the load-bearing signal for learned self-correction, and its informative
 * part is reliably at the END: the exception class and its message, after
 * however many frames.
 */
export const MAX_BODY_CHARS = 4000;

/**
 * Stamped into a body that had to be shortened: a fixed, greppable string with
 * the removed count in it, so a downstream census can tell "the tool printed
 * 300 chars" from "the tool printed 300,000 and we kept a window" without a
 * wire field every producer would have to learn to set.
 */
export function elision(dropped) {
  return `\n…[${dropped} chars elided by the SDK capture bound]…\n`;
}

/**
 * Shorten `text` to `limit` characters while keeping BOTH ends: half the room
 * from the front, the rest from the back, and a marker between them stating
 * how many characters of `text` it replaced. Characters are CODE POINTS, as
 * Python's `len` counts them -- a UTF-16 length would disagree with the Python
 * SDK on any astral character, and slicing by it could split a surrogate pair.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function bounded(text, limit = MAX_BODY_CHARS) {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  // The marker is part of the budget: a bound that its own annotation can
  // push past is not a bound. So what goes is `chars.length - room`, and room
  // depends on the marker's length, which depends on the count's digits. The
  // count only grows, so this settles in a step or two.
  let dropped = chars.length - limit;
  let room;
  for (;;) {
    room = limit - Array.from(elision(dropped)).length;
    // Too small to hold the marker: keep the tail, the half worth keeping.
    if (room <= 0) return chars.slice(chars.length - limit).join("");
    if (chars.length - room === dropped) break;
    dropped = chars.length - room;
  }
  const head = Math.floor(room / 2);
  return chars.slice(0, head).join("") + elision(dropped)
    + chars.slice(chars.length - (room - head)).join("");
}
