// The worker side of the human-like WhatsApp tools (PLAN 2.14): the owner MCP tools, the runner's wa-action plumbing and the media
// path checks, against a real runner on a temp socket and a bridge connection the test drives by hand.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evaluate } from "../hooks/guard.mjs";
import { ROOT, fakeBin, sandbox, waitFor } from "../testlib/helpers.mjs";
import { connect, startRunner } from "../testlib/harness.mjs";

const LG = "grp_120363", LG2 = "grp_120999";
const MB = 1024 * 1024;
const WEBP = "RIFF\0\0\0\0WEBPVP8 ";

// A tool call that stays open until the bridge answers: returns {done, ...}.
async function toolOp(R, lane, op, payload = {}) {
  const c = await connect(R.sock, { role: "tool", lane, token: R.runner.issueToken(lane) });
  const rid = Math.random().toString(36).slice(2);
  c.send({ op, rid, ...payload });
  return { c, reply: () => c.wait((e) => e.ev === "reply" && e.rid === rid) };
}
const bridgeUp = (S, R) => connect(R.sock, { role: "bridge" }, { xchg: S.xchg });
const answer = (bridge, ev, result) => bridge.send({ op: "wa-result", rid: ev.rid, ...result });
// One whole call: the tool asks, the bridge sees the wa-action, answers, the tool gets its reply.
async function call(S, R, bridge, lane, op, payload, result = { ok: true, ref: "#ab12" }) {
  const mark = bridge.of("wa-action").length;
  const t = await toolOp(R, lane, op, payload);
  const ev = await bridge.wait((e) => e.ev === "wa-action" && bridge.of("wa-action").indexOf(e) >= mark);
  answer(bridge, ev, result);
  return { ev, reply: await t.reply() };
}
const refused = async (R, lane, op, payload) => { const t = await toolOp(R, lane, op, payload); const r = await t.reply(); t.c.close(); return r; };

test("a tool call becomes a wa-action for the bridge with the lane the token proves, and the bridge's answer reaches the tool", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const bridge = await bridgeUp(S, R);
  const { ev, reply } = await call(S, R, bridge, "chat", "wa_react", { ref: "#a1b2", emoji: "👍", lane: LG, jid: "628222@s.whatsapp.net", to: "x" });
  assert.deepEqual([ev.lane, ev.action], ["chat", "react"]);                                // the lane is the token's, not what the payload says
  assert.deepEqual(ev.args, { ref: "#a1b2", emoji: "👍", multi: false });                    // only the fields the tool knows: no jid, no lane
  assert.deepEqual([reply.ok, reply.ref], [true, "#ab12"]);
  const g = await call(S, R, bridge, LG, "wa_reply", { ref: "#c3d4", text: "siap" }, { ok: false, error: "unknown ref: use one from a message tag of this chat, like #a1b2" });
  assert.deepEqual([g.ev.lane, g.ev.action, g.ev.args.text], [LG, "reply", "siap"]);
  assert.deepEqual([g.reply.ok, g.reply.error], [false, "unknown ref: use one from a message tag of this chat, like #a1b2"]);
  // every tool maps to its action, and a group lane may use all of them but still not notify the owner
  for (const [op, action] of [["wa_poll", "poll"], ["wa_mention", "mention"], ["wa_edit", "edit"], ["wa_delete", "delete"]]) assert.equal((await call(S, R, bridge, LG, op, { ref: "#a1b2", text: "x", question: "q", options: ["a", "b"], names: ["Budi"] })).ev.action, action);
  assert.match((await refused(R, LG, "notify", { kind: "done", text: "x" })).error, /not available in a group chat/);
  assert.match((await refused(R, LG, "wa_unknown", {})).error, /not available in a group chat/);
  for (const op of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.match((await refused(R, LG, op, {})).error, /not available in a group chat/, op); // not a tool just because Object has a member of that name
  assert.deepEqual(bridge.of("wa-action").filter((e) => !["react", "reply", "poll", "mention", "edit", "delete"].includes(e.action)), []);
});

test("without a bridge the tool gets an error at once, and nothing is kept to be replayed when a bridge connects later", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const r = await refused(R, "chat", "wa_react", { ref: "#a1b2", emoji: "👍" });
  assert.equal(r.ok, false);
  assert.match(r.error, /bridge is not connected/);
  const bridge = await bridgeUp(S, R);
  await new Promise((res) => setTimeout(res, 60));
  assert.deepEqual(bridge.of("wa-action"), []);
});

