// Review fixes for the human-like WhatsApp actions (PLAN 2.14): control messages the model cannot edit or delete (B1), the staged-file
// directory check (M1), votes only from the poll's own chat (M2), unpredictable refs (M4), the per-chat persisted rate limit (M5) and
// the caps on kept polls (M6). Each test fails on the code before the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCore } from "../src/bridge.mjs";
import { XPOLLS_OTHERS_MAX, openState } from "../src/state.mjs";
import { readCapped, readStaged } from "../src/wa-actions.mjs";
import { messageId } from "../src/wa.mjs";
import { sandbox } from "../testlib/helpers.mjs";

const FAM = "120363@g.us", OTHER = "120999@g.us", LF = "grp_120363";
const T0 = 1_800_000_000;
const MEMBER = "628222@s.whatsapp.net", OWNER = "628111@s.whatsapp.net";

function fakeWa() {
  const w = { texts: [], groupTexts: [], calls: [], open: true };
  w.sendText = async (text, o = {}) => { w.texts.push({ text, ...o }); };
  w.sendGroup = async (jid, text, o = {}) => { w.groupTexts.push({ jid, text, ...o }); };
  w.sendPoll = async (name, values, o = {}) => { w.calls.push({ m: "sendPoll", name, values, o }); return { id: o.id, raw: w.pollRaw ?? JSON.stringify({ key: { id: o.id, fromMe: true } }) }; };
  for (const m of ["reactAny", "reply", "sendMention", "sendMedia", "edit", "remove"]) w[m] = async (...args) => { w.calls.push({ m, args }); };
  w.react = async () => {};
  w.composing = () => {};
  w.isOpen = () => w.open;
  return w;
}
function mk(S, { groups = new Set([FAM]), path = join(S.dir, "bridge", "state.json"), clock = { t: 1_800_000_000_000 } } = {}) {
  const wa = fakeWa(), sent = [];
  const state = openState(path);
  const core = createCore({ state, xchg: S.xchg, wa, groups, toRunner: (m) => sent.push(m), now: () => clock.t, reactMs: 0, setTimer: () => ({}), clearTimer: () => {} });
  return { core, wa, sent, state, clock, path, results: () => sent.filter((m) => m.op === "wa-result") };
}
const up = async (b) => { await b.core.onOpen(); await b.core.onRunnerEvent({ ev: "hello", busy: [] }); };
const dm = (id, text, extra = {}) => ({ id, ts: T0 + 1, text, key: { id, remoteJid: OWNER, fromMe: false }, ...extra });
const gmsg = (id, text, { jid = FAM, ts = T0 + 1, ...extra } = {}) => ({ id, ts, text, ...extra, group: { jid, name: "Budi", fromOwner: false, family: jid === FAM, jids: [MEMBER], quote: { key: { id, remoteJid: jid, participant: MEMBER }, message: { conversation: text } } } });
let seq = 0;
async function act(b, lane, action, args = {}, { gap = 11_000 } = {}) {
  b.clock.t += gap;
  const rid = `h${++seq}`, before = b.results().length;
  await b.core.onRunnerEvent({ ev: "wa-action", rid, lane, action, args });
  const r = b.results().slice(before).find((x) => x.rid === rid);
  assert.ok(r, "the bridge answered");
  return r;
}
const items = (b, lane = "chat") => b.state.d.refs[lane].items;
const QS = (q) => [{ question: q, header: "m", multiSelect: false, options: [{ label: "ok" }, { label: "no" }] }];
const defer = (lane, id, q) => ({ ev: "result", lane, sessionId: `s-${lane}`, stopReason: "tool_deferred", deferred: { name: "AskUserQuestion", id, input: { questions: QS(q) } } });

