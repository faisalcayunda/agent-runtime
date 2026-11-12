// WhatsApp side of the bridge: Baileys socket, owner gate, group gate, normalized events, polls with persisted creation
// messages (PLAN 2.2, 2.2.1, 2.13, 5.2 item 1). It sends to the owner (no send function takes a JID) and, through sendGroup
// and react, to a group JID the bridge picked; both refuse anything that is not a group JID, and react also requires the key
// to be from that same chat.
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
import { REACT_EMOJIS } from "./ack.mjs";

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

// ---------- group gate (PLAN 2.13) ----------
const GROUP_JID = /^\d{5,30}(?:-\d{1,20})?@g\.us$/;
export const parseGroups = (s) => new Set(String(s ?? "").split(",").map((x) => x.trim()).filter((x) => GROUP_JID.test(x)));

// Media the model can look at (owner DM and every allowed group message, owner decision 2026-11-12) and the size above which it is skipped.
const MB = 1024 * 1024;
export const MEDIA_CAPS = { image: 10 * MB, sticker: 10 * MB, video: 20 * MB };
export const ACK_EMOJI = "👀";

const contextOf = (m) => { for (const v of Object.values(m ?? {})) if (v && typeof v === "object" && v.contextInfo) return v.contextInfo; return null; };
const GREMIO_ID = /^GR[0-9A-F]{30}$/; // the shape messageId() gives every message this bridge sends

// True when a group message speaks to Gremio: it mentions the bot (phone JID or LID), quotes a message Gremio sent (its own
// JID as the quoted author, or a quoted id of the shape the bridge generates), or its text starts with "gremio".
export function isAddressed(msg, self) {
  const m = unwrap(msg?.message);
  const ctx = contextOf(m);
  if ([...(ctx?.mentionedJid ?? []), ctx?.participant].some((j) => j && self.has(bare(j)))) return true;
  if (GREMIO_ID.test(String(ctx?.stanzaId ?? ""))) return true;
  return /^\s*gremio\b/i.test(normalizeMessage(msg).text);
}

// The family groups let any member address Gremio; every other group lets only an owner JID do it (phone form, learned LID or
// its LID twin in participantAlt). Everything else returns null and is ignored without a trace. self: bare JIDs of the bot.
export function groupGate(msg, { owners, family, self }) {
  const k = msg?.key;
  if (!k || k.fromMe || !/@g\.us$/.test(bare(k.remoteJid))) return null;
  if (!isAddressed(msg, self)) return null;
  const jid = bare(k.remoteJid);
  const fromOwner = [k.participant, k.participantAlt].some((j) => j && owners.has(bare(j)));
  const isFamily = family.has(jid);
  if (!isFamily && !fromOwner) return null;
  return { jid, fromOwner, family: isFamily };
}