test("a bridge that goes away, or never answers, fails the tool call with an error instead of leaving it hanging", async () => {
  const S = sandbox();
  const R = await startRunner(S, { waActionMs: 150 });
  const bridge = await bridgeUp(S, R);
  const t = await toolOp(R, "chat", "wa_react", { ref: "#a1b2", emoji: "👍" });
  await bridge.wait((e) => e.ev === "wa-action");
  const slow = await t.reply();                                    // the bridge does not answer
  assert.match(slow.error, /did not answer in time/);
  const t2 = await toolOp(R, "chat", "wa_react", { ref: "#a1b2", emoji: "👍" });
  await bridge.wait((e) => e.ev === "wa-action" && bridge.of("wa-action").length === 2);
  bridge.close();
  assert.match((await t2.reply()).error, /bridge disconnected/);
});

test("a late wa-result for a call that is already over, and one with a made-up id, do nothing", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const bridge = await bridgeUp(S, R);
  bridge.send({ op: "wa-result", rid: "nope", ok: true });
  bridge.send({ op: "wa-result", ok: true });
  const { reply } = await call(S, R, bridge, "chat", "wa_react", { ref: "#a1b2", emoji: "👍" });
  assert.equal(reply.ok, true);
});

// ---------- media ----------
const stage = (S) => join(S.xchg, "sock", "outbox");
const put = (p, data = "DATA") => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, data); return p; };

test("wa_send_media: only files under ~/assistant or /xchg/inbox, links resolved; the bytes are counted; oversize and missing files are refused before the bridge hears of them", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const bridge = await bridgeUp(S, R);
  const ask = (path, kind = "image") => refused(R, "chat", "wa_send_media", { path, kind });
  put(join(S.dir, "outside.png"));
  put(join(S.home, ".claude", "secret.png"));
  put(join(S.home, ".multica", "config.png"));
  symlinkSync(join(S.dir, "outside.png"), join(S.home, "assistant", "link.png"));            // inside by name, outside by target
  symlinkSync(join(S.home, ".multica"), join(S.home, "assistant", "dirlink"));
  put(join(S.home, "assistant-evil", "x.png"));                                               // a sibling that only shares the prefix
  for (const path of ["/etc/hosts", join(S.dir, "outside.png"), join(S.home, ".claude", "secret.png"), join(S.home, "assistant", "link.png"), join(S.home, "assistant", "dirlink", "config.png"), join(S.home, "assistant-evil", "x.png"), "~/.claude/secret.png", "../../outside.png", `${S.home}/assistant/../.claude/secret.png`, "", join(S.xchg, "inbox", "..", "answers", "x")]) {
    const r = await ask(path);
    assert.equal(r.ok, false, path);
    assert.match(r.error, /under ~\/assistant or \/xchg\/inbox|no such file|path is required/, path);
  }
  assert.match((await ask(join(S.home, "assistant", "nope.png"))).error, /no such file/);
  assert.match((await ask(join(S.home, "assistant"))).error, /under|not a regular|directly|EISDIR|file/i);   // a directory is not a file
  const big = join(S.home, "assistant", "big.jpg"); put(big, ""); truncateSync(big, 5 * MB + 1);
  assert.match((await ask(big)).error, /over 5 MB/);
  const vid = join(S.home, "assistant", "big.mp4"); put(vid, ""); truncateSync(vid, 16 * MB + 1);
  assert.match((await ask(vid, "video")).error, /over 16 MB/);
  const doc = join(S.home, "assistant", "big.pdf"); put(doc, ""); truncateSync(doc, 20 * MB + 1);
  assert.match((await ask(doc, "document")).error, /over 20 MB/);
  assert.match((await ask(join(S.home, "assistant", "link.png"), "audio")).error, /kind must be/);
  assert.deepEqual(bridge.of("wa-action"), []);                                               // none of it reached the bridge
  assert.deepEqual(existsSync(stage(S)) ? readdirSync(stage(S)) : [], []);                    // and nothing is left staged
});

