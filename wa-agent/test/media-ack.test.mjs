// Acknowledge work, media in the prompt, video frames and /status elapsed time (owner decisions 2026-11-12; PLAN 2.2, 2.13).
// Bridge core with a fake socket and fake timers, plus a real runner with a stub `ffmpeg` on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCore, mediaNotes } from "../src/bridge.mjs";
import { openState } from "../src/state.mjs";
import { fakeBin, sandbox, tmp, waitFor } from "../testlib/helpers.mjs";
import { attach } from "../src/ipc.mjs";
import { addRef } from "../src/wa-actions.mjs";
// The ref the bridge gives a message of a lane (4 hex characters of a hash, stable for the same lane and id).
const rf = (lane, id) => addRef({ refs: {} }, lane, { id }).ref;
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
const flush = () => new Promise((r) => setImmediate(r));
// Timers the test controls: fire() runs every live one now (nothing waits 60 s); advance(ms) moves a virtual clock and runs those that fall due.
function fakeTimers() {
  const list = [];
  let clock = 0;
  const T = {
    list,
    setTimer: (f, ms) => { const t = { f, ms, at: clock + ms, off: false }; list.push(t); return t; },
    clearTimer: (t) => { t.off = true; },
    live: () => list.filter((t) => !t.off),
    async fire() { for (const t of list.filter((x) => !x.off)) { t.off = true; await t.f(); } await flush(); },
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        const due = list.filter((t) => !t.off && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock = Math.max(clock, due.at);
        due.off = true;
        await due.f();
        await flush();
      }
      clock = end;
    },
  };
  return T;
}
// reactMs: 0 = at once; null = the production default (30 s). ackTextMs defaults to production's 8 s.
function mk(S, { groups = new Set([FAM]), statusMs = 30, reactMs = 0, ...more } = {}) {
  const wa = fakeWa(), sent = [], T = fakeTimers(), clock = { t: 1_800_000_000_000 };
  const state = openState(join(S.dir, "bridge", "state.json"));
  const core = createCore({ state, xchg: S.xchg, wa, groups, statusMs, setTimer: T.setTimer, clearTimer: T.clearTimer, ...(reactMs === null ? {} : { reactMs }), ...more, toRunner: (m) => sent.push(m), now: () => (clock.t += 1000) });
  return { core, wa, sent, state, T, clock, turns: () => sent.filter((m) => m.op === "turn") };
}
// The ack timer fires, the runner never answers, the 8 s wait runs out: the fixed line goes out.
const fixedAck = async (b) => { await b.T.fire(); await b.T.fire(); };
const up = async (b) => { await b.core.onOpen(); await b.core.onRunnerEvent({ ev: "hello", busy: [] }); };
const dm = (id, text, extra = {}) => ({ id, ts: T0 + 1, text, key: KEY(id), ...extra });
const gmsg = (id, text, { jid = FAM, fromOwner = false, family = jid === FAM, extra = {} } = {}) =>
  ({ id, ts: T0 + 1, text, ...extra, group: { jid, name: "Budi", fromOwner, family, quote: { key: { id, remoteJid: jid, participant: "628222@s.whatsapp.net" }, message: { conversation: text } } } });
const result = (lane) => ({ ev: "result", lane, sessionId: `s-${lane}`, stopReason: "end_turn" });
const QS = [{ question: "Mana?", header: "H", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: false }];
const DEFERRED = (id, lane) => ({ ev: "result", lane, sessionId: `s-${lane}`, stopReason: "tool_deferred", deferred: { id, name: "AskUserQuestion", input: { questions: QS } } });
const ACKS = ["Oke, lagi aku kerjain ya.", "Siap, bentar ya, lagi aku cek.", "Sip, aku proses dulu ya.", "Oke, bentar ya, lagi aku urus."];

// ---------- 1. acknowledge work ----------

