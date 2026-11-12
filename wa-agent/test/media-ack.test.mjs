// Acknowledge work, media in the prompt, video frames and /status elapsed time (owner decisions 2026-11-12; PLAN 2.2, 2.13).
// Bridge core with a fake socket and fake timers, plus a real runner with a stub `ffmpeg` on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCore, mediaNotes } from "../src/bridge.mjs";
import { openState } from "../src/state.mjs";
import { fakeBin, sandbox, tmp, waitFor } from "../testlib/helpers.mjs";
import { connect, startRunner } from "../testlib/harness.mjs";

const FAM = "120363@g.us", OTHER = "120999@g.us", LF = "grp_120363";
const T0 = 1_800_000_000;
const KEY = (id) => ({ id, remoteJid: "628111@s.whatsapp.net", fromMe: false });

function fakeWa() {
  const w = { texts: [], groupTexts: [], reacts: [], open: true };
  w.sendText = async (text, o = {}) => { w.texts.push({ text, ...o }); };
  w.sendGroup = async (jid, text, o = {}) => { w.groupTexts.push({ jid, text, ...o }); };
  w.sendPoll = async (name, values, o = {}) => ({ id: o.id, raw: "{}" });
  w.react = async (key, o = {}) => { w.reacts.push({ key, ...o }); };
  w.composing = () => {};
  w.isOpen = () => w.open;
  return w;
}
// Timers the test fires by hand: nothing waits 15 s.
function fakeTimers() {
  const list = [];
  return {
    list,
    setTimer: (f, ms) => { const t = { f, ms, off: false }; list.push(t); return t; },
    clearTimer: (t) => { t.off = true; },
    live: () => list.filter((t) => !t.off),
    async fire() { for (const t of list.filter((x) => !x.off)) { t.off = true; await t.f(); } },
  };
}
function mk(S, { groups = new Set([FAM]), statusMs = 30, reactMs = 0 } = {}) {
  const wa = fakeWa(), sent = [], T = fakeTimers(), clock = { t: 1_800_000_000_000 };
  const state = openState(join(S.dir, "bridge", "state.json"));
  const core = createCore({ state, xchg: S.xchg, wa, groups, statusMs, setTimer: T.setTimer, clearTimer: T.clearTimer, reactMs, toRunner: (m) => sent.push(m), now: () => (clock.t += 1000) });
  return { core, wa, sent, state, T, clock, turns: () => sent.filter((m) => m.op === "turn") };
}
const up = async (b) => { await b.core.onOpen(); await b.core.onRunnerEvent({ ev: "hello", busy: [] }); };
const dm = (id, text, extra = {}) => ({ id, ts: T0 + 1, text, key: KEY(id), ...extra });
const gmsg = (id, text, { jid = FAM, fromOwner = false, family = jid === FAM, extra = {} } = {}) =>
  ({ id, ts: T0 + 1, text, ...extra, group: { jid, name: "Budi", fromOwner, family, quote: { key: { id, remoteJid: jid, participant: "628222@s.whatsapp.net" }, message: { conversation: text } } } });
const result = (lane) => ({ ev: "result", lane, sessionId: `s-${lane}`, stopReason: "end_turn" });
const QS = [{ question: "Mana?", header: "H", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: false }];
const DEFERRED = (id, lane) => ({ ev: "result", lane, sessionId: `s-${lane}`, stopReason: "tool_deferred", deferred: { id, name: "AskUserQuestion", input: { questions: QS } } });
const ACKS = ["Oke, lagi aku kerjain ya.", "Siap, bentar ya, lagi aku cek.", "Sip, aku proses dulu ya.", "Oke, bentar ya, lagi aku urus."];

// ---------- 1. acknowledge work ----------

