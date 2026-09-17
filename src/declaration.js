/**
 * `describe`: an agent describing itself when nothing can read it.
 *
 * The Node end of the Python SDK's `agent_flywheel/declaration.py`, rule for
 * rule, so a declaration registers the same description from either SDK. The
 * Python repository's `tests/test_describe_parity.py` runs this module beside
 * that one over one table and holds them equal: the same wire record, and the
 * same refusals.
 *
 * WHY THE NODE PLUGIN NEEDS IT. OpenClaw's `llm_input` carries no tools, so
 * this plugin's own observation of an agent never has a catalogue (see
 * `describe.js`), and a catalogue is what task generation needs. The operator
 * knows what the agent sends its model; this is where they say it:
 *
 *   plugins.entries.agent-flywheel.config.describe = {
 *     system_prompt: "...",
 *     tools: [ ...the tool list the agent sends its model ],
 *   }
 *
 * THE CUSTOMER'S WORD WINS, AND ONLY WHERE THEY GAVE IT. Declared fields
 * replace what was observed; anything left out still comes from observation.
 * Leaving `tools` out never means "no tools" -- that is `tools: []`.
 *
 * PYTHON'S PARSER, NOT `normalizeTool`. The host observation's parser reads
 * OpenClaw shapes and scrubs what it copies. A declaration is read exactly as
 * the Python SDK reads it -- OpenAI function specs, Anthropic tools, or the
 * protocol's own `{name, description, input_schema, read_only}` -- because
 * the one thing that matters about a declared tool is that both SDKs register
 * the same record for it. That holds for anything JSON carries, with one
 * limit JavaScript imposes: an integer beyond 2**53 inside a schema is held
 * rounded here. Where the two languages would otherwise part -- whitespace,
 * coercion, number types, sort order -- the rule is Python's, or is one both
 * can keep: names and descriptions must be strings, and `max_tokens` a whole
 * number both hold exactly.
 *
 * NOT EVIDENCE. A declaration is what the customer says the agent does, not an
 * observation of what ran, so a declared description anchors no execution
 * identity: `index.js` withholds the fingerprint whenever this module
 * contributed.
 */
import { ConfigurationError } from "./errors.js";
import { compareStrings } from "./execution-identity.js";

/** `source_type` of a description a declaration contributed to. */
export const SOURCE_TYPE = "sdk_declared";

/**
 * The registration projection's prompt bound: the Python SDK's
 * `_MAX_PROMPT_CHARS`, counted in code points as Python counts them.
 */
export const MAX_PROMPT_CHARS = 20_000;

const KEYS = ["model", "system_prompt", "tools"];
const MODEL_KEYS = ["max_tokens", "model_name", "provider", "temperature"];

/**
 * Python's `str.strip()`: exactly the characters `str.isspace()` names. JS's
 * `trim()` also strips U+FEFF and keeps U+001C-U+001F and U+0085, so a tool
 * named "\u0085" was a tool here and nothing in Python.
 */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a" +
  "\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
const strip = (text) => text.replace(PY_STRIP, "");

/**
 * Python's truthiness, where the Python end branches on it: an empty array or
 * object is FALSE there and true here, and a declaration must not turn into a
 * different tool on the Node side because of it.
 */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (isMapping(v)) return Object.keys(v).length > 0;
  return Boolean(v);
}

/**
 * A JSON object: Python's `Mapping`. A PLAIN object only -- a Promise (an
 * async `describe`), a Map or a class instance is not a declaration, and
 * reading one as an empty object declared nothing in silence.
 */
