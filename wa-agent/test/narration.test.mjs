// A model message that only narrates its own WhatsApp action ("(reacted 🍢)") is never sent, on every path the model's words take.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCore } from "../src/bridge.mjs";
import { openState } from "../src/state.mjs";
import { isActionNarration } from "../src/wa-actions.mjs";
import { addRef } from "../src/wa-actions.mjs";
import { sandbox, REF_KEY, keyed } from "../testlib/helpers.mjs";

const FAM = "120363@g.us", LF = "grp_120363", OWNER = "628111@s.whatsapp.net", MEMBER = "628222@s.whatsapp.net", T0 = 1_800_000_000;
const rf = (lane, id) => addRef({ refs: {}, refKey: REF_KEY }, lane, { id }).ref;

function mk(S) {
  const calls = [], texts = [], groupTexts = [], logs = [], sent = [], clock = { t: 1_800_000_000_000 };
  const wa = { sendText: async (text) => { texts.push(text); }, sendGroup: async (jid, text) => { groupTexts.push(text); }, composing: () => {}, react: async () => {}, isOpen: () => true };
  for (const m of ["reactAny", "reply", "sendMention", "sendMedia"]) wa[m] = async (...args) => { calls.push({ m, args }); };
  const state = keyed(openState(join(S.dir, "bridge", "state.json")));
  const core = createCore({ state, xchg: S.xchg, wa, groups: new Set([FAM]), toRunner: (m) => sent.push(m), now: () => clock.t, reactMs: 0, setTimer: () => ({}), clearTimer: () => {}, log: (m) => logs.push(m) });
  const results = () => sent.filter((m) => m.op === "wa-result");
  let n = 0;
  const act = async (lane, action, args) => { clock.t += 11_000; const rid = `n${++n}`; await core.onRunnerEvent({ ev: "wa-action", rid, lane, action, args }); return results().find((x) => x.rid === rid); };
  return { core, wa, calls, texts, groupTexts, logs, act };
}
const up = async (b) => { await b.core.onOpen(); await b.core.onRunnerEvent({ ev: "hello", busy: [] }); };
const dm = (id, text) => ({ id, ts: T0 + 1, text, key: { id, remoteJid: OWNER, fromMe: false } });

test("the observed case: a sticker, wa_react, then the model's own '(reacted 🍢)' as text and as wa_reply: neither is sent", async () => {
  const b = mk(sandbox());
  await up(b);
  await b.core.onMessage(dm("d1", "[stiker]"));
  const ref = `#${rf("chat", "d1")}`;
  assert.equal((await b.act("chat", "react", { ref, emoji: "🍢" })).ok, true);
  await b.core.onRunnerEvent({ ev: "text", lane: "chat", key: "k1", text: "(reacted 🍢)" });
  const r = await b.act("chat", "reply", { ref, text: "(reacted 🍢)" });
  assert.equal(r.ok, true);
  assert.deepEqual(b.texts, []);
  assert.deepEqual(b.calls.map((c) => c.m), ["reactAny"]); // no wa.reply
  assert.equal(b.logs.filter((l) => /dropped narration/.test(l)).length, 2);
});

test("every narration shape is dropped in a chat lane's text", async () => {
  const b = mk(sandbox());
  await up(b);
  const shapes = ["(reacted 🍢)", "(reaction: 👍)", "*reacts with 😂*", "[sent sticker]", "(sends a sticker)", "(bereaksi 👍)", "*mengirim stiker*", "(voted B)", "(voted ...)", "(polling dibuat)", "  (reacted 🍢)\n"];
  for (const [i, text] of shapes.entries()) await b.core.onRunnerEvent({ ev: "text", lane: "chat", key: `k${i}`, text });
  assert.deepEqual(b.texts, []);
  assert.equal(b.logs.length, shapes.length);
});

test("ordinary messages that contain those words are sent", async () => {
  const b = mk(sandbox());
  await up(b);
  const ok = ["Aku udah bereaksi tadi ya", "sticker-nya lucu", "Udah aku kirim, cek ya (polling-nya jalan)", "(Aku tadi bereaksi, lalu kirim stiker, ya)", "(Besok aja ya)", "Hasil polling: Sabtu menang"];
  for (const [i, text] of ok.entries()) await b.core.onRunnerEvent({ ev: "text", lane: "chat", key: `k${i}`, text });
  assert.deepEqual(b.texts, ok);
  assert.deepEqual(b.logs, []);
});

test("isActionNarration is narrow: whole message, one short group", () => {
  for (const t of ["(reacted 🍢)", "[sent sticker]", "*mengirim stiker*", "(voted ...)"]) assert.equal(isActionNarration(t), true, t);
  for (const t of ["", "halo", "Aku udah bereaksi tadi ya", "sticker-nya lucu", "(reacted 🍢) oke", "oke (reacted 🍢)", "(oke)", "(reacted 🍢, lalu kirim stiker)", `(${"reacted ".repeat(9)})`, "(1) (reacted)"]) assert.equal(isActionNarration(t), false, t);
  assert.equal(isActionNarration(undefined), false);
});

test("a group lane: its text, wa_reply and wa_mention narration are dropped; a real reply goes out", async () => {
  const b = mk(sandbox());
  await up(b);
  await b.core.onMessage({ id: "g1", ts: T0 + 1, text: "gremio halo", group: { jid: FAM, name: "Budi", fromOwner: false, family: true, jids: [MEMBER], quote: { key: { id: "g1", remoteJid: FAM, participant: MEMBER }, message: { conversation: "gremio halo" } } } });
  const ref = `#${rf(LF, "g1")}`;
  await b.core.onRunnerEvent({ ev: "text", lane: LF, key: "k1", text: "*reacts with 😂*" });
  assert.deepEqual(b.groupTexts, []);
  assert.equal((await b.act(LF, "reply", { ref, text: "(bereaksi 👍)" })).ok, true);
  assert.equal((await b.act(LF, "mention", { text: "(@Budi reacted 🍢)", names: ["Budi"] })).ok, true);
  assert.deepEqual(b.calls, []);
  assert.equal((await b.act(LF, "mention", { text: "@Budi (sent sticker)", names: ["Budi"] })).ok, true);
  assert.deepEqual(b.calls.map((c) => c.m), ["sendMention"]); // "@Budi (sent sticker)" is not one whole group: it goes out
  assert.equal((await b.act(LF, "reply", { ref, text: "Siap, udah jalan" })).ok, true);
  assert.deepEqual(b.calls.map((c) => c.m), ["sendMention", "reply"]);
});

test("a narrating caption is dropped but the file still goes out", async () => {
  const S = sandbox();
  const b = mk(S);
  await up(b);
  mkdirSync(join(S.xchg, "sock", "outbox"), { recursive: true });
  const f = "chat.0123456789abcdef.png";
  writeFileSync(join(S.xchg, "sock", "outbox", f), "PNGBYTES");
  assert.equal((await b.act("chat", "media", { kind: "image", file: f, caption: "[sent image]", fileName: "a.png" })).ok, true);
  assert.equal(b.calls[0].m, "sendMedia");
  assert.equal(b.calls[0].args[0].caption, "");
});
