// Bridge core tests (PLAN 2.2, 2.2.1, 2.3, 2.12, 5.2; S3, S4, S7, S12, S16). The Baileys socket is a fake (wa), the
// runner is either driven by hand or a real runner over a real unix socket with the fake `claude`.
// Fixtures: plain, deferred, answered, parallel, guard-deny, multi-result are trimmed real recordings (spike T2, T3, T5, T8, T12); the rest are synthetic (test/fixtures/SOURCES.json). Assumed stream-json fields: see runner.test.mjs header and
// src/stream.mjs (system/init, result.session_id, stop_reason "tool_deferred", deferred_tool_use, modelUsage,
// permission_denials, duration_ms, usage).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCore, parseAnswer, renderQuestion, splitText } from "../src/bridge.mjs";
import { openState, safeWrite } from "../src/state.mjs";
import { pushMainOrder, parseApproval } from "../src/grants.mjs";
import { parseCommand } from "../src/commands.mjs";
import { attach, send } from "../src/ipc.mjs";
import { decide } from "../hooks/ask-defer.mjs";
import { evaluate } from "../hooks/guard.mjs";
import { spawnSync } from "node:child_process";
import { ROOT, sandbox, waitFor } from "../testlib/helpers.mjs";
import { startRunner } from "../testlib/harness.mjs";

const DEFERRED = (id, lane, qs = [{ question: "Which framework?", header: "FW", options: [{ label: "React", description: "" }, { label: "Vue", description: "" }], multiSelect: false }]) =>
  ({ ev: "result", lane, sessionId: `sess-${lane}`, stopReason: "tool_deferred", deferred: { id, name: "AskUserQuestion", input: { questions: qs } } });

function fakeWa() {
  const w = { texts: [], polls: [], composing: 0, fail: false };
  w.sendText = async (text, o = {}) => { if (w.fail) throw new Error("socket not open"); w.texts.push({ text, ...o }); };
  w.sendPoll = async (name, values, o = {}) => { const id = o.id ?? `poll-${w.polls.length + 1}`; w.polls.push({ name, values, ...o, id }); return { id, raw: JSON.stringify({ key: { id }, message: { pollCreationMessage: { name }, messageContextInfo: { messageSecret: "c2VjcmV0" } } }) }; };
  w.composing = () => { w.composing.n = (w.composing.n ?? 0) + 1; };
  w.isOpen = () => true;
  return w;
}
function mk(S, { wa = fakeWa(), start = 1_800_000_000_000 } = {}) {
  const clock = { t: start };
  const sent = [];
  const state = openState(join(S.dir, "bridge", "state.json"));
  const core = createCore({ state, xchg: S.xchg, wa, toRunner: (m) => sent.push(m), now: () => clock.t });
  return { core, wa, sent, state, clock, turns: () => sent.filter((m) => m.op === "turn") };
}
const msg = (id, text, ts) => ({ id, ts, text });
const up = async (b) => { await b.core.onOpen(); await b.core.onRunnerEvent({ ev: "hello", busy: [] }); };
const T0 = 1_800_000_000; // seconds, matches the default clock
const grants = (S) => readdirSync(join(S.xchg, "grants")).map((f) => JSON.parse(readFileSync(join(S.xchg, "grants", f), "utf8")));

