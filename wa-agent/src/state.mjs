// Bridge state (PLAN 2.1, 2.2.1, 2.12): /home/bridge/wa/state.json plus the safe-write used for every bridge write.
import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

// Every bridge write: a random temp name opened O_CREAT|O_EXCL|O_NOFOLLOW (never through a symlink, never over an
// existing file), fsync, then rename. rename replaces whatever sits at the target, including a planted symlink,
// without following it, so a link to creds.json cannot redirect the write (PLAN 2.1).
export function safeWrite(path, data, mode = 0o644) {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

const fresh = () => ({
  v: 1,
  pairedAt: null,            // ms: first time the socket opened; the history sync after pairing is older than this
  lastTs: 0,                 // seconds: newest inbound message processed
  sessions: {},              // lane -> claude session id
  lanes: { chat: { queue: [], inflight: null } }, // lane -> {queue:[{text,id}], inflight:{raw,ids}|null, done?, fresh?}
  queue: [],                 // FIFO question queue across lanes
  polls: {},                 // poll message id -> {raw, qid, cursor, ts}
  inbox: {},                 // message id -> ts (ledger, S3)
  outbox: {},                // outbound key -> ts (no duplicate replies)
  pendingOut: [],            // sends that failed and wait for the socket
  codes: {},                 // critical-action code -> {lane, ts}
  grants: {}, grantsUsed: {},// grant id -> {kind, ts}
  tasks: {},                 // task lane -> {at}
  groups: {},                // group lane (grp_<digits>) -> {jid, family}: the only place a group destination is stored (PLAN 2.13)
  gq: {},                    // group lane -> its own question queue (never the owner's)
  usage: {},                 // yyyy-mm-dd -> {turns, input, output, cache_read, cache_creation}
});

const MAPS = ["sessions", "lanes", "polls", "inbox", "outbox", "codes", "grants", "grantsUsed", "tasks", "groups", "gq", "usage"];
const LIMITS = { inbox: 2000, outbox: 2000, polls: 200, grantsUsed: 500, codes: 200 };

export function openState(path) {
  let d;
  try { d = { ...fresh(), ...JSON.parse(readFileSync(path, "utf8")) }; } catch { d = fresh(); }
  // Tables keyed by ids that came from another process have no prototype: "__proto__" or "constructor" is then an
  // ordinary key and can never reach Object.prototype.
  for (const k of MAPS) d[k] = Object.assign(Object.create(null), d[k]);
  mkdirSync(dirname(path), { recursive: true });
  const trim = (name) => {
    const o = d[name], keys = Object.keys(o);
    if (keys.length <= LIMITS[name]) return;
    const ts = (k) => (typeof o[k] === "number" ? o[k] : o[k]?.ts ?? 0);
    keys.sort((a, b) => ts(a) - ts(b)).slice(0, keys.length - LIMITS[name]).forEach((k) => delete o[k]);
  };
  return {
    d,
    save() { for (const n of Object.keys(LIMITS)) trim(n); safeWrite(path, JSON.stringify(d), 0o600); },
  };
}
