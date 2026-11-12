// Bridge health ping (PLAN phase 5, S9): every 5 minutes GET PING_BRIDGE_URL (a healthchecks.io check URL from the wa-bridge
// Secret) while the Baileys socket is open, so a disconnected or dead bridge stops pinging and the check alerts. No URL, no
// pinger. The URL carries the check's secret: it is never logged. A failing ping is logged once per failure streak and never throws.
import http from "node:http";
import https from "node:https";

export const PING_EVERY_MS = 5 * 60 * 1000;
export const PING_TIMEOUT_MS = 10 * 1000;

// GET url; resolves on 2xx, rejects otherwise or after timeoutMs. `agent` is the bridge's CONNECT proxy agent (https only);
// the built-in fetch would ignore it.
export function httpGet(url, { agent, timeoutMs = PING_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, { agent: u.protocol === "https:" ? agent : undefined, timeout: timeoutMs }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve(); else reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on("error", reject);
  });
}

// `get(url)`, `schedule(fn, ms)` (returns a stop function) and `isOpen()` are injectable.
export function createHealth({ url, isOpen, get = httpGet, schedule = (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); }, everyMs = PING_EVERY_MS, log = () => {} }) {
  let enabled = !!url;
  if (enabled) { try { if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("scheme"); } catch { enabled = false; log("health: PING_BRIDGE_URL is not an http(s) URL, ping disabled"); } }
  let failing = false, stop = null;
  async function tick() {
    if (!enabled || !isOpen()) return false; // a closed socket sends nothing: that silence is the alert
    try {
      await get(url);
      if (failing) log("health: ping recovered");
      failing = false;
      return true;
    } catch (e) {
      if (!failing) log(`health: ping failed: ${String(e?.message ?? e).slice(0, 120)}`); // once per streak
      failing = true;
      return false;
    }
  }
  return {
    tick,
    start() { if (enabled && !stop) stop = schedule(() => { tick(); }, everyMs); return enabled; },
    stop() { stop?.(); stop = null; },
  };
}
