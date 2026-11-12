// Bridge container main (PLAN 2.1, 2.2, 2.3, 2.12). Uid 1002: holds the WhatsApp session and state.json, never a
// model, GitHub or Multica credential. This file is the routing core plus startup and shutdown; the Baileys socket is
// in wa.mjs and everything that runs `claude` is in runner.mjs, reached over /xchg/sock/run.sock.
//
// Core rules: the bridge sends to the owner (wa.sendText has no JID argument) and, for a group lane, to the group that lane was
// created for (wa.sendGroup, destination from S.groups only; PLAN 2.13); the 👀 reaction and the ack line follow the same two
// destinations (wa.react: the owner, or the message's own group); routing order for an inbound owner text is (1)
// `done|deny <kode>`, (2) the head question, (3) the chat lane; one FIFO question queue across the owner's lanes; a group
// message never enters that routing (no grants, no owner answers, only /baru); the bridge starts every turn and owns every
// session id; every write goes through safeWrite.
import net from "node:net";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { openState, safeWrite } from "./state.mjs";
import { CODE_PATTERN, PR_URL, deleteGrant, isMergeYes, parseApproval, pushMainOrder, sweepGrants, writeGrant } from "./grants.mjs";
import { parseCommand } from "./commands.mjs";
import { questionsOf } from "./stream.mjs";
import { attach, send } from "./ipc.mjs";
import { MEDIA_CAPS, messageId } from "./wa.mjs";
import { createHealth, httpGet } from "./health.mjs";
import { groupLaneId, inside, isGroupLane, validFile, validId } from "./ids.mjs";

const MAX_TEXT = 4000; // WhatsApp message length we split at (UNVERIFIED limit, PLAN 2.2 step 4)
const POLL_MAX_OPTIONS = 12;
const CODE_TTL_MS = 24 * 3600 * 1000;
const POLL_UNREADABLE = "poll-nya gak kebaca, jawab pakai angka aja ya";
// Acknowledge work (owner decision 2026-11-12): a reaction at once, and one short line when a turn has said nothing for ACK_MS.
const ACK_MS = 15000;
const REACT_MS = 5000; // the 👀 shows only when no reply came within 5 s
const ACK_LINES = ["Oke, lagi aku kerjain ya.", "Siap, bentar ya, lagi aku cek.", "Sip, aku proses dulu ya.", "Oke, bentar ya, lagi aku urus."];
const ackLine = (msgId) => ACK_LINES[parseInt(messageId(`ack-line:${msgId}`).slice(2, 6), 16) % ACK_LINES.length];
const mb = (kind) => MEDIA_CAPS[kind] / 1024 / 1024;
const MEDIA_LABEL = { image: "gambar", sticker: "stiker", video: "video" };

// What the model reads for one message's media (owner DM or group). A video is only named here: the runner swaps the
// marker for extracted frames before the turn (it cannot be read directly). Others (document, audio) keep `[file: path]`.
export function mediaNotes(n) {
  const md = n.media, label = MEDIA_LABEL[md?.kind];
  if (!label) return { notes: (n.files ?? []).map((f) => `[file: ${f}]`), videos: [] };
  if (md.tooLarge) return { notes: [`[${label}: terlalu besar (>${mb(md.kind)} MB), dilewati]`], videos: [] };
  if (!md.path) return { notes: [], videos: [] };
  if (md.kind === "video") return { notes: [`[video: ${basename(md.path)}]`], videos: [{ name: basename(md.path), seconds: md.seconds || 0 }] };
  return { notes: [`[${label}: ${md.path}]`], videos: [] };
}

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

export function renderQuestion(head, { group = false } = {}) {
  const q = head.questions[head.cursor];
  const n = head.questions.length > 1 ? `(${head.cursor + 1}/${head.questions.length}) ` : "";
  const list = q.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  // A group answer has to address Gremio too, or the group gate ignores it; no polls in a group.
  const how = group ? "\n(balas pesan ini, atau awali dengan \"gremio\": angka atau jawaban bebas)" : q.options.length ? (q.multiSelect ? "\n(jawab angka dipisah koma, atau ketik jawaban bebas)" : "\n(jawab angka, pilih di poll, atau ketik jawaban bebas)") : "";
  return `${n}${q.question}${list ? "\n" + list : ""}${how}`;
}