test("splitText, parseAnswer and renderQuestion", () => {
  assert.deepEqual(splitText("a\n\n" + "b".repeat(30), 20).length, 2);
  assert.ok(splitText("x".repeat(9000)).every((p) => p.length <= 4000));
  const q = { question: "Pilih?", options: ["React", "Vue", "Svelte"], multiSelect: false };
  assert.equal(parseAnswer(q, "2"), "Vue");
  assert.equal(parseAnswer(q, " vue "), "Vue");
  assert.equal(parseAnswer(q, "9"), "9"); // out of range is free text
  assert.equal(parseAnswer(q, "pakai Solid aja"), "pakai Solid aja");
  assert.equal(parseAnswer({ ...q, multiSelect: true }, "1, 3"), "React, Svelte");
  assert.match(renderQuestion({ cursor: 0, questions: [q, q] }), /^\(1\/2\) Pilih\?\n1\. React\n2\. Vue\n3\. Svelte\n\(jawab angka, pilih di poll/);
  assert.equal(parseCommand("/baru"), "baru");
  assert.equal(parseCommand(" /STATUS "), "status");
  assert.equal(parseCommand("/baru lagi"), null);
  assert.equal(parseCommand("/lain"), null);
});

test("post-pairing history sync is ignored, a replay and a duplicate are dropped", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b); // first open: pairedAt = now
  await b.core.onMessage(msg("old1", "chat lama dari history sync", T0 - 3600));
  await b.core.onMessage(msg("new1", "halo", T0 + 1));
  await b.core.onMessage(msg("new1", "halo", T0 + 1)); // duplicate id
  await b.core.onMessage(msg("old2", "lebih lama dari yang terakhir", T0 - 5));
  assert.deepEqual(b.turns().map((t) => t.prompt), ["halo"]);
  assert.equal(b.state.d.pairedAt, 1_800_000_000_000);
});

test("append after reconnect accepted once", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(msg("a1", "satu", T0 + 1));
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "s1", stopReason: "end_turn" });
  // pod was down, WhatsApp delivers the message that arrived meanwhile as `append` after the reconnect, twice
  await b.core.onMessage(msg("a2", "dua (waktu pod mati)", T0 + 5));
  await b.core.onMessage(msg("a2", "dua (waktu pod mati)", T0 + 5));
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "s1", stopReason: "end_turn" });
  assert.deepEqual(b.turns().map((t) => t.prompt), ["satu", "dua (waktu pod mati)"]);
});

test("merged mid-turn messages go to the chat lane's next turn as one prompt", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(msg("m1", "cek status deploy", T0 + 1));
  assert.equal(b.turns().length, 1);
  await b.core.onMessage(msg("m2", "sekalian disk", T0 + 2)); // mid-turn
  await b.core.onMessage(msg("m3", "dan memori", T0 + 3));
  assert.equal(b.turns().length, 1); // one turn per lane at a time
  await b.core.onRunnerEvent({ ev: "session", lane: "chat", sessionId: "s1" });
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "s1", stopReason: "end_turn" });
  assert.equal(b.turns().length, 2);
  assert.equal(b.turns()[1].prompt, "sekalian disk\n\ndan memori");
  assert.equal(b.turns()[1].session, "s1"); // resumed, not a new session
  assert.ok(b.wa.composing.n >= 3); // typing indicator per inbound message (S1)
});

test("outbox no-duplicate: the same reply key is sent once, also after a restart", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", key: "u-1:0", text: "jawaban" });
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", key: "u-1:0", text: "jawaban" });
  assert.equal(b.wa.texts.length, 1);
  assert.match(b.wa.texts[0].id, /^GR[0-9A-F]{30}$/);
  const b2 = mk(S, { wa: fakeWa() }); // restart: state.json reloaded
  await up(b2);
  await b2.core.onRunnerEvent({ ev: "text", lane: "chat", key: "u-1:0", text: "jawaban" });
  assert.equal(b2.wa.texts.length, 0);
  await b2.core.onRunnerEvent({ ev: "text", lane: "chat", key: "u-2:0", text: "lain" });
  assert.equal(b2.wa.texts.length, 1);
});

test("a send that fails is kept and goes out once the socket is back", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  b.wa.fail = true;
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", key: "k1", text: "tertahan" });
  assert.equal(b.wa.texts.length, 0);
  b.wa.fail = false;
  await b.core.onOpen();
  assert.deepEqual(b.wa.texts.map((t) => t.text), ["tertahan"]);
  await b.core.onOpen();
  assert.equal(b.wa.texts.length, 1);
});

test("task-lane intermediate text is not sent; the bridge never sends to a JID from an event", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent({ ev: "text", lane: "issue-1", key: "k", text: "INTERMEDIATE" });
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", key: "k2", text: "halo", jid: "62811@s.whatsapp.net", to: "attacker@s.whatsapp.net" });
  assert.deepEqual(b.wa.texts.map((t) => t.text), ["halo"]);
  assert.deepEqual(Object.keys(b.wa.texts[0]).sort(), ["id", "text"]); // sendText(text, {id}): there is no recipient argument
  assert.equal(b.wa.sendText.length <= 2, true);
});

