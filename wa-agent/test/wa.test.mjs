// WhatsApp-side tests (PLAN 2.2, 2.2.1, 5.2 item 1; S7): owner gate (group and LID forms), message types, media,
// owner-only sends, poll persistence format, CONNECT proxy agent. Baileys is a fake socket factory: no network, no
// pairing. The real Baileys exports (BufferJSON, DisconnectReason) are used where they are pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, lstatSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as baileys from "@whiskeysockets/baileys";
import { ProxyAgent, createWa, decodeVote, isOwnerMessage, messageId, normalizeMessage, parseOwners } from "../src/wa.mjs";
import { sandbox, waitFor } from "../testlib/helpers.mjs";

const OWNER = "628111@s.whatsapp.net";
const owners = parseOwners(`${OWNER},999@lid`);
const m = (key, message = { conversation: "halo" }) => ({ key: { id: "ID1", ...key }, message, messageTimestamp: 1_800_000_000 });

test("owner gate: only a 1:1 message from an owner JID passes (phone, device, LID, LID twin)", () => {
  for (const key of [
    { remoteJid: OWNER },
    { remoteJid: "628111:12@s.whatsapp.net" },           // companion device suffix
    { remoteJid: "999@lid" },                              // owner's LID, listed
    { remoteJid: "555@lid", remoteJidAlt: OWNER },         // unknown LID whose phone twin is the owner
  ]) assert.equal(isOwnerMessage(m(key), owners), true, JSON.stringify(key));
});
test("owner gate drops strangers, groups, broadcasts, newsletters, own echoes and look-alike LIDs (S7)", () => {
  for (const key of [
    { remoteJid: "628222@s.whatsapp.net" },                                  // stranger
    { remoteJid: "120363@g.us", participant: OWNER },                        // the owner inside a group: groups are ignored
    { remoteJid: "120363@g.us", participant: "628222@s.whatsapp.net" },
    { remoteJid: "status@broadcast", participant: OWNER },
    { remoteJid: "1203@broadcast" },
    { remoteJid: "1203@newsletter" },
    { remoteJid: OWNER, fromMe: true },                                       // the bot's own echo
    { remoteJid: "628111@lid" },                                              // same digits, other server: not the owner
    { remoteJid: "555@lid", remoteJidAlt: "628222@s.whatsapp.net" },          // LID with a stranger twin
    { remoteJid: OWNER, participant: "628222@s.whatsapp.net" },               // relayed from someone else
    { remoteJid: "" },
    {},
  ]) assert.equal(isOwnerMessage(m(key), owners), false, JSON.stringify(key));
  assert.equal(isOwnerMessage(null, owners), false);
  assert.equal(isOwnerMessage({ key: { remoteJid: OWNER } }, new Set()), false); // no owner configured: nobody passes
});

test("normalizeMessage reads text, captions, wrappers and poll updates", () => {
  assert.equal(normalizeMessage(m({}, { conversation: "a" })).text, "a");
  assert.equal(normalizeMessage(m({}, { extendedTextMessage: { text: "b" } })).text, "b");
  assert.equal(normalizeMessage(m({}, { ephemeralMessage: { message: { conversation: "c" } } })).text, "c");
  const img = normalizeMessage(m({}, { imageMessage: { caption: "lihat", mimetype: "image/jpeg" } }));
  assert.deepEqual([img.text, img.media.kind], ["lihat", "image"]);
  const pu = { pollCreationMessageKey: { id: "P1" } };
  assert.equal(normalizeMessage(m({}, { pollUpdateMessage: pu })).pollUpdate, pu);
  assert.equal(normalizeMessage({ key: { id: "x" }, message: { conversation: "t" }, messageTimestamp: { toString: () => "42" } }).ts, 42);
});