test("ack: an owner DM is reacted to at once; after 60 s without text the runner is asked, and the fixed line follows when it never answers, once", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  await b.core.onMessage(dm("m1", "tolong cek deploy"));
  assert.deepEqual(b.wa.reacts, [{ key: KEY("m1") }]);            // at once, no jid: the owner
  assert.equal(b.turns().length, 1);
  assert.deepEqual(b.T.live().map((t) => t.ms), [60000]);          // armed when the turn started
  assert.deepEqual(b.wa.texts, []);
  await b.T.fire();
  assert.deepEqual(b.sent.filter((m) => m.op === "ack-text").map((m) => [m.lane, m.text]), [["chat", "tolong cek deploy"]]);
  assert.deepEqual(b.wa.texts, []);                                // waiting for the runner
  await b.T.fire();                                                // 8 s pass
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
  const lineFor = async (id) => { const b = mk(sandbox()); await up(b); await b.core.onMessage(dm(id, "x")); await fixedAck(b); return b.wa.texts[0].text; };
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
  await fixedAck(b);
  assert.equal(b.wa.texts.length, 1);
  await b.core.onRunnerEvent(result("chat"));                      // m2 and m3 run together now
  assert.equal(b.turns().length, 2);
  assert.equal(b.T.live().length, 1);
  await b.T.fire();
  assert.equal(b.sent.filter((m) => m.op === "ack-text").at(-1).text, "dua\ntiga");  // both messages of the batch describe the work
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
  await fixedAck(b);
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
  await fixedAck(b);
  assert.equal(b.wa.texts.length, 0);                              // never to the owner
  assert.equal(b.wa.groupTexts.length, 1);
  assert.deepEqual([b.wa.groupTexts[0].jid, ACKS.includes(b.wa.groupTexts[0].text), b.wa.groupTexts[0].quote.key.id], [FAM, true, "g1"]);
  await b.core.onRunnerEvent({ ev: "text", lane: LF, text: "ini resepnya", key: "k1" });
  await b.core.onRunnerEvent(result(LF));
  assert.equal(b.wa.groupTexts.length, 2);
});

test("ack: the reaction waits 30 s; a reply text cancels it, silence lets it through (DM and family group)", async () => {
  const S = sandbox();
  const b = mk(S, { reactMs: null });
  await up(b);
  const armed = () => b.T.live().filter((t) => t.ms === 30000).length;
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
  await b.T.advance(30000);                                        // 30 s pass with no reply: the runner is asked for an emoji
  assert.deepEqual(b.wa.reacts, []);
  await b.T.advance(5000);                                         // no answer in 5 s: 👀
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
  await b.T.advance(35000);
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
  assert.equal(b.turns()[0].prompt, `[#${rf("chat", "i1")}] ini apa?\n[gambar: /xchg/inbox/i1.jpg]`);
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("s1", "", { media: { kind: "sticker", path: "/xchg/inbox/s1.webp" }, files: ["/xchg/inbox/s1.webp"] }));
  assert.equal(b.turns()[1].prompt, `[#${rf("chat", "s1")}] [stiker: /xchg/inbox/s1.webp]`);
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("i2", "besar nih", { media: { kind: "image", tooLarge: true } }));
  assert.equal(b.turns()[2].prompt, `[#${rf("chat", "i2")}] besar nih\n[gambar: terlalu besar (>10 MB), dilewati]`);
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
  assert.equal(t.prompt, `[#${rf("chat", "v1")}] lihat ini\n[video: v1.mp4]`);
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
  assert.equal(b.turns()[0].prompt, `[Budi #${rf(LF, "g1")}] [stiker: /xchg/inbox/g1.webp]`);
  await b.core.onRunnerEvent(result(LF));
  await b.core.onMessage(gmsg("g2", "gremio ini apa", { extra: { media: { kind: "image", path: "/xchg/inbox/g2.jpg" }, files: ["/xchg/inbox/g2.jpg"] } }));
  assert.equal(b.turns()[1].prompt, `[Budi #${rf(LF, "g2")}] gremio ini apa\n[gambar: /xchg/inbox/g2.jpg]`);
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

// ---------- 5. generated ack line (owner 2026-11-12): the runner writes it, the bridge falls back to the fixed lines ----------

const askOf = (b) => b.sent.filter((m) => m.op === "ack-text" && !m.kind).at(-1);       // the progress line
const reactAskOf = (b) => b.sent.filter((m) => m.op === "ack-text" && m.kind === "react").at(-1);   // the reaction emoji
const askAt60 = async (b) => { await b.T.advance(60000); return askOf(b); };
const FIXED = (b) => ACKS.includes(b.wa.texts.at(-1)?.text);