test("defer then answer (numbered reply): poll and numbered text shown, answer file written, lane resumed", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(msg("m1", "pilih framework", T0 + 1));
  await b.core.onRunnerEvent(DEFERRED("toolu_ask1", "chat"));
  assert.match(b.wa.texts[0].text, /Which framework\?\n1\. React\n2\. Vue/);
  assert.deepEqual([b.wa.polls[0].name, b.wa.polls[0].values], ["Which framework?", ["React", "Vue"]]);
  assert.equal(b.turns().length, 1); // the lane is parked, nothing runs
  await b.core.onMessage(msg("m2", "2", T0 + 2)); // numbered reply
  const file = JSON.parse(readFileSync(join(S.xchg, "answers", "toolu_ask1.json"), "utf8"));
  assert.deepEqual(file.answers, { "Which framework?": "Vue" });
  assert.equal(file.questions[0].question, "Which framework?");
  assert.equal(b.turns().length, 2);
  assert.deepEqual([b.turns()[1].lane, b.turns()[1].prompt, b.turns()[1].session], ["chat", "", "sess-chat"]); // resume without prompt
  // the hook turns that file into allow + updatedInput
  const out = decide({ tool_name: "AskUserQuestion", tool_use_id: "toolu_ask1", tool_input: { questions: file.questions } }, S.xchg);
  assert.deepEqual([out.permissionDecision, out.updatedInput.answers], ["allow", { "Which framework?": "Vue" }]);
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "sess-chat", stopReason: "end_turn" });
  assert.ok(!existsSync(join(S.xchg, "answers", "toolu_ask1.json"))); // cleaned after the resumed turn
});

test("poll vote answers the question; a vote on a stale poll is ignored", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent(DEFERRED("toolu_a", "chat"));
  const pollId = b.wa.polls[0].id;
  await b.core.onVote({ pollId: "poll-unknown", options: ["React"] });
  assert.ok(!existsSync(join(S.xchg, "answers", "toolu_a.json")));
  await b.core.onVote({ pollId, options: ["React"] });
  assert.deepEqual(JSON.parse(readFileSync(join(S.xchg, "answers", "toolu_a.json"), "utf8")).answers, { "Which framework?": "React" });
  await b.core.onVote({ pollId, options: ["Vue"] }); // already answered: not the head any more
  assert.equal(b.turns().length, 1);
});

test("a vote that cannot be decrypted keeps the question at the head and asks for a number", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent(DEFERRED("toolu_a", "chat"));
  await b.core.onVote({ pollId: b.wa.polls[0].id, options: null });
  assert.equal(b.wa.texts.at(-1).text, "poll-nya gak kebaca, jawab pakai angka aja ya");
  assert.equal(b.state.d.queue.length, 1);
  await b.core.onMessage(msg("m9", "1", T0 + 3));
  assert.equal(b.state.d.queue.length, 0);
});

test("restart with a pending question: it is not asked again and the answer still works", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent(DEFERRED("toolu_a", "chat"));
  assert.equal(b.wa.texts.length, 1);
  const b2 = mk(S); // pod restarted: state.json reloaded, new socket, runner says hello
  await up(b2);
  assert.equal(b2.wa.texts.length, 0); // no re-ask
  assert.equal(b2.wa.polls.length, 0);
  assert.equal(b2.state.d.queue[0].id, "toolu_a");
  await b2.core.onMessage(msg("m5", "Vue", T0 + 9)); // a label as a plain reply
  assert.deepEqual(JSON.parse(readFileSync(join(S.xchg, "answers", "toolu_a.json"), "utf8")).answers, { "Which framework?": "Vue" });
  assert.deepEqual(b2.turns().at(-1).session, "sess-chat");
});

test("a turn that was in flight when the pod died is resumed once the runner says hello", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(msg("m1", "kerjain X", T0 + 1));
  await b.core.onRunnerEvent({ ev: "session", lane: "chat", sessionId: "s1" });
  const b2 = mk(S);
  await b2.core.onRunnerEvent({ ev: "hello", busy: [] });
  assert.deepEqual([b2.turns()[0].prompt, b2.turns()[0].session], ["", "s1"]); // CLAUDE_CODE_RESUME_INTERRUPTED_TURN continues it
  const b3 = mk(S);
  await b3.core.onRunnerEvent({ ev: "hello", busy: ["chat"] }); // the runner is still running it: wait for the result
  assert.equal(b3.turns().length, 0);
});

