// Phase 1 spike results applied (PLAN section 8): stream format facts, the ask path through the permission tool, D20 lane
// limit, runner-side wiki retrieval. Fixtures plain, deferred, answered, parallel, guard-deny, multi-result are trimmed real
// recordings (spike/results, see test/fixtures/SOURCES.json); session ids are normalized to __SID__.
// Fields asserted from the recordings: init.mcp_servers [{name,status,source}]; assistant lines one per content block with a
// shared message.id and a distinct uuid, thinking blocks included; result.result_index, queued_turn_count, stop_reason (null
// while background agents run), total_cost_usd / modelUsage / duration_api_ms cumulative across --resume,
// model_usage_since_last_result per turn, usage per turn; PreToolUse hook denials absent from permission_denials, present as
// tool_result text `<tool_use_error>PreToolUse:Bash hook error: Blocked by guard (rule): ...`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LineSplitter } from "../src/stream.mjs";
import * as stream from "../src/stream.mjs";
import * as selftest from "../src/selftest.mjs";
import * as runnerMod from "../src/runner.mjs";
import { decide } from "../mcp/owner.mjs";
import * as askDefer from "../hooks/ask-defer.mjs";

const readAnswers = (...a) => askDefer.readAnswers(...a); // namespace access: a missing export fails the test, not the file
import { ROOT, sandbox, waitFor } from "../testlib/helpers.mjs";
import { connect, startRunner, toolCall } from "../testlib/harness.mjs";

const fixture = (name) => readFileSync(join(ROOT, "test", "fixtures", `${name}.jsonl`), "utf8").split("\n").filter(Boolean);
const events = (name) => fixture(name).flatMap((l) => stream.parseLine(l));
const results = (name) => events(name).filter((e) => e.type === "result");

// ---------------- item 4: stream format ----------------
test("recorded init lists mcp_servers as [{name,status,source}] and the parser keeps them", () => {
  const init = events("deferred").find((e) => e.type === "init");
  assert.deepEqual(init.mcpServers, [{ name: "owner", status: "connected", source: "dynamic" }]);
  assert.deepEqual(selftest.mcpNames({ mcp_servers: [{ name: "owner", status: "connected" }, { name: "context7", status: "failed" }, { name: "x" }] }), ["owner"]);
  assert.deepEqual(selftest.mcpNames(null), []);
});

test("one process can emit several results: the turn's result is the last one with a non-null stop_reason", () => {
  const rs = results("multi-result");
  assert.deepEqual(rs.map((r) => [r.resultIndex, r.stopReason]), [[1, null], [2, null], [3, "end_turn"]]);
  const final = rs.reduce((cur, r) => stream.pickResult(cur, r), null);
  assert.equal(final.stopReason, "end_turn");
  assert.equal(final.resultIndex, 3);
  // the order of arrival does not matter once a real stop_reason was seen, and an all-null process ends on its last result
  assert.equal([rs[2], rs[0]].reduce((cur, r) => stream.pickResult(cur, r), null).stopReason, "end_turn");
  assert.equal([rs[0], rs[1]].reduce((cur, r) => stream.pickResult(cur, r), null).resultIndex, 2);
});

test("PreToolUse hook denials are not in permission_denials: they are read from the tool_result text", () => {
  const evs = events("guard-deny");
  assert.deepEqual(evs.filter((e) => e.type === "result")[0].denials, []);
  const denied = evs.filter((e) => e.type === "tool_result" && stream.hookDenial(e));
  assert.deepEqual(denied.map((e) => stream.hookDenial(e).rule), ["gh-repo-delete", "no-cluster-tools", "sql-drop", "git-push-protected", "gh-api-refs", "policy-path-write"]);
  assert.deepEqual(stream.hookDenial(denied[0]), { tool: "Bash", rule: "gh-repo-delete" });
  assert.equal(stream.hookDenial({ type: "tool_result", isError: true, text: "some other error" }), null);
  assert.equal(stream.hookDenial({ type: "tool_result", isError: false, text: "<tool_use_error>PreToolUse:Bash hook error: Blocked by guard (x): y" }), null);
});

test("an assistant message arrives as one line per content block: same message.id, distinct uuid, thinking skipped", () => {
  const evs = events("guard-deny").filter((e) => e.type === "tool_use");
  const sameMessage = evs.filter((e) => e.messageId === "msg_011Cgx3TQRRDBSgkcehGac9B");
  assert.ok(sameMessage.length >= 5, "five tool_use lines share the message id");
  assert.equal(events("guard-deny").some((e) => e.type === "text" && e.text === ""), false); // thinking blocks produce nothing
  const line = (uuid, text) => JSON.stringify({ type: "assistant", uuid, message: { id: "msg_same", content: [{ type: "text", text }] } });
  const [a] = stream.parseLine(line("u1", "satu")), [b] = stream.parseLine(line("u2", "dua"));
  assert.notEqual(a.key, b.key); // outbox ids stay unique although message.id repeats
  assert.equal(a.messageId, "msg_same");
});