test("wa_send_media: a file in ~/assistant is staged for the bridge under the lane's own name and removed when the bridge has answered; ~ and relative paths work", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const bridge = await bridgeUp(S, R);
  put(join(S.home, "assistant", "laporan.pdf"), "PDFDATA");
  put(join(S.home, "assistant", "tasks", "t1", "hasil.png"), "PNGDATA");
  const t = await toolOp(R, "chat", "wa_send_media", { path: "~/assistant/laporan.pdf", kind: "document", caption: "nih" });
  const ev = await bridge.wait((e) => e.ev === "wa-action");
  assert.deepEqual([ev.lane, ev.action, ev.args.kind, ev.args.caption, ev.args.fileName], ["chat", "media", "document", "nih", "laporan.pdf"]);
  assert.match(ev.args.file, /^chat\.[0-9a-f]{16}\.pdf$/);
  assert.equal(ev.args.inbox, undefined);
  assert.equal(readFileSync(join(stage(S), ev.args.file), "utf8"), "PDFDATA");               // the bytes the runner read
  answer(bridge, ev, { ok: true, ref: "#ab12" });
  assert.equal((await t.reply()).ok, true);
  await waitFor(() => !existsSync(join(stage(S), ev.args.file)));                             // gone after the answer
  // relative to the lane's own folder
  const t2 = await toolOp(R, "chat", "wa_send_media", { path: "tasks/t1/hasil.png", kind: "image" });
  const ev2 = await bridge.wait((e) => e.ev === "wa-action" && e.args.fileName === "hasil.png");
  assert.match(ev2.args.file, /^chat\.[0-9a-f]{16}\.png$/);
  answer(bridge, ev2, { ok: false, error: "x" });
  assert.equal((await t2.reply()).ok, false);
  await waitFor(() => readdirSync(stage(S)).length === 0);                                    // also gone after a refusal
});

test("wa_send_media: a file of /xchg/inbox goes to the bridge by name, never copied; it must be directly in the inbox", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const bridge = await bridgeUp(S, R);
  put(join(S.xchg, "inbox", "dm1.jpg"));
  mkdirSync(join(S.xchg, "inbox", "sub"));
  put(join(S.xchg, "inbox", "sub", "deep.jpg"));
  const { ev } = await call(S, R, bridge, "chat", "wa_send_media", { path: join(S.xchg, "inbox", "dm1.jpg"), kind: "image" });
  assert.deepEqual([ev.args.inbox, ev.args.file], ["dm1.jpg", undefined]);
  assert.match((await refused(R, "chat", "wa_send_media", { path: join(S.xchg, "inbox", "sub", "deep.jpg"), kind: "image" })).error, /directly in/);
});

test("wa_send_media from a group lane: its own folder ~/assistant/groups/<id> only (links resolved), or an inbox file by name for the bridge to check", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const bridge = await bridgeUp(S, R);
  const mine = join(S.home, "assistant", "groups", LG.slice(4), "chart.png");
  put(mine);
  put(join(S.home, "assistant", "groups", LG2.slice(4), "other.png"));                        // another group's folder
  put(join(S.home, "assistant", "private.png"));                                              // the owner's own area
  put(join(S.home, "assistant", "tasks", "t1", "t.png"));
  symlinkSync(join(S.home, "assistant", "private.png"), join(S.home, "assistant", "groups", LG.slice(4), "sneaky.png"));
  put(join(S.xchg, "inbox", "dm1.jpg"));
  for (const path of [join(S.home, "assistant", "groups", LG2.slice(4), "other.png"), join(S.home, "assistant", "private.png"), "~/assistant/tasks/t1/t.png", join(S.home, "assistant", "groups", LG.slice(4), "sneaky.png"), "../../private.png", "/etc/hosts"]) {
    const r = await refused(R, LG, "wa_send_media", { path, kind: "image" });
    assert.match(r.error, /only from its own folder/, path);
  }
  assert.deepEqual(bridge.of("wa-action"), []);
  const ok = await call(S, R, bridge, LG, "wa_send_media", { path: mine, kind: "image" });
  assert.match(ok.ev.args.file, new RegExp(`^${LG}\\.[0-9a-f]{16}\\.png$`));
  assert.equal(ok.ev.lane, LG);
  const rel = await call(S, R, bridge, LG, "wa_send_media", { path: "chart.png", kind: "image" });   // relative to the group folder
  assert.equal(rel.ev.args.fileName, "chart.png");
  const inbox = await call(S, R, bridge, LG, "wa_send_media", { path: join(S.xchg, "inbox", "dm1.jpg"), kind: "image" });   // the bridge decides whether it arrived there
  assert.equal(inbox.ev.args.inbox, "dm1.jpg");
  assert.match((await refused(R, LG, "wa_send_media", { path: join(S.xchg, "inbox", "dm1.jpg"), kind: "sticker" })).error, /sticker in a group chat/);
});

