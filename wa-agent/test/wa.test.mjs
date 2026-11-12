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
  assert.deepEqual(got.votes[0], { pollId: "P1", options: ["React"], voter: "owner", owner: true });
  F.lib.decryptPollVote = () => { throw new Error("bad"); };
  await up({ type: "notify", messages: [{ key: { id: "V2", remoteJid: OWNER }, messageTimestamp: 2, message: { pollUpdateMessage: vote("P1").pollUpdate } }] });
  await waitFor(() => got.votes.length === 2);
  assert.deepEqual(got.votes[1], { pollId: "P1", options: null, voter: "owner", owner: true });
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
  assert.deepEqual(got.messages[0].group, { jid: FAM, fromOwner: false, family: true, name: "Budi", jids: [MEMBER], quote: { key: { id: "u5", remoteJid: FAM, participant: MEMBER }, message: { conversation: "gremio cek" } } });
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

test("react: an allowlisted emoji is sent as given (DM and group); anything else goes out as 👀", async () => {
  const S = sandbox();
  const { F, wa } = await startWa(S);
  await wa.react({ id: "M1", remoteJid: "555@lid", fromMe: false }, { emoji: "\u{1F6E0}\uFE0F" });
  await wa.react({ id: "M2", remoteJid: FAM, participant: MEMBER }, { jid: FAM, emoji: "\u2764\uFE0F" });
  await wa.react({ id: "M3", remoteJid: "555@lid", fromMe: false }, { emoji: "\u{1F984}" });
  await wa.react({ id: "M4", remoteJid: FAM, participant: MEMBER }, { jid: FAM, emoji: "x" });
  const sends = F.sent.filter((x) => x.content?.react);
  assert.deepEqual(sends.map((x) => [x.jid, x.content.react.text]), [[OWNER, "\u{1F6E0}\uFE0F"], [FAM, "\u2764\uFE0F"], [OWNER, ACK_EMOJI], [FAM, ACK_EMOJI]]);
});

// ---------- human-like actions and perception (PLAN 2.14) ----------
// Message shapes here are written from Baileys 7.0.0-rc13's own sources (Utils/messages.js, Utils/process-message.js), not from a real
// account: polls made by others, edits, locations, contacts and reactions are verified against this fake socket only.
const ctxMention = (jids) => ({ mentionedJid: jids });
const SECRET = Buffer.from("0123456789abcdef0123456789abcdef");
const pollMsg = (key, name = "Futsal?", options = ["ikut", "gak"], ver = "pollCreationMessageV3", extra = {}) => ({
  key: { id: "P1", remoteJid: FAM, participant: MEMBER, ...key }, pushName: "Budi", messageTimestamp: 1_800_000_000,
  message: { [ver]: { name, selectableOptionsCount: 1, options: options.map((optionName) => ({ optionName })) }, messageContextInfo: { messageSecret: SECRET }, ...extra },
});

test("normalizeMessage reads polls (all three versions), locations, live locations, contacts, mentions and what a reply replies to", () => {
  const n = (message) => normalizeMessage(m({}, message));
  for (const ver of ["pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3"]) {
    assert.deepEqual(n({ [ver]: { name: "Q?", selectableOptionsCount: ver === "pollCreationMessage" ? 3 : 1, options: [{ optionName: "a" }, { optionName: "b" }] } }).poll, { question: "Q?", options: ["a", "b"], multi: ver === "pollCreationMessage" }, ver);
  }
  assert.equal(n({ pollCreationMessageV3: { name: "Q?", options: [] } }).poll, undefined);
  assert.deepEqual(n({ locationMessage: { degreesLatitude: -6.2, degreesLongitude: 106.8, name: "Monas", address: "Gambir" } }).location, { lat: -6.2, lng: 106.8, name: "Monas", address: "Gambir", caption: "", live: false });
  assert.deepEqual(n({ liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2, caption: "otw" } }).location, { lat: 1, lng: 2, name: "", address: "", caption: "otw", live: true });
  const vcard = "BEGIN:VCARD\nVERSION:3.0\nFN:Ibu\nTEL;type=CELL;type=VOICE;waid=6281234567890:+62 812-3456-7890\nitem1.TEL:08123\nEND:VCARD";
  assert.deepEqual(n({ contactMessage: { displayName: "Ibu", vcard } }).contacts, [{ name: "Ibu", numbers: ["+6281234567890", "08123"] }]);
  assert.deepEqual(n({ contactsArrayMessage: { contacts: [{ displayName: "A", vcard: "TEL:+111111" }, { displayName: "B", vcard: "no number" }] } }).contacts, [{ name: "A", numbers: ["+111111"] }, { name: "B", numbers: [] }]);
  assert.deepEqual(n({ extendedTextMessage: { text: "hai", contextInfo: ctxMention(["99:1@s.whatsapp.net", "555@lid"]) } }).mentionedJid, ["99@s.whatsapp.net", "555@lid"]);
  assert.deepEqual(n({ extendedTextMessage: { text: "ok", contextInfo: { stanzaId: "S9", participant: MEMBER, quotedMessage: { conversation: "x" } } } }).quotedKey, { id: "S9", participant: MEMBER });
  assert.equal(n({ conversation: "polos" }).quotedKey, undefined);
});