function fakeLib() {
  const handlers = {}, sent = [], sockets = [];
  const lib = {
    ...baileys,
    useMultiFileAuthState: async () => ({ state: {}, saveCreds() {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    downloadMediaMessage: async () => Buffer.from("JPEGBYTES"),
    makeWASocket: (cfg) => {
      const sock = {
        cfg, user: { id: "99:1@s.whatsapp.net", lid: "77@lid" },
        ev: { on: (n, f) => { handlers[n] = f; } },
        sendMessage: async (jid, content, opts) => { sent.push({ jid, content, opts }); return { key: { id: opts?.messageId ?? "WAID" }, message: { pollCreationMessage: { name: "q" }, messageContextInfo: { messageSecret: Buffer.from("0123456789abcdef0123456789abcdef") } } }; },
        sendPresenceUpdate: async (p, jid) => { sent.push({ presence: p, jid }); },
        signalRepository: { lidMapping: { getPNForLID: async (l) => (l === "555@lid" ? OWNER : null) } },
      };
      sockets.push(sock);
      return sock;
    },
  };
  return { lib, handlers, sent, sockets };
}
async function startWa(S, extra = {}) {
  const F = fakeLib();
  const got = { messages: [], votes: [], opens: 0 };
  const polls = new Map();
  const wa = createWa({ lib: F.lib, owners, ownerJid: OWNER, authDir: S.dir, xchg: S.xchg, polls: { get: (id) => polls.get(id) }, log() {}, onMessage: (n) => got.messages.push(n), onVote: (v) => got.votes.push(v), onOpen: () => got.opens++, ...extra });
  await wa.start();
  F.handlers["connection.update"]({ connection: "open" });
  return { F, wa, got, polls };
}

test("upsert: notify and append from the owner reach the bridge, strangers and groups never do", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S);
  const up = F.handlers["messages.upsert"];
  await up({ type: "notify", messages: [m({ remoteJid: OWNER, id: "n1" }), m({ remoteJid: "628222@s.whatsapp.net", id: "x1" }), m({ remoteJid: "120363@g.us", participant: OWNER, id: "g1" })] });
  await up({ type: "append", messages: [m({ remoteJid: OWNER, id: "a1" }, { conversation: "dari pas pod mati" })] });
  await up({ type: "prepend", messages: [m({ remoteJid: OWNER, id: "h1" })] }); // history is not a prompt
  await up({ type: "notify", messages: [{ key: { remoteJid: OWNER, id: "empty" }, message: null }] });
  assert.deepEqual(got.messages.map((x) => x.id), ["n1", "a1"]);
  assert.equal(got.opens, 1);
});
test("upsert resolves an unknown LID through the mapping store before the gate", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S);
  await F.handlers["messages.upsert"]({ type: "notify", messages: [m({ remoteJid: "555@lid", id: "l1" }), m({ remoteJid: "556@lid", id: "l2" })] });
  assert.deepEqual(got.messages.map((x) => x.id), ["l1"]);
});
test("media is saved under xchg/inbox as a regular file, replacing a planted symlink", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S);
  writeFileSync(join(S.dir, "creds.json"), "SESSION");
  symlinkSync(join(S.dir, "creds.json"), join(S.xchg, "inbox", "img1.jpg")); // planted link to the session file
  await F.handlers["messages.upsert"]({ type: "notify", messages: [m({ remoteJid: OWNER, id: "img1" }, { imageMessage: { caption: "ini", mimetype: "image/jpeg" } })] });
  const [file] = got.messages[0].files;
  assert.equal(file, join(S.xchg, "inbox", "img1.jpg"));
  assert.equal(readFileSync(file, "utf8"), "JPEGBYTES");
  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.equal(readFileSync(join(S.dir, "creds.json"), "utf8"), "SESSION"); // untouched
  assert.deepEqual(readdirSync(join(S.xchg, "inbox")), ["img1.jpg"]);
});

test("sends go to the owner and only the owner; there is no recipient argument", async () => {
  const S = sandbox();
  const { F, wa } = await startWa(S);
  await wa.sendText("halo", { id: messageId("k") });
  await wa.sendText("halo lagi", { id: messageId("k2"), jid: "attacker@s.whatsapp.net", to: "attacker@s.whatsapp.net" });
  await wa.composing();
  const poll = await wa.sendPoll("Pilih?", ["a", "b"], { id: messageId("p") });
  for (const s of F.sent) assert.equal(s.jid, OWNER);
  assert.equal(F.sent.length, 4);
  assert.deepEqual(F.sent[3].content.poll, { name: "Pilih?", values: ["a", "b"], selectableCount: 1 });
  assert.equal(F.sent[0].opts.messageId, messageId("k"));
  assert.equal(poll.id, messageId("p"));
  assert.equal(wa.sendText.length <= 2, true);
});

test("the sent poll is persisted with its messageSecret and getMessage serves it back", async () => {
  const S = sandbox();
  const { F, wa, polls } = await startWa(S);
  const p = await wa.sendPoll("Pilih?", ["a", "b"]);
  polls.set(p.id, p.raw);
  assert.match(p.raw, /messageSecret/);
  const back = JSON.parse(p.raw, baileys.BufferJSON.reviver);
  assert.equal(Buffer.from(back.message.messageContextInfo.messageSecret).toString(), "0123456789abcdef0123456789abcdef"); // bytes survive state.json
  const gm = await F.sockets[0].cfg.getMessage({ id: p.id });
  assert.equal(gm.pollCreationMessage.name, "q");
  assert.deepEqual(await F.sockets[0].cfg.getMessage({ id: "unknown" }), { conversation: "" });
});

