// WhatsApp side of the bridge: Baileys socket, owner-only gate, normalized events, polls with persisted creation
// messages (PLAN 2.2, 2.2.1, 5.2 item 1). It can only send to the owner: every send function takes no JID.
//
// Parts adapted from Hermes Agent's WhatsApp bridge (scripts/whatsapp-bridge/bridge.js and bridge_helpers.js,
// github.com/NousResearch/hermes-agent @ 5df966a), MIT License, Copyright (c) 2025 Nous Research:
// the 'notify' + 'append' upsert handling, the LID twin (`remoteJidAlt`) idea, and the poll-vote decryption that
// tries creator and voter JID candidates (`pollUpdateForAggregation`). Everything else here is written for Gremio.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { safeWrite } from "./state.mjs";

// ---------- owner gate ----------
const bare = (jid) => String(jid ?? "").replace(/:\d+(?=@)/, ""); // drop the device suffix
export const parseOwners = (s) => new Set(String(s ?? "").split(",").map((x) => bare(x.trim())).filter(Boolean));

// True only for a 1:1 chat message typed by an owner JID. Matches the sender (phone form or its LID twin), never a room.
export function isOwnerMessage(msg, owners) {
  const k = msg?.key;
  if (!k || k.fromMe || !k.remoteJid) return false;
  const chat = bare(k.remoteJid);
  if (/@(g\.us|broadcast|newsletter|status)$/.test(chat) || chat.startsWith("status@")) return false;
  if (k.participant && !owners.has(bare(k.participant)) && !owners.has(bare(k.participantAlt))) return false;
  return [chat, bare(k.remoteJidAlt)].some((id) => id && owners.has(id));
}

// ---------- normalizing ----------
const WRAPPERS = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "documentWithCaptionMessage", "editedMessage"];
export function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const w = WRAPPERS.find((k) => m[k]?.message);
    if (!w) break;
    m = m[w].message;
  }
  return m ?? {};
}
const num = (v) => Number(v?.toString?.() ?? v ?? 0);

export function normalizeMessage(msg) {
  const m = unwrap(msg.message);
  const media = ["imageMessage", "documentMessage", "audioMessage", "videoMessage"].find((k) => m[k]);
  const text = m.conversation ?? m.extendedTextMessage?.text ?? (media ? m[media].caption : "") ?? "";
  return { id: msg.key.id, ts: num(msg.messageTimestamp), text: text ?? "", media: media ? { kind: media.replace("Message", ""), mimetype: m[media].mimetype ?? "", fileName: m[media].fileName ?? "" } : null, pollUpdate: m.pollUpdateMessage ?? null };
}

// ---------- poll votes (Hermes bridge_helpers.js pollUpdateForAggregation, condensed) ----------
export const pollSecret = (creation) => creation?.message?.messageContextInfo?.messageSecret ?? creation?.messageContextInfo?.messageSecret ?? null;
const uniq = (a) => [...new Set(a.map((x) => String(x ?? "").trim()).filter(Boolean))];

// creation: the persisted sent poll message (decoded). lib: {decryptPollVote, getAggregateVotesInPollMessage, getKeyAuthor}.
// Returns the selected option labels, [] for a deselect, or null when the vote cannot be decrypted.
export function decodeVote({ creation, pollUpdate, voterJids, creatorJids, meId, lib }) {
  const secret = pollSecret(creation);
  const creationKey = pollUpdate.pollCreationMessageKey;
  const updateKey = pollUpdate.pollUpdateMessageKey ?? pollUpdate.key;
  if (!secret || !creationKey?.id || !pollUpdate.vote?.encPayload || !pollUpdate.vote?.encIv) return null;
  for (const pollCreatorJid of uniq([...creatorJids, lib.getKeyAuthor(creationKey, meId)])) {
    for (const voterJid of uniq([...voterJids, updateKey ? lib.getKeyAuthor(updateKey, meId) : ""])) {
      try {
        const vote = lib.decryptPollVote(pollUpdate.vote, { pollCreatorJid, pollMsgId: creationKey.id, pollEncKey: secret, voterJid });
        const agg = lib.getAggregateVotesInPollMessage({ message: creation.message, pollUpdates: [{ pollUpdateMessageKey: updateKey, vote, senderTimestampMs: pollUpdate.senderTimestampMs }] }, meId);
        return agg.filter((o) => (o.voters ?? []).length > 0 && o.name && o.name !== "Unknown").map((o) => o.name);
      } catch { /* try the next candidate pair */ }
    }
  }
  return null;
}

