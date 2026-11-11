#!/usr/bin/env node
// MCP server `owner` (PLAN 2.3, 2.11, 2.12). Spawned by claude per lane (WA_LANE and WA_TASK_ID reach it through
// mcp.json env expansion, UNVERIFIED until phase 1/4). Tools:
//   permission    target of --permission-prompt-tool: denies AskUserQuestion and ExitPlanMode (2.3) and whatever
//                 hooks/guard.mjs denies; allows the rest. Raw arguments are logged (shape not documented).
//   ask_owner     rank 3, blocking, over the runner socket
//   start_task    chat lane only: asks the runner for a task lane
//   notify_owner  kind done | critical (critical carries the code the bridge records); done is refused in the chat lane
//   track_issue   registers a child or vehicle issue for the poller
//   wiki_capture  asks the runner to run wiki-sync.sh (phase 6 seam)
// stdout carries JSON-RPC only.
import net from "node:net";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { evaluate, denyMessage, CODE_RE } from "../hooks/guard.mjs";
import { attach, send } from "../src/ipc.mjs";

const NEEDS_UPDATED_INPUT = new Set(["AskUserQuestion", "ExitPlanMode"]);
const SOCK = () => process.env.WA_SOCK || "/xchg/sock/run.sock";

export function decide(args, { home, xchg = "/xchg", lane, task, cwd } = {}) {
  const tool = args?.tool_name;
  if (typeof tool !== "string") return { behavior: "deny", message: "permission request has no tool_name" };
  if (NEEDS_UPDATED_INPUT.has(tool)) return { behavior: "deny", message: `${tool} must be called alone, in a turn with no other tool call. Call it again by itself.` };
  const input = args.input && typeof args.input === "object" && !Array.isArray(args.input) ? args.input : {};
  const { verdict } = evaluate({ tool_name: tool, tool_input: input, cwd }, { home, xchg, lane, task });
  if (verdict?.deny) return { behavior: "deny", message: denyMessage(verdict) };
  return { behavior: "allow", updatedInput: input };
}

