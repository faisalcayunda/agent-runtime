// Human-like WhatsApp actions and perception (PLAN 2.14): message refs, send caps, the per-lane rate limit, and the text the
// model reads for what other people send (polls, locations, contacts, mentions). Pure helpers: no socket, no clock of its own.
// Everything that comes from WhatsApp is attacker-controlled text here, so every string that reaches a prompt goes through
// clean() or cleanName() first: no brackets (the "[name (owner)]" marker must stay unforgeable), no line breaks, capped.
import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

const MB = 1024 * 1024;
export const SEND_CAPS = { image: 5 * MB, sticker: 5 * MB, video: 16 * MB, document: 20 * MB };
export const RATE_PER_MIN = 6;
export const RATE_PER_HOUR = 30;
export const REF_MAX = 200;      // messages a lane can refer to
export const PEOPLE_MAX = 200;   // names a group lane can mention
export const NOTES_MAX = 20;     // perceptions kept for the next turn of a lane
export const POLL_OPTIONS_MAX = 12;

// ---------- text that came from outside ----------
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
// Free text (poll question, location name): square brackets become round ones, so a "[Faisal (owner)]" cannot be typed.
export const clean = (s, max = 200) => String(s ?? "").replace(CONTROL, " ").replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim().slice(0, max);
// A person's display name: no brackets or parentheses at all (the same rule as the sender label of a group message).
export const cleanName = (s, max = 40) => String(s ?? "").replace(CONTROL, " ").replace(/[\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
export const maskDigits = (s) => String(s).replace(/\d(?=\d{4})/g, "*");

// ---------- refs: short opaque ids the bridge gives the model for messages it may act on ----------
// One table per lane in bridge state: {items: [{ref, id, chat, from, name, mine, kind, text, file, ts}], people: {jid: name}}.
// `mine` is set only by the bridge's own send records, never from anything a sender says about a message.
export const refTable = (S, lane) => (S.refs[lane] ??= { items: [], people: {} });
export const parseRef = (s) => { const m = /^#?([0-9a-f]{4,12})$/i.exec(String(s ?? "").trim()); return m ? m[1].toLowerCase() : null; };
export const findRef = (S, lane, ref) => { const r = parseRef(ref); return r ? (S.refs[lane]?.items.find((i) => i.ref === r) ?? null) : null; };
export const findMsg = (S, lane, id) => S.refs[lane]?.items.find((i) => i.id === id) ?? null;

// Adds a message (or returns the one already there: a record is never rewritten, so a quote cannot turn a member's message
// into one of Gremio's). The ref is 4 hex characters of an HMAC, one longer for each clash within the lane. The key is random,
// made once per bridge and kept in its state: a ref cannot be worked out from a message id (which a lane may know) alone.
export function addRef(S, lane, entry) {
  const t = refTable(S, lane);
  const hit = t.items.find((i) => i.id === entry.id);
  if (hit) return hit;
  S.refKey ??= randomBytes(32).toString("hex");
  const h = createHmac("sha256", S.refKey).update(`${lane}:${entry.id}`).digest("hex");
  let len = 4;
  while (len < 12 && t.items.some((i) => i.ref === h.slice(0, len))) len++;
  const item = { ...entry, ref: h.slice(0, len) };
  t.items.push(item);
  if (t.items.length > REF_MAX) t.items.splice(0, t.items.length - REF_MAX);
  return item;
}

export const PERSON_JID = /^\d{5,30}@(?:s\.whatsapp\.net|lid)$/;
// people: {jid: {n: display name, p: the person's primary jid}}. One person can be known by a phone JID and a LID; both point at p,
// which is what a mention carries, so two forms of one person are not "two people with the same name".
export function addPerson(S, lane, jids, name) {
  const n = cleanName(name);
  const ok = (jids ?? []).filter((j) => PERSON_JID.test(j ?? ""));
  if (!n || !ok.length) return;
  const people = refTable(S, lane).people;
  for (const j of ok) people[j] = { n, p: ok[0] };
  const keys = Object.keys(people);
  if (keys.length > PEOPLE_MAX) for (const k of keys.slice(0, keys.length - PEOPLE_MAX)) delete people[k];
}
export const personName = (S, lane, jid) => S.refs[lane]?.people[jid]?.n;

// ---------- rate limit: at most 6 actions per destination chat per minute and 30 per hour ----------
// `table` is a map in bridge state (chat -> [ms of each accepted action]), so a restart does not reset it. check() only looks; take()
// counts an action, and the caller takes only after it has validated the action: a refused action costs no slot.
export function rateLimiter(now, table) {
  const look = (chat) => {
    const t = now();
    const a = (Array.isArray(table[chat]) ? table[chat] : []).filter((x) => Number.isFinite(x) && t - x < 3600_000);
    if (a.length) table[chat] = a; else delete table[chat];
    const m = a.filter((x) => t - x < 60_000);
    if (m.length >= RATE_PER_MIN) return { ok: false, waitS: Math.ceil((60_000 - (t - m[0])) / 1000) };
    if (a.length >= RATE_PER_HOUR) return { ok: false, waitS: Math.ceil((3600_000 - (t - a[0])) / 1000) };
    return { ok: true, a, t };
  };
  return {
    check(chat) { const { ok, waitS } = look(chat); return ok ? { ok } : { ok, waitS }; },
    take(chat) {
      const v = look(chat);
      if (!v.ok) return v;
      v.a.push(v.t);
      table[chat] = v.a;
      return { ok: true };
    },
  };
}

// A reaction is one emoji, or "" to take it back.
export const isEmojiOrEmpty = (s) => s === "" || (typeof s === "string" && /^\p{RGI_Emoji}$/v.test(s));

// ---------- what other people send, as text ----------
export const pollLine = (ref, p) => `[polling${ref ? ` #${ref}` : ""}: ${clean(p.question, 250)} | ${p.options.map((o, i) => `${i + 1}. ${clean(o, 100)}`).join(" ")}]`;

// votes: {voter: [labels]}, the latest vote of each voter. Zero-vote options are listed too.
export function tally(opts, votes) {
  const counts = new Map(opts.map((o) => [o, 0]));
  for (const labels of Object.values(votes ?? {})) for (const l of new Set(labels)) if (counts.has(l)) counts.set(l, counts.get(l) + 1);
  return [...counts];
}
export const pollResultLine = (ref, opts, votes) => `[hasil polling${ref ? ` #${ref}` : ""}: ${tally(opts, votes).map(([o, c]) => `${clean(o, 40)}=${c}`).join(", ")}]`;

const coord = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(5) : "?");
export function locationLine(l) {
  const at = `(${coord(l.lat)}, ${coord(l.lng)})`;
  if (l.live) return `[lokasi live dimulai ${at}${l.caption ? " " + clean(l.caption, 100) : ""}]`;
  const where = [clean(l.name, 100), clean(l.address, 150)].filter(Boolean).join(", ");
  return `[lokasi: ${where ? where + " " : ""}${at}]`;
}

// Phone numbers from a vCard (TEL lines), digits and a leading plus only.
export function vcardNumbers(vcard) {
  const out = [];
  for (const line of String(vcard ?? "").split(/\r?\n/)) {
    const m = /^(?:item\d+\.)?TEL[^:]*:(.+)$/i.exec(line.trim());
    const num = m?.[1].replace(/[^\d+]/g, "");
    if (num && num.replace(/\D/g, "").length >= 5) out.push(num.slice(0, 20));
  }
  return out;
}
// full: the number in clear (the owner's own message); otherwise all but the last four digits are masked.
export const contactLine = (c, full) => `[kontak: ${cleanName(c.name, 60) || "?"}${c.numbers.length ? " " + c.numbers.map((x) => (full ? x : maskDigits(x))).join(", ") : ""}]`;

// The lines a message adds after its own text. nameOf(jid) gives a display name for a mention; full: sender is the owner.
export function extraLines(n, { ref, full, nameOf }) {
  const out = [];
  if (n.poll) out.push(pollLine(ref, n.poll));
  if (n.location) out.push(locationLine(n.location));
  for (const c of n.contacts ?? []) out.push(contactLine(c, full));
  const names = (n.mentions ?? []).map((m) => (m.who === "gremio" ? "Gremio" : m.who === "owner" ? "owner" : nameOf(m.jid))).filter(Boolean);
  if (names.length) out.push(`[menyebut: ${[...new Set(names)].map((x) => cleanName(x)).join(", ")}]`);
  return out;
}

// ---------- reading a file to send ----------
// Opens without following a final symlink and counts the bytes it actually reads: neither stat nor a claimed size is trusted.
// uid: when given, the file must also belong to that uid and have no other hard link (a link to a file of another uid is not staged by it).
export function readCapped(path, cap, { uid } = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (uid != null && (st.uid !== uid || st.nlink !== 1)) throw new Error("not a file the runner staged");
    if (st.size > cap) throw new Error(`file is over ${cap / 1024 / 1024} MB`);
    const chunks = [], b = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const r = readSync(fd, b, 0, b.length, null);
      if (!r) break;
      total += r;
      if (total > cap) throw new Error(`file is over ${cap / 1024 / 1024} MB`);
      chunks.push(Buffer.from(b.subarray(0, r)));
    }
    return Buffer.concat(chunks);
  } finally { closeSync(fd); }
}
// A file staged by the runner in `dir` (its outbox: /xchg/sock/outbox). O_NOFOLLOW guards only the last path component, so the
// directory itself is checked too: a real directory (not a link) owned by the uid that owns its parent, and the file by that uid.
export function readStaged(dir, name, cap) {
  const parent = lstatSync(dirname(dir)), d = lstatSync(dir);
  if (!parent.isDirectory() || !d.isDirectory() || d.uid !== parent.uid) throw new Error("the staging directory is not the runner's");
  return readCapped(join(dir, name), cap, { uid: parent.uid });
}
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", md: "text/markdown" };
export const mimeOf = (kind, name) => (kind === "sticker" ? "image/webp" : MIME[String(name ?? "").split(".").pop().toLowerCase()] ?? (kind === "image" ? "image/jpeg" : kind === "video" ? "video/mp4" : "application/octet-stream"));
export const isWebp = (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