test("ack: an owner DM is reacted to at once; after 15 s without text one short line follows, once", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(dm("m1", "tolong cek deploy"));
  assert.deepEqual(b.wa.reacts, [{ key: KEY("m1") }]);            // at once, no jid: the owner
  assert.equal(b.turns().length, 1);
  assert.deepEqual(b.T.live().map((t) => t.ms), [15000]);          // armed when the turn started
  assert.deepEqual(b.wa.texts, []);
  await b.T.fire();
  assert.equal(b.wa.texts.length, 1);
  assert.ok(ACKS.includes(b.wa.texts[0].text));
  assert.equal(b.wa.groupTexts.length, 0);
  await b.T.fire();                                                // nothing left to fire
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", text: "hasilnya", key: "k1" });
  await b.core.onRunnerEvent(result("chat"));
  assert.equal(b.wa.texts.length, 2);                              // the ack and the normal reply, nothing extra at the end
  assert.equal(b.wa.texts[1].text, "hasilnya");
});

test("ack: the line is picked by message id, and no ack once text arrived or the turn ended", async () => {
  const S = sandbox();
  const lineFor = async (id) => { const b = mk(sandbox()); await up(b); await b.core.onMessage(dm(id, "x")); await b.T.fire(); return b.wa.texts[0].text; };
  assert.equal(await lineFor("same-id"), await lineFor("same-id"));
  assert.equal(new Set(await Promise.all(Array.from({ length: 24 }, (_, i) => lineFor(`id-${i}`)))).size > 1, true);
  const b = mk(S);
  await up(b);
  await b.core.onMessage(dm("m1", "x"));
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", text: "  ", key: "k0" }); // blank text is not a reply
  assert.equal(b.T.live().length, 1);
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", text: "sebentar", key: "k1" });
  assert.equal(b.T.live().length, 0);
  await b.T.fire();
  assert.deepEqual(b.wa.texts.map((t) => t.text), ["sebentar"]);
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("m2", "lagi"));
  await b.core.onRunnerEvent(result("chat"));                      // the turn ends silently
  assert.equal(b.T.live().length, 0);
  await b.T.fire();
  assert.deepEqual(b.wa.texts.map((t) => t.text), ["sebentar"]);
});

test("ack: messages batched into one turn get one ack; a queued message is acked when its own turn starts", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(dm("m1", "satu"));
  await b.core.onMessage(dm("m2", "dua"));
  await b.core.onMessage(dm("m3", "tiga"));
  assert.equal(b.wa.reacts.length, 3);                             // every message gets its reaction
  assert.equal(b.turns().length, 1);
  await b.T.fire();
  assert.equal(b.wa.texts.length, 1);
  await b.core.onRunnerEvent(result("chat"));                      // m2 and m3 run together now
  assert.equal(b.turns().length, 2);
  assert.equal(b.T.live().length, 1);
  await b.T.fire();
  assert.equal(b.wa.texts.length, 2);
  assert.notEqual(b.wa.texts[0].id, b.wa.texts[1].id);
});

test("ack: none for the answer to a pending question, a resume, a command or a [dunan] event", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(dm("m1", "pilihkan"));
  await b.core.onRunnerEvent(DEFERRED("q1", "chat"));
  await b.T.fire();
  b.wa.reacts.length = 0; b.wa.texts.length = 0;
  await b.core.onMessage(dm("m2", "A"));                           // answers the head question; the lane resumes
  assert.equal(b.turns().length, 2);
  assert.equal(b.turns()[1].prompt, "");
  assert.deepEqual([b.wa.reacts.length, b.T.live().length], [0, 0]);
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("m3", "/status"));
  assert.deepEqual([b.wa.reacts.length, b.T.live().length], [0, 0]);
  await b.core.onRunnerEvent({ ev: "task-started", task: "i1", prompt: "[task] i1" });
  await b.core.onRunnerEvent({ ev: "dunan", file: "e1.json", task: "i1", prompt: "[dunan] update" });
  await b.T.fire();
  assert.equal(b.wa.reacts.length, 0);
  assert.equal(b.wa.texts.some((t) => ACKS.includes(t.text)), false);
});

test("ack: a runner that restarts and resumes the turn sends no ack", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(dm("m1", "kerjain"));
  await b.T.fire();
  b.wa.texts.length = 0;
  await b.core.onRunnerEvent({ ev: "hello", busy: [] });          // the turn died with the runner: resumed without an id
  assert.equal(b.turns().length, 2);
  assert.equal(b.T.live().length, 0);
  await b.T.fire();
  assert.deepEqual(b.wa.texts, []);
});