test("wa_send_media sticker: the runner converts the image to a 512x512 webp with ffmpeg and stages that; a failing or missing ffmpeg is an error", async () => {
  const S = sandbox();
  const log = join(S.dir, "ffmpeg.log");
  fakeBin(S.bin, "ffmpeg", `echo "$@" >> '${log}'\nfor a in "$@"; do out="$a"; done\nprintf 'RIFF\\0\\0\\0\\0WEBPVP8 ' > "$out"`);
  const R = await startRunner(S, { env: { PATH: `${S.bin}:${process.env.PATH}` } });
  const bridge = await bridgeUp(S, R);
  put(join(S.home, "assistant", "kucing.jpg"), "JPEGDATA");
  put(join(S.xchg, "inbox", "pic.png"), "PNGDATA");
  const t = await toolOp(R, "chat", "wa_send_media", { path: "~/assistant/kucing.jpg", kind: "sticker", caption: "ignored" });
  const ev = await bridge.wait((e) => e.ev === "wa-action");
  assert.match(ev.args.file, /^chat\.[0-9a-f]{16}\.webp$/);
  assert.equal(ev.args.caption, "ignored");                                                    // the bridge drops a sticker's caption
  assert.equal(readFileSync(join(stage(S), ev.args.file), "latin1").slice(0, 4), "RIFF");
  const argv = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(argv.length, 1);
  assert.match(argv[0], /^-nostdin -v error -y -protocol_whitelist file -i \S+\.in\.jpg -vf scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:\(ow-iw\)\/2:\(oh-ih\)\/2:color=0x00000000,format=rgba -frames:v 1 -c:v libwebp -lossless 0 -q:v 70 \S+\.webp$/);
  assert.ok(!argv[0].includes("kucing"));                                                      // ffmpeg reads the capped copy, not the path the model named
  answer(bridge, ev, { ok: true });
  assert.equal((await t.reply()).ok, true);
  await waitFor(() => readdirSync(stage(S)).length === 0);                                     // the copy and the webp both go
  // an inbox image of the owner's chat can become a sticker too
  const inboxSticker = await toolOp(R, "chat", "wa_send_media", { path: join(S.xchg, "inbox", "pic.png"), kind: "sticker" });
  const ev2 = await bridge.wait((e) => e.ev === "wa-action" && e.args.file?.endsWith(".webp") && e !== ev);
  assert.match(ev2.args.file, /\.webp$/);
  answer(bridge, ev2, { ok: true });
  await inboxSticker.reply();
  // ffmpeg fails
  fakeBin(S.bin, "ffmpeg", "exit 1");
  assert.match((await refused(R, "chat", "wa_send_media", { path: "~/assistant/kucing.jpg", kind: "sticker" })).error, /could not turn that image into a sticker/);
  // ffmpeg missing: the same error, nothing staged
  const S2 = sandbox();
  const R2 = await startRunner(S2, { env: { PATH: "/nonexistent" } });
  const b2 = await bridgeUp(S2, R2);
  put(join(S2.home, "assistant", "kucing.jpg"), "JPEGDATA");
  assert.match((await refused(R2, "chat", "wa_send_media", { path: "~/assistant/kucing.jpg", kind: "sticker" })).error, /could not turn that image into a sticker/);
  assert.deepEqual(b2.of("wa-action"), []);
  assert.deepEqual(readdirSync(stage(S2)), []);
});

// ---------- the MCP server ----------
const clients = [];
after(async () => { for (const c of clients) await c.close().catch(() => {}); });
async function mcp(S, R, lane, task) {
  const token = R.runner.issueToken(lane === "chat" ? "chat" : task);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "mcp", "owner.mjs")], env: { HOME: S.home, PATH: process.env.PATH, WA_SOCK: R.sock, WA_LANE: lane, WA_LANE_TOKEN: token, ...(task ? { WA_TASK_ID: task } : {}), OWNER_MCP_LOG: join(S.dir, "owner-mcp.log") } });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  clients.push(c);
  return c;
}