test("restart between poll send and vote: the vote decrypts from the persisted creation message", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent(DEFERRED("toolu_a", "chat"));
  const pollId = b.wa.polls[0].id;
  // the state file is the only thing that survives; wa.mjs getMessage and the vote decoder read polls from it
  const reloaded = openState(join(S.dir, "bridge", "state.json"));
  const raw = reloaded.d.polls[pollId].raw;
  assert.match(raw, /messageSecret/);
  const { createWa, decodeVote } = await import("../src/wa.mjs");
  const lib = (await import("@whiskeysockets/baileys"));
  const sockets = [];
  const fakeLib = { ...lib, useMultiFileAuthState: async () => ({ state: {}, saveCreds() {} }), fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }), makeWASocket: (cfg) => { const s = { cfg, ev: { on() {} }, user: { id: "bot:1@s.whatsapp.net" } }; sockets.push(s); return s; } };
  const wa = createWa({ lib: fakeLib, owners: new Set(["62811@s.whatsapp.net"]), ownerJid: "62811@s.whatsapp.net", authDir: S.dir, xchg: S.xchg, polls: { get: (id) => reloaded.d.polls[id]?.raw }, log() {} });
  await wa.start();
  const gm = await sockets[0].cfg.getMessage({ id: pollId });
  assert.equal(gm.pollCreationMessage.name, "Which framework?"); // served from the persisted message, not the placeholder
  assert.deepEqual(await sockets[0].cfg.getMessage({ id: "other" }), { conversation: "" });
  // the aggregate call receives that persisted creation message (the crypto itself is faked: no keys here)
  const seen = {};
  const creation = JSON.parse(raw, lib.BufferJSON.reviver);
  const votes = decodeVote({
    creation, meId: "bot@s.whatsapp.net", voterJids: ["62811@s.whatsapp.net"], creatorJids: ["bot@s.whatsapp.net"],
    pollUpdate: { pollCreationMessageKey: { id: pollId }, pollUpdateMessageKey: { id: "v1" }, vote: { encPayload: "x", encIv: "y" } },
    lib: {
      getKeyAuthor: (k, me) => me,
      decryptPollVote: (vote, o) => { seen.secret = o.pollEncKey; return { selectedOptions: ["h"] }; },
      getAggregateVotesInPollMessage: ({ message }) => { seen.message = message; return [{ name: "React", voters: ["62811"] }, { name: "Vue", voters: [] }]; },
    },
  });
  assert.deepEqual(votes, ["React"]);
  assert.ok(seen.secret && seen.message.pollCreationMessage); // secret and creation message came from state.json
  // and the decoded vote answers the question on the restarted core
  const b2 = mk(S);
  await up(b2);
  await b2.core.onVote({ pollId, options: votes });
  assert.deepEqual(JSON.parse(readFileSync(join(S.xchg, "answers", "toolu_a.json"), "utf8")).answers, { "Which framework?": "React" });
});