test("ack timing: the reaction is decided at 30 s (👀 when the emoji does not come within 5 s) and not before; the runner is asked for the line at 60 s and not before", async () => {
  const b = mk(sandbox(), { reactMs: null });
  await up(b);
  await b.core.onMessage(dm("m1", "tolong cek deploy"));
  assert.deepEqual(b.T.live().map((t) => t.ms).sort((x, y) => x - y), [30000, 60000]);
  await b.T.advance(29999);
  assert.deepEqual(b.wa.reacts, []);
  await b.T.advance(1);
  assert.deepEqual(b.wa.reacts, []);                               // asked the runner, waiting for the emoji
  await b.T.advance(5000);
  assert.deepEqual(b.wa.reacts, [{ key: KEY("m1") }]);
  await b.T.advance(24999);                                        // 59.999 s
  assert.equal(askOf(b), undefined);
  await b.T.advance(1);                                            // 60 s
  assert.deepEqual([askOf(b).lane, askOf(b).text], ["chat", "tolong cek deploy"]);
  assert.equal(b.sent.filter((m) => m.op === "ack-text" && !m.kind).length, 1);
});

test("ack text: the generated line is sent when the runner answers in time; quotes are stripped; the 8 s wait is dropped", async () => {
  const b = mk(sandbox());
  await up(b);
  await b.core.onMessage(dm("m1", "tolong cek deploy"));
  const q = await askAt60(b);
  assert.ok(q.id);
  await b.core.onRunnerEvent({ ev: "ack-text", id: "wrong-id", text: "salah" });   // not ours: ignored
  assert.deepEqual(b.wa.texts, []);
  await b.core.onRunnerEvent({ ev: "ack-text", id: q.id, text: '  "Lagi aku cek status deploy-nya."  ' });
  await flush();
  assert.deepEqual(b.wa.texts.map((t) => t.text), ["Lagi aku cek status deploy-nya."]);
  assert.deepEqual(b.T.live(), []);                                // the 8 s timer was cleared, nothing else pending
  await b.T.advance(20000);
  assert.equal(b.wa.texts.length, 1);
  await b.core.onRunnerEvent({ ev: "ack-text", id: q.id, text: "dobel" });           // a second answer to the same request does nothing
  await flush();
  assert.equal(b.wa.texts.length, 1);
});

test("ack text: no answer within 8 s, or the runner is down, sends the fixed line", async () => {
  const b = mk(sandbox());
  await up(b);
  await b.core.onMessage(dm("m1", "cek"));
  await askAt60(b);
  assert.deepEqual(b.T.live().map((t) => t.ms), [8000]);
  await b.T.advance(7999);
  assert.deepEqual(b.wa.texts, []);
  await b.T.advance(1);
  assert.equal(b.wa.texts.length, 1);
  assert.ok(FIXED(b));
  // a late answer from the runner is dropped
  await b.core.onRunnerEvent({ ev: "ack-text", id: askOf(b).id, text: "telat" });
  await flush();
  assert.equal(b.wa.texts.length, 1);
  // runner down at 60 s: no request at all, the fixed line goes at once
  const d = mk(sandbox());
  await up(d);
  await d.core.onMessage(dm("m1", "cek"));
  d.core.onRunnerDown();
  await d.T.advance(60000);
  assert.equal(askOf(d), undefined);
  assert.ok(FIXED(d));
});

test("ack text: an HTTP failure at the runner (null), a line over 140 chars, a multi-line line or a non-string falls back to the fixed line", async () => {
  for (const reply of [null, "x".repeat(141), "Baris satu.\nBaris dua.", "Lagi ngecek — bentar.", "   ", 42, undefined]) {
    const b = mk(sandbox());
    await up(b);
    await b.core.onMessage(dm("m1", "cek"));
    const q = await askAt60(b);
    await b.core.onRunnerEvent({ ev: "ack-text", id: q.id, ...(reply === undefined ? {} : { text: reply }) });
    await flush();
    assert.equal(b.wa.texts.length, 1, `reply ${JSON.stringify(reply)}`);
    assert.ok(FIXED(b), `reply ${JSON.stringify(reply)} gave ${b.wa.texts[0]?.text}`);
  }
  const b = mk(sandbox());                                         // exactly 140 characters is fine
  await up(b);
  await b.core.onMessage(dm("m1", "cek"));
  await b.core.onRunnerEvent({ ev: "ack-text", id: (await askAt60(b)).id, text: "y".repeat(140) });
  await flush();
  assert.deepEqual(b.wa.texts.map((t) => t.text), ["y".repeat(140)]);
});

