// Bridge container main (PLAN 2.1, 2.2, 2.3, 2.12). Uid 1002: holds the WhatsApp session and state.json, never a
// model, GitHub or Multica credential. This file is the routing core plus startup and shutdown; the Baileys socket is
// in wa.mjs and everything that runs `claude` is in runner.mjs, reached over /xchg/sock/run.sock.
//
// Core rules: the bridge sends only to the owner (wa.sendText has no JID argument); routing order for an inbound
// text is (1) `done|deny <kode>`, (2) the head question, (3) the chat lane; one FIFO question queue across lanes;
// the bridge starts every turn and owns every session id; every write goes through safeWrite.
import net from "node:net";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openState, safeWrite } from "./state.mjs";
import { CODE_PATTERN, PR_URL, deleteGrant, isMergeYes, parseApproval, pushMainOrder, sweepGrants, writeGrant } from "./grants.mjs";
import { parseCommand } from "./commands.mjs";
import { questionsOf } from "./stream.mjs";
import { attach, send } from "./ipc.mjs";
import { messageId } from "./wa.mjs";
import { inside, validFile, validId } from "./ids.mjs";

const MAX_TEXT = 4000; // WhatsApp message length we split at (UNVERIFIED limit, PLAN 2.2 step 4)
const POLL_MAX_OPTIONS = 12;
const CODE_TTL_MS = 24 * 3600 * 1000;
const POLL_UNREADABLE = "poll-nya gak kebaca, jawab pakai angka aja ya";

export function splitText(text, max = MAX_TEXT) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// Parses the owner's answer to one question. A number picks an option, a label picks that label, "1,3" picks several
// on a multi-select, anything else is free text (the tool's "Other").
export function parseAnswer(q, raw) {
  const t = raw.trim();
  if (q.multiSelect) {
    const parts = t.split(/[,\s]+/).filter(Boolean);
    if (parts.length && parts.every((p) => /^\d+$/.test(p) && +p >= 1 && +p <= q.options.length)) return [...new Set(parts)].map((p) => q.options[+p - 1]).join(", ");
  }
  if (/^\d+$/.test(t) && +t >= 1 && +t <= q.options.length) return q.options[+t - 1];
  const hit = q.options.find((o) => o.toLowerCase() === t.toLowerCase());
  return hit ?? t;
}

export function renderQuestion(head) {
  const q = head.questions[head.cursor];
  const n = head.questions.length > 1 ? `(${head.cursor + 1}/${head.questions.length}) ` : "";
  const list = q.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const how = q.options.length ? (q.multiSelect ? "\n(jawab angka dipisah koma, atau ketik jawaban bebas)" : "\n(jawab angka, pilih di poll, atau ketik jawaban bebas)") : "";
  return `${n}${q.question}${list ? "\n" + list : ""}${how}`;
}