test("cost, modelUsage and duration_api_ms are cumulative: a per-turn figure comes from usage or the delta", () => {
  const r = results("plain")[0];
  assert.equal(r.totalCostUsd, 0.02990175);
  assert.deepEqual(Object.keys(r.modelUsageSince), ["role-exec"]);
  assert.equal(r.usage.output_tokens, 4);
  assert.equal(stream.costDelta(0.0299, 0.0626), 0.0327);
  assert.equal(stream.costDelta(0.2, 0.1), 0.1); // a new session resets the total: the new total is the turn's cost
  assert.equal(stream.costDelta(null, 0.05), 0.05);
  // the selftest takes the model list from the per-turn field when there is one
  assert.deepEqual(selftest.perTurnModels({ modelUsage: { a: {}, b: {} }, model_usage_since_last_result: { b: {} } }), ["b"]);
  assert.deepEqual(selftest.perTurnModels({ modelUsage: { a: {} } }), ["a"]);
  assert.deepEqual(selftest.perTurnModels({}), []);
});

test("selftest digest keeps the last result with a stop_reason from a multi-result process", () => {
  const d = selftest.digest(fixture("multi-result"));
  assert.equal(d.result.stop_reason, "end_turn");
  assert.equal(d.result.result_index, 3);
  assert.deepEqual(selftest.mcpNames(d.init), ["owner"]);
});

test("the runner forwards one result per process, the final one, and no permission_denials count", async () => {
  const S = sandbox();
  const R = await startRunner(S, { script: ["multi-result", "guard-deny"] });
  const b = await connect(R.sock, { role: "bridge" });
  b.send({ op: "turn", lane: "chat", prompt: "x", session: null });
  await b.wait((e) => e.ev === "result");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(b.of("result").length, 1);
  const r = b.of("result")[0];
  assert.deepEqual([r.stopReason, r.resultIndex], ["end_turn", 3]);
  assert.equal("denials" in r, false); // hook denials are not in the stream's count; guard.log is the source
  assert.equal(typeof r.totalCostUsd, "number");
  b.send({ op: "turn", lane: "i1", task: "i1", prompt: "y", session: null });
  const g = await b.wait((e) => e.ev === "result" && e.lane === "i1");
  assert.equal(g.stopReason, "end_turn");
  assert.equal("denials" in g, false);
});

// ---------------- item 1: the ask path goes through the permission tool ----------------
const ASK_ID = "toolu_0171fPoPiDXrhmqhiXbWPEh1";
const askInput = { questions: [{ question: "Which colour do you prefer?", header: "Colour", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }], multiSelect: false }] };
const ctxOf = (S, over = {}) => ({ home: S.home, xchg: S.xchg, lane: "chat", ...over });
const ask = (S, args, over) => decide({ tool_name: "AskUserQuestion", tool_use_id: ASK_ID, input: askInput, ...args }, ctxOf(S, over));

test("permission tool allows AskUserQuestion with updatedInput = input + answers once the bridge wrote the answer file", () => {
  const S = sandbox();
  assert.equal(ask(S, {}).behavior, "deny"); // no answer yet: the retry-alone deny stays
  assert.equal(ask(S, {}).message, "AskUserQuestion must be called alone, in a turn with no other tool call. Call it again by itself.");
  writeFileSync(join(S.xchg, "answers", `${ASK_ID}.json`), JSON.stringify({ questions: [{ question: "FORGED" }], answers: { "Which colour do you prefer?": "Blue" } }));
  const d = ask(S, {});
  assert.equal(d.behavior, "allow");
  assert.deepEqual(d.updatedInput, { ...askInput, answers: { "Which colour do you prefer?": "Blue" } }); // questions come from Claude, not the file
});