test("ack text: no ack when reply text came first, also while the runner is still writing the line", async () => {
  const b = mk(sandbox());
  await up(b);
  await b.core.onMessage(dm("m1", "cek"));
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", text: "ini hasilnya", key: "k1" });
  await b.T.advance(120000);
  assert.equal(askOf(b), undefined);                               // cancelled before 60 s: the runner is not even asked
  assert.deepEqual(b.wa.texts.map((t) => t.text), ["ini hasilnya"]);
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("m2", "lagi"));
  const q = await askAt60(b);
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", text: "beres", key: "k2" });  // arrives while the ack text is awaited
  await b.core.onRunnerEvent({ ev: "ack-text", id: q.id, text: "Lagi aku cek." });
  await b.T.advance(20000);
  assert.deepEqual(b.wa.texts.map((t) => t.text), ["ini hasilnya", "beres"]);
  // the turn ends while the line is awaited: nothing goes out either
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("m3", "satu lagi"));
  const q3 = await askAt60(b);
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onRunnerEvent({ ev: "ack-text", id: q3.id, text: "Lagi aku cek." });
  await b.T.advance(20000);
  assert.deepEqual(b.wa.texts.map((t) => t.text), ["ini hasilnya", "beres"]);
});

test("ack text: the wait for the runner does not hold the serial chain (a reply text still gets through and cancels the ack)", async () => {
  const b = mk(sandbox());
  await up(b);
  await b.core.onMessage(dm("m1", "cek"));
  await askAt60(b);
  let done = false;
  const p = b.core.onRunnerEvent({ ev: "text", lane: "chat", text: "jawaban", key: "k1" }).then(() => { done = true; });
  await flush();
  assert.equal(done, true);
  await p;
  assert.deepEqual(b.wa.texts.map((t) => t.text), ["jawaban"]);
});

test("ack text, group: the request carries the trigger only; the generated line goes to the group quoting that message", async () => {
  const b = mk(sandbox());
  await up(b);
  await b.core.onMessage(gmsg("g1", "gremio resep nasi goreng?"));
  const q = await askAt60(b);
  assert.equal(q.lane, LF);
  assert.deepEqual(Object.keys(q).sort(), ["id", "lane", "op", "text"]);   // nothing else rides along
  assert.match(q.text, /resep nasi goreng/);
  await b.core.onRunnerEvent({ ev: "ack-text", id: q.id, text: "Lagi aku cariin resepnya." });
  await flush();
  assert.equal(b.wa.texts.length, 0);                              // never to the owner
  assert.deepEqual(b.wa.groupTexts.map((t) => [t.jid, t.text, t.quote.key.id]), [[FAM, "Lagi aku cariin resepnya.", "g1"]]);
  // fixed fallback in a group keeps the quote too
  await b.core.onRunnerEvent(result(LF));
  await b.core.onMessage(gmsg("g2", "gremio lagi"));
  await b.T.advance(60000);
  await b.T.advance(8000);
  assert.deepEqual([b.wa.groupTexts.at(-1).quote.key.id, ACKS.includes(b.wa.groupTexts.at(-1).text)], ["g2", true]);
});

test("ack text: the trigger is capped at 500 chars; none is asked for an answer, a resume or a [dunan] event", async () => {
  const b = mk(sandbox());
  await up(b);
  await b.core.onMessage(dm("m1", "k".repeat(900)));
  assert.equal((await askAt60(b)).text.length, 500);
  await b.core.onRunnerEvent(DEFERRED("q1", "chat"));
  await b.core.onMessage(dm("m2", "A"));
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onRunnerEvent({ ev: "task-started", task: "i1", prompt: "[task] i1" });
  await b.core.onRunnerEvent({ ev: "dunan", file: "e1.json", task: "i1", prompt: "[dunan] update" });
  const before = b.sent.filter((m) => m.op === "ack-text").length;
  await b.T.advance(200000);
  assert.equal(b.sent.filter((m) => m.op === "ack-text").length, before);
});

// ---- the runner side: one call to the router (fake HTTP server), the credential stays out of logs ----

async function fakeRouter(t, handler) {
  const reqs = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { reqs.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, body); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { reqs, url: `http://127.0.0.1:${server.address().port}` };
}
const says = (text) => (req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "msg_1", type: "message", content: [{ type: "text", text }] })); };
const TOKEN = "tok-SECRET-9f3a";