test("the question queue shows one question at a time across lanes (FIFO)", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent({ ev: "task-started", task: "i1", prompt: "[task] i1" });
  await b.core.onRunnerEvent({ ev: "task-started", task: "i2", prompt: "[task] i2" });
  await b.core.onRunnerEvent(DEFERRED("q-i1", "i1", [{ question: "Dari i1?", header: "a", options: [{ label: "ya" }, { label: "tidak" }] }]));
  await b.core.onRunnerEvent(DEFERRED("q-i2", "i2", [{ question: "Dari i2?", header: "b", options: [{ label: "x" }, { label: "y" }] }]));
  await b.core.onRunnerEvent(DEFERRED("q-chat", "chat", [{ question: "Dari chat?", header: "c", options: [{ label: "p" }, { label: "q" }] }]));
  const shown = () => b.wa.texts.map((t) => t.text.split("\n")[0]);
  assert.deepEqual(shown(), ["Dari i1?"]);
  assert.equal(b.state.d.queue.length, 3);
  await b.core.onMessage(msg("r1", "1", T0 + 2)); // answers the head (i1), then i2 is shown
  assert.deepEqual(shown(), ["Dari i1?", "Dari i2?"]);
  assert.deepEqual(JSON.parse(readFileSync(join(S.xchg, "answers", "q-i1.json"), "utf8")).answers, { "Dari i1?": "ya" });
  assert.ok(!existsSync(join(S.xchg, "answers", "q-i2.json")));
  const resumed = b.turns().filter((t) => t.prompt === "");
  assert.deepEqual(resumed.map((t) => t.lane), ["i1"]); // only the lane that asked resumes
  await b.core.onMessage(msg("r2", "2", T0 + 3));
  await b.core.onMessage(msg("r3", "q", T0 + 4));
  assert.deepEqual(shown(), ["Dari i1?", "Dari i2?", "Dari chat?"]);
  assert.equal(b.state.d.queue.length, 0);
});

test("reply routing order: done <kode> to the lane that sent the code, then the head question, then the chat lane", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent({ ev: "task-started", task: "i1", prompt: "[task] i1" });
  await b.core.onRunnerEvent({ ev: "result", lane: "i1", sessionId: "sess-i1", stopReason: "end_turn" });
  await b.core.onRunnerEvent({ ev: "notify", lane: "i1", kind: "critical", code: "k7q-4821", nid: "n1", text: "Jalankan: psql -c 'DROP TABLE x'. Balas done k7q-4821" });
  assert.match(b.wa.texts.at(-1).text, /k7q-4821/);
  await b.core.onRunnerEvent(DEFERRED("q-chat", "chat"));
  // (1) the code wins over the head question
  await b.core.onMessage(msg("r1", "done k7q-4821", T0 + 2));
  assert.deepEqual([b.turns().at(-1).lane, b.turns().at(-1).prompt], ["i1", "done k7q-4821"]);
  assert.equal(b.state.d.queue.length, 1); // the question is still pending
  // an unknown code is not a code: it answers the head question as free text
  await b.core.onMessage(msg("r2", "done zzz-9999", T0 + 3));
  assert.deepEqual(JSON.parse(readFileSync(join(S.xchg, "answers", "q-chat.json"), "utf8")).answers, { "Which framework?": "done zzz-9999" });
  // (3) nothing pending: the chat lane
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "sess-chat", stopReason: "end_turn" });
  await b.core.onMessage(msg("r3", "lanjut", T0 + 4));
  assert.deepEqual([b.turns().at(-1).lane, b.turns().at(-1).prompt], ["chat", "lanjut"]);
});

test("every question is answered before chat resumes: while a question is pending, free text is its answer (PLAN 2.2 step 3 consequence)", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent({ ev: "task-started", task: "i9", prompt: "[task] i9" });
  await b.core.onRunnerEvent(DEFERRED("q1", "i9"));
  await b.core.onMessage(msg("c1", "eh sekalian bikinin PR", T0 + 2));
  assert.equal(b.turns().filter((t) => t.lane === "chat").length, 0);
  assert.equal(b.state.d.queue.length, 0);
});

