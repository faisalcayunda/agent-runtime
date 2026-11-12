// WhatsApp-side tests (PLAN 2.2, 2.2.1, 5.2 item 1; S7): owner gate (group and LID forms), message types, media,
// owner-only sends, poll persistence format, CONNECT proxy agent. Baileys is a fake socket factory: no network, no
// pairing. The real Baileys exports (BufferJSON, DisconnectReason) are used where they are pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, lstatSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as baileys from "@whiskeysockets/baileys";
import { ACK_EMOJI, ProxyAgent, createWa, decodeVote, groupGate, isOwnerMessage, messageId, normalizeMessage, parseGroups, parseOwners, quotedOf } from "../src/wa.mjs";
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
        groupFetchAllParticipating: async () => ({ "120363@g.us": { id: "120363@g.us", subject: "Home Sweet Home", participants: [{ id: "628222@s.whatsapp.net" }] }, "120999@g.us": { id: "120999@g.us", subject: "Kantor" } }),
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

// ---------- family group lane and other groups (PLAN 2.13) ----------
const FAM = "120363@g.us", OTHER = "120999@g.us", MEMBER = "628222@s.whatsapp.net";
const SELF = new Set(["99@s.whatsapp.net", "77@lid"]);
const gm = (key, text = "halo semua", ctx = null, extra = {}) => ({
  key: { id: "G1", remoteJid: FAM, participant: MEMBER, ...key }, pushName: "Budi", messageTimestamp: 1_800_000_000, ...extra,
  message: ctx ? { extendedTextMessage: { text, contextInfo: ctx } } : { conversation: text },
});
const gate = (msg, family = new Set([FAM])) => groupGate(msg, { owners, family, self: SELF });

test("parseGroups keeps only well-formed group JIDs", () => {
  assert.deepEqual([...parseGroups(" 120363@g.us, 628111-1600000000@g.us ,bad,628@s.whatsapp.net,,x@g.us")], ["120363@g.us", "628111-1600000000@g.us"]);
  assert.equal(parseGroups("").size, 0);
  assert.equal(parseGroups(undefined).size, 0);
});

test("group gate: a family message passes only when it addresses Gremio (mention, reply to Gremio, 'gremio' prefix)", () => {
  assert.equal(gate(gm({}, "halo semua")), null);                                               // chatter: ignored
  assert.equal(gate(gm({}, "halo semua", { mentionedJid: ["628333@s.whatsapp.net"] })), null);  // mentions someone else
  assert.equal(gate(gm({}, "tanya dulu gremio", {})), null);                                    // not a prefix
  assert.equal(gate(gm({}, "gremiox halo")), null);                                              // word boundary
  assert.equal(gate(gm({}, "x", { participant: MEMBER, stanzaId: "ABC123" })), null);           // reply to a member
  const pass = (msg) => assert.deepEqual(gate(msg), { jid: FAM, fromOwner: false, family: true });
  pass(gm({}, "@99 tolong", { mentionedJid: ["99@s.whatsapp.net"] }));                            // mention by phone JID
  pass(gm({}, "@77 tolong", { mentionedJid: ["628333@s.whatsapp.net", "77@lid"] }));             // mention by LID
  pass(gm({}, "oke", { participant: "99@s.whatsapp.net", stanzaId: "ABC123" }));                  // reply to Gremio (its own JID)
  pass(gm({}, "oke", { participant: "77@lid", stanzaId: "ABC123" }));                             // reply to Gremio (its LID)
  pass(gm({}, "oke", { stanzaId: messageId("t:k1") }));                                           // reply to an id the bridge generated
  pass(gm({}, "Gremio, tolong cek"));
  pass(gm({}, "  GREMIO tolong"));
  pass({ ...gm({}, "gremio"), message: { imageMessage: { caption: "gremio ini apa", contextInfo: {} } } }); // caption counts as text
});

test("group gate: other groups pass the owner only, matched by phone JID, LID or LID twin", () => {
  const to = (key, text = "gremio cek") => gm({ remoteJid: OTHER, ...key }, text);
  assert.equal(gate(to({})), null);                                                          // a member addressing Gremio in another group
  assert.equal(gate(to({ participant: OWNER }, "halo semua")), null);                         // the owner not addressing Gremio
  assert.deepEqual(gate(to({ participant: OWNER })), { jid: OTHER, fromOwner: true, family: false });
  assert.equal(gate(to({ participant: "628111:7@s.whatsapp.net" }))?.fromOwner, true);       // device suffix
  assert.equal(gate(to({ participant: "999@lid" }))?.fromOwner, true);                        // learned owner LID
  assert.equal(gate(to({ participant: "555@lid", participantAlt: OWNER }))?.fromOwner, true); // unknown LID, phone twin is the owner
  assert.equal(gate(to({ participant: "555@lid", participantAlt: MEMBER })), null);
  assert.equal(gate(to({ participant: "628111@lid" })), null);                                // same digits, other server
  assert.equal(gate(gm({ remoteJid: OTHER, participant: OWNER }, "x", { mentionedJid: ["99@s.whatsapp.net"] }))?.fromOwner, true);
  assert.equal(gate(gm({ participant: OWNER }, "gremio hi"))?.fromOwner, true);               // the owner in the family group keeps the flag
});