export function createCore({ state, xchg, wa, toRunner, now = Date.now, log = () => {} }) {
  const S = state.d;
  const save = () => state.save();
  const known = (id) => id === "chat" || (validId(id) && !!S.lanes[id]);
  const lane = (id) => S.lanes[id]; // only ever called for a lane that `known` accepted
  const answersDir = join(xchg, "answers");
  let runnerUp = false, nonceFile = null;
  const memoriWaiting = new Set();
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const newLane = () => ({ queue: [], inflight: null });
  S.lanes.chat ??= newLane();

  // One runner event, vote or message at a time: handlers await WhatsApp sends, and two interleaved handlers would each
  // see the same unshown question and send it twice.
  let chain = Promise.resolve();
  const serial = (fn) => (...args) => { const r = chain.then(() => fn(...args)); chain = r.catch(() => {}); return r; };

  // ---- outbound: dedup ledger, chunking, retry list ----
  async function sendOnce(key, text) {
    if (S.outbox[key] || !text.trim()) return;
    const parts = splitText(text);
    try {
      for (let i = 0; i < parts.length; i++) await wa.sendText(parts[i], { id: messageId(key, i) });
      S.outbox[key] = now();
    } catch (e) {
      log(`send failed, kept for retry: ${e.message}`);
      S.pendingOut.push({ key, text });
    }
    save();
  }
  async function flushPending() {
    const list = S.pendingOut.splice(0);
    save();
    for (const p of list) await sendOnce(p.key, p.text);
  }

  // ---- turns ----
  const hasQuestion = (id) => S.queue.some((q) => q.lane === id);
  function pump(id) {
    const L = S.lanes[id];
    // A lane with a question waiting runs nothing: its only next turn is the empty resume after the answer.
    if (!L || !runnerUp || L.inflight || !L.queue.length || hasQuestion(id)) return;
    const items = L.resumeFirst ? [L.queue.shift()] : L.queue.splice(0);
    L.resumeFirst = false;
    const raw = items.map((i) => i.text).filter(Boolean);
    L.inflight = { raw, ids: items.map((i) => i.id).filter(Boolean), answered: items.find((i) => i.answered)?.answered ?? null };
    save();
    toRunner({ op: "turn", lane: id, task: id === "chat" ? undefined : id, session: S.sessions[id] ?? null, prompt: raw.join("\n\n"), origin: L.inflight.ids });
  }
  function enqueue(id, text, msgId) { if (!known(id)) return log(`no lane ${id}`); lane(id).queue.push({ text, id: msgId ?? null }); save(); pump(id); }

  // ---- questions ----
  async function showHead() {
    const head = S.queue[0];
    if (!head || head.shown) return;
    if (head.kind === "ask-owner") { await sendOnce(`q:${head.id}`, head.text); } else {
      const q = head.questions[head.cursor];
      await sendOnce(`q:${head.id}:${head.cursor}`, renderQuestion(head));
      if (q.options.length >= 2 && q.options.length <= POLL_MAX_OPTIONS) {
        try {
          const p = await wa.sendPoll(q.question.slice(0, 250), q.options, { id: messageId(`poll:${head.id}:${head.cursor}`), multi: q.multiSelect });
          S.polls[p.id] = { raw: p.raw, qid: head.id, cursor: head.cursor, ts: now() };
        } catch (e) { log(`poll failed, the numbered text still carries the question: ${e.message}`); }
      }
    }
    head.shown = true;
    save();
  }
  function enqueueQuestion(entry) {
    if (S.queue.some((q) => q.id === entry.id)) return showHead(); // a resumed, still unanswered deferral returns the same id
    S.queue.push({ cursor: 0, answers: {}, shown: false, ...entry });
    save();
    return showHead();
  }

  async function answerHead(label, raw) {
    const head = S.queue[0];
    if (!head) return;
    if (head.kind === "ask-owner") { // the runner waits for this file: only the bridge-owned dir can hold it
      safeWrite(inside(answersDir, `${head.rid}.json`), JSON.stringify({ answer: raw }), 0o644);
      S.queue.shift();
      save();
      return showHead();
    }
    const q = head.questions[head.cursor];
    head.answers[q.question] = label;
    head.cursor++;
    if (head.cursor < head.questions.length) { head.shown = false; save(); return showHead(); }
    // Complete: merge grant (only from his own "ok"/"merge" to a question carrying a PR URL), answer file, resume.
    for (const qq of head.questions) {
      const url = PR_URL.exec(qq.question)?.[0];
      if (url && isMergeYes(head.answers[qq.question] ?? "")) {
        const g = writeGrant(xchg, "merge", { url, tool_use_id: head.id }, now());
        S.grants[g.id] = { kind: "merge", ts: g.created_at };
      }
    }
    safeWrite(inside(answersDir, `${head.id}.json`), JSON.stringify({ questions: head.input?.questions ?? [], answers: head.answers }), 0o644);
    S.queue.shift();
    const L = known(head.lane) ? lane(head.lane) : null;
    if (L) {
      // The resume of a deferred tool must carry no prompt (hooks.md), so it goes first; anything queued waits behind it.
      L.queue.unshift({ text: "", id: null, answered: head.id });
      L.resumeFirst = true;
    }
    save();
    pump(head.lane);
    return showHead();
  }

  // ---- inbound ----
  async function onMessage(n) {
    if (S.inbox[n.id]) return log(`duplicate ${n.id}`);
    // Cutoff is the pairing time, not the newest message: a message that was late (a reconnect `append`) is still his,
    // while the history sync after pairing is older than pairedAt. Duplicates are caught by the id ledger above.
    if (n.ts < Math.floor((S.pairedAt ?? now()) / 1000)) return log(`dropped old message ${n.id} (history sync or replay)`);
    S.inbox[n.id] = n.ts;
    S.lastTs = Math.max(S.lastTs, n.ts);
    save();
    wa.composing();
    const text = [n.text, ...(n.files ?? []).map((f) => `[file: ${f}]`)].filter(Boolean).join("\n");
    if (!text) return;
    const cmd = parseCommand(text);
    if (cmd) return runCommand(cmd);
    return route(text, n.id);
  }

  async function route(text, msgId) {
    const ap = parseApproval(text);
    const rec = ap && S.codes[ap.code];
    if (rec && known(rec.lane) && now() - rec.ts < CODE_TTL_MS) { // (1) goes to the lane whose message carried the code
      const g = writeGrant(xchg, "approval", { code: ap.code, verb: ap.verb }, now());
      S.grants[g.id] = { kind: "approval", ts: g.created_at };
      return enqueue(rec.lane, text, msgId);
    }
    if (S.queue[0]) return answerHead(parseAnswerFor(S.queue[0], text), text); // (2) the head question
    return enqueue("chat", text, msgId); // (3) the chat lane
  }
  const parseAnswerFor = (head, text) => (head.kind === "ask-owner" ? text : parseAnswer(head.questions[head.cursor], text));

  async function onVote({ pollId, options }) {
    const p = S.polls[pollId], head = S.queue[0];
    if (!p || !head || head.id !== p.qid || head.cursor !== p.cursor) return log("vote for a poll that is not the head question");
    if (options === null) return sendOnce(`unreadable:${pollId}:${now()}`, POLL_UNREADABLE); // keeps the question at the head
    if (!options.length) return;
    return answerHead(options.join(", "), options.join(", "));
  }

  // ---- commands ----
  async function runCommand(cmd) {
    if (cmd === "baru") {
      const L = lane("chat");
      delete S.sessions.chat;
      L.queue = [];
      if (L.inflight) L.fresh = true; // the running turn must not store its session id again
      toRunner({ op: "wiki_capture" });
      save();
      return sendOnce(`cmd:${now()}`, "Sesi baru. Memori tetap ada.");
    }
    if (cmd === "stop") {
      for (const L of Object.values(S.lanes)) L.queue = [];
      toRunner({ op: "stop" });
      save();
      return sendOnce(`cmd:${now()}`, "Distop.");
    }
    if (cmd === "memori") { const id = String(now()); memoriWaiting.add(id); return toRunner({ op: "memori", id }); }
    if (cmd === "status") {
      const u = S.usage[today()] ?? {};
      const lines = [`runner: ${runnerUp ? "nyambung" : "putus"}, WhatsApp: ${wa.isOpen?.() ? "nyambung" : "putus"}`];
      for (const [id, L] of Object.entries(S.lanes)) lines.push(`${id}: ${L.inflight ? "jalan" : "diam"}${L.queue.length ? `, antrean ${L.queue.length}` : ""}${hasQuestion(id) ? ", nunggu jawaban" : ""}`);
      lines.push(`pertanyaan antre: ${S.queue.length}`, `hari ini: ${u.turns ?? 0} turn, in ${u.input ?? 0}, out ${u.output ?? 0}, cache read ${u.cache_read ?? 0}`);
      return sendOnce(`cmd:${now()}`, lines.join("\n"));
    }
  }

  // ---- events from the runner (everything in `m` is untrusted input: ids are checked before they key or name anything) ----
  async function onRunnerEvent(m) {
    if (!m || typeof m.ev !== "string") return;
    switch (m.ev) {
      case "challenge": { // the runner asks for proof that this is the bridge: a file only this uid can create in answers/
        if (!/^[0-9a-f]{32}$/.test(String(m.nonce))) return;
        nonceFile = inside(answersDir, `.hello-${m.nonce}`);
        safeWrite(nonceFile, "", 0o644);
        return toRunner({ op: "auth", nonce: m.nonce });
      }
      case "hello": {
        runnerUp = true;
        if (nonceFile) { try { unlinkSync(nonceFile); } catch { /* gone */ } nonceFile = null; }
        for (const t of Array.isArray(m.tasks) ? m.tasks : []) if (validId(t) && t !== "chat") S.lanes[t] ??= newLane(); // lanes the runner still has
        const alive = new Set([...(m.busy ?? []), ...(m.buffered ?? [])]); // running, or finished with the result about to be replayed
        for (const [id, L] of Object.entries(S.lanes)) {
          if (L.inflight && !alive.has(id)) { // the turn died with the runner: resume it (CLAUDE_CODE_RESUME_INTERRUPTED_TURN)
            const raw = L.inflight.raw;
            L.inflight = null;
            L.queue.unshift({ text: S.sessions[id] ? "" : raw.join("\n\n"), id: null });
          }
        }
        save();
        for (const id of Object.keys(S.lanes)) pump(id);
        return showHead();
      }
      case "task-started": {
        if (!validId(m.task) || m.task === "chat") return log(`rejected task id ${String(m.task).slice(0, 40)}`);
        S.lanes[m.task] ??= newLane();
        const L = lane(m.task);
        S.tasks[m.task] = { at: now() };
        // Only when this task came from the chat turn in flight (origin matches its message ids): a task that waited for a
        // lane starts with origin null and must not borrow the grant from an unrelated message.
        const chatTurn = S.lanes.chat.inflight;
        const fromThisTurn = Array.isArray(m.origin) && m.origin.length && chatTurn && m.origin.every((id) => chatTurn.ids.includes(id));
        const branch = fromThisTurn ? pushMainOrder(chatTurn.raw.join("\n")) : null;
        if (branch) { const g = writeGrant(xchg, "push-main", { task_id: m.task, branch }, now()); S.grants[g.id] = { kind: "push-main", ts: g.created_at }; }
        L.queue.push({ text: String(m.prompt ?? ""), id: null });
        save();
        return pump(m.task);
      }
      case "grant-used": {
        if (validId(m.grant)) {
          deleteGrant(xchg, m.grant);
          S.grantsUsed[m.grant] = { ts: now(), toolUseId: validId(m.toolUseId) ? m.toolUseId : null };
          delete S.grants[m.grant];
          save();
          toRunner({ op: "grant-ack", grant: m.grant });
        }
        return;
      }
      case "notice": return sendOnce(`notice:${now()}`, String(m.text ?? ""));
      case "memori": if (memoriWaiting.delete(String(m.id))) return sendOnce(`memori:${m.id}`, String(m.text ?? "") || "(kosong)"); return;
      case "ask": {
        if (!/^ask-[0-9a-f]{16,64}$/.test(String(m.rid)) || !known(m.lane)) return log("rejected ask");
        return enqueueQuestion({ id: `ask:${m.rid}`, kind: "ask-owner", rid: m.rid, lane: m.lane, text: String(m.text ?? "") });
      }
      case "dunan": {
        if (!validFile(m.file)) return log("rejected dunan event file name");
        if (!known(m.task)) return toRunner({ op: "ack", file: m.file }); // stale: its lane is gone, let the runner drop the file
        const key = `dunan:${m.file}`;
        if (!S.inbox[key]) { S.inbox[key] = Math.floor(now() / 1000); save(); enqueue(m.task, String(m.prompt ?? ""), key); }
        return toRunner({ op: "ack", file: m.file });
      }
    }
    // the rest name a lane: it has to be one this bridge knows
    if (!known(m.lane)) return log(`event ${m.ev} for unknown lane ${String(m.lane).slice(0, 40)}`);
    switch (m.ev) {
      case "session": { const L = lane(m.lane); if (!L.fresh && validSession(m.sessionId)) { S.sessions[m.lane] = m.sessionId; save(); } return; }
      case "text": if (m.lane === "chat" && typeof m.key === "string" && m.key.length <= 200) return sendOnce(`t:${m.key}`, String(m.text ?? "")); return; // a task lane's text is never sent
      case "busy": { // the runner still runs this lane (race after a restart): put the request back, wait for that turn's result
        const L = lane(m.lane);
        L.queue.unshift(...(L.inflight?.raw ?? []).map((text) => ({ text, id: null })));
        L.inflight = { raw: [], ids: [], answered: L.inflight?.answered ?? null };
        return save();
      }
      case "result": return onResult(m);
      case "notify": {
        if (m.kind !== "done" && m.kind !== "critical") return;
        if (m.nid != null && !validId(m.nid)) return log("rejected notify id");
        if (m.kind === "critical") {
          if (!new RegExp(`^${CODE_PATTERN}$`, "i").test(String(m.code))) return log("rejected critical code");
          S.codes[String(m.code).toLowerCase()] = { lane: m.lane, ts: now() };
          save();
        }
        if (m.kind === "done" && m.lane !== "chat") { lane(m.lane).done = true; save(); } // the chat lane never ends
        return sendOnce(`n:${m.nid ?? now()}`, String(m.text ?? ""));
      }
    }
  }
  const validSession = (x) => typeof x === "string" && /^[\w.-]{1,100}$/.test(x);

  async function onResult(m) {
    const L = lane(m.lane);
    const answered = L.inflight?.answered ?? null;
    L.inflight = null;
    const fresh = L.fresh;
    L.fresh = false;
    if (validSession(m.sessionId) && !fresh) S.sessions[m.lane] = m.sessionId;
    // The answer file stays until the resumed turn has finished successfully: the hook reads it on every attempt.
    if (answered && !m.error) { try { unlinkSync(inside(answersDir, `${answered}.json`)); } catch { /* already gone */ } }
    if (m.usage && !m.error) {
      const u = (S.usage[today()] ??= { turns: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0 });
      u.turns++; u.input += m.usage.input_tokens ?? 0; u.output += m.usage.output_tokens ?? 0;
      u.cache_read += m.usage.cache_read_input_tokens ?? 0; u.cache_creation += m.usage.cache_creation_input_tokens ?? 0;
    }
    if (m.error && m.error !== "stopped") await sendOnce(`err:${m.lane}:${now()}`, `Turn ${m.lane === "chat" ? "chat" : `task ${m.lane}`} error: ${String(m.error).slice(0, 300)}`);
    if (m.deferred) {
      if (m.deferred.name === "AskUserQuestion" && validId(m.deferred.id)) await enqueueQuestion({ id: m.deferred.id, kind: "ask-user", lane: m.lane, input: m.deferred.input, questions: questionsOf(m.deferred.input) });
      else log(`rejected deferred tool ${String(m.deferred.name).slice(0, 40)} id ${String(m.deferred.id).slice(0, 40)}`);
    }
    if (L.done && !L.queue.length && !hasQuestion(m.lane)) {
      delete S.lanes[m.lane]; delete S.sessions[m.lane]; delete S.tasks[m.lane];
      save();
      return showHead();
    }
    save();
    pump(m.lane);
    return showHead();
  }

  return {
    state: S,
    onMessage: serial(onMessage), onVote: serial(onVote), onRunnerEvent: serial(onRunnerEvent), showHead: serial(showHead),
    flushPending: serial(flushPending),
    onOpen: serial(async () => { if (!S.pairedAt) { S.pairedAt = now(); save(); } return flushPending(); }),
    onRunnerDown() { runnerUp = false; },
    sweep() {
      for (const id of sweepGrants(xchg, now())) delete S.grants[id];
      // answer files and stale handshake files the bridge itself wrote: nobody else can delete them
      try {
        for (const f of readdirSync(answersDir)) {
          const age = now() - statSync(join(answersDir, f)).mtimeMs;
          if (age > (f.startsWith(".hello-") ? 600_000 : 24 * 3600_000)) unlinkSync(join(answersDir, f));
        }
      } catch { /* dir missing in a test */ }
      save();
    },
  };
}

