// Owner MCP server tests (PLAN 2.3, 2.11, 2.12): the real server over stdio via the MCP SDK client, talking to a real
// runner on a temp socket. The permission tool's argument shape ({tool_name, input, tool_use_id}) is the spike's
// recorded assumption (spike/owner-mcp.mjs); phase 1 T3 confirms it from owner-mcp.log.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { decide } from "../mcp/owner.mjs";
import { ROOT, sandbox } from "../testlib/helpers.mjs";
import { connect, startRunner } from "../testlib/harness.mjs";

const clients = [];
after(async () => { for (const c of clients) await c.close().catch(() => {}); });

async function mcp(S, R, lane, task) {
  const sock = R.sock;
  const token = R.runner.issueToken(lane === "chat" ? "chat" : task ?? "none");
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(ROOT, "mcp", "owner.mjs")],
    env: { HOME: S.home, PATH: process.env.PATH, WA_SOCK: sock, WA_LANE: lane, WA_LANE_TOKEN: token, ...(task ? { WA_TASK_ID: task } : {}), OWNER_MCP_LOG: join(S.dir, "owner-mcp.log") },
  });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  clients.push(c);
  const call = async (name, args) => c.callTool({ name, arguments: args });
  const text = (r) => r.content[0].text;
  return { c, call, text };
}

test("the owner server lists its six tools", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const { c } = await mcp(S, R, "chat");
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["ask_owner", "notify_owner", "permission", "start_task", "track_issue", "wiki_capture"]);
});

test("permission tool denies AskUserQuestion and ExitPlanMode with the retry-alone message, denies what the guard denies, allows the rest", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const { call, text } = await mcp(S, R, "chat");
  const perm = async (tool_name, input) => { const r = await call("permission", { tool_name, input, tool_use_id: "toolu_1" }); assert.ok(!r.isError); assert.equal(r.content.length, 1); return JSON.parse(text(r)); };
  const ask = await perm("AskUserQuestion", { questions: [] });
  assert.equal(ask.behavior, "deny");
  assert.equal(ask.message, "AskUserQuestion must be called alone, in a turn with no other tool call. Call it again by itself.");
  assert.equal((await perm("ExitPlanMode", {})).behavior, "deny");
  const kube = await perm("Bash", { command: "kubectl delete pod x" });
  assert.equal(kube.behavior, "deny");
  assert.match(kube.message, /no-cluster-tools/);
  assert.equal((await perm("Bash", { command: "gh pr merge https://github.com/o/r/pull/1" })).behavior, "deny"); // no grant
  const ok = await perm("Read", { file_path: "/tmp/x" });
  assert.deepEqual(ok, { behavior: "allow", updatedInput: { file_path: "/tmp/x" } });
  assert.equal((await perm(undefined, {})).behavior, "deny"); // unknown shape fails closed
});
test("decide() honours the lane: a task lane cannot write agent-memory through the permission tool", () => {
  const S = sandbox();
  const args = { tool_name: "Write", input: { file_path: join(S.home, ".claude", "agent-memory", "MEMORY.md"), content: "x" } };
  assert.equal(decide(args, { home: S.home, xchg: S.xchg, lane: "task", task: "i1" }).behavior, "deny");
  assert.equal(decide(args, { home: S.home, xchg: S.xchg, lane: "chat" }).behavior, "allow");
});

test("start_task, track_issue and notify_owner go through the runner; critical needs a code", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const bridge = await connect(R.sock, { role: "bridge" });
  const chat = await mcp(S, R, "chat");
  const r1 = await chat.call("start_task", { issue: "i1" });
  assert.equal(chat.text(r1), "task started");
  await bridge.wait((e) => e.ev === "task-started" && e.task === "i1");
  assert.equal((await chat.call("start_task", { issue: "bad id!" })).isError, true);
  const task = await mcp(S, R, "task", "i1");
  assert.equal(task.text(await task.call("track_issue", { issue: "child-1", role: "child" })), "tracked");
  const noCode = await task.call("notify_owner", { kind: "critical", text: "jalankan X" });
  assert.equal(noCode.isError, true);
  assert.match(task.text(noCode), /code/);
  assert.equal((await task.call("notify_owner", { kind: "critical", text: "jalankan X", code: "word" })).isError, true);
  assert.equal(task.text(await task.call("notify_owner", { kind: "critical", text: "jalankan psql -c ... Balas done k7q-4821", code: "K7Q-4821" })), "sent");
  const n = await bridge.wait((e) => e.ev === "notify" && e.kind === "critical");
  assert.deepEqual([n.lane, n.code], ["i1", "k7q-4821"]);
  assert.equal((await task.call("notify_owner", { kind: "weird", text: "x" })).isError, true);
  assert.ok(!(await chat.call("start_task", { issue: "i2" })).isError);
  const noEnv = await mcp(S, R, "task"); // a task lane without WA_TASK_ID: refuses
  assert.equal((await noEnv.call("notify_owner", { kind: "done", text: "x" })).isError, true);
});

test("start_task from the MCP is an error while the project id is unset", async () => {
  const S = sandbox();
  const R = await startRunner(S, { projectId: "" });
  const chat = await mcp(S, R, "chat");
  const r = await chat.call("start_task", { issue: "i1" });
  assert.equal(r.isError, true);
  assert.match(chat.text(r), /WA_GREMIO_PROJECT_ID/);
});

test("a tool call when the runner is down fails with an error result, not a crash", async () => {
  const S = sandbox();
  const chat = await mcp(S, { sock: join(S.dir, "nope.sock"), runner: { issueToken: () => "x" } }, "chat");
  const r = await chat.call("start_task", { issue: "i1" });
  assert.equal(r.isError, true);
});
