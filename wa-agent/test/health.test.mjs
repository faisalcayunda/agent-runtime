// Health ping (PLAN phase 5, S9): injectable socket state, GET and scheduler; one real-socket test for the timeout and status handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PING_EVERY_MS, PING_TIMEOUT_MS, createHealth, httpGet } from "../src/health.mjs";

const URL_ = "https://hc-ping.com/secret-check-uuid";
function mk(o = {}) {
  const { url = "url" in o ? o.url : URL_, open = true, fail = false } = o;
  const h = { open, fail, urls: [], logs: [], sched: null, stopped: 0 };
  const get = async (u) => { h.urls.push(u); if (h.fail) throw new Error("HTTP 502"); };
  const schedule = (fn, ms) => { h.sched = { fn, ms }; return () => { h.stopped++; }; };
  h.health = createHealth({ url, isOpen: () => h.open, get, schedule, log: (m) => h.logs.push(m) });
  return h;
}

test("pings every 5 minutes, and only while the socket is open", async () => {
  const h = mk();
  assert.equal(h.health.start(), true);
  assert.equal(h.sched.ms, PING_EVERY_MS);
  assert.equal(PING_EVERY_MS, 300000);
  h.sched.fn();
  await h.health.tick();
  assert.equal(h.urls.length, 2);
  assert.equal(h.urls[0], URL_);
  h.open = false;
  assert.equal(await h.health.tick(), false);
  assert.equal(h.urls.length, 2); // closed socket: no ping, the check alerts
  h.open = true;
  assert.equal(await h.health.tick(), true);
  assert.equal(h.urls.length, 3);
  h.health.stop();
  assert.equal(h.stopped, 1);
});

test("no URL means no pinger and no log", async () => {
  for (const url of [undefined, ""]) {
    const h = mk({ url });
    assert.equal(h.health.start(), false);
    assert.equal(h.sched, null);
    assert.equal(await h.health.tick(), false);
    assert.deepEqual([h.urls, h.logs], [[], []]);
  }
});

test("a bad or non-http URL disables the pinger without throwing or echoing the value", async () => {
  for (const url of ["not a url", "file:///etc/passwd"]) {
    const h = mk({ url });
    assert.equal(h.health.start(), false);
    assert.equal(await h.health.tick(), false);
    assert.deepEqual(h.urls, []);
    assert.equal(h.logs.length, 1);
    assert.ok(!h.logs[0].includes(url));
  }
});

test("a failing ping does not throw, is logged once per failure streak, and the next streak logs again", async () => {
  const h = mk({ fail: true });
  h.health.start();
  for (let i = 0; i < 3; i++) assert.equal(await h.health.tick(), false);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /ping failed: HTTP 502/);
  assert.ok(!h.logs[0].includes("secret-check-uuid")); // the URL is a secret
  h.fail = false;
  assert.equal(await h.health.tick(), true);
  assert.equal(h.logs.length, 2);
  assert.match(h.logs[1], /recovered/);
  h.fail = true;
  await h.health.tick();
  assert.equal(h.logs.length, 3);
  h.sched.fn(); // the scheduled callback swallows the rejection too
});

test("httpGet resolves on 2xx, rejects on other status, and times out a server that never answers", async () => {
  assert.equal(PING_TIMEOUT_MS, 10000);
  const srv = http.createServer((req, res) => {
    if (req.url === "/ok") res.end("OK");
    else if (req.url === "/bad") { res.statusCode = 500; res.end(); }
    // anything else: never answers
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await httpGet(`${base}/ok`);
    await assert.rejects(httpGet(`${base}/bad`), /HTTP 500/);
    await assert.rejects(httpGet(`${base}/hang`, { timeoutMs: 100 }), /timeout after 100 ms/);
  } finally { srv.closeAllConnections(); srv.close(); }
});