// One request/reply over the runner socket. Rejects when the runner is not there.
export function callRunner(op, payload, { lane, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const rid = randomUUID();
    const sock = net.connect(SOCK());
    const t = timeoutMs ? setTimeout(() => { sock.destroy(); reject(new Error("runner did not answer in time")); }, timeoutMs) : null;
    attach(sock, (m) => {
      if (m.ev === "hello") send(sock, { op, rid, ...payload });
      else if (m.ev === "error") { clearTimeout(t); reject(new Error(m.error)); }
      else if (m.ev === "reply" && m.rid === rid) { clearTimeout(t); sock.end(); resolve(m); }
    });
    sock.on("error", (e) => { clearTimeout(t); reject(e); });
    sock.on("close", () => { clearTimeout(t); reject(new Error("runner closed the connection")); });
    // The lane's own secret (put in this server's env by the runner through mcp.json) proves which lane this is.
    sock.on("connect", () => send(sock, { op: "hello", role: "tool", lane, token: process.env.WA_LANE_TOKEN }));
  });
}

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const TOOLS = [
  { name: "permission", description: "Permission prompt tool: allow everything except AskUserQuestion, ExitPlanMode and what the guard denies.", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object", additionalProperties: true }, tool_use_id: { type: "string" } }, additionalProperties: true } },
  { name: "ask_owner", description: "Ask Lord Faisal one short question over WhatsApp and wait for the reply. Only for short waits inside one turn; prefer AskUserQuestion.", inputSchema: obj({ question: { type: "string" } }, ["question"]) },
  { name: "start_task", description: "Chat lane only: start a task lane for a Gremio issue that already exists. Returns started, queued or an error.", inputSchema: obj({ issue: { type: "string", description: "Multica issue id" } }, ["issue"]) },
  { name: "notify_owner", description: "Task lane to WhatsApp. kind done: the task is finished (short report). kind critical: a critical action Lord Faisal must run himself; text carries the exact command and why, code is the code he replies with as 'done <code>' or 'deny <code>'.", inputSchema: obj({ kind: { type: "string", enum: ["done", "critical"] }, text: { type: "string" }, code: { type: "string", description: "critical only, like k7q-4821" } }, ["kind", "text"]) },
  { name: "track_issue", description: "Register a child or vehicle issue of this task so its comments and status wake this lane.", inputSchema: obj({ issue: { type: "string" }, role: { type: "string", enum: ["child", "vehicle"] } }, ["issue"]) },
  { name: "wiki_capture", description: "Commit and push wiki pages already written under ~/.claude/wiki (runs wiki-sync.sh outside the model).", inputSchema: obj({}) },
];

const reply = (text, isError = false) => ({ isError, content: [{ type: "text", text }] });

export async function callTool(name, args, env = process.env) {
  const lane = env.WA_LANE ?? "";
  const laneId = lane === "chat" ? "chat" : env.WA_TASK_ID ?? "";
  if (!laneId) return reply("WA_LANE is not set for this server", true);
  const rpc = async (op, payload, opts) => {
    try { return await callRunner(op, payload, { lane: laneId, ...opts }); } catch (e) { return { ok: false, error: e.message }; }
  };
  const show = (r, ok) => (r.ok ? reply(ok(r)) : reply(r.error ?? "failed", true));
  switch (name) {
    case "start_task": return show(await rpc("start_task", { issue: String(args.issue ?? "") }), (r) => (r.status === "queued" ? `queued: both task lanes are busy (position ${r.position}); tell Lord Faisal it waits` : `task ${r.status}`));
    case "track_issue": return show(await rpc("track_issue", { issue: String(args.issue ?? ""), role: args.role }), () => "tracked");
    case "wiki_capture": return show(await rpc("wiki_capture", {}, { timeoutMs: 180000 }), (r) => (r.ran ? `wiki sync: ${r.status ?? "done"}${r.branch ? ` (the pages conflicted with main and went to branch ${r.branch}; Lord Faisal was told)` : ""}` : "wiki sync is not installed yet"));
    case "ask_owner": return show(await rpc("ask_owner", { question: String(args.question ?? "") }, { timeoutMs: 0 }), (r) => r.answer);
    case "notify_owner": {
      const kind = args.kind, text = String(args.text ?? "").trim();
      if (kind !== "done" && kind !== "critical") return reply("kind must be done or critical", true);
      if (kind === "done" && laneId === "chat") return reply("notify_owner done is for task lanes; the chat lane answers in plain text", true);
      if (!text || text.length > 3500) return reply("text must be 1 to 3500 characters", true);
      if (kind === "critical" && !CODE_RE.test(String(args.code ?? ""))) return reply("critical needs a code like k7q-4821 (3-8 letters or digits, a dash, 3-6 digits)", true);
      return show(await rpc("notify", { kind, text, code: kind === "critical" ? String(args.code).toLowerCase() : null, nid: randomUUID() }), () => "sent");
    }
    default: return reply(`unknown tool ${name}`, true);
  }
}

async function main() {
  const LOG = process.env.OWNER_MCP_LOG || join(process.env.HOME, ".claude", "owner-mcp.log");
  const log = (rec) => { try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n"); } catch { /* best effort */ } };
  const server = new Server({ name: "owner", version: "0.2.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (name === "permission") {
      const d = decide(args, { home: process.env.HOME, lane: process.env.WA_LANE, task: process.env.WA_TASK_ID, cwd: process.cwd() });
      log({ raw_args: args, decision: d.behavior, message: d.message });
      return { content: [{ type: "text", text: JSON.stringify(d) }] }; // one text block, no structuredContent (spike finding)
    }
    return callTool(name, args);
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { process.stderr.write(`owner-mcp: ${e.stack}\n`); process.exit(1); });