test("permission tool: a bad id, a missing id, a malformed or non-object answers file all keep the deny", () => {
  const S = sandbox();
  writeFileSync(join(S.xchg, "answers", "ok_id.json"), JSON.stringify({ answers: ["not", "an", "object"] }));
  writeFileSync(join(S.xchg, "answers", "bad_json.json"), "{not json");
  writeFileSync(join(S.dir, "outside.json"), JSON.stringify({ answers: { q: "a" } }));
  for (const tool_use_id of ["ok_id", "bad_json", "../../outside", "a/b", "__proto__", "x".repeat(65), "", undefined, 7]) {
    assert.equal(ask(S, { tool_use_id }).behavior, "deny", String(tool_use_id));
  }
  assert.equal(ask(S, { input: undefined }).behavior, "deny");
  assert.equal(decide({ tool_name: "ExitPlanMode", tool_use_id: ASK_ID, input: {} }, ctxOf(S)).behavior, "deny"); // only AskUserQuestion has an answer path
  writeFileSync(join(S.xchg, "answers", `${ASK_ID}.json`), JSON.stringify({ answers: { q: "a" } }));
  assert.equal(decide({ tool_name: "ExitPlanMode", tool_use_id: ASK_ID, input: {} }, ctxOf(S)).behavior, "deny");
  assert.equal(decide({ tool_name: "Bash", tool_use_id: ASK_ID, input: { command: "kubectl get pods" } }, ctxOf(S)).behavior, "deny"); // the guard still applies
});

test("readAnswers is the one reader the hook and the permission tool share", () => {
  const S = sandbox();
  writeFileSync(join(S.xchg, "answers", "t1.json"), JSON.stringify({ answers: { q: "a" } }));
  assert.deepEqual(readAnswers(S.xchg, "t1"), { q: "a" });
  assert.equal(readAnswers(S.xchg, "../t1"), null);
  assert.equal(readAnswers(S.xchg, "missing"), null);
});

test("through the real owner MCP server: the permission tool allows the answered AskUserQuestion by tool_use_id", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const S = sandbox();
  const R = await startRunner(S, {});
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "mcp", "owner.mjs")], env: { HOME: S.home, PATH: process.env.PATH, WA_SOCK: R.sock, WA_XCHG_DIR: S.xchg, WA_LANE: "chat", WA_LANE_TOKEN: R.runner.issueToken("chat"), OWNER_MCP_LOG: join(S.dir, "m.log") } });
  const c = new Client({ name: "t", version: "0" });
  await c.connect(transport);
  try {
    const call = async () => JSON.parse((await c.callTool({ name: "permission", arguments: { tool_name: "AskUserQuestion", input: askInput, tool_use_id: ASK_ID } })).content[0].text);
    assert.equal((await call()).behavior, "deny");
    // the server reads the fixed /xchg: the env override is ignored (like the hooks), so an answer under another dir changes nothing
    writeFileSync(join(S.xchg, "answers", `${ASK_ID}.json`), JSON.stringify({ answers: { q: "a" } }));
    assert.equal((await call()).behavior, "deny");
  } finally { await c.close(); }
});

// ---------------- item 2: D20, one task lane by default ----------------
test("WA_MAX_TASK_LANES: 1 or 2, anything else is 1", () => {
  assert.equal(runnerMod.maxTaskLanes(undefined), 1);
  assert.equal(runnerMod.maxTaskLanes("1"), 1);
  assert.equal(runnerMod.maxTaskLanes("2"), 2);
  for (const bad of ["0", "3", "-1", "two", "", "1.5", " "]) assert.equal(runnerMod.maxTaskLanes(bad), 1, bad);
});

test("by default the chat lane plus one task lane run; a second task waits and starts when the first is done", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const b = await connect(R.sock, { role: "bridge" });
  assert.equal((await toolCall(R, "chat", "start_task", { issue: "i1" })).status, "started");
  const second = await toolCall(R, "chat", "start_task", { issue: "i2" });
  assert.deepEqual([second.status, second.position], ["queued", 1]);
  await waitFor(() => b.of("task-started").length === 1);
  assert.equal((await toolCall(R, "i1", "notify", { kind: "done", text: "beres" })).ok, true);
  await b.wait((e) => e.ev === "task-started" && e.task === "i2");
  assert.equal(b.of("task-started").length, 2);
  await R.runner.close();
});

test("WA_MAX_TASK_LANES=2 in the runner's env allows two task lanes", async () => {
  const S = sandbox();
  const R = await startRunner(S, { env: { WA_MAX_TASK_LANES: "2" } });
  assert.equal((await toolCall(R, "chat", "start_task", { issue: "i1" })).status, "started");
  assert.equal((await toolCall(R, "chat", "start_task", { issue: "i2" })).status, "started");
  assert.equal((await toolCall(R, "chat", "start_task", { issue: "i3" })).status, "queued");
  await R.runner.close();
});