// ---------- quoted message (a reply to something) ----------
const QUOTED_MEDIA = ["imageMessage", "videoMessage", "documentMessage", "audioMessage", "stickerMessage"];
export const QUOTE_MAX = 2000;
export const maskJid = (j) => bare(j).split("@")[0].replace(/\d(?=\d{4})/g, "*");
// What the message replies to, from contextInfo.quotedMessage (+ participant, its author): {author, text} or null. Media is never
// downloaded: it is named as "[media: image]" with its caption. author is "Gremio", "owner", a masked number, or "?".
export function quotedOf(msg, { self = new Set(), owners = new Set() } = {}) {
  const ctx = contextOf(unwrap(msg?.message));
  if (!ctx?.quotedMessage) return null;
  const m = unwrap(ctx.quotedMessage);
  const media = QUOTED_MEDIA.find((k) => m[k]);
  let text = media ? `[media: ${media.replace("Message", "")}]${m[media].caption ? " " + m[media].caption : ""}` : (m.conversation ?? m.extendedTextMessage?.text ?? "");
  if (!String(text).trim()) return null;
  if (text.length > QUOTE_MAX) text = text.slice(0, QUOTE_MAX - 1) + "…";
  const p = bare(ctx.participant);
  return { author: !p ? "?" : self.has(p) ? "Gremio" : owners.has(p) ? "owner" : maskJid(p), text };
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
  const media = ["imageMessage", "documentMessage", "audioMessage", "videoMessage", "stickerMessage"].find((k) => m[k]);
  const text = m.conversation ?? m.extendedTextMessage?.text ?? (media ? m[media].caption : "") ?? "";
  return { id: msg.key.id, ts: num(msg.messageTimestamp), text: text ?? "", media: media ? { kind: media.replace("Message", ""), mimetype: m[media].mimetype ?? "", fileName: m[media].fileName ?? "", size: num(m[media].fileLength), seconds: num(m[media].seconds) } : null, pollUpdate: m.pollUpdateMessage ?? null };
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
export function createWa({ lib, owners, groups = new Set(), ownerJid, authDir, xchg, polls, onMessage, onVote, onOpen, logger, agent, fetchVersion = true, qr = () => {}, log = () => {} }) {
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
      if (u.connection === "open") { open = true; backoff = 1000; waiters.splice(0).forEach((w) => w()); onOpen?.(); addOwnerLids(); listGroups(); }
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
    // To help the owner fill WA_GROUP_JIDS: one line per group (subject and id) while the list is empty. Nothing about members.
    async function listGroups() {
      if (groups.size) return;
      try { for (const g of Object.values((await sock.groupFetchAllParticipating()) ?? {})) log(`group: ${String(g.subject ?? "").replace(/\s+/g, " ").trim()} ${g.id}`); }
      catch (e) { log(`group list failed: ${e.message}`); }
    }
    const selfIds = () => new Set([sock?.user?.id, sock?.user?.lid].filter(Boolean).map(bare));
    // A group message is dealt with only when it addresses Gremio, and then silently dropped unless the gate passes: group
    // chatter and members' names are never logged. Only image, sticker and video are saved from a group, and only after the gate.
    async function groupEvent(msg) {
      const k = msg.key;
      if (k.fromMe || !isAddressed(msg, selfIds())) return null;
      if (k.participant && !k.participantAlt && /@lid$/.test(k.participant)) {
        try { const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(k.participant); if (pn) k.participantAlt = pn; } catch { /* no mapping yet */ }
      }
      let g = groupGate(msg, { owners, family: groups, self: selfIds() });
      if (!g && /@lid$/.test(k.participant ?? "")) { await addOwnerLids(); g = groupGate(msg, { owners, family: groups, self: selfIds() }); }
      if (!g) return null;
      const n = normalizeMessage(msg);
      if (n.pollUpdate) return null;
      if (n.media && n.media.kind in MEDIA_CAPS) await keepMedia(msg, n);
      const quoted = quotedOf(msg, { self: selfIds(), owners });
      return { ...n, ...(quoted ? { quoted } : {}), group: { ...g, name: msg.pushName || maskJid(k.participantAlt ?? k.participant ?? ""), quote: { key: { id: k.id, remoteJid: k.remoteJid, participant: k.participant }, message: { conversation: n.text.slice(0, 200) } } } };
    }
    // Both types: messages sent while the pod was down can arrive as `append` after a reconnect (PLAN 2.2).
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;
      for (const msg of messages ?? []) {
        if (!msg.message) continue;
        if (/@g\.us$/.test(msg.key?.remoteJid ?? "")) {
          const n = await groupEvent(msg);
          if (n) try { await onMessage(n); } catch (e) { log(`onMessage failed: ${e.stack}`); }
          continue;
        }
        if (!msg.key?.remoteJidAlt && /@lid$/.test(msg.key?.remoteJid ?? "")) {
          try { const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(msg.key.remoteJid); if (pn) msg.key.remoteJidAlt = pn; } catch { /* no mapping yet */ }
        }
        if (!isOwnerMessage(msg, owners) && /@lid$/.test(msg.key?.remoteJid ?? "")) await addOwnerLids();
        if (!isOwnerMessage(msg, owners)) { log(`dropped message from ${String(msg.key?.remoteJid).replace(/\d(?=\d{4})/g, "*")}`); continue; }
        const n = normalizeMessage(msg);
        const quoted = quotedOf(msg, { self: selfIds(), owners });
        if (quoted) n.quoted = quoted;
        if (n.pollUpdate) { handleVote(msg, n.pollUpdate); continue; }
        n.key = msg.key; // the bridge reacts to this message (react)
        if (n.media) await keepMedia(msg, n);
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
  // Sets n.files and n.media.path on success, n.media.tooLarge when it is over the kind's cap (the size in the message is only
  // a claim, so the downloaded bytes are checked again), and leaves both unset when the download fails.
  async function keepMedia(msg, n) {
    const cap = MEDIA_CAPS[n.media.kind];
    try {
      if (cap && n.media.size > cap) { n.media.tooLarge = true; return; }
      const buf = await lib.downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (cap && buf.length > cap) { n.media.tooLarge = true; return; }
      const ext = (n.media.fileName.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? ({ image: ".jpg", sticker: ".webp", video: ".mp4", audio: ".ogg", document: "" })[n.media.kind] ?? "");
      const path = join(xchg, "inbox", `${n.id.replace(/[^\w-]/g, "_")}${ext}`);
      mkdirSync(join(xchg, "inbox"), { recursive: true });
      safeWrite(path, buf, 0o644);
      n.files = [path];
      n.media.path = path;
    } catch (e) { log(`media failed: ${e.message}`); }
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
    // The one send that takes a JID, and only a group JID: the bridge maps a group lane to its group and passes nothing else.
    sendGroup: (jid, text, { id, quote } = {}) => (GROUP_JID.test(String(jid)) ? withRetry(() => sock.sendMessage(jid, { text }, { ...(id ? { messageId: id } : {}), ...(quote ? { quoted: quote } : {}) })) : Promise.reject(new Error("not a group JID"))),
    // Reaction to a message the bridge is about to work on: the owner's DM (no jid) or a group message (the group JID, which must
    // be the message's own chat). Same destinations as every other send; best effort, the caller does not wait on it.
    // `emoji` must be on the REACT_EMOJIS allowlist, else the default 👀 goes out.
    react: (key, { jid, emoji } = {}) => {
      if (!key?.id) return Promise.resolve();
      const text = REACT_EMOJIS.includes(emoji) ? emoji : ACK_EMOJI;
      if (jid === undefined) return withRetry(() => sock.sendMessage(to, { react: { text, key } }));
      return GROUP_JID.test(String(jid)) && key.remoteJid === jid ? withRetry(() => sock.sendMessage(jid, { react: { text, key } })) : Promise.reject(new Error("not a group JID"));
    },
    // Returns {id, raw}: the poll creation message, JSON-encoded for state.json (messageSecret included).
    sendPoll: (name, values, { id, multi = false } = {}) => withRetry(async () => {
      const sent = await sock.sendMessage(to, { poll: { name, values, selectableCount: multi ? values.length : 1 } }, id ? { messageId: id } : {});
      return { id: sent.key.id, raw: JSON.stringify(sent, lib.BufferJSON.replacer) };
    }),
  };
}

export const messageId = (key, i = 0) => "GR" + createHash("sha1").update(`${key}#${i}`).digest("hex").slice(0, 30).toUpperCase();
