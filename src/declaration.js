/**
 * `describe`: an agent describing itself when nothing can read it.
 *
 * The Node end of the Python SDK's `agent_flywheel/declaration.py`, rule for
 * rule, so a declaration registers the same description from either SDK. The
 * Python repository's `tests/test_describe_parity.py` runs this module beside
 * that one over one table of inputs and holds them equal: the same wire
 * record, and the same refusals.
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
 * the same bytes for it. `read_only` goes at the top level of an entry,
 * whichever shape, and only a declaration carries it.
 *
 * NOT EVIDENCE. A declaration is what the customer says the agent does, not an
 * observation of what ran, so a declared description anchors no execution
 * identity: `index.js` withholds the fingerprint whenever this module
 * contributed.
 */
import { ConfigurationError } from "./errors.js";

/** `source_type` of a description a declaration contributed to. */
export const SOURCE_TYPE = "sdk_declared";

/**
 * The registration projection's prompt bound: the Python SDK's
 * `_MAX_PROMPT_CHARS`, counted in code points as Python counts them.
 */
export const MAX_PROMPT_CHARS = 20_000;

// Sorted, because the refusals print them the way Python's `sorted()` does.
const KEYS = ["model", "system_prompt", "tools"];
const MODEL_KEYS = ["max_tokens", "model_name", "provider", "temperature"];

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

/** Python's `str()` for the scalars a declaration can carry. */
function str(v) {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/** A JSON object: Python's `Mapping`. Not an array, not null. */
function isMapping(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The Python type name a refusal prints, for the values a config can hold. */
function typeName(v) {
  if (v === null || v === undefined) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "function") return "function";
  return "dict";
}

/** Python's list-of-strings repr: `['a', 'b']`. */
function strList(keys) {
  return `[${keys.map((k) => `'${k}'`).join(", ")}]`;
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
      const name = err?.constructor?.name ?? typeof err;
      throw new ConfigurationError(
        `describe= raised ${name}: ${err?.message ?? err}`);
    }
  } else {
    spec = describe;
  }
  if (!isMapping(spec)) {
    throw new ConfigurationError(
      "describe= must be a mapping (or a callable returning one), got " +
      typeName(spec));
  }
  const unknown = Object.keys(spec).filter((k) => !KEYS.includes(k)).sort();
  if (unknown.length) {
    throw new ConfigurationError(
      `describe= got unknown key(s) ${strList(unknown)}; it accepts ` +
      strList(KEYS));
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
      input_schema: "input_schema" in entry ? entry.input_schema : entry.parameters,
      original_format: "anthropic_tool",
    };
  }
  return null;
}

/** Python's `_tool_from_wire`: null when there is no usable name. */
function fromWire(raw) {
  const name = str(truthy(raw.name) ? raw.name : "").trim();
  if (!name) return null;
  return {
    name,
    description: str(truthy(raw.description) ? raw.description : ""),
    input_schema: isMapping(raw.input_schema) ? raw.input_schema : {},
    original_format: str(truthy(raw.original_format) ? raw.original_format : "unknown"),
  };
}

/**
 * The declared tools, in the wire's tool shape. A tool the parser cannot read
 * is the customer's mistake and is said at startup rather than dropped: a
 * silently shorter catalogue is a smaller task universe nobody chose. So is a
 * schema that is not a mapping, or a `read_only` that is not a boolean, or
 * one inside `function` where the parser would not see it.
 */
function declaredTools(declared) {
  return declared.map((entry, i) => {
    const where = `describe['tools'][${i}]`;
    const parsed = fromRequest(entry);
    const tool = parsed === null ? null : fromWire(parsed);
    if (tool === null) {
      throw new ConfigurationError(
        `${where} is not a tool: expected an OpenAI function spec, an ` +
        `Anthropic tool, or a mapping with a 'name', got ` +
        String(JSON.stringify(entry)).slice(0, 120));
    }
    const schema = parsed.input_schema;
    if (schema !== null && schema !== undefined && !isMapping(schema)) {
      throw new ConfigurationError(
        `${where}: the schema must be a JSON-schema mapping, got ` +
        typeName(schema));
    }
    if (isMapping(entry.function) && "read_only" in entry.function) {
      throw new ConfigurationError(
        `${where}: read_only goes beside 'function', not inside it`);
    }
    const readOnly = entry.read_only ?? null;
    if (readOnly !== null && typeof readOnly !== "boolean") {
      throw new ConfigurationError(
        `${where}['read_only'] must be true or false, got ` +
        JSON.stringify(readOnly));
    }
    // OMITTED when undeclared, never null: the Python wire's absence rule.
    return readOnly === null ? tool : { ...tool, read_only: readOnly };
  });
}

/** The declared model, in the wire's model-config shape. */
function declaredModel(declared) {
  if (typeof declared === "string") {
    if (!declared.trim()) {
      throw new ConfigurationError("describe['model'] must not be empty");
    }
    return { provider: "unknown", model_name: declared };
  }
  const unknown = Object.keys(declared).filter((k) => !MODEL_KEYS.includes(k)).sort();
  if (unknown.length) {
    throw new ConfigurationError(
      `describe['model'] got unknown key(s) ${strList(unknown)}; it accepts ` +
      strList(MODEL_KEYS));
  }
  const name = declared.model_name ?? null;
  const provider = declared.provider ?? null;
  const temperature = declared.temperature ?? null;
  const maxTokens = declared.max_tokens ?? null;
  if (typeof name !== "string" || !name.trim()) {
    throw new ConfigurationError("describe['model'] needs a 'model_name' string");
  }
  if (provider !== null && typeof provider !== "string") {
    throw new ConfigurationError("describe['model']['provider'] must be a string");
  }
  if (temperature !== null && typeof temperature !== "number") {
    throw new ConfigurationError("describe['model']['temperature'] must be a number");
  }
  if (maxTokens !== null && !Number.isInteger(maxTokens)) {
    throw new ConfigurationError("describe['model']['max_tokens'] must be an integer");
  }
  const out = { provider: provider || "unknown", model_name: name };
  if (temperature !== null) out.temperature = temperature;
  if (maxTokens !== null) out.max_tokens = maxTokens;
  return out;
}

/**
 * `reflected` (a wire description) with the declared fields in place, the
 * declaration alone when nothing was observed, or `reflected` unchanged when
 * nothing was declared.
 *
 * A part the declaration supplies stops being listed in `incomplete`: it is no
 * longer unknown.
 */
export function applyDeclaration(declared, { reflected = null, agentName }) {
  if (declared === null || declared === undefined) return reflected;
  const base = reflected ?? {
    agent_name: agentName,
    framework: "custom",
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