test("ack: an addressed family-group message is reacted to in its group and acked there, quoting it", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(gmsg("g1", "gremio resep nasi goreng?"));
  assert.equal(b.wa.reacts.length, 1);
  assert.deepEqual([b.wa.reacts[0].jid, b.wa.reacts[0].key.id, b.wa.reacts[0].key.remoteJid], [FAM, "g1", FAM]);
  assert.equal(b.turns()[0].lane, LF);
  await b.T.fire();
  assert.equal(b.wa.texts.length, 0);                              // never to the owner
  assert.equal(b.wa.groupTexts.length, 1);
  assert.deepEqual([b.wa.groupTexts[0].jid, ACKS.includes(b.wa.groupTexts[0].text), b.wa.groupTexts[0].quote.key.id], [FAM, true, "g1"]);
  await b.core.onRunnerEvent({ ev: "text", lane: LF, text: "ini resepnya", key: "k1" });
  await b.core.onRunnerEvent(result(LF));
  assert.equal(b.wa.groupTexts.length, 2);
});

test("ack: with reactMs 5000 the reaction waits; a reply text cancels it, silence lets it through (DM and family group)", async () => {
  const S = sandbox();
  const b = mk(S, { reactMs: 5000 });
  await up(b);
  const armed = () => b.T.live().filter((t) => t.ms === 5000).length;
  // DM
  await b.core.onMessage(dm("m1", "cek"));
  assert.deepEqual(b.wa.reacts, []);                               // not at once
  assert.equal(armed(), 1);
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", text: "sudah", key: "k1" });
  assert.equal(armed(), 0);
  await b.T.fire();
  assert.deepEqual(b.wa.reacts, []);                               // the reply came first: no 👀
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("m2", "lagi"));
  assert.equal(armed(), 1);
  await b.T.fire();                                                // 5 s pass with no reply
  assert.deepEqual(b.wa.reacts, [{ key: KEY("m2") }]);
  await b.core.onRunnerEvent(result("chat"));
  // family group
  b.wa.reacts.length = 0;
  await b.core.onMessage(gmsg("g1", "gremio cek"));
  assert.deepEqual(b.wa.reacts, []);
  assert.equal(armed(), 1);
  await b.core.onRunnerEvent({ ev: "text", lane: LF, text: "beres", key: "k2" });
  assert.equal(armed(), 0);
  await b.T.fire();
  assert.deepEqual(b.wa.reacts, []);
  await b.core.onRunnerEvent(result(LF));
  await b.core.onMessage(gmsg("g2", "gremio lagi"));
  assert.equal(armed(), 1);
  await b.T.fire();
  assert.deepEqual(b.wa.reacts.map((r) => [r.jid, r.key.id]), [[FAM, "g2"]]);
});

test("ack: no reaction or ack for a group message that never became a turn (not allowed, a command, a question's answer)", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(gmsg("g1", "gremio cek", { jid: OTHER, family: false, fromOwner: false })); // a member of a non-family group
  await b.core.onMessage(gmsg("g2", "gremio /status"));
  await b.core.onMessage(gmsg("g3", "gremio /baru"));
  assert.equal(b.wa.reacts.length, 0);
  assert.equal(b.T.live().length, 0);
  await b.core.onMessage(gmsg("g4", "gremio tanya"));
  await b.core.onRunnerEvent(DEFERRED("q1", LF));
  b.wa.reacts.length = 0;
  await b.core.onMessage(gmsg("g5", "gremio A"));                  // answers the group question; resume, no ack
  assert.equal(b.wa.reacts.length, 0);
  assert.equal(b.T.live().length, 0);
});

test("ack: a family group removed from the allowed list gets neither a reaction nor an ack", async () => {
  const S = sandbox();
  const b = mk(S, { groups: new Set() });
  await up(b);
  await b.core.onMessage(gmsg("g1", "gremio halo", { family: true, fromOwner: false }));
  assert.equal(b.wa.reacts.length + b.turns().length + b.T.list.length, 0);
});

// ---------- 2. media in the prompt ----------