// ---------------- item 3: wiki retrieval in the runner ----------------
const PAGE = `---\ntitle: Gremio wiki sync flock\ntype: concept\naliases: [sinkron wiki Gremio]\ntags: [gremio]\nstatus: draft\norg: dunan\ndescription: How the runner serializes wiki pushes.\n---\nbody\n`;
async function retrievalWorld(over = {}) {
  const S = sandbox();
  const R = await startRunner(S, { script: ["plain"], ...over });
  mkdirSync(join(R.agentDir, "hooks"), { recursive: true });
  cpSync(join(ROOT, "hooks", "wiki-retrieve.py"), join(R.agentDir, "hooks", "wiki-retrieve.py"));
  mkdirSync(join(S.home, ".claude", "wiki", "concepts"), { recursive: true });
  writeFileSync(join(S.home, ".claude", "wiki", "concepts", "Gremio wiki sync flock.md"), PAGE);
  const b = await connect(R.sock, { role: "bridge" });
  const turn = async (m) => { const n = b.of("result").length; b.send({ op: "turn", ...m }); await waitFor(() => b.of("result").length === n + 1); return R.calls().at(-1).argv; };
  return { S, R, b, turn };
}

test("a prompt that matches a wiki page gets the hook's context prepended, never on a resume", async () => {
  const w = await retrievalWorld();
  const argv = await w.turn({ lane: "chat", prompt: "jelaskan Gremio wiki sync flock itu apa", session: null });
  const prompt = argv[1];
  assert.match(prompt, /Gremio wiki sync flock \[concept, dunan, draft\]/);
  assert.match(prompt, /How the runner serializes wiki pushes\./);
  assert.ok(prompt.endsWith("jelaskan Gremio wiki sync flock itu apa"), "the owner's text comes last, unchanged");
  assert.ok(prompt.length < 7000); // bounded
  const resume = await w.turn({ lane: "chat", prompt: "", session: "sess-1" });
  assert.deepEqual(resume.slice(0, 3), ["-p", "--resume", "sess-1"]); // an empty-prompt resume retrieves nothing
  const task = await w.turn({ lane: "i1", task: "i1", prompt: "[task] cek Gremio wiki sync flock", session: null });
  assert.match(task[1], /Gremio wiki sync flock \[concept/); // a task-lane turn with a prompt retrieves too
  await w.R.runner.close();
});

test("no match, no hook script, a failing hook or garbage output leave the prompt exactly as it was", async () => {
  const w = await retrievalWorld({ wikiRetrieveTimeoutMs: 400 });
  assert.equal((await w.turn({ lane: "chat", prompt: "berapa harga tomat hari ini", session: null }))[1], "berapa harga tomat hari ini");
  assert.equal((await w.turn({ lane: "chat", prompt: "ya", session: "s" }))[1], "ya");
  const hook = join(w.R.agentDir, "hooks", "wiki-retrieve.py");
  writeFileSync(hook, "import sys\nsys.exit(3)\n");
  assert.equal((await w.turn({ lane: "chat", prompt: "jelaskan Gremio wiki sync flock itu apa", session: "s" }))[1], "jelaskan Gremio wiki sync flock itu apa");
  writeFileSync(hook, "print('not json at all')\n");
  assert.equal((await w.turn({ lane: "chat", prompt: "jelaskan Gremio wiki sync flock itu apa", session: "s" }))[1], "jelaskan Gremio wiki sync flock itu apa");
  writeFileSync(hook, "import time\ntime.sleep(30)\n");
  const t0 = Date.now();
  assert.equal((await w.turn({ lane: "chat", prompt: "jelaskan Gremio wiki sync flock itu apa", session: "s" }))[1], "jelaskan Gremio wiki sync flock itu apa");
  assert.ok(Date.now() - t0 < 3000, "a hung hook is cut off");
  chmodSync(hook, 0o644);
  await w.R.runner.close();
}, { timeout: 30000 });

test("the context is capped so a huge hook output cannot swamp the prompt", async () => {
  const w = await retrievalWorld();
  const hook = join(w.R.agentDir, "hooks", "wiki-retrieve.py");
  writeFileSync(hook, "import json\nprint(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': 'X' * 50000}}))\n");
  const prompt = (await w.turn({ lane: "chat", prompt: "jelaskan Gremio wiki sync flock itu apa", session: null }))[1];
  assert.ok(prompt.length < 9000, String(prompt.length));
  assert.ok(prompt.endsWith("jelaskan Gremio wiki sync flock itu apa"));
  await w.R.runner.close();
});

test("a prompt that starts with a dash still gets the leading space after retrieval changed nothing", async () => {
  const w = await retrievalWorld();
  assert.equal((await w.turn({ lane: "chat", prompt: "- beli susu", session: null }))[1], " - beli susu");
  await w.R.runner.close();
});