test("a poll made by a member of the family group, or by the owner anywhere, reaches the bridge with its creation message; anyone else's does not", async () => {
  const S = sandbox();
  const seen = [];
  const { F, got } = await startWa(S, { groups: new Set([FAM]), onSeen: (n) => seen.push(n) });
  await F.handlers["messages.upsert"]({ type: "notify", messages: [
    pollMsg({ id: "P1" }),                                                      // family member
    pollMsg({ id: "P2", remoteJid: OTHER }),                                    // member of another group: nobody's business
    pollMsg({ id: "P3", remoteJid: OTHER, participant: OWNER }),                // the owner in another group
    pollMsg({ id: "P4", fromMe: true }),                                        // our own, already kept when we sent it
    pollMsg({ id: "P5", remoteJid: "120777@g.us" }),                            // an unknown group
    pollMsg({ id: "P6", remoteJid: OTHER, participant: "555@lid" }, "Q?", ["a", "b"], "pollCreationMessageV2"), // an unknown LID whose phone twin is the owner
  ] });
  assert.deepEqual(seen.map((n) => n.id), ["P1", "P3", "P6"]);
  assert.deepEqual(got.messages, []);                                           // no turn input at this level
  const n = seen[0];
  assert.deepEqual([n.poll.question, n.poll.options, n.group.jid, n.group.fromOwner, n.group.name, n.group.jids], ["Futsal?", ["ikut", "gak"], FAM, false, "Budi", [MEMBER]]);
  const back = JSON.parse(n.pollRaw, baileys.BufferJSON.reviver);               // what state.json keeps: key, message and the secret
  assert.equal(back.key.participant, MEMBER);
  assert.equal(Buffer.from(back.message.messageContextInfo.messageSecret).toString(), SECRET.toString());
  assert.equal(seen[1].group.fromOwner, true);
});

test("a poll that addresses Gremio (a mention) is a message with its poll and creation message; in the owner's DM too", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S, { groups: new Set([FAM]), onSeen() { assert.fail("an addressed poll is a message"); } });
  const withMention = (key) => { const p = pollMsg(key); p.message.pollCreationMessageV3.contextInfo = ctxMention(["99@s.whatsapp.net"]); return p; };
  await F.handlers["messages.upsert"]({ type: "notify", messages: [withMention({ id: "P1" }), pollMsg({ id: "P2", remoteJid: OWNER, participant: undefined })] });
  assert.deepEqual(got.messages.map((x) => [x.id, x.poll?.question, typeof x.pollRaw]), [["P1", "Futsal?", "string"], ["P2", "Futsal?", "string"]]);
  assert.equal(got.messages[1].key.id, "P2");
});