test("mediaNotes: image, sticker, oversize, video and files", () => {
  assert.deepEqual(mediaNotes({ media: { kind: "image", path: "/xchg/inbox/a.jpg" } }).notes, ["[gambar: /xchg/inbox/a.jpg]"]);
  assert.deepEqual(mediaNotes({ media: { kind: "sticker", path: "/xchg/inbox/a.webp" } }).notes, ["[stiker: /xchg/inbox/a.webp]"]);
  assert.deepEqual(mediaNotes({ media: { kind: "image", tooLarge: true } }).notes, ["[gambar: terlalu besar (>10 MB), dilewati]"]);
  assert.deepEqual(mediaNotes({ media: { kind: "video", tooLarge: true } }).notes, ["[video: terlalu besar (>20 MB), dilewati]"]);
  assert.deepEqual(mediaNotes({ media: { kind: "video", path: "/xchg/inbox/v.mp4", seconds: 12 } }), { notes: ["[video: v.mp4]"], videos: [{ name: "v.mp4", seconds: 12 }] });
  assert.deepEqual(mediaNotes({ media: { kind: "document" }, files: ["/xchg/inbox/d.pdf"] }).notes, ["[file: /xchg/inbox/d.pdf]"]);
  assert.deepEqual(mediaNotes({ media: { kind: "image" } }), { notes: [], videos: [] });   // download failed
  assert.deepEqual(mediaNotes({}), { notes: [], videos: [] });
});

test("owner DM: image and sticker paths are in the prompt with the caption; an oversize one is skipped with a note", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(dm("i1", "ini apa?", { media: { kind: "image", path: "/xchg/inbox/i1.jpg" }, files: ["/xchg/inbox/i1.jpg"] }));
  assert.equal(b.turns()[0].prompt, "ini apa?\n[gambar: /xchg/inbox/i1.jpg]");
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("s1", "", { media: { kind: "sticker", path: "/xchg/inbox/s1.webp" }, files: ["/xchg/inbox/s1.webp"] }));
  assert.equal(b.turns()[1].prompt, "[stiker: /xchg/inbox/s1.webp]");
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("i2", "besar nih", { media: { kind: "image", tooLarge: true } }));
  assert.equal(b.turns()[2].prompt, "besar nih\n[gambar: terlalu besar (>10 MB), dilewati]");
  assert.equal(b.turns().every((t) => t.videos === undefined), true);
});

test("owner DM: a video is named in the prompt and handed to the runner; the bridge deletes it when the turn ends", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  const file = join(S.xchg, "inbox", "v1.mp4");
  writeFileSync(file, "VIDEO");
  await b.core.onMessage(dm("v1", "lihat ini", { media: { kind: "video", path: file, seconds: 8 }, files: [file] }));
  const t = b.turns()[0];
  assert.equal(t.prompt, "lihat ini\n[video: v1.mp4]");
  assert.deepEqual(t.videos, [{ name: "v1.mp4", seconds: 8 }]);
  assert.equal(existsSync(file), true);                            // still there while the turn runs
  await b.core.onRunnerEvent(result("chat"));
  assert.equal(existsSync(file), false);
});

test("group: a caption-less sticker or image that addresses Gremio (a reply) starts a turn with its path", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(gmsg("g1", "", { extra: { media: { kind: "sticker", path: "/xchg/inbox/g1.webp" }, files: ["/xchg/inbox/g1.webp"] } }));
  assert.equal(b.turns()[0].prompt, "[Budi] [stiker: /xchg/inbox/g1.webp]");
  await b.core.onRunnerEvent(result(LF));
  await b.core.onMessage(gmsg("g2", "gremio ini apa", { extra: { media: { kind: "image", path: "/xchg/inbox/g2.jpg" }, files: ["/xchg/inbox/g2.jpg"] } }));
  assert.equal(b.turns()[1].prompt, "[Budi] gremio ini apa\n[gambar: /xchg/inbox/g2.jpg]");
  await b.core.onRunnerEvent(result(LF));
  await b.core.onMessage(gmsg("g3", "gremio", { extra: { media: { kind: "video", path: "/xchg/inbox/g3.mp4", seconds: 5 }, files: ["/xchg/inbox/g3.mp4"] } }));
  assert.deepEqual(b.turns()[2].videos, [{ name: "g3.mp4", seconds: 5 }]);
  assert.equal(b.wa.reacts.length, 3);                             // media messages are reacted to like text
  await b.core.onRunnerEvent(result(LF));
  await b.core.onMessage(gmsg("g4", "", { extra: { media: { kind: "audio" } } }));   // empty audio: nothing to say
  assert.equal(b.turns().length, 3);
});