// ---------- B1 ----------
test("B1: the chat lane cannot edit or delete the merge question a task lane asked, so the owner's ok grants the PR he saw", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent({ ev: "task-started", task: "t1", prompt: "x", origin: [] });
  const TU = "toolu_01ABCDEF";
  await b.core.onRunnerEvent(defer("t1", TU, "Merge https://github.com/o/r/pull/66 ?"));
  const asked = b.wa.texts.at(-1).text;
  assert.match(asked, /pull\/66/);
  const q = items(b).find((i) => i.id === messageId(`q:${TU}:0`, 0));
  assert.ok(q, "the question is a record (so a reply to it can be quoted)");
  assert.deepEqual([q.mine, q.kind], [true, "system"]);
  const ref = `#${q.ref}`;
  const e = await act(b, "chat", "edit", { ref, text: "Merge https://github.com/o/r/pull/65 ? (docs typo)\n1. ok\n2. no" });
  assert.equal(e.ok, false);
  assert.match(e.error, /message of the bridge/);
  const d = await act(b, "chat", "delete", { ref });
  assert.equal(d.ok, false);
  assert.match(d.error, /message of the bridge/);
  assert.deepEqual(b.wa.calls.filter((c) => c.m === "edit" || c.m === "remove"), []);
  // a tampered record that says "text" is still refused: the id belongs to a question that is waiting for an answer
  q.kind = "text";
  assert.match((await act(b, "chat", "edit", { ref, text: "x" })).error, /message of the bridge/);
  assert.match((await act(b, "chat", "delete", { ref })).error, /message of the bridge/);
  // the owner answers ok: the grant is for the PR in the question he read
  await b.core.onMessage(dm("OWN1", "ok", { ts: T0 + 100 }));
  const grants = readdirSync(join(S.xchg, "grants")).map((f) => JSON.parse(readFileSync(join(S.xchg, "grants", f), "utf8")));
  assert.deepEqual(grants.map((g) => g.url), ["https://github.com/o/r/pull/66"]);
  // after the answer the grant still pins the question's message
  assert.match((await act(b, "chat", "delete", { ref })).error, /message of the bridge/);
});

test("B1: every message the bridge writes itself is system (notify, error, command reply); only the turn's own text and its actions are editable", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(dm("d1", "halo"));
  await b.core.onRunnerEvent({ ev: "notify", lane: "chat", kind: "done", nid: "n1", text: "Selesai." });
  await b.core.onRunnerEvent({ ev: "notice", text: "perhatian" });
  await b.core.onRunnerEvent({ ev: "result", lane: "chat", sessionId: "s", error: "boom" });
  await b.core.onMessage(dm("d2", "/status", { ts: T0 + 3 }));
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", key: "k1", text: "jawabanku" });
  const sys = items(b).filter((i) => i.mine && i.kind === "system");
  assert.ok(sys.length >= 4, `system records: ${sys.length}`);
  for (const it of sys) {
    assert.match((await act(b, "chat", "edit", { ref: it.ref, text: "x" })).error, /message of the bridge/, it.text);
    assert.match((await act(b, "chat", "delete", { ref: it.ref })).error, /message of the bridge/, it.text);
  }
  const mine = items(b).find((i) => i.id === messageId("t:k1", 0));
  assert.equal(mine.kind, "text");
  assert.equal((await act(b, "chat", "edit", { ref: mine.ref, text: "jawabanku v2" })).ok, true);
  const reply = await act(b, "chat", "reply", { ref: `#${items(b).find((i) => i.id === "d1").ref}`, text: "oke" });
  assert.equal((await act(b, "chat", "delete", { ref: reply.ref })).ok, true);
  assert.deepEqual(b.wa.calls.filter((c) => c.m === "edit" || c.m === "remove").map((c) => c.m), ["edit", "remove"]);
});

test("B1: a group lane's own bridge messages (/baru reply, group question) are system too", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(gmsg("g1", "gremio halo"));
  await b.core.onRunnerEvent(defer(LF, "toolu_GRP1", "Lanjut?"));
  await b.core.onMessage(gmsg("g2", "gremio /baru", { ts: T0 + 3 }));
  const sys = items(b, LF).filter((i) => i.mine);
  assert.ok(sys.length >= 1);
  for (const it of sys) {
    assert.equal(it.kind, "system");
    assert.match((await act(b, LF, "edit", { ref: it.ref, text: "x" })).error, /message of the bridge/);
    assert.match((await act(b, LF, "delete", { ref: it.ref })).error, /message of the bridge/);
  }
});