// A runner with a running chat turn (fake claude hangs), and a bridge connection to it.
async function runnerWithTurn(t, env, opts = {}) {
  const S = sandbox();
  const R = await startRunner(S, { script: ["hang"], env, ...opts });
  const b = await connect(R.sock, { role: "bridge" });
  turnOf(b, { prompt: "kerja", session: "S-9" });
  await b.wait((e) => e.ev === "session");
  const ask = async (m = {}) => { const id = `a${Math.random()}`; b.send({ op: "ack-text", id, lane: "chat", text: "tolong cek deploy", ...m }); return b.wait((e) => e.ev === "ack-text" && e.id === (m.id ?? id)); };
  return { S, R, b, ask };
}

test("runner ack-text: one POST to $ANTHROPIC_BASE_URL/v1/messages with the CLI's credential, the lite model, 60 tokens, no memory or other lanes in the prompt", async (t) => {
  const router = await fakeRouter(t, says('"Lagi aku cek deploy-nya."'));
  const { S, R, ask } = await runnerWithTurn(t, { ANTHROPIC_BASE_URL: `${router.url}/`, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite", HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "" });
  writeFileSync(join(S.home, ".claude", "agent-memory", "MEMORY.md"), "RAHASIA-MEMORI-OWNER\n");
  const line = (session, subject) => JSON.stringify({ decision: "pass", tool: "Bash", subject, session_id: session, lane: "chat" }) + "\n";
  writeFileSync(join(S.home, ".claude", "guard.log"), line("S-9", "kubectl get pods") + line("LAIN", "ambil rahasia lane lain"));
  const r = await ask({ text: "tolong cek deploy <b>x</b>" });
  assert.equal(r.text, "Lagi aku cek deploy-nya.");               // quotes stripped; the proxy variables were not used
  assert.equal(router.reqs.length, 1);
  const q = router.reqs[0];
  assert.deepEqual([q.method, q.url], ["POST", "/v1/messages"]);
  assert.equal(q.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(q.headers["x-api-key"], undefined);
  const body = JSON.parse(q.body);
  assert.deepEqual([body.model, body.max_tokens], ["role-exec-lite", 60]);
  assert.match(body.system, /aku/);
  assert.match(body.system, /12 kata/);
  const user = body.messages[0].content;
  assert.match(user, /tolong cek deploy/);
  assert.match(user, /kubectl get pods/);                           // this lane's own last action
  assert.doesNotMatch(q.body, /RAHASIA|lane lain|<b>/);             // no memory, no other session, no markup from the trigger
  assert.equal(q.body.includes(TOKEN), false);
});

test("runner ack-text: WA_ACK_MODEL wins over the haiku default; an API key goes in x-api-key; no base URL or key means null", async (t) => {
  const router = await fakeRouter(t, says("Lagi aku cek."));
  const a = await runnerWithTurn(t, { ANTHROPIC_BASE_URL: router.url, ANTHROPIC_API_KEY: "sk-ant-KEY", ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite", WA_ACK_MODEL: "role-other" });
  assert.equal((await a.ask()).text, "Lagi aku cek.");
  assert.equal(router.reqs[0].headers["x-api-key"], "sk-ant-KEY");
  assert.equal(router.reqs[0].headers.authorization, undefined);
  assert.equal(JSON.parse(router.reqs[0].body).model, "role-other");
  const none = await runnerWithTurn(t, { ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite" });   // direct route: no router URL
  assert.equal((await none.ask()).text, null);
  assert.equal(router.reqs.length, 1);
  const fable = await runnerWithTurn(t, { ANTHROPIC_BASE_URL: router.url, ANTHROPIC_AUTH_TOKEN: TOKEN, WA_ACK_MODEL: "Fable-5" });   // never sent to the router
  assert.equal((await fable.ask()).text, null);
  assert.equal(router.reqs.length, 1);
});

test("runner ack-text: HTTP errors, a hung router, bad JSON and unusable text all answer null; a lane that is not running answers null", async (t) => {
  for (const [name, handler, opts] of [
    ["500", (req, res) => { res.statusCode = 500; res.end("boom"); }, {}],
    ["401 echoing the credential", (req, res) => { res.statusCode = 401; res.end(`bad key ${req.headers.authorization}`); }, {}],
    ["not json", (req, res) => res.end("<html>"), {}],
    ["no text block", (req, res) => res.end(JSON.stringify({ content: [{ type: "thinking" }] })), {}],
    ["too long", says("z".repeat(141)), {}],
    ["two lines", says("satu\ndua"), {}],
    ["hung", () => {}, { ackHttpMs: 150 }],
  ]) {
    const router = await fakeRouter(t, handler);
    const x = await runnerWithTurn(t, { ANTHROPIC_BASE_URL: router.url, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite" }, opts);
    const r = await x.ask();
    assert.equal(r.text, null, name);
    assert.equal(router.reqs.length, 1, name);
    assert.equal(x.R.logs.join("\n").includes(TOKEN), false, `${name}: the credential reached the runner log`);
    assert.equal(JSON.stringify(x.b.events).includes(TOKEN), false, name);
    assert.ok(x.R.logs.some((l) => l.startsWith("ack text: ")), name);
    if (name === "hung") assert.match(x.R.logs.join("\n"), /ack text: call failed/);
    if (name === "500") assert.match(x.R.logs.join("\n"), /router answered 500/);
  }
  const router = await fakeRouter(t, says("Lagi aku cek."));
  const x = await runnerWithTurn(t, { ANTHROPIC_BASE_URL: router.url, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite" });
  assert.equal((await x.ask({ lane: "nope" })).text, null);        // not running
  assert.equal((await x.ask({ lane: 7 })).text, null);
  assert.equal(router.reqs.length, 0);
});

test("ack text end to end: bridge core, real runner, fake router: the generated line reaches the owner; a router failure gives the fixed line", async (t) => {
  for (const ok of [true, false]) {
    const router = await fakeRouter(t, ok ? says("Lagi aku cek deploy-nya.") : (req, res) => { res.statusCode = 503; res.end("{}"); });
    const S = sandbox();
    const R = await startRunner(S, { script: ["hang"], env: { ANTHROPIC_BASE_URL: router.url, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite" } });
    const conn = await connect(R.sock, { role: "bridge" });
    const b = mk(S);                                                 // its fake timers and WhatsApp; the core below talks to the real runner
    const core = createCore({ state: openState(join(S.dir, "bridge2", "state.json")), xchg: S.xchg, wa: b.wa, setTimer: b.T.setTimer, clearTimer: b.T.clearTimer, reactMs: 0, toRunner: (m) => conn.send(m), now: () => (b.clock.t += 1000) });
    attach(conn.socket, (ev) => { if (ev.ev === "ack-text") core.onRunnerEvent(ev); });
    await core.onOpen();
    await core.onRunnerEvent({ ev: "hello", busy: [] });
    await core.onMessage(dm("m1", "tolong cek deploy"));            // the turn starts a fake claude through the socket
    await conn.wait((e) => e.ev === "session");
    await b.T.advance(60000);
    await waitFor(() => b.wa.texts.length === 1);
    if (ok) assert.deepEqual(b.wa.texts.map((x) => x.text), ["Lagi aku cek deploy-nya."]);
    else assert.ok(ACKS.includes(b.wa.texts[0].text));
    assert.equal(router.reqs.length, 1);
    conn.send({ op: "stop" });
    await conn.wait((e) => e.ev === "result");
  }
});

// ---------- 6. reaction emoji (owner 2026-11-12): at 30 s the runner picks one allowlisted emoji for the message, 👀 otherwise ----------

const answerEmoji = (b, text, over = {}) => b.core.onRunnerEvent({ ev: "ack-text", id: reactAskOf(b).id, text, ...over });
const emojiBridge = async (extra) => { const b = mk(sandbox(), { reactMs: null, ...extra }); await up(b); return b; };

test("react emoji: at 30 s the runner is asked for the message (300 chars, kind react); the allowlisted answer is the reaction, ❤ without the selector is normalized", async () => {
  const b = await emojiBridge();
  await b.core.onMessage(dm("m1", "k".repeat(900)));
  await b.T.advance(29999);
  assert.equal(reactAskOf(b), undefined);                          // not before 30 s
  await b.T.advance(1);
  const q = reactAskOf(b);
  assert.deepEqual([q.op, q.kind, q.lane, q.text.length], ["ack-text", "react", "chat", 300]);
  assert.deepEqual(b.wa.reacts, []);                               // waits for the answer
  await answerEmoji(b, " \u{1F6E0}\uFE0F\n");
  assert.deepEqual(b.wa.reacts, [{ key: KEY("m1"), emoji: "\u{1F6E0}\uFE0F" }]);
  await b.T.advance(5000);                                         // the wait timer was dropped: nothing more
  assert.equal(b.wa.reacts.length, 1);
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("m2", "makasih ya"));
  await b.T.advance(30000);
  await answerEmoji(b, "\u2764");
  assert.deepEqual(b.wa.reacts.at(-1), { key: KEY("m2"), emoji: "\u2764\uFE0F" });
});

test("react emoji: an answer off the allowlist, or an unusable one, gives 👀", async () => {
  for (const bad of ["\u{1F984}", "\u{1F440}\u{1F440}", "\u{1F440} oke", "oke", "", "\u{1F6E0}\u{1F6E0}", "👍🏽", 7, undefined, null]) {
    const b = await emojiBridge();
    await b.core.onMessage(dm("m1", "tolong cek"));
    await b.T.advance(30000);
    await answerEmoji(b, bad);
    assert.deepEqual(b.wa.reacts, [{ key: KEY("m1") }], String(bad));       // no emoji: wa.react sends its default 👀
  }
});

test("react emoji: no answer in 5 s gives 👀 and a late answer changes nothing; a runner that is down is not asked", async () => {
  const b = await emojiBridge();
  await b.core.onMessage(dm("m1", "tolong cek"));
  await b.T.advance(34999);
  assert.deepEqual(b.wa.reacts, []);
  await b.T.advance(1);
  assert.deepEqual(b.wa.reacts, [{ key: KEY("m1") }]);
  await answerEmoji(b, "\u{1F525}");
  assert.equal(b.wa.reacts.length, 1);
  const d = mk(sandbox(), { reactMs: null });                      // never said hello: the runner is down
  await d.core.onOpen();
  await d.core.onMessage(dm("m1", "tolong cek"));
  await d.T.advance(30000);
  assert.equal(reactAskOf(d), undefined);
  assert.deepEqual(d.wa.reacts, [{ key: KEY("m1") }]);
});

test("react emoji: a reply before 30 s cancels the reaction with no router call; a reply while the emoji is awaited cancels it too", async () => {
  const b = await emojiBridge();
  await b.core.onMessage(dm("m1", "cek"));
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", text: "sudah", key: "k1" });
  await b.T.advance(40000);
  assert.deepEqual([reactAskOf(b), b.wa.reacts], [undefined, []]);
  await b.core.onRunnerEvent(result("chat"));
  await b.core.onMessage(dm("m2", "lagi"));
  await b.T.advance(30000);
  assert.ok(reactAskOf(b));
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", text: "nih", key: "k2" });
  await answerEmoji(b, "\u{1F44D}");
  await b.T.advance(5000);
  assert.deepEqual(b.wa.reacts, []);
});

test("react emoji, group: the emoji goes to the message's own group JID", async () => {
  const b = await emojiBridge();
  await b.core.onMessage(gmsg("g1", "gremio resep nasi goreng?"));
  await b.T.advance(30000);
  const q = reactAskOf(b);
  assert.deepEqual([q.lane, q.kind], [LF, "react"]);
  assert.match(q.text, /resep nasi goreng/);
  await answerEmoji(b, "\u{1F64F}");
  assert.deepEqual(b.wa.reacts.map((r) => [r.jid, r.key.id, r.emoji]), [[FAM, "g1", "\u{1F64F}"]]);
  await b.core.onRunnerEvent(result(LF));
  await b.core.onMessage(gmsg("g2", "gremio lagi"));
  await b.T.advance(35000);                                        // no answer: 👀 in the group
  assert.deepEqual(b.wa.reacts.at(-1), { key: b.wa.reacts.at(-1).key, jid: FAM });
  assert.equal(b.wa.reacts.at(-1).key.id, "g2");
  assert.equal(b.wa.texts.length, 0);
});

test("runner react emoji: one POST, 10 tokens, the allowlist in the prompt, 300 chars of the message, no memory or last action; allowlisted answer returned", async (t) => {
  const router = await fakeRouter(t, says("\u{1F6E0}\uFE0F"));
  const { S, R, ask } = await runnerWithTurn(t, { ANTHROPIC_BASE_URL: router.url, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite", HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "" });
  writeFileSync(join(S.home, ".claude", "agent-memory", "MEMORY.md"), "RAHASIA-MEMORI-OWNER\n");
  writeFileSync(join(S.home, ".claude", "guard.log"), JSON.stringify({ decision: "pass", tool: "Bash", subject: "kubectl get pods", session_id: "S-9", lane: "chat" }) + "\n");
  const r = await ask({ kind: "react", text: "benerin <b>bug</b> " + "x".repeat(400) });
  assert.equal(r.text, "\u{1F6E0}\uFE0F");
  assert.equal(router.reqs.length, 1);
  const q = router.reqs[0];
  assert.deepEqual([q.method, q.url, q.headers.authorization], ["POST", "/v1/messages", `Bearer ${TOKEN}`]);
  const body = JSON.parse(q.body);
  assert.deepEqual([body.model, body.max_tokens], ["role-exec-lite", 10]);
  for (const e of ["\u{1F440}", "\u{1F6E0}\uFE0F", "\u{1FAE1}"]) assert.ok(body.system.includes(e), e);
  const user = body.messages[0].content;
  assert.match(user, /benerin/);
  assert.equal(user.replace(/<\/?pesan>/g, "").trim().length, 300);
  assert.doesNotMatch(q.body, /RAHASIA|kubectl|<b>/);
  assert.equal(q.body.includes(TOKEN), false);
  assert.equal(R.logs.join("\n").includes(TOKEN), false);
});

test("runner react emoji: a non-allowlisted answer, HTTP errors, a hung router, bad JSON, no router and a lane that is not running all answer null", async (t) => {
  for (const [name, handler, opts] of [
    ["off the allowlist", says("\u{1F984}"), {}],
    ["text", says("keren banget"), {}],
    ["500", (req, res) => { res.statusCode = 500; res.end("boom"); }, {}],
    ["401 echoing the credential", (req, res) => { res.statusCode = 401; res.end(`bad key ${req.headers.authorization}`); }, {}],
    ["not json", (req, res) => res.end("<html>"), {}],
    ["hung", () => {}, { reactHttpMs: 150 }],
  ]) {
    const router = await fakeRouter(t, handler);
    const x = await runnerWithTurn(t, { ANTHROPIC_BASE_URL: router.url, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite" }, opts);
    assert.equal((await x.ask({ kind: "react", text: "cek" })).text, null, name);
    assert.equal(router.reqs.length, 1, name);
    assert.equal(x.R.logs.join("\n").includes(TOKEN), false, `${name}: the credential reached the runner log`);
    assert.ok(x.R.logs.some((l) => l.startsWith("react emoji: ")), name);
  }
  const router = await fakeRouter(t, says("\u{1F44D}"));
  const x = await runnerWithTurn(t, { ANTHROPIC_BASE_URL: router.url, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite" });
  assert.equal((await x.ask({ kind: "react", lane: "nope" })).text, null);
  assert.equal(router.reqs.length, 0);
  const none = await runnerWithTurn(t, { ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite" });   // direct route: no router URL
  assert.equal((await none.ask({ kind: "react", text: "cek" })).text, null);
});

test("react emoji end to end: bridge core, real runner, fake router: the generated emoji is the reaction; a router failure gives 👀", async (t) => {
  for (const ok of [true, false]) {
    const router = await fakeRouter(t, ok ? says("\u{1F525}") : (req, res) => { res.statusCode = 503; res.end("{}"); });
    const S = sandbox();
    const R = await startRunner(S, { script: ["hang"], env: { ANTHROPIC_BASE_URL: router.url, ANTHROPIC_AUTH_TOKEN: TOKEN, ANTHROPIC_DEFAULT_HAIKU_MODEL: "role-exec-lite" } });
    const conn = await connect(R.sock, { role: "bridge" });
    const b = mk(S);
    const core = createCore({ state: openState(join(S.dir, "bridge2", "state.json")), xchg: S.xchg, wa: b.wa, setTimer: b.T.setTimer, clearTimer: b.T.clearTimer, toRunner: (m) => conn.send(m), now: () => (b.clock.t += 1000) });
    attach(conn.socket, (ev) => { if (ev.ev === "ack-text") core.onRunnerEvent(ev); });
    await core.onOpen();
    await core.onRunnerEvent({ ev: "hello", busy: [] });
    await core.onMessage(dm("m1", "tolong cek deploy"));
    await conn.wait((e) => e.ev === "session");
    await b.T.advance(30000);
    await waitFor(() => b.wa.reacts.length === 1);
    assert.deepEqual(b.wa.reacts, ok ? [{ key: KEY("m1"), emoji: "\u{1F525}" }] : [{ key: KEY("m1") }]);
    assert.equal(router.reqs.length, 1);
    conn.send({ op: "stop" });
    await conn.wait((e) => e.ev === "result");
  }
});