test("grants: merge from his own ok, never from another reply; push-main from the starting order; approval from done/deny <kode>", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  const url = "https://github.com/o/r/pull/7";
  const ask = (id, text) => DEFERRED(id, "chat", [{ question: text, header: "Merge", options: [{ label: "ok" }, { label: "revisi" }] }]);
  await b.core.onRunnerEvent(ask("q-m1", `Merge PR ${url}?`));
  await b.core.onMessage(msg("g1", "revisi: ganti nama fungsi", T0 + 2));
  assert.deepEqual(grants(S), []); // anything else is a revision request
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "sess-chat", stopReason: "end_turn" });
  await b.core.onRunnerEvent(ask("q-m2", `Merge PR ${url}?`));
  await b.core.onMessage(msg("g2", "ok", T0 + 3));
  const [g] = grants(S);
  assert.deepEqual([g.kind, g.url, g.tool_use_id], ["merge", url, "q-m2"]);
  // "ok" to a question without a PR URL writes nothing
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "sess-chat", stopReason: "end_turn" });
  await b.core.onRunnerEvent(ask("q-m3", "Lanjut deploy ke staging?"));
  await b.core.onMessage(msg("g3", "ok", T0 + 4));
  assert.equal(grants(S).length, 1);
  // the guard honours it (S12)
  const ctx = { home: S.home, xchg: S.xchg, lane: "chat", task: "i1", now: b.clock.t };
  const merge = () => evaluate({ tool_name: "Bash", tool_input: { command: `gh pr merge ${url} --squash` } }, ctx).verdict;
  assert.ok(merge().grants.length);
  // push-main: the raw text that started the task
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "sess-chat", stopReason: "end_turn" });
  await b.core.onMessage(msg("g4", "bikin fix typo lalu push langsung ke main ya", T0 + 5));
  await b.core.onRunnerEvent({ ev: "task-started", task: "i1", origin: ["g4"], prompt: "[task] i1" });
  const pm = grants(S).find((x) => x.kind === "push-main");
  assert.deepEqual([pm.task_id, pm.branch], ["i1", "main"]);
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "sess-chat", stopReason: "end_turn" });
  await b.core.onMessage(msg("g5", "bikin fitur Y, jangan push ke main", T0 + 6));
  await b.core.onRunnerEvent({ ev: "task-started", task: "i2", origin: ["g5"], prompt: "[task] i2" });
  assert.equal(grants(S).filter((x) => x.kind === "push-main").length, 1); // no grant for i2
  // approval: only for a code the bridge recorded
  await b.core.onRunnerEvent({ ev: "notify", lane: "i1", kind: "critical", code: "k7q-4821", nid: "n9", text: "x" });
  await b.core.onMessage(msg("g6", "deny k7q-4821", T0 + 7));
  assert.equal(grants(S).filter((x) => x.kind === "approval").length, 1);
  assert.equal(grants(S).find((x) => x.kind === "approval").code, "k7q-4821");
});
test("pushMainOrder and parseApproval", () => {
  for (const t of ["push langsung ke main", "tolong push ke dev ya", "commit then push to master", "langsung aja ke main", "straight to main"]) assert.ok(pushMainOrder(t), t);
  for (const t of ["jangan push ke main", "don't push to main", "buka PR ke main", "push ke fitur-x", "tanpa push langsung ke main"]) assert.equal(pushMainOrder(t), null, t);
  assert.deepEqual(parseApproval(" Done K7Q-4821 "), { verb: "done", code: "k7q-4821" });
  assert.equal(parseApproval("done with it"), null);
  assert.equal(parseApproval("done k7q-4821 please"), null);
});

test("a grant is single use: grant-used deletes the file and the guard denies afterwards; 24 h expiry sweeps", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  const url = "https://github.com/o/r/pull/12";
  await b.core.onRunnerEvent(DEFERRED("q-s1", "chat", [{ question: `Merge ${url}?`, header: "m", options: [{ label: "ok" }, { label: "revisi" }] }]));
  await b.core.onMessage(msg("s1", "merge", T0 + 2));
  const [g] = grants(S);
  const ctx = { home: S.home, xchg: S.xchg, lane: "chat", task: "t", now: b.clock.t };
  const merge = () => evaluate({ tool_name: "Bash", tool_input: { command: `gh pr merge ${url}` } }, ctx).verdict;
  assert.deepEqual(merge().grants, [g.id]);
  await b.core.onRunnerEvent({ ev: "grant-used", grant: g.id, toolUseId: "toolu_merge", lane: "chat" });
  assert.deepEqual(readdirSync(join(S.xchg, "grants")), []);
  assert.equal(merge().deny, true);
  assert.equal(b.state.d.grantsUsed[g.id].toolUseId, "toolu_merge");
  await b.core.onRunnerEvent({ ev: "grant-used", grant: "../../etc/passwd" }); // path traversal in an id does nothing
  // expiry: an unused grant older than 24 h is swept
  writeFileSync(join(S.xchg, "grants", "old.json"), JSON.stringify({ id: "old", kind: "merge", url, created_at: b.clock.t - 25 * 3600 * 1000 }));
  writeFileSync(join(S.xchg, "grants", "fresh.json"), JSON.stringify({ id: "fresh", kind: "merge", url, created_at: b.clock.t - 3600 * 1000 }));
  b.core.sweep();
  assert.deepEqual(readdirSync(join(S.xchg, "grants")), ["fresh.json"]);
});