test("votes of group members on a kept poll are decrypted with the creator's JIDs and reach the bridge with the voter; unknown polls are ignored", async () => {
  const S = sandbox();
  const F = fakeLib();
  const tried = [];
  F.lib.getKeyAuthor = (k, me) => k.participant ?? k.remoteJid ?? me;
  F.lib.decryptPollVote = (vote, o) => { tried.push(o); if (o.pollCreatorJid !== MEMBER || o.voterJid !== "628333@s.whatsapp.net") throw new Error("bad mac"); return { selectedOptions: ["h"] }; };
  F.lib.getAggregateVotesInPollMessage = () => [{ name: "ikut", voters: ["x"] }, { name: "gak", voters: [] }];
  const raw = JSON.stringify(pollMsg({ id: "P1" }), baileys.BufferJSON.replacer);
  const got = { votes: [] };
  const wa = createWa({ lib: F.lib, owners, groups: new Set([FAM]), ownerJid: OWNER, authDir: S.dir, xchg: S.xchg, polls: { get: (id) => (id === "P1" ? raw : undefined) }, log() {}, onMessage() {}, onVote: (v) => got.votes.push(v) });
  await wa.start();
  const vote = (key, id = "P1") => ({ key: { id: "V1", remoteJid: FAM, participant: "628333@s.whatsapp.net", ...key }, messageTimestamp: 1_800_000_001, message: { pollUpdateMessage: { pollCreationMessageKey: { id, remoteJid: FAM, participant: MEMBER }, vote: { encPayload: "x", encIv: "y" } } } });
  await F.handlers["messages.upsert"]({ type: "notify", messages: [vote({}), vote({ id: "V2" }, "UNKNOWN"), vote({ participant: undefined, id: "V3" }), vote({ fromMe: true, id: "V4" })] });
  await waitFor(() => got.votes.length === 1);
  assert.deepEqual(got.votes[0], { pollId: "P1", options: ["ikut"], voter: "628333@s.whatsapp.net", owner: false });
  assert.ok(tried.some((o) => o.pollCreatorJid === MEMBER)); // the creator is the member who made it, not Gremio
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got.votes.length, 1);                          // an unknown poll, a vote with no voter and our own echo count for nothing
  // the same vote arriving again as a message update gives the same voter and the same labels
  F.handlers["messages.update"]([{ key: { id: "P1", remoteJid: FAM, participant: MEMBER }, update: { pollUpdates: [{ pollUpdateMessageKey: { id: "V1", remoteJid: FAM, participant: "628333@s.whatsapp.net" }, vote: { encPayload: "x", encIv: "y" } }] } }]);
  await waitFor(() => got.votes.length === 2);
  assert.deepEqual(got.votes[1], got.votes[0]);
});

test("an owner's vote in another group is the voter 'owner'", async () => {
  const S = sandbox();
  const F = fakeLib();
  F.lib.getKeyAuthor = (k, me) => k.participant ?? me;
  F.lib.decryptPollVote = () => ({ selectedOptions: ["h"] });
  F.lib.getAggregateVotesInPollMessage = () => [{ name: "a", voters: ["x"] }];
  const raw = JSON.stringify(pollMsg({ id: "P1", remoteJid: OTHER, fromMe: true, participant: undefined }), baileys.BufferJSON.replacer);
  const got = { votes: [] };
  const wa = createWa({ lib: F.lib, owners, groups: new Set(), ownerJid: OWNER, authDir: S.dir, xchg: S.xchg, polls: { get: () => raw }, log() {}, onMessage() {}, onVote: (v) => got.votes.push(v) });
  await wa.start();
  await F.handlers["messages.upsert"]({ type: "notify", messages: [{ key: { id: "V1", remoteJid: OTHER, participant: OWNER }, messageTimestamp: 1, message: { pollUpdateMessage: { pollCreationMessageKey: { id: "P1" }, vote: { encPayload: "x", encIv: "y" } } } }] });
  await waitFor(() => got.votes.length === 1);
  assert.deepEqual(got.votes[0], { pollId: "P1", options: ["a"], voter: "owner", owner: true });
});

test("getMessage serves a kept poll of someone else, so Baileys can decrypt its votes", async () => {
  const S = sandbox();
  const raw = JSON.stringify(pollMsg({ id: "P1" }), baileys.BufferJSON.replacer);
  const { F } = await startWa(S, { polls: { get: (id) => (id === "P1" ? raw : undefined) } });
  const back = await F.sockets[0].cfg.getMessage({ id: "P1" });
  assert.equal(back.pollCreationMessageV3.name, "Futsal?");
  assert.equal(Buffer.from(back.messageContextInfo.messageSecret).toString(), SECRET.toString());
});

test("an edit arrives as a message update: the owner's DM and an addressed group message reach the bridge as edited, with the original's key and a ledger id of their own", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S, { groups: new Set([FAM]) });
  const edit = (key, text, ts = 1_800_000_050) => ({ key: { id: "ORIG", ...key }, update: { message: { editedMessage: { message: { conversation: text } } }, messageTimestamp: ts } });
  F.handlers["messages.update"]([
    edit({ remoteJid: OWNER }, "versi baru"),
    edit({ remoteJid: FAM, participant: MEMBER }, "gremio versi baru"),
    edit({ remoteJid: FAM, participant: MEMBER }, "bukan buat gremio"),          // chatter
    edit({ remoteJid: "628222@s.whatsapp.net" }, "dari orang asing"),
    edit({ remoteJid: OWNER, fromMe: true }, "dari kita sendiri"),
    { key: { id: "ORIG", remoteJid: OWNER }, update: { message: null, messageStubType: 1 } },   // a delete
    { key: { id: "ORIG", remoteJid: OWNER }, update: { status: 3 } },                           // a receipt
  ]);
  await waitFor(() => got.messages.length === 2);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got.messages.length, 2);
  const [d, g] = got.messages;
  assert.deepEqual([d.text, d.edited, d.id, d.key.id, d.media], ["versi baru", true, "ORIG:edit:1800000050", "ORIG", null]);
  assert.deepEqual([g.text, g.edited, g.id, g.group.quote.key.id, g.group.jid], ["gremio versi baru", true, "ORIG:edit:1800000050", "ORIG", FAM]);
});