// ---------- process wiring ----------
async function main() {
  const env = process.env;
  const dir = env.WA_BRIDGE_DIR ?? "/home/bridge/wa", xchg = env.WA_XCHG_DIR ?? "/xchg";
  const owner = env.WA_OWNER_JID;
  if (!owner) throw new Error("WA_OWNER_JID is required");
  const log = (m) => process.stderr.write(`bridge: ${m}\n`);
  const state = openState(join(dir, "state.json"));
  const { default: pino } = await import("pino");
  const { default: qrt } = await import("qrcode-terminal");
  const lib = await import("@whiskeysockets/baileys");
  const { createWa, parseOwners, ProxyAgent } = await import("./wa.mjs");
  const proxy = env.HTTPS_PROXY || env.https_proxy;

  let conn = null, core = null;
  const toRunner = (m) => send(conn, m);
  const polls = { get: (id) => state.d.polls[id]?.raw };
  const wa = createWa({
    lib, owners: parseOwners(owner), ownerJid: owner.split(",")[0], authDir: join(dir, "auth"), xchg, polls,
    logger: pino({ level: env.WA_LOG_LEVEL ?? "warn" }), agent: proxy ? new ProxyAgent(proxy) : undefined,
    fetchVersion: env.WA_FETCH_VERSION !== "0", qr: (q) => qrt.generate(q, { small: true }), log,
    onMessage: (n) => core.onMessage(n), onVote: (v) => core.onVote(v), onOpen: () => core.onOpen(),
  });
  core = createCore({ state, xchg, wa, toRunner, log });
  core.sweep();
  setInterval(() => core.sweep(), 3600 * 1000).unref();

  // Runner connection with reconnect; one ping per 30 s as the health check.
  const sockPath = join(xchg, "sock", "run.sock");
  let pongAt = Date.now();
  const connectRunner = () => {
    const s = net.connect(sockPath);
    s.on("connect", () => { conn = s; send(s, { op: "hello", role: "bridge" }); });
    attach(s, (m) => { if (m.ev === "pong") { pongAt = Date.now(); try { safeWrite(join(dir, "health"), new Date().toISOString()); } catch { /* best effort */ } } else if (m.ev === "bye") process.exit(0); else core.onRunnerEvent(m).catch((e) => log(`event ${m.ev}: ${e.stack}`)); });
    s.on("error", () => {});
    s.on("close", () => { if (conn === s) conn = null; core.onRunnerDown(); setTimeout(connectRunner, 2000); });
  };
  connectRunner();
  setInterval(() => { send(conn, { op: "ping" }); if (Date.now() - pongAt > 90000 && conn) conn.destroy(); }, 30000).unref();

  await wa.start();
  // SIGTERM: stop taking messages, let the runner finish the turn up to 20 s, then cancel (PLAN phase 2 table).
  process.on("SIGTERM", () => { wa.stop(); send(conn, { op: "shutdown", graceMs: 20000 }); setTimeout(() => process.exit(0), 25000).unref(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { process.stderr.write(`bridge: ${e.stack}\n`); process.exit(1); });