function isMapping(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** The JSON type a refusal names: one vocabulary both SDKs print alike. */
function jsonType(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  if (isMapping(v)) return "object";
  if (typeof v !== "object") return typeof v;
  try {
    return v.constructor?.name ?? "object";
  } catch {
    return "object";
  }
}

/** Python's `json.dumps(str)`: `JSON.stringify` with non-ASCII escaped. */
function jsonAscii(text) {
  return JSON.stringify(text).replace(/[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Key names as a JSON array, sorted by code point, as Python renders them. */
function keyList(keys) {
  return `[${[...keys].sort(compareStrings).map(jsonAscii).join(", ")}]`;
}

/** A value quoted back in a refusal. Never throws: a BigInt or a cycle is still a refusal. */
function render(v) {
  let text;
  try {
    text = JSON.stringify(v);
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    try {
      text = String(v);
    } catch {
      text = Object.prototype.toString.call(v);
    }
  }
  return text.slice(0, 120);
}

/**
 * `describe` validated and parsed, calling it if it is a function.
 *
 * `null` when nothing was declared -- including an object whose every value
 * is null. A function that throws is refused the same way, naming `describe`.
 *
 * @returns {{system_prompt: string|null, tools: object[]|null, model: object|null}|null}
 * @throws {ConfigurationError}
 */
export function resolveDeclaration(describe) {
  if (describe === null || describe === undefined) return null;
  let spec;
  if (typeof describe === "function") {
    try {
      spec = describe();
    } catch (err) {
      if (err instanceof ConfigurationError) throw err;
      // Whatever was thrown -- a Symbol, a null-prototype object -- becomes a
      // refusal; reading its name or message must not throw a second time.
      let name;
      let detail;
      try {
        name = err?.constructor?.name ?? typeof err;
        detail = typeof err?.message === "string" ? err.message : render(err);
      } catch {
        name = typeof err;
        detail = render(err);
      }
      throw new ConfigurationError(`describe= raised ${name}: ${detail}`);
    }
  } else {
    spec = describe;
  }
  if (!isMapping(spec)) {
    throw new ConfigurationError(
      "describe= must be a mapping (or a callable returning one), got " +
      jsonType(spec));
  }
  const unknown = Object.keys(spec).filter((k) => !KEYS.includes(k));
  if (unknown.length) {
    throw new ConfigurationError(
      `describe= got unknown key(s) ${keyList(unknown)}; it accepts ` +
      keyList(KEYS));
  }
  const prompt = spec.system_prompt ?? null;
  const tools = spec.tools ?? null;
  const model = spec.model ?? null;
  if (prompt !== null && typeof prompt !== "string") {
    throw new ConfigurationError("describe['system_prompt'] must be a string");
  }
  if (tools !== null && !Array.isArray(tools)) {
    throw new ConfigurationError(
      "describe['tools'] must be a list -- the tools you send the model");
  }
  if (model !== null && typeof model !== "string" && !isMapping(model)) {
    throw new ConfigurationError(
      "describe['model'] must be a model name or a mapping of " +
      "provider / model_name / temperature / max_tokens");
  }
  if (prompt === null && tools === null && model === null) return null;
  return {
    system_prompt: prompt === null ? null : codePoints(prompt, MAX_PROMPT_CHARS),
    tools: tools === null ? null : declaredTools(tools),
    model: model === null ? null : declaredModel(model),
  };
}

/** `text` cut to `max` code points, as a Python slice cuts it. */
function codePoints(text, max) {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

/**
 * Python's `_tools_from_request` for one entry: the OpenAI envelope, or a flat
 * tool with a name. The legacy flat `functions` shape spells the schema
 * `parameters`, so that is read when `input_schema` is absent.
 */
function fromRequest(entry) {
  if (!isMapping(entry)) return null;
  const fn = entry.function;
  if (isMapping(fn)) {
    return {
      name: fn.name, description: fn.description,
      input_schema: fn.parameters, original_format: "openai_function",
    };
  }
  if (truthy(entry.name)) {
    return {
      name: entry.name, description: entry.description,
      input_schema: Object.hasOwn(entry, "input_schema")
        ? entry.input_schema : entry.parameters,
      original_format: "anthropic_tool",
    };
  }
  return null;
}

/** Python's `_tool_from_wire`: null when there is no usable name. */
function fromWire(raw) {
  const name = strip(truthy(raw.name) ? raw.name : "");
  if (!name) return null;
  return {
    name,
    description: truthy(raw.description) ? raw.description : "",
    input_schema: isMapping(raw.input_schema) ? raw.input_schema : {},
    original_format: raw.original_format,
  };
}

/**
 * The declared tools, in the wire's tool shape. A tool the parser cannot read
 * is the customer's mistake and is said at startup rather than dropped: a
 * silently shorter catalogue is a smaller task universe nobody chose. So is a
 * schema that is not a mapping, a `read_only` that is not a boolean or sits
 * inside `function` where the parser would not see it, and a name or
 * description that is not a string -- coerced, it became text no two
 * languages agree on.
 */
function declaredTools(declared) {
  return declared.map((entry, i) => {
    const where = `describe['tools'][${i}]`;
    if (isMapping(entry)) {
      const body = isMapping(entry.function) ? entry.function : entry;
      for (const field of ["name", "description"]) {
        const value = body[field] ?? null;
        if (value !== null && typeof value !== "string") {
          throw new ConfigurationError(
            `${where}: '${field}' must be a string, got ${jsonType(value)}`);
        }
      }
    }
    const parsed = fromRequest(entry);
    const tool = parsed === null ? null : fromWire(parsed);
    if (tool === null) {
      throw new ConfigurationError(
        `${where} is not a tool: expected an OpenAI function spec, an ` +
        `Anthropic tool, or a mapping with a 'name', got ${render(entry)}`);
    }
    const schema = parsed.input_schema;
    if (schema !== null && schema !== undefined && !isMapping(schema)) {
      throw new ConfigurationError(
        `${where}: the schema must be a JSON-schema mapping, got ` +
        jsonType(schema));
    }
    if (isMapping(entry.function) && Object.hasOwn(entry.function, "read_only")) {
      throw new ConfigurationError(
        `${where}: read_only goes beside 'function', not inside it`);
    }
    const readOnly = entry.read_only ?? null;
    if (readOnly !== null && typeof readOnly !== "boolean") {
      throw new ConfigurationError(
        `${where}['read_only'] must be true or false, got ${render(readOnly)}`);
    }
    // OMITTED when undeclared, never null: the Python wire's absence rule.
    return readOnly === null ? tool : { ...tool, read_only: readOnly };
  });
}

/** The declared model, in the wire's model-config shape. */
function declaredModel(declared) {
  if (typeof declared === "string") {
    if (!strip(declared)) {
      throw new ConfigurationError("describe['model'] must not be empty");
    }
    return { provider: "unknown", model_name: declared };
  }
  const unknown = Object.keys(declared).filter((k) => !MODEL_KEYS.includes(k));
  if (unknown.length) {
    throw new ConfigurationError(
      `describe['model'] got unknown key(s) ${keyList(unknown)}; it accepts ` +
      keyList(MODEL_KEYS));
  }
  const name = declared.model_name ?? null;
  const provider = declared.provider ?? null;
  if (typeof name !== "string" || !strip(name)) {
    throw new ConfigurationError("describe['model'] needs a 'model_name' string");
  }
  if (provider !== null && typeof provider !== "string") {
    throw new ConfigurationError("describe['model']['provider'] must be a string");
  }
  const out = { provider: provider || "unknown", model_name: name };
  const temperature = declaredTemperature(declared.temperature ?? null);
  const maxTokens = declaredMaxTokens(declared.max_tokens ?? null);
  if (temperature !== null) out.temperature = temperature;
  if (maxTokens !== null) out.max_tokens = maxTokens;
  return out;
}

/** A finite number, or null: `1e400` reads as Infinity, which is not JSON. */
function declaredTemperature(value) {
  if (value === null) return null;
  if (typeof value !== "number") {
    throw new ConfigurationError("describe['model']['temperature'] must be a number");
  }
  if (!Number.isFinite(value)) {
    throw new ConfigurationError(
      "describe['model']['temperature'] must be a finite number");
  }
  return value;
}

/** A whole number from 1 to 2**53 - 1, or null: past that, JSON reads round. */
function declaredMaxTokens(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConfigurationError(
      "describe['model']['max_tokens'] must be a whole number from 1 to " +
      Number.MAX_SAFE_INTEGER);
  }
  return value;
}

/**
 * `reflected` (a wire description) with the declared fields in place, the
 * declaration alone when nothing was observed, or `reflected` unchanged when
 * nothing was declared.
 *
 * `framework` names what the caller knows when nothing was observed. The
 * Python SDK knows nothing about a custom agent and says `custom`; this plugin
 * knows its host, and passes it.
 *
 * A part the declaration supplies stops being listed in `incomplete`: it is no
 * longer unknown.
 */
export function applyDeclaration(
  declared, { reflected = null, agentName, framework = "custom" },
) {
  if (declared === null || declared === undefined) return reflected;
  const base = reflected ?? {
    agent_name: agentName,
    framework,
    source_type: "sdk_runtime",
    role: "standalone",
    tool_definitions: null,
  };
  const out = { ...base, source_type: SOURCE_TYPE };
  const supplied = new Set();
  if (declared.system_prompt !== null) {
    out.system_prompt = declared.system_prompt;
    supplied.add("system_prompt");
  }
  if (declared.tools !== null) {
    out.tool_definitions = declared.tools.map((t) => ({ ...t }));
    supplied.add("tool_definitions").add("tool");
  }
  if (declared.model !== null) {
    out.discovered_model_config = { ...declared.model };
    supplied.add("discovered_model_config");
  }
  const incomplete = (Array.isArray(base.incomplete) ? base.incomplete : [])
    .filter((part) => !supplied.has(part));
  if (incomplete.length) out.incomplete = incomplete;
  else delete out.incomplete;
  return out;
}