test("the owner MCP lists the seven WhatsApp tools and passes their arguments to the runner; the answer's #ref comes back as text", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const bridge = await bridgeUp(S, R);
  const c = await mcp(S, R, "chat");
  const tools = (await c.listTools()).tools;
  const names = tools.map((t) => t.name).filter((n) => n.startsWith("wa_")).sort();
  assert.deepEqual(names, ["wa_delete", "wa_edit", "wa_mention", "wa_poll", "wa_react", "wa_reply", "wa_send_media"]);
  for (const t of tools.filter((x) => x.name.startsWith("wa_"))) assert.equal(t.inputSchema.additionalProperties, false); // no jid field exists to be filled in
  assert.ok(!JSON.stringify(tools.filter((x) => x.name.startsWith("wa_"))).match(/jid|chat id|recipient/i));
  const p = c.callTool({ name: "wa_reply", arguments: { ref: "#a1b2", text: "oke" } });
  const ev = await bridge.wait((e) => e.ev === "wa-action");
  assert.deepEqual([ev.lane, ev.action, ev.args.ref, ev.args.text], ["chat", "reply", "#a1b2", "oke"]);
  answer(bridge, ev, { ok: true, ref: "#9f9f" });
  const r = await p;
  assert.equal(r.isError, false);
  assert.equal(r.content[0].text, "sent #9f9f");
  const q = c.callTool({ name: "wa_poll", arguments: { question: "Q?", options: ["a", "b"], multi: true } });
  const ev2 = await bridge.wait((e) => e.ev === "wa-action" && e.action === "poll");
  assert.deepEqual([ev2.args.options, ev2.args.multi], [["a", "b"], true]);
  answer(bridge, ev2, { ok: false, error: "rate limit: at most 6 actions per minute and 30 per hour in a chat; try again in 12 s" });
  const bad = await q;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /rate limit/);                                             // the model reads the limit
  assert.equal((await c.callTool({ name: "wa_nope", arguments: {} })).isError, true);
});

test("a group lane's MCP server can call the WhatsApp tools too", async () => {
  const S = sandbox();
  const R = await startRunner(S, {});
  const bridge = await bridgeUp(S, R);
  const c = await mcp(S, R, "group", LG);
  const p = c.callTool({ name: "wa_react", arguments: { ref: "#a1b2", emoji: "🙏" } });
  const ev = await bridge.wait((e) => e.ev === "wa-action");
  assert.equal(ev.lane, LG);
  answer(bridge, ev, { ok: true });
  assert.equal((await p).content[0].text, "reaction sent");
});

// ---------- the guard: first of three checks on a media path ----------
test("guard: wa_send_media is allowed for chat, task and group lanes, and denied for a path outside ~/assistant and /xchg/inbox (a group: outside its own folder)", () => {
  const S = sandbox();
  const g = (lane, task, path, cwd) => evaluate({ tool_name: "mcp__owner__wa_send_media", tool_input: { path, kind: "image" }, cwd }, { home: S.home, xchg: S.xchg, lane, task }).verdict;
  const A = join(S.home, "assistant");
  for (const t of ["wa_react", "wa_reply", "wa_poll", "wa_mention", "wa_edit", "wa_delete"]) for (const [lane, task] of [["chat", undefined], ["task", "t1"], ["group", LG]]) assert.equal(evaluate({ tool_name: `mcp__owner__${t}`, tool_input: { ref: "#a1b2", text: "DROP TABLE x", emoji: "👍" } }, { home: S.home, xchg: S.xchg, lane, task }).verdict, null, `${t} ${lane}`);
  for (const [lane, task] of [["chat", undefined], ["task", "t1"]]) {
    assert.equal(g(lane, task, join(A, "x.png"), A), null);
    assert.equal(g(lane, task, "~/assistant/tasks/t1/x.png", A), null);
    assert.equal(g(lane, task, join(S.xchg, "inbox", "x.jpg"), A), null);
    assert.equal(g(lane, task, "x.png", join(A, "tasks", "t1")), null);
    for (const p of ["/etc/passwd", join(S.home, ".claude", "x.png"), "~/.multica/c", "../x.png", join(S.home, "assistant-evil", "x"), "/xchg/answers/a", "/xchg/inbox"]) { const v = g(lane, task, p, A); assert.equal(v?.deny, true, p); assert.equal(v.rule, "media-path"); }
  }
  const own = join(A, "groups", LG.slice(4));
  assert.equal(g("group", LG, join(own, "x.png"), own), null);
  assert.equal(g("group", LG, "x.png", own), null);
  assert.equal(g("group", LG, join(S.xchg, "inbox", "x.jpg"), own), null);                    // the bridge checks that it arrived in this group
  for (const p of [join(A, "private.png"), join(A, "groups", LG2.slice(4), "x.png"), "~/assistant/tasks/t1/x.png", "../x.png", "../../private.png", "/etc/passwd"]) assert.equal(g("group", LG, p, own)?.rule, "media-path", p);
  assert.equal(g("group", undefined, join(own, "x.png"), own)?.rule, "media-path"); // a group lane with no id fails closed
});