test("group gate: never a DM, a broadcast, an echo of Gremio or a missing sender", () => {
  assert.equal(gate(gm({ remoteJid: OWNER, participant: undefined }, "gremio hi")), null);   // 1:1 chats are the owner gate's job
  assert.equal(gate(gm({ remoteJid: "status@broadcast" }, "gremio hi")), null);
  assert.equal(gate(gm({ fromMe: true }, "gremio hi")), null);
  assert.equal(gate(null), null);
  assert.equal(gate(gm({ participant: undefined }, "gremio hi"))?.fromOwner, false);          // no sender: a member, never the owner
});

test("upsert: group messages reach the bridge only through the gate, and nothing about them is logged", async () => {
  const S = sandbox();
  const logs = [];
  const { F, got } = await startWa(S, { groups: new Set([FAM]), log: (l) => logs.push(l) });
  logs.length = 0;
  const up = F.handlers["messages.upsert"];
  await up({ type: "notify", messages: [
    gm({ id: "u1" }, "halo semua"),                                                      // family chatter
    gm({ id: "u2", remoteJid: OTHER }, "gremio cek"),                                    // member of another group addressing Gremio
    gm({ id: "u3", remoteJid: OTHER, participant: OWNER }, "ngobrol biasa"),             // the owner, not addressing Gremio
    gm({ id: "u4", remoteJid: "120777@g.us", participant: MEMBER }, "gremio cek"),       // unknown group
    gm({ id: "u5" }, "gremio cek"),                                                      // family, addressed
    gm({ id: "u6", remoteJid: OTHER, participant: OWNER }, "gremio cek"),                // owner, other group, addressed
    gm({ id: "u7", remoteJid: "628222@s.whatsapp.net", participant: undefined }, "gremio cek"), // DM from a stranger
  ] });
  assert.deepEqual(got.messages.map((x) => x.id), ["u5", "u6"]);
  assert.deepEqual(got.messages[0].group, { jid: FAM, fromOwner: false, family: true, name: "Budi", quote: { key: { id: "u5", remoteJid: FAM, participant: MEMBER }, message: { conversation: "gremio cek" } } });
  assert.equal(got.messages[1].group.fromOwner, true);
  assert.equal(got.messages[1].group.family, false);
  assert.deepEqual(logs.filter((l) => /g\.us|group|grup/i.test(l)), []);               // no group log line at all
  assert.equal(logs.filter((l) => /dropped message from/.test(l)).length, 1);            // only the stranger's DM
});

test("upsert: the display name falls back to a masked number, and a group voice note or document is not downloaded", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S, { groups: new Set([FAM]) });
  await F.handlers["messages.upsert"]({ type: "notify", messages: [
    gm({ id: "n1", participant: "628123456789@s.whatsapp.net" }, "gremio hi", null, { pushName: undefined }),
    { ...gm({ id: "n2" }, ""), message: { audioMessage: { mimetype: "audio/ogg" }, extendedTextMessage: { text: "gremio dengar ini" } } },
    { ...gm({ id: "n3" }, ""), message: { documentMessage: { caption: "gremio baca ini", fileName: "a.pdf" } } },
  ] });
  assert.equal(got.messages[0].group.name, "********6789");
  assert.equal(got.messages[1].files, undefined); // only image, sticker and video are saved from a group
  assert.equal(got.messages[2].files, undefined);
  assert.deepEqual(readdirSync(join(S.xchg, "inbox")), []);
});

test("upsert: a group message from an unknown owner LID learns it before the gate", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S, { groups: new Set() });
  await F.handlers["messages.upsert"]({ type: "notify", messages: [gm({ id: "l1", remoteJid: OTHER, participant: "555@lid" }, "gremio cek")] });
  assert.deepEqual(got.messages.map((x) => x.id), ["l1"]); // 555@lid maps to the owner phone JID in the fake store
  assert.equal(got.messages[0].group.fromOwner, true);
});