test("commands: /baru starts a new chat session, /stop clears queues, /status and /memori reply", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(msg("c1", "halo", T0 + 1));
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "s1", stopReason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
  assert.equal(b.state.d.sessions.chat, "s1");
  await b.core.onMessage(msg("c2", "/status", T0 + 2));
  assert.match(b.wa.texts.at(-1).text, /chat: diam[\s\S]*hari ini: 1 turn, in 10, out 5/);
  await b.core.onMessage(msg("c3", "/memori", T0 + 3));
  const memo = b.sent.find((m) => m.op === "memori");
  await b.core.onRunnerEvent({ ev: "memori", id: memo.id, text: "- deploy window 22.00" });
  assert.equal(b.wa.texts.at(-1).text, "- deploy window 22.00");
  await b.core.onMessage(msg("c4", "/baru", T0 + 4));
  assert.equal(b.state.d.sessions.chat, undefined);
  assert.ok(b.sent.some((m) => m.op === "wiki_capture")); // phase 6 seam
  await b.core.onMessage(msg("c5", "halo lagi", T0 + 5));
  assert.equal(b.turns().at(-1).session, null); // new session, no --resume
  await b.core.onMessage(msg("c6", "/stop", T0 + 6));
  assert.ok(b.sent.some((m) => m.op === "stop"));
  // a command is not an answer to a pending question
  await b.core.onRunnerEvent(DEFERRED("q-x", "chat"));
  await b.core.onMessage(msg("c7", "/status", T0 + 7));
  assert.equal(b.state.d.queue.length, 1);
});

test("a task-lane error is reported once; a done lane is forgotten after its last result", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent({ ev: "task-started", task: "i1", prompt: "[task] i1" });
  await b.core.onRunnerEvent({ ev: "result", lane: "i1", error: "claude exited 1: boom" });
  assert.match(b.wa.texts.at(-1).text, /task i1 error: claude exited 1: boom/);
  await b.core.onRunnerEvent({ ev: "notify", lane: "i1", kind: "done", nid: "d1", text: "Udah beres Lord Faisal." });
  assert.equal(b.wa.texts.at(-1).text, "Udah beres Lord Faisal.");
  await b.core.onRunnerEvent({ ev: "result", lane: "i1", sessionId: "s", stopReason: "end_turn" });
  assert.equal(b.state.d.lanes.i1, undefined);
});

test("Dunan events become a turn on the owning lane once and are acked", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent({ ev: "task-started", task: "i1", prompt: "[task] i1" });
  await b.core.onRunnerEvent({ ev: "result", lane: "i1", sessionId: "s", stopReason: "end_turn" });
  const ev = { ev: "dunan", file: "c1-x.json", task: "i1", prompt: "[dunan] update\n<<<DATA\nx\nDATA>>>" };
  await b.core.onRunnerEvent(ev);
  await b.core.onRunnerEvent(ev); // redelivered because the ack was lost
  assert.equal(b.turns().filter((t) => t.prompt.startsWith("[dunan]")).length, 1);
  assert.equal(b.sent.filter((m) => m.op === "ack").length, 2); // acked both times so the runner can drop the file
});

test("safeWrite never follows a planted symlink: the target is replaced, creds.json stays untouched", () => {
  const S = sandbox();
  const creds = join(S.dir, "creds.json");
  writeFileSync(creds, "SESSION");
  const target = join(S.xchg, "inbox", "photo.jpg");
  symlinkSync(creds, target);
  safeWrite(target, "image bytes");
  assert.equal(readFileSync(creds, "utf8"), "SESSION");
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  assert.equal(readFileSync(target, "utf8"), "image bytes");
  // a symlink planted at a temp name cannot be used either (O_EXCL | O_NOFOLLOW)
  assert.equal(readdirSync(join(S.xchg, "inbox")).filter((f) => f.endsWith(".tmp")).length, 0);
});