test("a delete, an edit envelope and a reaction in messages.upsert are not messages", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S, { groups: new Set([FAM]) });
  await F.handlers["messages.upsert"]({ type: "notify", messages: [
    m({ remoteJid: OWNER, id: "x1" }, { protocolMessage: { type: 0, key: { id: "ORIG" } } }),
    m({ remoteJid: OWNER, id: "x2" }, { protocolMessage: { type: 14, key: { id: "ORIG" }, editedMessage: { conversation: "baru" } } }),
    m({ remoteJid: OWNER, id: "x3" }, { reactionMessage: { text: "👍", key: { id: "ORIG" } } }),
    gm({ id: "x4" }, "", null, { message: { protocolMessage: { type: 0, key: { id: "ORIG" } } } }),
  ] });
  assert.deepEqual(got.messages, []);
});

test("messages.reaction: the owner in his DM, a family member or the owner in a group; strangers, our own echo and removals are ignored", async () => {
  const S = sandbox();
  const reactions = [];
  const { F } = await startWa(S, { groups: new Set([FAM]), onReaction: (r) => reactions.push(r) });
  const r = (rkey, text, key = { id: "GRMSG" }) => ({ key, reaction: { text, key: { id: "RX", ...rkey }, senderTimestampMs: 1 } });
  F.handlers["messages.reaction"]([
    r({ remoteJid: OWNER }, "👍", { id: "A1", remoteJid: OWNER, fromMe: true }),
    r({ remoteJid: "628222@s.whatsapp.net" }, "👍"),                                // a stranger's DM
    r({ remoteJid: OWNER, fromMe: true }, "👀"),                                    // our own reaction coming back
    r({ remoteJid: OWNER }, ""),                                                    // the owner took it back
    r({ remoteJid: FAM, participant: MEMBER }, "😂", { id: "A2", remoteJid: FAM, fromMe: true }),
    r({ remoteJid: OTHER, participant: MEMBER }, "😂"),                             // a member of another group
    r({ remoteJid: OTHER, participant: OWNER }, "🙏", { id: "A3", remoteJid: OTHER }),
    r({ remoteJid: "120777@g.us", participant: OWNER }, "🙏"),                      // the owner in a group: his, even if the bridge has no lane for it (it decides)
    r({ remoteJid: FAM, participant: "555@lid" }, "❤️", { id: "A4", remoteJid: FAM }), // an unknown LID whose twin is the owner
  ]);
  await waitFor(() => reactions.length === 5);
  assert.deepEqual(reactions.map((x) => [x.chat, x.id, x.emoji, x.owner]), [[null, "A1", "👍", true], [FAM, "A2", "😂", false], [OTHER, "A3", "🙏", true], ["120777@g.us", "GRMSG", "🙏", true], [FAM, "A4", "❤️", true]]);
  assert.deepEqual(reactions[1].jids, [MEMBER]);
});

test("mentions in a message are classified: Gremio (phone or LID), the owner, anyone else", async () => {
  const S = sandbox();
  const { F, got } = await startWa(S, { groups: new Set([FAM]) });
  await F.handlers["messages.upsert"]({ type: "notify", messages: [
    gm({ id: "m1" }, "@99 @77 @628111 @628333", ctxMention(["99@s.whatsapp.net", "77@lid", OWNER, "628333@s.whatsapp.net"])),
    { key: { id: "m2", remoteJid: OWNER }, messageTimestamp: 1_800_000_000, message: { extendedTextMessage: { text: "tanya @628333", contextInfo: ctxMention(["628333@s.whatsapp.net"]) } } },
  ] });
  assert.deepEqual(got.messages[0].mentions, [{ jid: "99@s.whatsapp.net", who: "gremio" }, { jid: "77@lid", who: "gremio" }, { jid: OWNER, who: "owner" }, { jid: "628333@s.whatsapp.net", who: null }]);
  assert.deepEqual(got.messages[1].mentions, [{ jid: "628333@s.whatsapp.net", who: null }]);
});