test("sendGroup sends to a group JID only, quoted; sendText still has no recipient", async () => {
  const S = sandbox();
  const { F, wa } = await startWa(S, { groups: new Set([FAM]) });
  const quote = { key: { id: "Q1", remoteJid: FAM, participant: MEMBER }, message: { conversation: "gremio cek" } };
  await wa.sendGroup(FAM, "halo", { id: messageId("k"), quote });
  await wa.sendGroup(OTHER, "ke grup lain", { id: messageId("k2") });
  await assert.rejects(() => wa.sendGroup(OWNER, "dm", {}), /not a group/);
  await assert.rejects(() => wa.sendGroup("628222@s.whatsapp.net", "dm", {}), /not a group/);
  assert.deepEqual(F.sent.map((s) => s.jid), [FAM, OTHER]);
  assert.equal(F.sent[0].opts.quoted, quote);
  assert.equal(F.sent[0].opts.messageId, messageId("k"));
  await wa.sendText("masih ke owner", { jid: FAM });
  assert.equal(F.sent[2].jid, OWNER);
});

test("on connect, with WA_GROUP_JIDS empty the groups of the account are listed, one line each; with it set, nothing", async () => {
  const S = sandbox();
  const logs = [];
  const { F } = await startWa(S, { groups: new Set(), log: (l) => logs.push(l) });
  await waitFor(() => logs.filter((l) => /Home Sweet Home|Kantor/.test(l)).length === 2);
  assert.deepEqual(logs.filter((l) => /g\.us/.test(l)).sort(), ["group: Home Sweet Home 120363@g.us", "group: Kantor 120999@g.us"]);
  assert.ok(!logs.join("\n").includes("628222")); // no member numbers
  const logs2 = [];
  await startWa(sandbox(), { groups: new Set([FAM]), log: (l) => logs2.push(l) });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(logs2.filter((l) => /group|g\.us/i.test(l)), []);
});

test("quotedOf reads text, extended text, captions and names media; caps long text; names the author", () => {
  const q = (quotedMessage, participant = MEMBER) => gm({}, "gremio jelasin", { quotedMessage, participant, stanzaId: "S1" });
  const opt = { self: SELF, owners };
  assert.deepEqual(quotedOf(q({ conversation: "laptopnya lemot" }), opt), { author: "**8222", text: "laptopnya lemot" });
  assert.equal(quotedOf(q({ extendedTextMessage: { text: "panjang" } }), opt).text, "panjang");
  assert.deepEqual(quotedOf(q({ imageMessage: { caption: "ini errornya", mimetype: "image/jpeg" } }), opt).text, "[media: image] ini errornya");
  assert.equal(quotedOf(q({ videoMessage: {} }), opt).text, "[media: video]");
  assert.equal(quotedOf(q({ documentWithCaptionMessage: { message: { documentMessage: { caption: "laporan" } } } }), opt).text, "[media: document] laporan");
  assert.equal(quotedOf(q({ conversation: "x" }, "99:1@s.whatsapp.net"), opt).author, "Gremio");
  assert.equal(quotedOf(q({ conversation: "x" }, OWNER), opt).author, "owner");
  assert.equal(quotedOf(q({ conversation: "x" }, null), opt).author, "?");
  const long = quotedOf(q({ conversation: "a".repeat(5000) }), opt).text;
  assert.equal(long.length, 2000);
  assert.ok(long.endsWith("…"));
  assert.equal(quotedOf(gm({}, "gremio hi"), opt), null);                                        // not a reply
  assert.equal(quotedOf(q({ pollCreationMessage: { name: "p" } }), opt), null);                  // nothing readable
});

test("a reply reaches the bridge with its quoted message, in a group and in the owner's DM; media is not downloaded", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S, { groups: new Set([FAM]) });
  await F.handlers["messages.upsert"]({ type: "notify", messages: [
    gm({ id: "r1", participant: OWNER }, "@99 jelasin", { mentionedJid: ["99@s.whatsapp.net"], participant: MEMBER, stanzaId: "S1", quotedMessage: { imageMessage: { caption: "ini errornya" } } }),
    { key: { id: "r2", remoteJid: OWNER }, messageTimestamp: 1_800_000_000, message: { extendedTextMessage: { text: "ok", contextInfo: { participant: "99@s.whatsapp.net", stanzaId: "S2", quotedMessage: { conversation: "PR-nya siap" } } } } },
  ] });
  assert.deepEqual(got.messages.map((x) => x.quoted), [{ author: "**8222", text: "[media: image] ini errornya" }, { author: "Gremio", text: "PR-nya siap" }]);
  assert.deepEqual(readdirSync(join(S.xchg, "inbox")), []);
});

// ---------- images, stickers, video (owner decision 2026-11-12) ----------
const MB = 1024 * 1024;
const inbox = (S) => readdirSync(join(S.xchg, "inbox")).sort();