// ---------- 3. video frames in the runner ----------

const turnOf = (b, m) => b.send({ op: "turn", lane: "chat", session: null, ...m });
// A stub ffmpeg: logs its argv (one line) and writes `frames` JPEGs where the last argument points (a %d pattern).
function stubFfmpeg(bin, log, { frames = 4, code = 0 } = {}) {
  fakeBin(bin, "ffmpeg", `echo "$@" >> '${log}'\nfor a in "$@"; do out="$a"; done\ni=1\nwhile [ $i -le ${frames} ]; do printf JPG > "$(printf '%s' "$out" | sed "s/%d/$i/")"; i=$((i+1)); done\nexit ${code}`);
}
const promptOf = (R) => R.calls()[0].argv[1];
const mkInbox = (S, name) => { const p = join(S.xchg, "inbox", name); writeFileSync(p, "VIDEO"); return p; };

test("video: the runner extracts 4 frames into ~/assistant/media/<id>/ before the turn and the prompt carries their paths", async () => {
  const S = sandbox();
  const log = join(S.dir, "ffmpeg.log");
  stubFfmpeg(S.bin, log);
  const R = await startRunner(S, { script: ["plain"], env: { PATH: `${S.bin}:${process.env.PATH}` } });
  const b = await connect(R.sock, { role: "bridge" });
  const file = mkInbox(S, "v1.mp4");
  turnOf(b, { prompt: "lihat\n[video: v1.mp4]", videos: [{ name: "v1.mp4", seconds: 8 }] });
  await b.wait((e) => e.ev === "result");
  const dir = join(S.home, "assistant", "media", "v1");
  const args = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(args.length, 1);                                    // one ffmpeg run
  assert.equal(args[0], `-nostdin -v error -protocol_whitelist file -f mov -i ${file} -vf fps=4/8 -frames:v 4 -q:v 4 ${join(dir, "frame-%d.jpg")}`);
  const frames = [1, 2, 3, 4].map((i) => join(dir, `frame-${i}.jpg`));
  assert.match(promptOf(R), new RegExp(`lihat\\n\\[video 8s, frame: ${frames.join(", ").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\]$`));
  await waitFor(() => !existsSync(dir));                           // frames go with the turn
  assert.equal(existsSync(file), true);                            // the video is the bridge's to delete
});

test("video: no ffmpeg, a failing ffmpeg, or no frames written all fall back to 'tidak bisa dibaca' and the turn still runs", async () => {
  for (const mode of ["absent", "fails", "empty"]) {
    const S = sandbox();
    const empty = tmp("noff-");                                    // a PATH without ffmpeg, whatever the host has
    if (mode === "fails") stubFfmpeg(S.bin, join(S.dir, "ff.log"), { frames: 0, code: 1 });
    if (mode === "empty") stubFfmpeg(S.bin, join(S.dir, "ff.log"), { frames: 0, code: 0 });
    const R = await startRunner(S, { script: ["plain"], env: { PATH: mode === "absent" ? empty : `${S.bin}:${process.env.PATH}` } });
    const b = await connect(R.sock, { role: "bridge" });
    mkInbox(S, "v2.mp4");
    turnOf(b, { prompt: "[video: v2.mp4] apa ini", videos: [{ name: "v2.mp4", seconds: 3 }] });
    const r = await b.wait((e) => e.ev === "result");
    assert.equal(r.error, undefined, mode);
    assert.equal(promptOf(R), "[video: tidak bisa dibaca] apa ini", mode);
  }
});

