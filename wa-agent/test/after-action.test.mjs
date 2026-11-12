// Once a lane has spoken through an action tool in a turn, the turn's later plain text only narrates it and is not sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createCore } from "../src/bridge.mjs";
import { openState } from "../src/state.mjs";
import { addRef } from "../src/wa-actions.mjs";
import { sandbox, REF_KEY, keyed } from "../testlib/helpers.mjs";

const OWNER = "628111@s.whatsapp.net", T0 = 1_800_000_000;

function mk() {
  const S = sandbox(), texts = [], logs = [], sent = [], clock = { t: 1_800_000_000_000 };
  const wa = { sendText: async (t) => { texts.push(t); }, composing: () => {}, react: async () => {}, isOpen: () => true, reply: async () => {}, reactAny: async () => {}, sendPoll: async () => ({ id: "P1" }) };
  const state = keyed(openState(join(S.dir, "bridge", "state.json")));
  const core = createCore({ state, xchg: S.xchg, wa, groups: new Set(), toRunner: (m) => sent.push(m), now: () => clock.t, reactMs: 0, setTimer: () => ({}), clearTimer: () => {}, log: (m) => logs.push(m) });
  let n = 0;
  const act = async (action, args) => { clock.t += 11_000; const rid = `r${++n}`; await core.onRunnerEvent({ ev: "wa-action", rid, lane: "chat", action, args }); return sent.find((x) => x.op === "wa-result" && x.rid === rid); };
  const text = (t) => core.onRunnerEvent({ ev: "text", lane: "chat", key: `k${++n}`, text: t });
  const turn = async (id) => { // the owner writes, the runner answers the turn
    await core.onMessage({ id, ts: T0 + 1, text: "hai", key: { id, remoteJid: OWNER, fromMe: false } });
    return `#${addRef({ refs: {}, refKey: REF_KEY }, "chat", { id }).ref}`;
  };
  const end = () => core.onRunnerEvent({ ev: "result", lane: "chat" });
  return { core, texts, logs, act, text, turn, end, up: async () => { await core.onOpen(); await core.onRunnerEvent({ ev: "hello", busy: [] }); } };
}

const actions = {
  wa_reply: (b, ref) => b.act("reply", { ref, text: "Siap Lord" }),
  wa_poll: (b) => b.act("poll", { question: "Sabtu atau Minggu?", options: ["Sabtu", "Minggu"] }),
  notify: (b) => b.core.onRunnerEvent({ ev: "notify", lane: "chat", kind: "done", nid: "n1", text: "Udah beres." }),
};

for (const [name, run] of Object.entries(actions)) {
  test(`${name}: text before the action is sent, text after it is not, the next turn's text is sent again`, async () => {
    const b = mk();
    await b.up();
    const ref = await b.turn("d1");
    await b.text("Bentar, aku cek dulu.");
    const r = await run(b, ref);
    if (r) assert.equal(r.ok, true);
    const afterAction = b.texts.length;
    await b.text("Selesai dikirim ke Lord Faisal lewat WhatsApp.");
    assert.equal(b.texts.length, afterAction, "the narration is not sent");
    assert.ok(b.texts.includes("Bentar, aku cek dulu."));
    assert.ok(!b.texts.includes("Selesai dikirim ke Lord Faisal lewat WhatsApp."));
    assert.equal(b.logs.filter((l) => /dropped text after an action/.test(l)).length, 1);
    assert.ok(b.logs.find((l) => /dropped text after an action/.test(l)).endsWith("Selesai dikirim ke Lord Faisal lewat WhatsApp.".slice(0, 40)));
    await b.end();
    await b.turn("d2");
    await b.text("Halo lagi.");
    assert.ok(b.texts.includes("Halo lagi."), "the next turn's text goes out");
  });
}

test("a failed or refused action does not silence the turn, and wa_react alone does not either", async () => {
  const b = mk();
  await b.up();
  const ref = await b.turn("d1");
  assert.equal((await b.act("reply", { ref: "#zzzz", text: "x" })).ok, false);
  assert.equal((await b.act("react", { ref, emoji: "👍" })).ok, true);
  await b.text("Ini jawabannya.");
  assert.ok(b.texts.includes("Ini jawabannya."));
});
