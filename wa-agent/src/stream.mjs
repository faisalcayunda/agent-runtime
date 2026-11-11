// The only module that knows the shape of `claude -p --output-format stream-json --verbose` lines (PLAN 2.2).
// When phase 1 records real output, a wrong assumption is fixed here and in test/fixtures, nowhere else.
//
// Assumed fields (documented in hooks.md "defer" and headless.md unless marked UNVERIFIED):
//   system/init          {type:"system", subtype:"init", session_id, model}
//   assistant            {type:"assistant", uuid, message:{id, content:[{type:"text",text} | {type:"tool_use",id,name,input}]}}
//                        UNVERIFIED: `uuid` per line; `message.id` is the fallback block key
//   user                 {type:"user", message:{content:[{type:"tool_result", tool_use_id, is_error}]}}
//   result               {type:"result", subtype, is_error, session_id, stop_reason, duration_ms, result, usage,
//                         modelUsage, permission_denials, deferred_tool_use:{id,name,input}}
// Everything else (stream_event, rate_limit_event, system/hook_*, ...) is ignored: real streams carry many types.

// Splits a byte stream into lines. Keeps a partial last line until its newline arrives.
export class LineSplitter {
  #buf = "";
  push(chunk) {
    this.#buf += chunk;
    const lines = this.#buf.split("\n");
    this.#buf = lines.pop();
    return lines.filter((l) => l.trim());
  }
  flush() {
    const rest = this.#buf.trim();
    this.#buf = "";
    return rest ? [rest] : [];
  }
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// One stream-json line -> zero or more normalized events. Never throws: a bad line is `{type:"garbage"}`.
export function parseLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return [{ type: "garbage", line: line.slice(0, 200) }]; }
  if (!isObj(o)) return [];
  if (o.type === "system" && o.subtype === "init") return [{ type: "init", sessionId: o.session_id ?? null, model: o.model ?? null }];
  if (o.type === "assistant" && isObj(o.message) && Array.isArray(o.message.content)) {
    const base = o.uuid ?? o.message.id ?? "";
    const out = [];
    o.message.content.forEach((b, i) => {
      if (!isObj(b)) return;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ type: "text", text: b.text, key: `${base}:${i}` });
      else if (b.type === "tool_use") out.push({ type: "tool_use", id: String(b.id ?? ""), name: String(b.name ?? ""), input: isObj(b.input) ? b.input : {} });
    });
    return out;
  }
  if (o.type === "user" && isObj(o.message) && Array.isArray(o.message.content)) {
    return o.message.content.filter((b) => isObj(b) && b.type === "tool_result").map((b) => ({ type: "tool_result", toolUseId: String(b.tool_use_id ?? ""), isError: !!b.is_error }));
  }
  if (o.type === "result") {
    const d = o.deferred_tool_use;
    return [{
      type: "result",
      subtype: o.subtype ?? null,
      sessionId: o.session_id ?? null,
      stopReason: o.stop_reason ?? null,
      isError: !!o.is_error,
      durationMs: typeof o.duration_ms === "number" ? o.duration_ms : null,
      text: typeof o.result === "string" ? o.result : "",
      usage: isObj(o.usage) ? o.usage : {},
      modelUsage: isObj(o.modelUsage) ? o.modelUsage : {},
      denials: Array.isArray(o.permission_denials) ? o.permission_denials : [],
      deferred: isObj(d) && d.id ? { id: String(d.id), name: String(d.name ?? ""), input: isObj(d.input) ? d.input : {} } : null,
    }];
  }
  return [];
}

// AskUserQuestion input -> [{question, header, options:[label], multiSelect}], dropping malformed entries.
export function questionsOf(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs
    .filter((q) => isObj(q) && typeof q.question === "string")
    .map((q) => ({
      question: q.question,
      header: typeof q.header === "string" ? q.header : "",
      options: (Array.isArray(q.options) ? q.options : []).map((o) => (isObj(o) ? String(o.label ?? "") : String(o))).filter(Boolean),
      multiSelect: !!q.multiSelect,
    }));
}
