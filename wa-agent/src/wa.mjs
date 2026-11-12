// WhatsApp side of the bridge: Baileys socket, owner gate, group gate, normalized events, polls with persisted creation
// messages (PLAN 2.2, 2.2.1, 2.13, 5.2 item 1, 2.14). It sends to the owner (no send function takes a JID) and, through
// sendGroup, react and the actions of a normal user (reactAny, reply, sendMedia, sendMention, sendPoll, edit, remove), to a
// group JID the bridge picked; all of them refuse anything that is not a group JID, and those that name a message also require
// its key to be from that same chat.
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
import { vcardNumbers } from "./wa-actions.mjs";

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

const POLL_KEYS = ["pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3"];
// A poll someone else created: question, option labels, whether more than one option may be picked.
function pollOf(m) {
  const p = m[POLL_KEYS.find((k) => m[k])];
  const options = (p?.options ?? []).map((o) => o?.optionName).filter((x) => typeof x === "string" && x);
  return options.length ? { question: String(p.name ?? ""), options, multi: num(p.selectableOptionsCount) !== 1 } : null;
}
const contactOf = (c) => ({ name: String(c?.displayName ?? ""), numbers: vcardNumbers(c?.vcard) });

export function normalizeMessage(msg) {
  const m = unwrap(msg.message);
  const media = ["imageMessage", "documentMessage", "audioMessage", "videoMessage", "stickerMessage"].find((k) => m[k]);
  const text = m.conversation ?? m.extendedTextMessage?.text ?? (media ? m[media].caption : "") ?? "";
  const n = { id: msg.key.id, ts: num(msg.messageTimestamp), text: text ?? "", media: media ? { kind: media.replace("Message", ""), mimetype: m[media].mimetype ?? "", fileName: m[media].fileName ?? "", size: num(m[media].fileLength), seconds: num(m[media].seconds) } : null, pollUpdate: m.pollUpdateMessage ?? null };
  // What other people send besides text (PLAN 2.14): the bridge renders these lines, this only reads the message.
  const poll = pollOf(m);
  if (poll) n.poll = poll;
  const loc = m.locationMessage ?? m.liveLocationMessage;
  if (loc) n.location = { lat: loc.degreesLatitude, lng: loc.degreesLongitude, name: loc.name ?? "", address: loc.address ?? "", caption: loc.caption ?? "", live: !!m.liveLocationMessage };
  const contacts = m.contactMessage ? [contactOf(m.contactMessage)] : (m.contactsArrayMessage?.contacts ?? []).map(contactOf);
  if (contacts.length) n.contacts = contacts.slice(0, 5);
  const ctx = contextOf(m);
  if (ctx?.mentionedJid?.length) n.mentionedJid = ctx.mentionedJid.map(bare);
  if (ctx?.quotedMessage && ctx.stanzaId) n.quotedKey = { id: String(ctx.stanzaId), participant: ctx.participant ?? null }; // what a reply replies to, so the bridge can give it a ref
  return n;
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
export function createWa({ lib, owners, groups = new Set(), ownerJid, authDir, xchg, polls, onMessage, onVote, onSeen, onReaction, onOpen, logger, agent, fetchVersion = true, qr = () => {}, log = () => {} }) {
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
    const mentionsOf = (n) => { const self = selfIds(); return (n.mentionedJid ?? []).map((jid) => ({ jid, who: self.has(jid) ? "gremio" : owners.has(jid) ? "owner" : null })); };
    // A group sender in LID form: learn its phone twin from the mapping store before the owner check looks at it.
    async function lidTwin(k) {
      if (k.participant && !k.participantAlt && /@lid$/.test(k.participant)) {
        try { const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(k.participant); if (pn) k.participantAlt = pn; } catch { /* no mapping yet */ }
      }
    }
    const senderIsOwner = (k) => [k.participant, k.participantAlt].some((j) => j && owners.has(bare(j)));
    async function ownerInGroup(k) {
      await lidTwin(k);
      if (!senderIsOwner(k) && /@lid$/.test(k.participant ?? "")) await addOwnerLids();
      return senderIsOwner(k);
    }
    const senderJids = (k) => [...new Set([bare(k.participant), bare(k.participantAlt)].filter(Boolean))];
    // A group message is dealt with only when it addresses Gremio, and then silently dropped unless the gate passes: group
    // chatter and members' names are never logged. Only image, sticker and video are saved from a group, and only after the gate.
    // edit: {of} when this is the new text of an earlier message (it gets its own ledger id, the original id stays its ref).
    async function groupEvent(msg, edit) {
      const k = msg.key;
      if (k.fromMe || !isAddressed(msg, selfIds())) return null;
      await lidTwin(k);
      let g = groupGate(msg, { owners, family: groups, self: selfIds() });
      if (!g && /@lid$/.test(k.participant ?? "")) { await addOwnerLids(); g = groupGate(msg, { owners, family: groups, self: selfIds() }); }
      if (!g) return null;
      const n = normalizeMessage(msg);
      if (n.pollUpdate) return null;
      if (edit) { n.id = `${edit.of}:edit:${n.ts}`; n.edited = true; n.media = null; } else if (n.media && n.media.kind in MEDIA_CAPS) await keepMedia(msg, n);
      if (n.poll) n.pollRaw = JSON.stringify(msg, lib.BufferJSON.replacer);
      const quoted = quotedOf(msg, { self: selfIds(), owners });
      return { ...n, mentions: mentionsOf(n), ...(quoted ? { quoted } : {}), group: { ...g, name: msg.pushName || maskJid(k.participantAlt ?? k.participant ?? ""), jids: senderJids(k), quote: { key: { id: k.id, remoteJid: k.remoteJid, participant: k.participant }, message: { conversation: n.text.slice(0, 200) } } } };
    }
    // A group message that does not address Gremio is chatter and is dropped, with two exceptions the bridge keeps for the next turn
    // (PLAN 2.14): a vote on a poll it keeps, and a poll someone creates, from a member of a family group or from the owner anywhere.
    async function groupSeen(msg) {
      const k = msg.key, m = unwrap(msg.message);
      if (k.fromMe) return;
      if (m.pollUpdateMessage) return handleVote(msg, m.pollUpdateMessage);
      const poll = pollOf(m);
      if (!poll || !onSeen) return;
      const jid = bare(k.remoteJid);
      const owner = await ownerInGroup(k);
      if (!groups.has(jid) && !owner) return;
      const n = normalizeMessage(msg);
      await onSeen({ ...n, pollRaw: JSON.stringify(msg, lib.BufferJSON.replacer), mentions: mentionsOf(n), group: { jid, fromOwner: owner, family: groups.has(jid), name: msg.pushName || maskJid(k.participantAlt ?? k.participant ?? ""), jids: senderJids(k), quote: { key: { id: k.id, remoteJid: k.remoteJid, participant: k.participant }, message: { conversation: "" } } } });
    }
    // One incoming message (a new one from messages.upsert, or the new text of an edited one from messages.update).
    async function inbound(msg, edit = null) {
      if (!msg.message) return;
      const m = unwrap(msg.message);
      if (!edit && (m.reactionMessage || m.protocolMessage)) return; // reactions come as messages.reaction, edits and deletes as messages.update
      if (/@g\.us$/.test(msg.key?.remoteJid ?? "")) {
        const n = await groupEvent(msg, edit);
        if (n) { try { await onMessage(n); } catch (e) { log(`onMessage failed: ${e.stack}`); } } else if (!edit) await groupSeen(msg);
        return;
      }
      if (!msg.key?.remoteJidAlt && /@lid$/.test(msg.key?.remoteJid ?? "")) {
        try { const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(msg.key.remoteJid); if (pn) msg.key.remoteJidAlt = pn; } catch { /* no mapping yet */ }
      }
      if (!isOwnerMessage(msg, owners) && /@lid$/.test(msg.key?.remoteJid ?? "")) await addOwnerLids();
      if (!isOwnerMessage(msg, owners)) { log(`dropped message from ${String(msg.key?.remoteJid).replace(/\d(?=\d{4})/g, "*")}`); return; }
      const n = normalizeMessage(msg);
      const quoted = quotedOf(msg, { self: selfIds(), owners });
      if (quoted) n.quoted = quoted;
      if (n.pollUpdate) { handleVote(msg, n.pollUpdate); return; }
      n.key = msg.key; // the bridge reacts to and refers to this message
      n.mentions = mentionsOf(n);
      if (edit) { n.id = `${edit.of}:edit:${n.ts}`; n.edited = true; n.media = null; } else if (n.media) await keepMedia(msg, n);
      if (n.poll) n.pollRaw = JSON.stringify(msg, lib.BufferJSON.replacer);
      try { await onMessage(n); } catch (e) { log(`onMessage failed: ${e.stack}`); }
    }
    // Both types: messages sent while the pod was down can arrive as `append` after a reconnect (PLAN 2.2).
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;
      for (const msg of messages ?? []) await inbound(msg);
    });
    // Votes may also arrive as message updates, and so do edits (the original id and the new content) and deletes (message: null, ignored).
    sock.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates ?? []) {
        const edited = update?.message?.editedMessage?.message;
        if (edited && key?.id) inbound({ key: { ...key }, message: edited, messageTimestamp: update.messageTimestamp }, { of: key.id }).catch((e) => log(`edit failed: ${e.message}`));
        for (const pu of update?.pollUpdates ?? []) handleVote({ key: pu.pollUpdateMessageKey ?? key }, { ...pu, pollCreationMessageKey: pu.pollCreationMessageKey ?? key });
      }
    });
    // A reaction to a message: only the owner in a DM, a family member (or the owner) in a group. The bridge keeps it only when the
    // message is one Gremio sent. Our own reactions come back here too (fromMe) and are ignored.
    sock.ev.on("messages.reaction", (list) => {
      for (const r of list ?? []) reactionEvent(r).catch((e) => log(`reaction event failed: ${e.message}`));
    });
    async function reactionEvent({ reaction, key }) {
      const emoji = reaction?.text ?? "", rk = reaction?.key ?? {};
      if (!emoji || rk.fromMe || !key?.id || !onReaction) return;
      const chat = bare(rk.remoteJid ?? key.remoteJid);
      if (/@g\.us$/.test(chat)) {
        const owner = await ownerInGroup(rk);
        if (!groups.has(chat) && !owner) return;
        return onReaction({ chat, id: key.id, emoji, jids: senderJids(rk), owner });
      }
      if (!isOwnerMessage({ key: rk }, owners)) return;
      return onReaction({ chat: null, id: key.id, emoji, jids: [], owner: true });
    }
  }

  function handleVote(msg, pollUpdate) {
    const pollId = pollUpdate.pollCreationMessageKey?.id;
    const raw = pollId && polls.get(pollId);
    if (!raw) return;
    const norm = lib.jidNormalizedUser ?? ((x) => x);
    const me = norm(sock?.user?.id ?? "me");
    const lid = norm(sock?.user?.lid ?? "");
    const k = msg.key ?? {};
    const dm = !/@g\.us$/.test(k.remoteJid ?? "");
    const owner = [k.participant, k.participantAlt, dm ? k.remoteJid : "", dm ? k.remoteJidAlt : ""].some((j) => j && owners.has(bare(j)));
    const voter = owner ? "owner" : bare(k.participant || k.participantAlt) || (dm ? bare(k.remoteJid) : "");
    if (!voter) return; // a group vote that names no voter cannot be counted
    let options = null;
    try {
      const creation = decode(raw), author = creation.key ?? {};
      options = decodeVote({
        creation, pollUpdate, meId: me, lib,
        creatorJids: [lid, me, bare(author.participant), bare(author.participantAlt), /@g\.us$/.test(author.remoteJid ?? "") ? "" : bare(author.remoteJid)], // our own poll, or the creator of someone else's
        voterJids: [bare(k.participant), bare(k.participantAlt), bare(k.remoteJid), bare(k.remoteJidAlt), bare(ownerJid)],
      });
    } catch (e) { log(`vote decode failed: ${e.message}`); }
    Promise.resolve(onVote?.({ pollId, options, voter, owner })).catch((e) => log(`onVote failed: ${e.message}`));
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
  const destOf = (jid) => (jid === undefined ? to : GROUP_JID.test(String(jid)) ? jid : null);
  const badDest = () => Promise.reject(new Error("not the owner or a group JID"));
  // A message key for the chat `d`: a group key must already name that group, a DM key must not name a group.
  const keyFor = (key, d, jid) => {
    if (!key?.id) return null;
    if (jid === undefined) return /@g\.us$/.test(String(key.remoteJid ?? "")) ? null : { ...key, remoteJid: key.remoteJid ?? d };
    return key.remoteJid === undefined || key.remoteJid === jid ? { ...key, remoteJid: jid } : null;
  };
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
    // Returns {id, raw}: the poll creation message, JSON-encoded for state.json (messageSecret included). jid: a group (a model poll).
    sendPoll: (name, values, { id, multi = false, jid } = {}) => (destOf(jid) ? withRetry(async () => {
      const sent = await sock.sendMessage(destOf(jid), { poll: { name, values, selectableCount: multi ? values.length : 1 } }, id ? { messageId: id } : {});
      return { id: sent.key.id, raw: JSON.stringify(sent, lib.BufferJSON.replacer) };
    }) : badDest()),
    // ---- the actions of a normal user (PLAN 2.14). Same destinations as every send above: no jid means the owner, a jid must be a
    // group JID, and a message key must belong to that chat. A message to edit or delete is named by its id only (always our own).
    reactAny: (key, text, { jid } = {}) => { const d = destOf(jid), k = d && keyFor(key, d, jid); return k ? withRetry(() => sock.sendMessage(d, { react: { text, key: k } })) : badDest(); },
    reply: (text, quote, { jid, id } = {}) => { const d = destOf(jid), k = d && keyFor(quote?.key, d, jid); return k ? withRetry(() => sock.sendMessage(d, { text }, { ...(id ? { messageId: id } : {}), quoted: { key: k, message: quote.message ?? { conversation: "" } } })) : badDest(); },
    sendMention: (text, mentions, { jid, id } = {}) => (destOf(jid) ? withRetry(() => sock.sendMessage(destOf(jid), { text, mentions }, id ? { messageId: id } : {})) : badDest()),
    // spec: {kind: image|sticker|video|document, data: Buffer, mimetype, fileName, caption}
    sendMedia: (spec, { jid, id } = {}) => {
      const d = destOf(jid), { kind, data, mimetype, fileName, caption } = spec;
      const content = kind === "image" ? { image: data, mimetype, ...(caption ? { caption } : {}) }
        : kind === "video" ? { video: data, mimetype, ...(caption ? { caption } : {}) }
        : kind === "sticker" ? { sticker: data }
        : kind === "document" ? { document: data, mimetype, fileName, ...(caption ? { caption } : {}) } : null;
      return d && content ? withRetry(() => sock.sendMessage(d, content, id ? { messageId: id } : {})) : badDest();
    },
    edit: (id, text, { jid } = {}) => (destOf(jid) && id ? withRetry(() => sock.sendMessage(destOf(jid), { text, edit: { remoteJid: destOf(jid), fromMe: true, id } })) : badDest()),
    remove: (id, { jid } = {}) => (destOf(jid) && id ? withRetry(() => sock.sendMessage(destOf(jid), { delete: { remoteJid: destOf(jid), fromMe: true, id } })) : badDest()),
  };
}

export const messageId = (key, i = 0) => "GR" + createHash("sha1").update(`${key}#${i}`).digest("hex").slice(0, 30).toUpperCase();