test("B1: records written before the fix (own messages, kind text, no ref key yet) become system on the first start; a turn's text stays editable", async () => {
  const S = sandbox();
  const path = join(S.dir, "bridge", "state.json");
  const old = openState(path);
  old.d.refKey = null;
  old.d.outbox["t:k1"] = 1;
  old.d.refs.chat = { items: [
    { ref: "aaaa", id: messageId("q:toolu_1:0", 0), chat: null, mine: true, kind: "text", text: "Merge?", ts: 1_800_000_000_000 },
    { ref: "bbbb", id: messageId("t:k1", 0), chat: null, mine: true, kind: "text", text: "jawaban", ts: 1_800_000_000_000 },
    { ref: "cccc", id: "d1", chat: OWNER, mine: false, kind: "text", text: "halo", ts: 1_800_000_000_000 },
  ], people: {} };
  old.save();
  const b = mk(S, { path });
  await up(b);
  assert.deepEqual(items(b).map((i) => [i.ref, i.kind]), [["aaaa", "system"], ["bbbb", "text"], ["cccc", "text"]]);
  assert.match((await act(b, "chat", "edit", { ref: "#aaaa", text: "x" })).error, /message of the bridge/);
  assert.equal((await act(b, "chat", "edit", { ref: "#bbbb", text: "x" })).ok, true);
  assert.match(b.state.d.refKey, /^[0-9a-f]{64}$/);
});

// ---------- M1 ----------
const STAGED = "chat.0123456789abcdef.png";
test("M1: an outbox that is a symlink to another directory is not followed", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  const secret = join(S.dir, "bridgeonly");
  mkdirSync(secret);
  writeFileSync(join(secret, STAGED), "CREDS");
  symlinkSync(secret, join(S.xchg, "sock", "outbox"));
  const r = await act(b, "chat", "media", { kind: "image", file: STAGED });
  assert.equal(r.ok, false);
  assert.match(r.error, /staging directory/);
  assert.deepEqual(b.wa.calls.filter((c) => c.m === "sendMedia"), []);
});

test("M1: a hard link in the outbox (nlink 2) and a file of another uid are refused; a normal staged file passes", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  const out = join(S.xchg, "sock", "outbox");
  mkdirSync(out);
  writeFileSync(join(S.dir, "creds.json"), "CREDS");
  linkSync(join(S.dir, "creds.json"), join(out, "chat.1111111111111111.json"));
  const r = await act(b, "chat", "media", { kind: "document", file: "chat.1111111111111111.json" });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a file the runner staged/);
  writeFileSync(join(out, STAGED), "PNG");
  assert.equal((await act(b, "chat", "media", { kind: "image", file: STAGED })).ok, true);
  assert.equal(b.wa.calls.filter((c) => c.m === "sendMedia").length, 1);
  // a file whose uid is not the staging directory's: the check compares fstat.uid (here with a wrong expected uid, since a test cannot chown)
  assert.throws(() => readCapped(join(out, STAGED), 1024, { uid: process.getuid() + 1 }), /not a file the runner staged/);
  assert.equal(readCapped(join(out, STAGED), 1024, { uid: process.getuid() }).toString(), "PNG");
  assert.equal(readStaged(out, STAGED, 1024).toString(), "PNG");
});