test("the socket config carries the proxy agent for both the websocket and media, and no QR print", async () => {
  const S = sandbox();
  const agent = new ProxyAgent("http://wa-egress:8888");
  const { F } = await startWa(S, { agent });
  const cfg = F.sockets[0].cfg;
  assert.equal(cfg.agent, agent);
  assert.equal(cfg.fetchAgent, agent);
  assert.equal(cfg.printQRInTerminal, false);
  assert.equal(cfg.syncFullHistory, false);
  assert.deepEqual(cfg.version, [2, 3000, 1]); // fetched; WA_FETCH_VERSION=0 uses the bundled one
  const off = await startWa(sandbox(), { fetchVersion: false });
  assert.equal(off.F.sockets[0].cfg.version, undefined);
});

test("ProxyAgent sends CONNECT host:port to the proxy and fails closed when it refuses", async () => {
  const seen = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, socket) => { seen.push(req.url); socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const agent = new ProxyAgent(`http://127.0.0.1:${proxy.address().port}`);
  const err = await new Promise((res) => agent.createConnection({ host: "web.whatsapp.com", port: 443 }, (e) => res(e)));
  assert.match(err.message, /proxy refused CONNECT web\.whatsapp\.com:443: 502/);
  assert.deepEqual(seen, ["web.whatsapp.com:443"]);
  await new Promise((r) => proxy.close(r));
});

test("decodeVote returns null without a secret or payload, [] for a deselect", () => {
  const lib = { getKeyAuthor: (k, me) => me, decryptPollVote: () => ({ selectedOptions: [] }), getAggregateVotesInPollMessage: () => [{ name: "A", voters: [] }] };
  const pu = { pollCreationMessageKey: { id: "P" }, pollUpdateMessageKey: { id: "V" }, vote: { encPayload: "x", encIv: "y" } };
  const creation = { message: { messageContextInfo: { messageSecret: "s" } } };
  assert.equal(decodeVote({ creation: { message: {} }, pollUpdate: pu, voterJids: ["v"], creatorJids: ["c"], meId: "me", lib }), null);
  assert.equal(decodeVote({ creation, pollUpdate: { ...pu, vote: {} }, voterJids: ["v"], creatorJids: ["c"], meId: "me", lib }), null);
  assert.deepEqual(decodeVote({ creation, pollUpdate: pu, voterJids: ["v"], creatorJids: ["c"], meId: "me", lib }), []);
  const boom = { ...lib, decryptPollVote: () => { throw new Error("bad mac"); } };
  assert.equal(decodeVote({ creation, pollUpdate: pu, voterJids: ["v"], creatorJids: ["c"], meId: "me", lib: boom }), null); // undecryptable
});

test("a vote event reaches onVote with the decoded labels, or null when it cannot be decrypted", async () => {
  const S = sandbox();
  const lib = { ...baileys, getKeyAuthor: (k, me) => me, decryptPollVote: () => ({ selectedOptions: ["h"] }), getAggregateVotesInPollMessage: () => [{ name: "React", voters: ["x"] }] };
  const F = fakeLib();
  F.lib.decryptPollVote = lib.decryptPollVote; F.lib.getAggregateVotesInPollMessage = lib.getAggregateVotesInPollMessage; F.lib.getKeyAuthor = lib.getKeyAuthor;
  const got = { votes: [] };
  const raw = JSON.stringify({ key: { id: "P1" }, message: { pollCreationMessage: { name: "q" }, messageContextInfo: { messageSecret: "c2VjcmV0" } } });
  const wa = createWa({ lib: F.lib, owners, ownerJid: OWNER, authDir: S.dir, xchg: S.xchg, polls: { get: (id) => (id === "P1" ? raw : undefined) }, log() {}, onMessage() {}, onVote: (v) => got.votes.push(v) });
  await wa.start();
  const vote = (id) => ({ key: { id: "V", remoteJid: OWNER }, pollUpdate: { pollCreationMessageKey: { id }, vote: { encPayload: "x", encIv: "y" } } });
  const up = F.handlers["messages.upsert"];
  await up({ type: "notify", messages: [{ key: { id: "V", remoteJid: OWNER }, messageTimestamp: 1, message: { pollUpdateMessage: vote("P1").pollUpdate } }] });
  await waitFor(() => got.votes.length === 1);
  assert.deepEqual(got.votes[0], { pollId: "P1", options: ["React"] });
  F.lib.decryptPollVote = () => { throw new Error("bad"); };
  await up({ type: "notify", messages: [{ key: { id: "V2", remoteJid: OWNER }, messageTimestamp: 2, message: { pollUpdateMessage: vote("P1").pollUpdate } }] });
  await waitFor(() => got.votes.length === 2);
  assert.deepEqual(got.votes[1], { pollId: "P1", options: null });
  await up({ type: "notify", messages: [{ key: { id: "V3", remoteJid: "628222@s.whatsapp.net" }, messageTimestamp: 3, message: { pollUpdateMessage: vote("P1").pollUpdate } }] }); // a stranger's vote
  assert.equal(got.votes.length, 2);
});