// ---- end to end: core <-> real runner socket <-> fake claude ----
test("end to end: message -> turn -> deferred -> poll -> numbered reply -> hook allow -> resumed turn -> reply text", async () => {
  const S = sandbox();
  const R = await startRunner(S, { script: ["deferred", "answered"] });
  const b = mk(S);
  const s = net.connect(R.sock);
  let hello = false;
  attach(s, (m) => b.core.onRunnerEvent(m).then(() => { if (m.ev === "hello") hello = true; }, (e) => assert.fail(e)));
  b.sent.push = (m) => (send(s, m), 1);
  await new Promise((r) => s.on("connect", r));
  send(s, { op: "hello", role: "bridge" });
  await b.core.onOpen();
  await waitFor(() => hello); // turns start only after the runner's hello, as in bridge.mjs main()
  await b.core.onMessage(msg("e1", "pilih framework", T0 + 1));
  await waitFor(() => b.state.d.queue.length === 1);
  assert.equal(b.wa.polls.length, 1);
  await b.core.onMessage(msg("e2", "1", T0 + 2));
  await waitFor(() => b.wa.texts.some((t) => t.text === "You chose **blue**."));
  const calls = R.calls();
  assert.deepEqual(calls[1].argv.slice(0, 3), ["-p", "--resume", "sess-1"]);
  assert.equal(b.state.d.sessions.chat, "sess-1");
  s.destroy();
});

test("bridge.mjs refuses to start without WA_OWNER_JID (no socket, no network)", () => {
  const S = sandbox();
  const r = spawnSync(process.execPath, [join(ROOT, "src", "bridge.mjs")], { env: { HOME: S.home, PATH: process.env.PATH, WA_BRIDGE_DIR: join(S.dir, "bridge"), WA_XCHG_DIR: S.xchg }, encoding: "utf8", timeout: 10000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /WA_OWNER_JID is required/);
});

test("a task that waited for a lane (no origin) gets no push-main grant from an unrelated message", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(msg("p1", "tolong push langsung ke main untuk hal lain", T0 + 1)); // chat turn in flight
  await b.core.onRunnerEvent({ ev: "task-started", task: "i3", origin: null, prompt: "[task] i3" }); // started from the waiting list
  assert.deepEqual(grants(S), []);
  await b.core.onRunnerEvent({ ev: "task-started", task: "i4", origin: ["other-message"], prompt: "[task] i4" });
  assert.deepEqual(grants(S), []);
  await b.core.onRunnerEvent({ ev: "task-started", task: "i5", origin: ["p1"], prompt: "[task] i5" });
  assert.deepEqual(grants(S).map((g) => [g.kind, g.task_id, g.branch]), [["push-main", "i5", "main"]]);
});

test("end to end grant chain: the guard's pass-grant line makes the runner report, the bridge deletes the grant file", async () => {
  const S = sandbox();
  const R = await startRunner(S, { script: ["granted-merge"] });
  writeFileSync(join(R.ctl, "guard-lines.jsonl"), JSON.stringify({ decision: "pass-grant", rule: "merge-grant", grant_ids: ["g-e2e"], tool_use_id: "toolu_merge", lane: "chat" }) + "\n");
  writeFileSync(join(S.xchg, "grants", "g-e2e.json"), JSON.stringify({ id: "g-e2e", kind: "merge", url: "https://github.com/o/r/pull/7", created_at: Date.now() }));
  const b = mk(S, { start: Date.now() });
  const s = net.connect(R.sock);
  let hello = false;
  attach(s, (m) => b.core.onRunnerEvent(m).then(() => { if (m.ev === "hello") hello = true; }, (e) => assert.fail(e)));
  b.sent.push = (m) => (send(s, m), 1);
  await new Promise((r) => s.on("connect", r));
  send(s, { op: "hello", role: "bridge" });
  await waitFor(() => hello);
  await b.core.onMessage(msg("c1", "merge PR-nya", Math.floor(Date.now() / 1000) + 1));
  await waitFor(() => !existsSync(join(S.xchg, "grants", "g-e2e.json")));
  assert.equal(b.state.d.grantsUsed["g-e2e"].toolUseId, "toolu_merge");
  s.destroy();
});