// ---------- CONNECT proxy agent (Baileys takes `agent` and `fetchAgent`; D9 wants all egress through wa-egress) ----------
// Checked in rc13 (lib/Utils/messages-media.js): `agent` covers the websocket; media download and upload use native fetch,
// which ignores an https.Agent (it needs an undici dispatcher). So media bypasses this proxy unless the container runs with
// NODE_USE_ENV_PROXY=1 (Node 24 built-in; UNVERIFIED here). Phase 4 decides; undici is not a declared dependency.
export class ProxyAgent extends https.Agent {
  constructor(proxyUrl) { super({ keepAlive: false }); this.proxy = new URL(proxyUrl); }
  createConnection(opts, cb) {
    const target = `${opts.host}:${opts.port || 443}`;
    const req = http.request({ host: this.proxy.hostname, port: this.proxy.port || 80, method: "CONNECT", path: target, headers: { Host: target } });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return cb(new Error(`proxy refused CONNECT ${target}: ${res.statusCode}`)); }
      cb(null, tls.connect({ socket, servername: opts.servername || opts.host }));
    });
    req.once("error", cb);
    req.end();
  }
}

// ---------- the socket ----------
// lib: the Baileys module (injected so tests can fake it). polls: {get(id) -> raw JSON string | undefined}.
export function createWa({ lib, owners, ownerJid, authDir, xchg, polls, onMessage, onVote, onOpen, logger, agent, fetchVersion = true, qr = () => {}, log = () => {} }) {
  const outRetryMs = [2000, 5000, 10000];
  let sock = null, open = false, stopped = false, backoff = 1000;
  let waiters = [];
  const decode = (raw) => JSON.parse(raw, lib.BufferJSON.reviver);

  async function connect() {
    if (stopped) return;
    const { state, saveCreds } = await lib.useMultiFileAuthState(authDir);
    let version;
    if (fetchVersion) { try { version = (await lib.fetchLatestBaileysVersion()).version; } catch (e) { log(`version fetch failed, using the bundled one: ${e.message}`); } }
    sock = lib.makeWASocket({
      ...(version ? { version } : {}), auth: state, logger, printQRInTerminal: false, browser: ["Gremio", "Chrome", "120.0"],
      syncFullHistory: false, markOnlineOnConnect: false, ...(agent ? { agent, fetchAgent: agent } : {}),
      // Baileys needs this for E2EE retries and poll votes: serve the persisted poll creation message, else a placeholder.
      getMessage: async (key) => { const raw = polls.get(key?.id); return raw ? decode(raw).message : { conversation: "" }; },
    });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (u) => {
      if (u.qr) qr(u.qr);
      if (u.connection === "open") { open = true; backoff = 1000; waiters.splice(0).forEach((w) => w()); onOpen?.(); addOwnerLids(); }
      if (u.connection === "close") {
        open = false;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === lib.DisconnectReason.loggedOut) { log("logged out: pair again (phase 4)"); stopped = true; return; }
        if (stopped) return;
        setTimeout(() => connect().catch((e) => log(`reconnect failed: ${e.message}`)), backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    });
    // WhatsApp now addresses 1:1 senders by LID; learn each owner phone JID's LID from the server (seen 2026-11-12:
    // the owner's first message arrived as <lid>@lid with no remoteJidAlt and no stored mapping, and was dropped).
    async function addOwnerLids() {
      const m = sock?.signalRepository?.lidMapping;
      for (const pn of [...owners].filter((j) => j.endsWith("@s.whatsapp.net"))) {
        try { const lid = await m?.getLIDForPN?.(pn); if (lid && !owners.has(bare(lid))) { owners.add(bare(lid)); log("owner LID learned"); } }
        catch (e) { log(`owner LID lookup failed: ${e.message}`); }
      }
    }
    // Both types: messages sent while the pod was down can arrive as `append` after a reconnect (PLAN 2.2).
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;
      for (const msg of messages ?? []) {
        if (!msg.message) continue;
        if (!msg.key?.remoteJidAlt && /@lid$/.test(msg.key?.remoteJid ?? "")) {
          try { const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(msg.key.remoteJid); if (pn) msg.key.remoteJidAlt = pn; } catch { /* no mapping yet */ }
        }
        if (!isOwnerMessage(msg, owners) && /@lid$/.test(msg.key?.remoteJid ?? "")) await addOwnerLids();
        if (!isOwnerMessage(msg, owners)) { log(`dropped message from ${String(msg.key?.remoteJid).replace(/\d(?=\d{4})/g, "*")}`); continue; }
        const n = normalizeMessage(msg);
        if (n.pollUpdate) { handleVote(msg, n.pollUpdate); continue; }
        if (n.media) { try { n.files = [await saveMedia(msg, n)]; } catch (e) { log(`media failed: ${e.message}`); } }
        try { await onMessage(n); } catch (e) { log(`onMessage failed: ${e.stack}`); }
      }
    });
    // Votes may also arrive as message updates.
    sock.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates ?? []) {
        for (const pu of update?.pollUpdates ?? []) handleVote({ key: pu.pollUpdateMessageKey ?? key }, { ...pu, pollCreationMessageKey: pu.pollCreationMessageKey ?? key });
      }
    });
  }

  function handleVote(msg, pollUpdate) {
    const pollId = pollUpdate.pollCreationMessageKey?.id;
    const raw = pollId && polls.get(pollId);
    if (!raw) return;
    const me = (lib.jidNormalizedUser ?? ((x) => x))(sock?.user?.id ?? "me");
    const lid = (lib.jidNormalizedUser ?? ((x) => x))(sock?.user?.lid ?? "");
    let options = null;
    try {
      options = decodeVote({
        creation: decode(raw), pollUpdate, meId: me, lib,
        creatorJids: [lid, me],
        voterJids: [bare(msg.key?.participant), bare(msg.key?.remoteJid), bare(msg.key?.remoteJidAlt), bare(ownerJid)],
      });
    } catch (e) { log(`vote decode failed: ${e.message}`); }
    Promise.resolve(onVote?.({ pollId, options })).catch((e) => log(`onVote failed: ${e.message}`));
  }

  // Media goes to /xchg/inbox (the worker reads it there); the bridge only saves bytes, never parses them (PLAN 5.3).
  async function saveMedia(msg, n) {
    const buf = await lib.downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
    const ext = (n.media.fileName.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? ({ image: ".jpg", video: ".mp4", audio: ".ogg", document: "" })[n.media.kind] ?? "");
    const path = join(xchg, "inbox", `${n.id.replace(/[^\w-]/g, "_")}${ext}`);
    mkdirSync(join(xchg, "inbox"), { recursive: true });
    safeWrite(path, buf, 0o644);
    return path;
  }

  const ready = () => (open ? Promise.resolve() : new Promise((r) => waiters.push(r)));
  // Sends wait for the socket and retry a few times; the caller keeps a pending list when this finally throws.
  async function withRetry(fn) {
    let err;
    for (let i = 0; i <= outRetryMs.length; i++) {
      try { await Promise.race([ready(), new Promise((_, rej) => setTimeout(() => rej(new Error("socket not open")), 30000))]); return await fn(); } catch (e) {
        err = e;
        if (i < outRetryMs.length) await new Promise((r) => setTimeout(r, outRetryMs[i]));
      }
    }
    throw err;
  }

  const to = bare(ownerJid);
  return {
    start: connect,
    stop() { stopped = true; try { sock?.end?.(undefined); } catch { /* closing */ } },
    isOpen: () => open,
    composing: () => sock?.sendPresenceUpdate?.("composing", to).catch(() => {}),
    // id: deterministic message id, so a resend after a crash is the same message to WhatsApp (UNVERIFIED that it dedupes).
    sendText: (text, { id } = {}) => withRetry(() => sock.sendMessage(to, { text }, id ? { messageId: id } : {})),
    // Returns {id, raw}: the poll creation message, JSON-encoded for state.json (messageSecret included).
    sendPoll: (name, values, { id, multi = false } = {}) => withRetry(async () => {
      const sent = await sock.sendMessage(to, { poll: { name, values, selectableCount: multi ? values.length : 1 } }, id ? { messageId: id } : {});
      return { id: sent.key.id, raw: JSON.stringify(sent, lib.BufferJSON.replacer) };
    }),
  };
}

export const messageId = (key, i = 0) => "GR" + createHash("sha1").update(`${key}#${i}`).digest("hex").slice(0, 30).toUpperCase();