test("the new sends take the owner or a group JID the bridge picked, never another JID, and a key must belong to the chat", async () => {
  const S = sandbox();
  const { F, wa } = await startWa(S, { groups: new Set([FAM]) });
  const dmKey = { id: "M1", remoteJid: "555@lid", fromMe: false }, grpKey = { id: "M2", remoteJid: FAM, participant: MEMBER, fromMe: false };
  await wa.reactAny(dmKey, "🎉");
  await wa.reactAny(grpKey, "🫶", { jid: FAM });
  await wa.reactAny(grpKey, "", { jid: FAM });
  await wa.reply("oke", { key: dmKey, message: { conversation: "halo" } }, { id: messageId("r1") });
  await wa.reply("siap", { key: grpKey, message: { conversation: "gremio" } }, { jid: FAM, id: messageId("r2") });
  await wa.sendMention("@628222 cek", [MEMBER], { jid: FAM, id: messageId("m1") });
  await wa.sendPoll("Makan?", ["a", "b"], { jid: FAM, id: messageId("p1"), multi: true });
  await wa.sendMedia({ kind: "image", data: Buffer.from("x"), mimetype: "image/png", caption: "nih" }, { id: messageId("i1") });
  await wa.sendMedia({ kind: "sticker", data: Buffer.from("x") }, { jid: FAM });
  await wa.sendMedia({ kind: "document", data: Buffer.from("x"), mimetype: "application/pdf", fileName: "a.pdf" }, { jid: FAM });
  await wa.sendMedia({ kind: "video", data: Buffer.from("x"), mimetype: "video/mp4", caption: "c" });
  await wa.edit(messageId("t"), "baru");
  await wa.edit(messageId("t"), "baru", { jid: FAM });
  await wa.remove(messageId("t"), { jid: FAM });
  assert.deepEqual(F.sent.map((s) => s.jid), [OWNER, FAM, FAM, OWNER, FAM, FAM, FAM, OWNER, FAM, FAM, OWNER, OWNER, FAM, FAM]);
  assert.deepEqual(F.sent[0].content.react, { text: "🎉", key: dmKey });
  assert.equal(F.sent[2].content.react.text, "");
  assert.deepEqual(F.sent[3].opts.quoted, { key: dmKey, message: { conversation: "halo" } });
  assert.deepEqual(F.sent[5].content, { text: "@628222 cek", mentions: [MEMBER] });
  assert.deepEqual(F.sent[6].content.poll, { name: "Makan?", values: ["a", "b"], selectableCount: 2 });
  assert.deepEqual(Object.keys(F.sent[7].content), ["image", "mimetype", "caption"]);
  assert.deepEqual(Object.keys(F.sent[8].content), ["sticker"]);
  assert.deepEqual(F.sent[9].content, { document: Buffer.from("x"), mimetype: "application/pdf", fileName: "a.pdf" });
  assert.equal(F.sent[10].content.video.toString(), "x");
  assert.deepEqual(F.sent[11].content.edit, { remoteJid: OWNER, fromMe: true, id: messageId("t") });
  assert.deepEqual(F.sent[12].content.edit, { remoteJid: FAM, fromMe: true, id: messageId("t") });
  assert.deepEqual(F.sent[13].content.delete, { remoteJid: FAM, fromMe: true, id: messageId("t") });
  const n = F.sent.length;
  // refused: a JID that is not a group, a group key for the owner's DM, a key of another group, a DM key for a group, a kind it does not know
  for (const call of [
    () => wa.reactAny(dmKey, "👍", { jid: OWNER }), () => wa.reactAny(dmKey, "👍", { jid: "628222@s.whatsapp.net" }),
    () => wa.reactAny(grpKey, "👍"), () => wa.reactAny({ ...grpKey, remoteJid: OTHER }, "👍", { jid: FAM }), () => wa.reactAny({ id: "M3", remoteJid: OWNER }, "👍", { jid: FAM }),
    () => wa.reply("x", { key: grpKey, message: {} }), () => wa.reply("x", { key: { id: "M" }, message: {} }, { jid: OWNER }),
    () => wa.sendMention("x", [MEMBER], { jid: OWNER }), () => wa.sendPoll("q", ["a", "b"], { jid: "x@s.whatsapp.net" }),
    () => wa.sendMedia({ kind: "audio", data: Buffer.from("x") }), () => wa.sendMedia({ kind: "image", data: Buffer.from("x") }, { jid: OWNER }),
    () => wa.edit("", "x"), () => wa.edit(messageId("t"), "x", { jid: OWNER }), () => wa.remove(messageId("t"), { jid: "628222@s.whatsapp.net" }), () => wa.remove(undefined),
  ]) await assert.rejects(call, /not the owner or a group JID/);
  assert.equal(F.sent.length, n);
});