test("owner DM: an image and a sticker are saved to xchg/inbox with their own extension and named in n.media", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S);
  await F.handlers["messages.upsert"]({ type: "notify", messages: [
    m({ remoteJid: OWNER, id: "i1" }, { imageMessage: { caption: "ini apa", mimetype: "image/jpeg", fileLength: 1000 } }),
    m({ remoteJid: OWNER, id: "s1" }, { stickerMessage: { mimetype: "image/webp" } }),
    m({ remoteJid: OWNER, id: "v1" }, { videoMessage: { mimetype: "video/mp4", seconds: 12, fileLength: 2 * MB } }),
  ] });
  assert.deepEqual(inbox(S), ["i1.jpg", "s1.webp", "v1.mp4"]);
  const [i, s, v] = got.messages;
  assert.deepEqual([i.text, i.files, i.media.path, i.media.kind], ["ini apa", [join(S.xchg, "inbox", "i1.jpg")], join(S.xchg, "inbox", "i1.jpg"), "image"]);
  assert.deepEqual([s.media.kind, s.media.path, s.text], ["sticker", join(S.xchg, "inbox", "s1.webp"), ""]);
  assert.deepEqual([v.media.kind, v.media.seconds, v.media.path], ["video", 12, join(S.xchg, "inbox", "v1.mp4")]);
  assert.equal(got.messages[0].key.id, "i1"); // the bridge reacts to this key
});

test("a family-group image addressed to Gremio is saved; an unaddressed or ungated one is not", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S, { groups: new Set([FAM]) });
  const img = (key, caption) => ({ ...gm(key, ""), message: { imageMessage: { caption, mimetype: "image/jpeg" } } });
  await F.handlers["messages.upsert"]({ type: "notify", messages: [
    img({ id: "g1" }, "gremio ini apa?"),
    img({ id: "g2" }, "foto liburan"),                                   // chatter
    img({ id: "g3", remoteJid: OTHER }, "gremio ini apa?"),              // another group, a member
    { ...gm({ id: "g4" }, ""), message: { stickerMessage: { mimetype: "image/webp" }, messageContextInfo: {} } }, // not addressed
  ] });
  assert.deepEqual(got.messages.map((x) => x.id), ["g1"]);
  assert.deepEqual(got.messages[0].files, [join(S.xchg, "inbox", "g1.jpg")]);
  assert.equal(got.messages[0].group.jid, FAM);
  assert.deepEqual(inbox(S), ["g1.jpg"]);
});

test("media over the cap is skipped and flagged: by the claimed size without downloading, and by the real bytes", async () => {
  const S = sandbox();
  let downloads = 0, size = 0;
  const { F, got } = await startWa(S);
  F.lib.downloadMediaMessage = async () => { downloads++; return Buffer.alloc(size); };
  await F.handlers["messages.upsert"]({ type: "notify", messages: [
    m({ remoteJid: OWNER, id: "b1" }, { imageMessage: { mimetype: "image/jpeg", fileLength: 11 * MB } }),
    m({ remoteJid: OWNER, id: "b2" }, { videoMessage: { mimetype: "video/mp4", fileLength: 51 * MB } }),
  ] });
  assert.equal(downloads, 0);
  size = 11 * MB; // the sender claimed less than the bytes
  await F.handlers["messages.upsert"]({ type: "notify", messages: [m({ remoteJid: OWNER, id: "b3" }, { stickerMessage: { fileLength: 1 } })] });
  size = 20 * MB; // a video of 20 MB is within its own cap
  await F.handlers["messages.upsert"]({ type: "notify", messages: [m({ remoteJid: OWNER, id: "b4" }, { videoMessage: { fileLength: 20 * MB, seconds: 3 } })] });
  assert.deepEqual(got.messages.map((x) => [x.media.tooLarge ?? false, x.media.path ? "saved" : "none"]), [[true, "none"], [true, "none"], [true, "none"], [false, "saved"]]);
  assert.deepEqual(inbox(S), ["b4.mp4"]);
});

test("react: the owner's DM goes to the owner, a group message to its own group; nothing else", async () => {
  const S = sandbox();
  const { F, wa } = await startWa(S);
  await wa.react({ id: "M1", remoteJid: "555@lid", fromMe: false });
  await wa.react({ id: "M2", remoteJid: FAM, participant: MEMBER }, { jid: FAM });
  await wa.react(undefined);
  await assert.rejects(wa.react({ id: "M3", remoteJid: "628222@s.whatsapp.net" }, { jid: "628222@s.whatsapp.net" }), /not a group JID/);
  await assert.rejects(wa.react({ id: "M4", remoteJid: OTHER }, { jid: FAM }), /not a group JID/); // the key must be from that chat
  const sends = F.sent.filter((x) => x.content?.react);
  assert.deepEqual(sends.map((x) => [x.jid, x.content.react.text, x.content.react.key.id]), [[OWNER, ACK_EMOJI, "M1"], [FAM, ACK_EMOJI, "M2"]]);
  assert.equal(ACK_EMOJI, "\u{1F440}");
});