// ---------- M2 ----------
test("M2: a vote counts only from the poll's own chat: a group poll from another group or a DM, an owner-DM poll from a group", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(gmsg("g1", "gremio bikin poll"));
  await b.core.onRunnerEvent({ ev: "result", lane: LF, sessionId: "s", stopReason: "end_turn" });
  await act(b, LF, "poll", { question: "Makan?", options: ["nasi", "mie"] });
  const gid = b.wa.calls.find((c) => c.m === "sendPoll").o.id;
  await b.core.onVote({ pollId: gid, options: ["nasi"], voter: MEMBER, owner: false, chat: OTHER });
  await b.core.onVote({ pollId: gid, options: ["nasi"], voter: "owner", owner: true, chat: null });
  await b.core.onVote({ pollId: gid, options: ["nasi"], voter: MEMBER, owner: false });
  assert.deepEqual(Object.keys(b.state.d.xpolls[gid].votes), []);
  await b.core.onVote({ pollId: gid, options: ["nasi"], voter: MEMBER, owner: false, chat: FAM });
  assert.deepEqual(Object.keys(b.state.d.xpolls[gid].votes), [MEMBER]);
  // the owner's own chat poll
  await act(b, "chat", "poll", { question: "Pilih?", options: ["a", "b"] });
  const did = b.wa.calls.filter((c) => c.m === "sendPoll").at(-1).o.id;
  await b.core.onVote({ pollId: did, options: ["a"], voter: "owner", owner: true, chat: FAM });
  await b.core.onVote({ pollId: did, options: ["a"], voter: MEMBER, owner: false, chat: null });
  assert.deepEqual(Object.keys(b.state.d.xpolls[did].votes), []);
  await b.core.onVote({ pollId: did, options: ["a"], voter: "owner", owner: true, chat: null });
  assert.deepEqual(Object.keys(b.state.d.xpolls[did].votes), ["owner"]);
});

test("M2: a vote on the owner's question poll counts only from his DM", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onRunnerEvent(defer("chat", "toolu_Q1", "Lanjut?"));
  const pid = b.wa.calls.find((c) => c.m === "sendPoll").o.id;
  await b.core.onVote({ pollId: pid, options: ["ok"], voter: "owner", owner: true, chat: FAM });
  await b.core.onVote({ pollId: pid, options: ["ok"], voter: MEMBER, owner: false, chat: null });
  assert.equal(b.state.d.queue.length, 1);
  await b.core.onVote({ pollId: pid, options: ["ok"], voter: "owner", owner: true, chat: null });
  assert.equal(b.state.d.queue.length, 0);
});

// ---------- M4 ----------
test("M4: refs come from a random per-bridge key kept in state: not the sha1 of lane:id, different per bridge, stable across a restart", async () => {
  const S = sandbox(), S2 = sandbox();
  const b = mk(S), b2 = mk(S2);
  await up(b); await up(b2);
  const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
  for (const id of ids) { await b.core.onMessage(dm(id, `t${id}`, { ts: T0 + 2 })); await b2.core.onMessage(dm(id, `t${id}`, { ts: T0 + 2 })); }
  const refs = (x) => ids.map((id) => items(x).find((i) => i.id === id).ref);
  const sha = ids.map((id) => createHash("sha1").update(`chat:${id}`).digest("hex").slice(0, 4));
  assert.ok(refs(b).filter((r, i) => r === sha[i]).length < 5, "not the old predictable ref");
  assert.notDeepEqual(refs(b), refs(b2));
  assert.match(b.state.d.refKey, /^[0-9a-f]{64}$/);
  assert.notEqual(b.state.d.refKey, b2.state.d.refKey);
  const again = mk(S, { path: b.path });
  assert.equal(again.state.d.refKey, b.state.d.refKey);
  assert.deepEqual(refs(again), refs(b));
});

// ---------- M5 ----------
test("M5: the limit is per destination chat (the owner's lanes share it), a refused action costs no slot, and it survives a restart", async () => {
  const S = sandbox();
  const clock = { t: 1_800_000_000_000 };
  const b = mk(S, { clock });
  await up(b);
  await b.core.onRunnerEvent({ ev: "task-started", task: "t-1", prompt: "x", origin: null });
  await b.core.onMessage(gmsg("g1", "gremio halo"));
  const poll = (lane, n = 1) => act(b, lane, "poll", { question: `Q${n}`, options: ["a", "b"] }, { gap: 0 });
  for (let i = 0; i < 3; i++) assert.equal((await poll("chat", i)).ok, true);
  for (let i = 0; i < 2; i++) assert.equal((await poll("t-1", i)).ok, true);      // another lane of the same chat: same bucket
  // refusals before the action is accepted take no slot
  for (let i = 0; i < 12; i++) {
    assert.equal((await act(b, "chat", "react", { ref: "#dead", emoji: "👍" }, { gap: 0 })).ok, false);
    assert.equal((await act(b, "chat", "poll", { question: "", options: ["a"] }, { gap: 0 })).ok, false);
    assert.equal((await act(b, "chat", "media", { kind: "image", file: "nope" }, { gap: 0 })).ok, false);
  }
  assert.equal((await poll("t-1", 9)).ok, true);                                   // the 6th accepted one
  const over = await poll("chat", 10);
  assert.match(over.error, /rate limit/);
  assert.match((await poll("t-1", 11)).error, /rate limit/);                       // the task lane shares the owner's chat
  assert.equal((await act(b, LF, "poll", { question: "G", options: ["a", "b"] }, { gap: 0 })).ok, true); // the group is another chat
  // a restart on the same state file does not reset it
  const b2 = mk(S, { path: b.path, clock });
  await up(b2);
  assert.match((await act(b2, "chat", "poll", { question: "again", options: ["a", "b"] }, { gap: 0 })).error, /rate limit/);
  clock.t += 61_000;
  assert.equal((await act(b2, "chat", "poll", { question: "later", options: ["a", "b"] }, { gap: 0 })).ok, true);
});

