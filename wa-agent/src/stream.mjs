// The only module that knows the shape of `claude -p --output-format stream-json --verbose` lines (PLAN 2.2).
// Shapes below are from real recordings (spike results, PLAN section 8, claude 2.1.322); test/fixtures/SOURCES.json says which
// fixtures are recordings.
//   system/init          {type:"system", subtype:"init", session_id, model, mcp_servers:[{name,status,source}]}
//   assistant            ONE LINE PER CONTENT BLOCK (text, thinking, tool_use): {type:"assistant", uuid, message:{id, content:[block]}};
//                        lines of one API message share message.id and have distinct uuids, so the uuid keys a block
//   user                 {type:"user", message:{content:[{type:"tool_result", tool_use_id, is_error, content}]}}
//   result               {type:"result", subtype, is_error, session_id, stop_reason, result_index, queued_turn_count, duration_ms,
//                         result, usage, modelUsage, model_usage_since_last_result, permission_denials, total_cost_usd,
//                         deferred_tool_use:{id,name,input}}
//                        - ONE PROCESS CAN EMIT SEVERAL results (background agents): stop_reason is null on the early ones; the
//                          turn ends at process exit and its result is the last one with a non-null stop_reason (pickResult)
//                        - total_cost_usd, modelUsage and duration_api_ms are CUMULATIVE across --resume; usage and
//                          model_usage_since_last_result are per turn (costDelta for a per-turn cost)
//                        - PreToolUse HOOK denials are NOT in permission_denials (only permission-tool denials are): they show
//                          as a tool_result `<tool_use_error>PreToolUse:Bash hook error: Blocked by guard (rule): ...`
//                          (hookDenial); count guard denials from guard.log, not from the stream
// Everything else (stream_event, rate_limit_event, command_lifecycle, attachment, system/thinking_tokens, ...) is ignored.

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
  if (o.type === "system" && o.subtype === "init") return [{ type: "init", sessionId: o.session_id ?? null, model: o.model ?? null, mcpServers: Array.isArray(o.mcp_servers) ? o.mcp_servers.filter(isObj).map((m) => ({ name: String(m.name ?? ""), status: String(m.status ?? ""), source: m.source ?? null })) : [] }];
  if (o.type === "assistant" && isObj(o.message) && Array.isArray(o.message.content)) {
    const base = o.uuid ?? o.message.id ?? "";
    const out = [];
    o.message.content.forEach((b, i) => {
      if (!isObj(b)) return;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ type: "text", text: b.text, key: `${base}:${i}`, messageId: o.message.id ?? null });
      else if (b.type === "tool_use") out.push({ type: "tool_use", id: String(b.id ?? ""), name: String(b.name ?? ""), input: isObj(b.input) ? b.input : {}, messageId: o.message.id ?? null });
    });
    return out;
  }
  if (o.type === "user" && isObj(o.message) && Array.isArray(o.message.content)) {
    return o.message.content.filter((b) => isObj(b) && b.type === "tool_result").map((b) => ({ type: "tool_result", toolUseId: String(b.tool_use_id ?? ""), isError: !!b.is_error, text: resultText(b.content) }));
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
      denials: Array.isArray(o.permission_denials) ? o.permission_denials : [], // permission-tool denials only, never the guard's
      resultIndex: typeof o.result_index === "number" ? o.result_index : null,
      totalCostUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null, // cumulative across --resume
      modelUsageSince: isObj(o.model_usage_since_last_result) ? o.model_usage_since_last_result : null,
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

const resultText = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (isObj(b) ? b.text ?? "" : String(b))).join("") : "").slice(0, 600);

// Which result ends the turn: the last one with a non-null stop_reason; with none, the last one. Fold over a process's results.
export const pickResult = (cur, next) => (cur && cur.stopReason !== null && next.stopReason === null ? cur : next);

// A guard (PreToolUse hook) denial as the model sees it, or null. The stream's permission_denials never lists these.
export function hookDenial(ev) {
  if (!ev?.isError) return null;
  const m = /PreToolUse:(\w+) hook error: Blocked by guard \(([\w-]+)\)/.exec(ev.text ?? "");
  return m ? { tool: m[1], rule: m[2] } : null;
}

// total_cost_usd is cumulative across --resume: the cost of one turn is the difference. A smaller total means a new session.
export const costDelta = (prev, total) => (prev == null || total < prev ? total : Math.round((total - prev) * 1e8) / 1e8);