export function createCore({ state, xchg, wa, toRunner, groups = new Set(), now = Date.now, log = () => {}, setTimer = (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; }, clearTimer = clearTimeout, ackMs = ACK_MS, reactMs = REACT_MS, statusMs = 2000 }) {
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
  // to: null = the owner; {jid, quote} = a group (the first chunk quotes the message that triggered the reply).
  async function sendOnce(key, text, to = null, retry = true) {
    if (S.outbox[key] || !text.trim()) return;
    const parts = splitText(text);
    try {
      for (let i = 0; i < parts.length; i++) {
        if (to) await wa.sendGroup(to.jid, parts[i], { id: messageId(key, i), ...(i === 0 && to.quote ? { quote: to.quote } : {}) });
        else await wa.sendText(parts[i], { id: messageId(key, i) });
      }
      S.outbox[key] = now();
    } catch (e) {
      log(`send failed${retry ? ", kept for retry" : ""}: ${e.message}`);
      if (retry) S.pendingOut.push({ key, text, ...(to ? { to } : {}) });
    }
    save();
  }
  async function flushPending() {
    const list = S.pendingOut.splice(0);
    save();
    for (const p of list) await sendOnce(p.key, p.text, p.to ?? null);
  }
  // The destination of a group lane: the JID its first gated message registered, still allowed today (a family group removed
  // from WA_GROUP_JIDS stops receiving), with the message to quote. Null for anything else.
  const laneDest = (id) => {
    const g = isGroupLane(id) ? S.groups[id] : null;
    if (!g || groupLaneId(g.jid) !== id || (g.family && !groups.has(g.jid))) return null;
    return { jid: g.jid, quote: S.lanes[id]?.quote ?? null };
  };

  // ---- turns ----
  const hasQuestion = (id) => (isGroupLane(id) ? !!S.gq[id]?.length : S.queue.some((q) => q.lane === id));
  // One group turn at a time across all groups: each is one more `claude` process on top of chat and the task lane (D20 memory budget).
  const groupBusy = (id) => Object.entries(S.lanes).some(([k, l]) => k !== id && isGroupLane(k) && l.inflight);
  function pump(id) {
    const L = S.lanes[id];
    // A lane with a question waiting runs nothing: its only next turn is the empty resume after the answer.
    if (!L || !runnerUp || L.inflight || !L.queue.length || hasQuestion(id)) return;
    const group = isGroupLane(id);
    if (group && groupBusy(id)) return;
    // A group turn is one message from one sender, so the owner flag below describes exactly that sender.
    const items = L.resumeFirst || group ? [L.queue.shift()] : L.queue.splice(0);
    L.resumeFirst = false;
    const raw = items.map((i) => i.text).filter(Boolean);
    const videos = items.flatMap((i) => i.videos ?? []);
    L.inflight = { raw, ids: items.map((i) => i.id).filter(Boolean), answered: items.find((i) => i.answered)?.answered ?? null, ...(videos.length ? { videos } : {}), ...(group ? { fromOwner: items[0].fromOwner === true } : {}) };
    if (group && items[0].quote) L.quote = items[0].quote;
    save();
    startAck(id, items.find((i) => i.ack)?.id);
    toRunner({ op: "turn", lane: id, task: id === "chat" || group ? undefined : id, session: S.sessions[id] ?? null, prompt: items.map((i) => (i.pre ? `${i.pre}\n${i.text}` : i.text)).filter(Boolean).join("\n\n"), origin: L.inflight.ids, ...(videos.length ? { videos } : {}), ...(group ? { group: true, fromOwner: L.inflight.fromOwner } : {}) });
  }
  // extra: pre (what the message replies to: for the model only, it stays out of `raw`, which grants and requeues read),
  // videos (the runner turns them into frames) and ack (a user message that gets a reaction and maybe an ack line).
  function enqueue(id, text, msgId, extra = {}) { if (!known(id)) return log(`no lane ${id}`); lane(id).queue.push({ text, id: msgId ?? null, ...extra }); save(); pump(id); }

  // ---- acknowledge work: one reaction at once, one line when the turn has sent no text for ackMs (no model call) ----
  const acks = new Map(); // lane -> {msgId, timer}: only while the turn that msgId started is running
  const cancelAck = (id) => { const a = acks.get(id); if (a) { clearTimer(a.timer); acks.delete(id); } };
  const fireAck = serial(async (id, a) => {
    if (acks.get(id) !== a) return;
    acks.delete(id);
    const to = isGroupLane(id) ? laneDest(id) : null;
    if (!S.lanes[id]?.inflight || (isGroupLane(id) && !to) || wa.isOpen?.() === false) return;
    await sendOnce(`ack:${a.msgId}`, ackLine(a.msgId), to, false); // a late ack is worse than none: no retry list
  });
  function startAck(id, msgId) {
    cancelAck(id);
    if (!msgId || S.outbox[`ack:${msgId}`]) return;
    const a = { msgId, timer: null };
    a.timer = setTimer(() => fireAck(id, a).catch((e) => log(`ack failed: ${e.message}`)), ackMs);
    acks.set(id, a);
  }
  // The 👀 waits reactMs (owner 2026-11-12): a quick reply makes it unnecessary, so any reply text on the lane cancels it.
  const reacts = new Map(); // lane -> timer
  const cancelReact = (id) => { const t = reacts.get(id); if (t) { clearTimer(t); reacts.delete(id); } };
  const deferReact = (id, key, group) => { cancelReact(id); if (key && reactMs <= 0) return react(key, group); if (key) reacts.set(id, setTimer(() => { reacts.delete(id); react(key, group); }, reactMs)); };
  // Best effort and never awaited: a reaction must not hold the serial chain while the socket is down.
  const react = (key, group) => { if (key) Promise.resolve(group ? wa.react?.(key, { jid: group }) : wa.react?.(key)).catch((e) => log(`reaction failed: ${e.message}`)); };

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

  // ---- group questions: a group lane's AskUserQuestion is asked in its group, in that lane's own small queue ----
  async function showGroupHead(id) {
    const head = S.gq[id]?.[0], to = laneDest(id);
    if (!head || head.shown || !to) return;
    await sendOnce(`q:${head.id}:${head.cursor}`, renderQuestion(head, { group: true }), to);
    head.shown = true;
    save();
  }
  function enqueueGroupQuestion(entry) {
    const q = (S.gq[entry.lane] ??= []);
    if (!q.some((x) => x.id === entry.id)) { q.push({ cursor: 0, answers: {}, shown: false, ...entry }); save(); }
    return showGroupHead(entry.lane);
  }
  // Any gated message in the group answers its head question. No grant is ever written from here, whatever the question says.
  async function answerGroupHead(id, text, g) {
    const head = S.gq[id][0];
    const q = head.questions[head.cursor];
    head.answers[q.question] = parseAnswer(q, text);
    head.cursor++;
    if (head.cursor < head.questions.length) { head.shown = false; save(); return showGroupHead(id); }
    safeWrite(inside(answersDir, `${head.id}.json`), JSON.stringify({ questions: head.input?.questions ?? [], answers: head.answers }), 0o644);
    S.gq[id].shift();
    if (!S.gq[id].length) delete S.gq[id];
    lane(id).queue.unshift({ text: "", id: null, answered: head.id, quote: g.quote, fromOwner: g.fromOwner === true });
    lane(id).resumeFirst = true;
    save();
    pump(id);
    return showGroupHead(id);
  }

  // ---- inbound ----
  // The sender's name as the model sees it: one line, no brackets, and "(owner)" only where the WhatsApp layer proved it.
  const labelOf = (g) => `${String(g.name ?? "").replace(/[\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "?"}${g.fromOwner === true ? " (owner)" : ""}`;
  const preOf = (q) => (q?.text ? `[membalas ${String(q.author ?? "?").replace(/[\[\]\n]/g, " ")}]: ${q.text}` : "");
  const ADDRESS = /^\s*(?:(?:@\d+|gremio)\b[\s,:;.!-]*)+/i;
  // A group message: its own lane per group, never route(). Allowed when the group is in the family list or the sender is the owner.
  async function onGroupMessage(n) {
    const g = n.group, id = groupLaneId(g.jid);
    const { notes, videos } = mediaNotes(n);
    const text = [n.text?.trim(), ...notes].filter(Boolean).join("\n"); // a caption-less sticker or image is a message too
    if (!id || !text || !(groups.has(g.jid) || g.fromOwner === true)) return;
    S.groups[id] = { jid: g.jid, family: groups.has(g.jid) };
    S.lanes[id] ??= newLane();
    const bare = (n.text ?? "").replace(ADDRESS, "");
    const cmd = parseCommand(bare);
    if (cmd) { // only /baru works in a group: /stop, /status and /memori belong to the owner's own chat
      if (cmd !== "baru") return save();
      const L = lane(id);
      delete S.sessions[id];
      delete S.gq[id];
      L.queue = [];
      if (L.inflight) L.fresh = true;
      L.quote = g.quote;
      save();
      return sendOnce(`cmd:${id}:${now()}`, "Sesi baru.", laneDest(id));
    }
    if (S.gq[id]?.length) return answerGroupHead(id, bare.trim() ? bare : text, g);
    const pre = preOf(n.quoted);
    lane(id).queue.push({ text: `[${labelOf(g)}] ${pre ? pre + "\n" : ""}${text}`, id: n.id, quote: g.quote, fromOwner: g.fromOwner === true, ack: true, ...(videos.length ? { videos } : {}) });
    save();
    if (laneDest(id)) deferReact(id, g.quote?.key, g.jid);
    return pump(id);
  }

  async function onMessage(n) {
    if (S.inbox[n.id]) return log(`duplicate ${n.id}`);
    // Cutoff is the pairing time, not the newest message: a message that was late (a reconnect `append`) is still his,
    // while the history sync after pairing is older than pairedAt. Duplicates are caught by the id ledger above.
    if (n.ts < Math.floor((S.pairedAt ?? now()) / 1000)) return log(`dropped old message ${n.id} (history sync or replay)`);
    S.inbox[n.id] = n.ts;
    S.lastTs = Math.max(S.lastTs, n.ts);
    save();
    if (n.group) return onGroupMessage(n);
    wa.composing();
    const { notes, videos } = mediaNotes(n);
    const text = [n.text, ...notes].filter(Boolean).join("\n");
    if (!text) return;
    const cmd = parseCommand(text);
    if (cmd) return runCommand(cmd);
    return route(text, n.id, { pre: preOf(n.quoted), key: n.key, videos });
  }

  async function route(text, msgId, { pre, key, videos = [] } = {}) {
    const ap = parseApproval(text);
    const rec = ap && S.codes[ap.code];
    if (rec && known(rec.lane) && now() - rec.ts < CODE_TTL_MS) { // (1) goes to the lane whose message carried the code
      const g = writeGrant(xchg, "approval", { code: ap.code, verb: ap.verb }, now());
      S.grants[g.id] = { kind: "approval", ts: g.created_at };
      return enqueue(rec.lane, text, msgId);
    }
    if (S.queue[0]) return answerHead(parseAnswerFor(S.queue[0], text), text); // (2) the head question
    deferReact("chat", key);
    return enqueue("chat", text, msgId, { ...(pre ? { pre } : {}), ...(videos.length ? { videos } : {}), ack: true }); // (3) the chat lane
  }
  const parseAnswerFor = (head, text) => (head.kind === "ask-owner" ? text : parseAnswer(head.questions[head.cursor], text));

  async function onVote({ pollId, options }) {
    const p = S.polls[pollId], head = S.queue[0];
    if (!p || !head || head.id !== p.qid || head.cursor !== p.cursor) return log("vote for a poll that is not the head question");
    if (options === null) return sendOnce(`unreadable:${pollId}:${now()}`, POLL_UNREADABLE); // keeps the question at the head
    if (!options.length) return;
    return answerHead(options.join(", "), options.join(", "));
  }

  // ---- /status: how long a running turn has run and its last guarded action, asked of the runner (it alone knows) ----
  const statusWait = new Map(); // request id -> resolve
  let statusSeq = 0;
  function askRunnerStatus() {
    const id = `st${++statusSeq}`;
    return new Promise((res) => {
      const t = setTimeout(() => { statusWait.delete(id); res(null); }, statusMs);
      statusWait.set(id, (lanes) => { clearTimeout(t); res(lanes); });
      toRunner({ op: "status", id });
    });
  }
  // The reply must not wait in the serial chain: the /status command that asked is holding it.
  function onStatusReply(m) {
    const done = statusWait.get(String(m.id));
    if (done) { statusWait.delete(String(m.id)); done(m.lanes && typeof m.lanes === "object" ? m.lanes : null); }
  }
  function runInfo(live, id) {
    const r = live && Object.hasOwn(live, id) ? live[id] : null;
    if (!r || !Number.isFinite(r.ms) || r.ms < 0) return "";
    const last = typeof r.last === "string" ? r.last.split("\n")[0].slice(0, 60).trim() : "";
    return ` ${r.ms < 60000 ? `${Math.floor(r.ms / 1000)} dtk` : `${Math.floor(r.ms / 60000)} mnt`}${last ? `, lagi: ${last}` : ""}`;
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
      const live = Object.values(S.lanes).some((L) => L.inflight) && runnerUp ? await askRunnerStatus() : null; // {lane: {ms, last}} from the runner, null when it does not answer
      for (const [id, L] of Object.entries(S.lanes)) lines.push(`${id}: ${L.inflight ? `jalan${runInfo(live, id)}` : "diam"}${L.queue.length ? `, antrean ${L.queue.length}` : ""}${hasQuestion(id) ? ", nunggu jawaban" : ""}`);
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
        for (const t of Array.isArray(m.tasks) ? m.tasks : []) if (validId(t) && t !== "chat" && !isGroupLane(t)) S.lanes[t] ??= newLane(); // lanes the runner still has
        const alive = new Set([...(m.busy ?? []), ...(m.buffered ?? [])]); // running, or finished with the result about to be replayed
        for (const [id, L] of Object.entries(S.lanes)) {
          if (L.inflight && !alive.has(id)) { // the turn died with the runner: resume it (CLAUDE_CODE_RESUME_INTERRUPTED_TURN)
            const raw = L.inflight.raw;
            L.inflight = null;
            L.queue.unshift({ text: S.sessions[id] ? "" : raw.join("\n\n"), id: null, ...(isGroupLane(id) ? { fromOwner: L.inflight?.fromOwner === true } : {}) });
          }
        }
        save();
        for (const id of Object.keys(S.lanes)) pump(id);
        for (const id of Object.keys(S.gq)) await showGroupHead(id);
        return showHead();
      }
      case "task-started": {
        if (!validId(m.task) || m.task === "chat" || isGroupLane(m.task)) return log(`rejected task id ${String(m.task).slice(0, 40)}`);
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
        if (!/^ask-[0-9a-f]{16,64}$/.test(String(m.rid)) || !known(m.lane) || isGroupLane(m.lane)) return log("rejected ask"); // a group lane never reaches the owner's queue
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
      case "text": { // a task lane's text is never sent; a group lane's goes to its own group
        if (typeof m.key !== "string" || m.key.length > 200) return;
        if (String(m.text ?? "").trim()) { cancelAck(m.lane); cancelReact(m.lane); }
        if (m.lane === "chat") return sendOnce(`t:${m.key}`, String(m.text ?? ""));
        const to = laneDest(m.lane);
        if (to) return sendOnce(`t:${m.key}`, String(m.text ?? ""), to);
        return;
      }
      case "busy": { // the runner still runs this lane (race after a restart): put the request back, wait for that turn's result
        const L = lane(m.lane);
        L.queue.unshift(...(L.inflight?.raw ?? []).map((text) => ({ text, id: null, ...(isGroupLane(m.lane) ? { fromOwner: L.inflight?.fromOwner === true } : {}) })));
        L.inflight = { raw: [], ids: [], answered: L.inflight?.answered ?? null };
        return save();
      }
      case "result": return onResult(m);
      case "notify": {
        if (isGroupLane(m.lane)) return log("rejected notify from a group lane");
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
    cancelAck(m.lane); cancelReact(m.lane);
    // The runner has its frames by now and cannot delete from the bridge-owned inbox: the video goes with the turn.
    for (const v of L.inflight?.videos ?? []) { try { unlinkSync(inside(join(xchg, "inbox"), v.name)); } catch { /* gone */ } }
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
    if (m.error && m.error !== "stopped") await sendOnce(`err:${m.lane}:${now()}`, `Turn ${m.lane === "chat" ? "chat" : isGroupLane(m.lane) ? `grup ${m.lane}` : `task ${m.lane}`} error: ${String(m.error).slice(0, 300)}`);
    if (m.deferred) {
      if (m.deferred.name === "AskUserQuestion" && validId(m.deferred.id)) await (isGroupLane(m.lane) ? enqueueGroupQuestion : enqueueQuestion)({ id: m.deferred.id, kind: "ask-user", lane: m.lane, input: m.deferred.input, questions: questionsOf(m.deferred.input) });
      else log(`rejected deferred tool ${String(m.deferred.name).slice(0, 40)} id ${String(m.deferred.id).slice(0, 40)}`);
    }
    if (L.done && !L.queue.length && !hasQuestion(m.lane)) {
      delete S.lanes[m.lane]; delete S.sessions[m.lane]; delete S.tasks[m.lane];
      save();
      return showHead();
    }
    save();
    pump(m.lane);
    for (const id of Object.keys(S.lanes)) if (isGroupLane(id) && id !== m.lane) pump(id); // a group turn waiting for this one
    return isGroupLane(m.lane) ? showGroupHead(m.lane) : showHead();
  }

  const runnerEvent = serial(onRunnerEvent);
  return {
    state: S,
    onMessage: serial(onMessage), onVote: serial(onVote), onRunnerEvent: (m) => { if (m?.ev === "status") { onStatusReply(m); return Promise.resolve(); } return runnerEvent(m); }, showHead: serial(showHead),
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
  const { createWa, parseGroups, parseOwners, ProxyAgent } = await import("./wa.mjs");
  const proxy = env.HTTPS_PROXY || env.https_proxy;
  const agent = proxy ? new ProxyAgent(proxy) : undefined; // the one proxy agent: Baileys and the health ping

  const groups = parseGroups(env.WA_GROUP_JIDS); // family groups: any member may address Gremio there (PLAN 2.13)
  let conn = null, core = null;
  const toRunner = (m) => send(conn, m);
  const polls = { get: (id) => state.d.polls[id]?.raw };
  const wa = createWa({
    lib, owners: parseOwners(owner), groups, ownerJid: owner.split(",")[0], authDir: join(dir, "auth"), xchg, polls,
    logger: pino({ level: env.WA_LOG_LEVEL ?? "warn" }), agent,
    fetchVersion: env.WA_FETCH_VERSION !== "0", qr: (q) => qrt.generate(q, { small: true }), log,
    onMessage: (n) => core.onMessage(n), onVote: (v) => core.onVote(v), onOpen: () => core.onOpen(),
  });
  core = createCore({ state, xchg, wa, toRunner, groups, log });
  const health = createHealth({ url: env.PING_BRIDGE_URL, isOpen: () => wa.isOpen(), get: (u) => httpGet(u, { agent }), log });
  health.start();
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
  process.on("SIGTERM", () => { health.stop(); wa.stop(); send(conn, { op: "shutdown", graceMs: 20000 }); setTimeout(() => process.exit(0), 25000).unref(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { process.stderr.write(`bridge: ${e.stack}\n`); process.exit(1); });