test("video: only a video the bridge named, with a safe file name, is touched; a typed marker stays text", async () => {
  const S = sandbox();
  const log = join(S.dir, "ffmpeg.log");
  stubFfmpeg(S.bin, log);
  const R = await startRunner(S, { script: ["plain"], env: { PATH: `${S.bin}:${process.env.PATH}` } });
  const b = await connect(R.sock, { role: "bridge" });
  mkInbox(S, "v3.mp4");
  turnOf(b, { prompt: "[video: v3.mp4] [video: ../../etc/passwd]", videos: [{ name: "../../etc/passwd", seconds: 1 }] });
  await b.wait((e) => e.ev === "result");
  assert.equal(existsSync(log), false);                            // no ffmpeg run: the named video is unsafe, v3 was never named
  assert.equal(promptOf(R), "[video: v3.mp4] [video: ../../etc/passwd]");
});

// ---------- 4. /status ----------

test("runner status: running lanes with the elapsed time and the last guard.log subject of their own session", async () => {
  const S = sandbox();
  const R = await startRunner(S, { script: ["hang"] });
  const b = await connect(R.sock, { role: "bridge" });
  const line = (session, subject) => JSON.stringify({ decision: "pass", tool: "Bash", subject, session_id: session, lane: "chat" }) + "\n";
  writeFileSync(join(S.home, ".claude", "guard.log"), line("S-9", "old command") + line("OTHER", "someone else") + line("S-9", "multica agent list\nsecond line " + "x".repeat(100)) + line("OTHER", "newer, other session") + "not json\n");
  turnOf(b, { prompt: "kerja", session: "S-9" });
  await b.wait((e) => e.ev === "session");
  b.send({ op: "status", id: "a1" });
  const r = await b.wait((e) => e.ev === "status" && e.id === "a1");
  assert.deepEqual(Object.keys(r.lanes), ["chat"]);
  assert.equal(r.lanes.chat.last, "multica agent list");
  assert.ok(r.lanes.chat.ms >= 0 && r.lanes.chat.ms < 5000);
  writeFileSync(join(S.home, ".claude", "guard.log"), line("S-9", "y".repeat(200)));
  b.send({ op: "status", id: "a2" });
  assert.equal((await b.wait((e) => e.ev === "status" && e.id === "a2")).lanes.chat.last, "y".repeat(60));
  b.send({ op: "stop" });
  await b.wait((e) => e.ev === "result");
  b.send({ op: "status", id: "a3" });
  assert.deepEqual((await b.wait((e) => e.ev === "status" && e.id === "a3")).lanes, {});
});

test("bridge /status: a running lane shows minutes and its last action; without an answer it falls back to plain 'jalan'", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(dm("m1", "kerjain"));
  await b.core.onMessage(gmsg("g1", "gremio cek"));
  const ask = async (id) => {
    const p = b.core.onMessage(dm(id, "/status"));
    return p;
  };
  // 1. the runner answers (the reply arrives while /status holds the serial chain)
  let p = ask("c1");
  const q = await waitFor(() => b.sent.find((m) => m.op === "status"));
  await b.core.onRunnerEvent({ ev: "status", id: "wrong-id", lanes: { chat: { ms: 1, last: "ignored" } } });
  await b.core.onRunnerEvent({ ev: "status", id: q.id, lanes: { chat: { ms: 9 * 60000 + 5000, last: "multica agent list" }, [LF]: { ms: 42000, last: "z".repeat(90) }, nope: { ms: 5 } } });
  await p;
  const full = b.wa.texts.at(-1).text;
  assert.match(full, /^chat: jalan 9 mnt, lagi: multica agent list$/m);
  assert.match(full, new RegExp(`^${LF}: jalan 42 dtk, lagi: ${"z".repeat(60)}$`, "m"));
  assert.doesNotMatch(full, /nope|ignored/);
  // 2. the runner never answers: today's output after the timeout
  const before = b.sent.length;
  await ask("c2");
  assert.equal(b.sent.slice(before).some((m) => m.op === "status"), true);
  assert.match(b.wa.texts.at(-1).text, /^chat: jalan$/m);
  assert.match(b.wa.texts.at(-1).text, /hari ini: 0 turn/);
  // 3. an idle bridge does not ask at all
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onRunnerEvent(result(LF));
  const n = b.sent.length;
  await ask("c3");
  assert.equal(b.sent.length, n);
  assert.match(b.wa.texts.at(-1).text, /chat: diam/);
});