// ---------- M6 ----------
test("M6: a poll of someone else is kept only with a creation message of at most 16 KB and options of at most 100 characters", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(gmsg("g0", "gremio halo"));
  await b.core.onRunnerEvent({ ev: "result", lane: LF, sessionId: "s", stopReason: "end_turn" });
  const seen = (id, poll, raw) => b.core.onSeen({ id, ts: T0 + 2, text: "", poll, pollRaw: raw, group: { jid: FAM, name: "Budi", fromOwner: false, family: true, jids: [MEMBER], quote: { key: { id, remoteJid: FAM, participant: MEMBER }, message: { conversation: "" } } } });
  const ok = { question: "Q", options: ["a", "b"], multi: false };
  await seen("big", ok, "x".repeat(16 * 1024 + 1));
  await seen("longopt", { ...ok, options: ["a", "b".repeat(101)] }, "{}");
  assert.deepEqual(Object.keys(b.state.d.xpolls), []);
  await seen("fine", { ...ok, options: ["a", "b".repeat(100)] }, "x".repeat(16 * 1024));
  assert.deepEqual(Object.keys(b.state.d.xpolls), ["fine"]);
  // the same limits for an addressed poll in the owner's DM
  await b.core.onMessage({ ...dm("dp1", ""), poll: ok, pollRaw: "x".repeat(20000) });
  assert.equal(b.state.d.xpolls.dp1, undefined);
});

test("M6: a flood of polls in a group cannot push out a poll Gremio made; others' polls are capped apart; an oversized own creation message is not kept", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(gmsg("g0", "gremio halo"));
  await b.core.onRunnerEvent({ ev: "result", lane: LF, sessionId: "s", stopReason: "end_turn" });
  await act(b, LF, "poll", { question: "Punyaku", options: ["a", "b"] });
  const own = b.wa.calls.find((c) => c.m === "sendPoll").o.id;
  for (let i = 0; i < XPOLLS_OTHERS_MAX + 40; i++) {
    b.clock.t += 1000;
    await b.core.onSeen({ id: `P${i}`, ts: T0 + 2, text: "", poll: { question: "Q", options: ["a", "b"], multi: false }, pollRaw: "{}", group: { jid: FAM, name: "Budi", fromOwner: false, family: true, jids: [MEMBER], quote: { key: { id: `P${i}`, remoteJid: FAM, participant: MEMBER }, message: { conversation: "" } } } });
  }
  const keys = Object.keys(b.state.d.xpolls);
  assert.ok(keys.includes(own), "the own poll survived the flood");
  assert.equal(keys.filter((k) => k !== own).length, XPOLLS_OTHERS_MAX);
  assert.ok(keys.includes(`P${XPOLLS_OTHERS_MAX + 39}`) && !keys.includes("P0"), "the oldest of the others' went");
  b.wa.pollRaw = "x".repeat(40 * 1024);
  assert.equal((await act(b, LF, "poll", { question: "Besar", options: ["a", "b"] })).ok, true);
  assert.equal(Object.values(b.state.d.xpolls).filter((x) => x.question === "Besar").length, 0);
});
