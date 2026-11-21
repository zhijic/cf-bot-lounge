const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { Miniflare } = require("miniflare");

const ROOT = join(__dirname, "..");
const origin = "https://cf-bot-lounge.test";

const ALICE_TOKEN = "test-alice-admin";
const ASSISTANT_TOKEN = "test-assistant-bot";
const OPS_TOKEN = "test-ops-bot";
const HUMAN_TOKEN = "test-bob-human";

const DEFAULT_TOKENS = {
  [ALICE_TOKEN]: { id: "alice", name: "Alice", role: "admin" },
  [ASSISTANT_TOKEN]: { id: "assistant", name: "Assistant", role: "bot", rooms: ["*"] },
  [OPS_TOKEN]: { id: "ops-bot", name: "Ops Bot", role: "bot", rooms: ["ops"] },
  [HUMAN_TOKEN]: { id: "bob", name: "Bob", role: "human" },
};

const aliceHeaders = { Authorization: `Bearer ${ALICE_TOKEN}`, "Content-Type": "application/json" };
const assistantHeaders = { Authorization: `Bearer ${ASSISTANT_TOKEN}`, "Content-Type": "application/json" };
const opsHeaders = { Authorization: `Bearer ${OPS_TOKEN}`, "Content-Type": "application/json" };
const bobHeaders = { Authorization: `Bearer ${HUMAN_TOKEN}`, "Content-Type": "application/json" };

const legacy = {
  id: "mwo1fzri0nlq13",
  ts: "2026-11-19T21:00:00.000Z",
  from: "assistant",
  from_name: "Assistant",
  to: "all",
  text: "旧历史",
};

function startRuntime(opts = {}) {
  const {
    persist,
    tokens = { [ALICE_TOKEN]: { id: "alice", name: "Alice", role: "human" } },
    tokensJsonRaw,
    kv = false,
    r2 = false,
    bindings = {},
  } = opts;
  const config = {
    modules: true,
    modulesRoot: ROOT,
    modulesRules: [{ type: "Text", include: ["**/*.html"] }],
    cf: false,
    scriptPath: join(ROOT, "worker.js"),
    compatibilityDate: "2026-06-25",
    durableObjects: { CHAT_HISTORY: { className: "ChatHistory", useSQLite: true } },
    bindings: {
      TOKENS_JSON: tokensJsonRaw !== undefined ? tokensJsonRaw : JSON.stringify(tokens),
      ...bindings,
    },
  };
  if (persist) config.durableObjectsPersist = persist;
  if (kv) config.kvNamespaces = ["BOT_CHAT"];
  if (r2) config.r2Buckets = ["UPLOADS"];
  return new Miniflare(config);
}

async function request(runtime, path, status = 200, init) {
  const response = await runtime.dispatchFetch(origin + path, init);
  assert.equal(response.status, status, `Expected ${status} for ${init?.method || "GET"} ${path}, got ${response.status}`);
  return response.json();
}

async function post(runtime, text, opts = {}) {
  const { headers = aliceHeaders, room, extra = {} } = opts;
  const qs = room ? `?room=${encodeURIComponent(room)}` : "";
  const result = await request(runtime, `/api/messages${qs}`, 201, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, to: "assistant", from: "spoof", ...extra }),
  });
  return result.message;
}

function makeWsQueue(ws) {
  const messages = [];
  const waiters = [];
  let closed = null;
  const closeWaiters = [];

  ws.addEventListener("message", (ev) => {
    let data = ev.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch {}
    }
    if (waiters.length > 0) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.resolve(data);
    } else {
      messages.push(data);
    }
  });

  ws.addEventListener("close", (ev) => {
    closed = { code: ev.code, reason: ev.reason };
    while (closeWaiters.length > 0) {
      const w = closeWaiters.shift();
      clearTimeout(w.timer);
      w.resolve(closed);
    }
  });

  return {
    nextMessage(timeoutMs = 2000) {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for WS message`));
        }, timeoutMs);
        const entry = { resolve, timer };
        waiters.push(entry);
      });
    },
    waitForClose(timeoutMs = 2000) {
      if (closed) return Promise.resolve(closed);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = closeWaiters.indexOf(entry);
          if (idx >= 0) closeWaiters.splice(idx, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for WS close`));
        }, timeoutMs);
        const entry = { resolve, timer };
        closeWaiters.push(entry);
      });
    },
    get bufferedCount() {
      return messages.length;
    },
  };
}

function rawUpgradeStatus(baseUrl, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
          ...headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(body); } catch {}
          resolve({ status: res.statusCode, json, body });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function openRealWs(wsBase, path, extraHeaders) {
  const opts = extraHeaders ? { headers: extraHeaders } : undefined;
  const ws = opts ? new WebSocket(wsBase + path, opts) : new WebSocket(wsBase + path);
  const queue = makeWsQueue(ws);
  await new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (ev) => { cleanup(); reject(new Error(`WS open failed for ${path}: ${ev?.message || "error"}`)); };
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
  return { ws, queue };
}

test("Zero-KV bundled page serving, /api/health v2.0, and legacy KV fallback", async (t) => {
  // Zero-KV runtime: NO kvNamespaces bound at all!
  const zeroKv = startRuntime({ kv: false, r2: false });
  t.after(() => zeroKv.dispose());

  for (const path of ["/", "/index.html"]) {
    const res = await zeroKv.dispatchFetch(origin + path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") || "", /^text\/html/i);
    assert.equal(res.headers.get("Cache-Control"), "no-cache");
    const html = await res.text();
    assert.ok(html.includes("Bot Lounge"), `Missing 'Bot Lounge' marker on ${path}`);
    assert.ok(html.includes("发给"), `Missing '发给' marker on ${path}`);
  }

  const health = await request(zeroKv, "/api/health");
  assert.equal(health.ok, true);
  assert.equal(health.version, "2.0.0");
  assert.ok(typeof health.time === "string" && !Number.isNaN(Date.parse(health.time)));
  assert.deepEqual(health.capabilities, {
    websocket: true,
    rooms: true,
    uploads: false,
    admin: false,
  });

  // Empty room status works cleanly with zero KV
  const status = await request(zeroKv, "/api/status");
  assert.deepEqual(status, {
    ok: true,
    room: "general",
    latest_seq: 0,
    latest_id: "",
    latest_from: "",
    latest_to: "",
    count: 0,
  });

  // Legacy KV runtime: falls back to bundled PAGE_HTML if KV "page" absent, overrides when set
  const legacyKv = startRuntime({ kv: true });
  t.after(() => legacyKv.dispose());

  const bundledFallback = await legacyKv.dispatchFetch(origin + "/index.html");
  assert.equal(bundledFallback.status, 200);
  assert.ok((await bundledFallback.text()).includes("Bot Lounge"));

  const kv = await legacyKv.getKVNamespace("BOT_CHAT");
  await kv.put("page", "<!doctype html><title>Custom KV Override</title>");
  const overridden = await legacyKv.dispatchFetch(origin + "/");
  assert.equal(overridden.status, 200);
  assert.match(await overridden.text(), /Custom KV Override/);

  // Legacy KV messages import ONLY in "general", NOT in other rooms
  await kv.put("messages", JSON.stringify([legacy]));
  const opsStatus = await request(legacyKv, "/api/status?room=ops");
  assert.equal(opsStatus.count, 0);
  assert.equal(opsStatus.latest_seq, 0);

  const generalStatus = await request(legacyKv, "/api/status?room=general");
  assert.equal(generalStatus.count, 1);
  assert.equal(generalStatus.latest_seq, 1);
  assert.equal(generalStatus.latest_id, legacy.id);
});

test("imports legacy KV history, assigns integer seq, and concurrent sends read back via since_seq and legacy since", async (t) => {
  const runtime = startRuntime({ kv: true });
  t.after(() => runtime.dispose());
  const kv = await runtime.getKVNamespace("BOT_CHAT");
  await kv.put("messages", JSON.stringify([legacy]));

  await request(runtime, "/api/messages", 401);
  await request(runtime, "/api/me", 401);
  assert.deepEqual(await request(runtime, "/api/me", 200, { headers: aliceHeaders }), {
    ok: true,
    me: { id: "alice", name: "Alice", role: "human" },
  });

  await request(runtime, "/api/messages", 400, {
    method: "POST",
    headers: aliceHeaders,
    body: JSON.stringify({ text: "  " }),
  });

  assert.deepEqual(await request(runtime, "/api/status"), {
    ok: true,
    room: "general",
    latest_seq: 1,
    latest_id: legacy.id,
    latest_from: "assistant",
    latest_to: "all",
    count: 1,
  });

  const sent = await Promise.all(Array.from({ length: 24 }, (_, i) => post(runtime, "并发 " + i)));
  const orderedBySeq = [...sent].sort((a, b) => a.seq - b.seq);
  const orderedById = [...sent].sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.equal(new Set(sent.map((m) => m.id)).size, 24);
  assert.equal(new Set(sent.map((m) => m.seq)).size, 24);
  assert.deepEqual(orderedBySeq.map((m) => m.seq), Array.from({ length: 24 }, (_, i) => i + 2));
  for (const message of sent) {
    assert.equal(message.from, "alice");
    assert.equal(message.to, "assistant");
  }

  // since_seq pagination
  const page1 = await request(runtime, "/api/messages?since_seq=1&limit=10", 200, { headers: aliceHeaders });
  assert.equal(page1.room, "general");
  assert.deepEqual(page1.messages, orderedBySeq.slice(0, 10));

  const page2 = await request(runtime, "/api/messages?since_seq=" + page1.messages.at(-1).seq, 200, { headers: aliceHeaders });
  assert.deepEqual(page2.messages, orderedBySeq.slice(10));

  // Invalid since_seq rejected with 400
  for (const bad of ["-1", "abc", "", "1.5"]) {
    await request(runtime, "/api/messages?since_seq=" + encodeURIComponent(bad), 400, { headers: aliceHeaders });
  }

  // Legacy since=<id> pagination still works and backfills seq on legacy row
  const legacyFirst = await request(runtime, "/api/messages?since=" + legacy.id + "&limit=10", 200, { headers: aliceHeaders });
  assert.deepEqual(legacyFirst.messages, orderedById.slice(0, 10));
  const legacyNext = await request(runtime, "/api/messages?since=" + legacyFirst.messages.at(-1).id, 200, { headers: aliceHeaders });
  assert.deepEqual(legacyNext.messages, orderedById.slice(10));

  const all = await request(runtime, "/api/messages", 200, { headers: aliceHeaders });
  assert.deepEqual(all.messages, [{ ...legacy, seq: 1 }, ...orderedBySeq]);

  assert.deepEqual(await request(runtime, "/api/status"), {
    ok: true,
    room: "general",
    latest_seq: 25,
    latest_id: orderedBySeq.at(-1).id,
    latest_from: "alice",
    latest_to: "assistant",
    count: 25,
  });
  assert.equal(await kv.get("messages"), JSON.stringify([legacy]));
});

test("multi-room isolation, room validation, GET /api/rooms, and per-token room ACL", async (t) => {
  const runtime = startRuntime({
    tokens: DEFAULT_TOKENS,
    bindings: { ROOMS: "general,dev,ops" },
  });
  t.after(() => runtime.dispose());

  // Invalid room names return 400 across room endpoints
  for (const badRoom of ["__auth__", "_private", "../etc", "has space", "bad!room", "a".repeat(33)]) {
    await request(runtime, `/api/status?room=${encodeURIComponent(badRoom)}`, 400);
    await request(runtime, `/api/messages?room=${encodeURIComponent(badRoom)}`, 400, { headers: aliceHeaders });
    await request(runtime, `/api/bots?room=${encodeURIComponent(badRoom)}`, 400, { headers: aliceHeaders });
  }

  // "default" and case-normalization map properly
  const mGen = await post(runtime, "in general via default", { room: "default" });
  const mOps = await post(runtime, "in ops via uppercase", { room: "OPS" });
  const mCustom = await post(runtime, "in release room", { room: "release-2" });

  // Isolation between general and ops
  const genMsgs = await request(runtime, "/api/messages?room=general", 200, { headers: aliceHeaders });
  assert.equal(genMsgs.room, "general");
  assert.equal(genMsgs.messages.length, 1);
  assert.equal(genMsgs.messages[0].id, mGen.id);

  const opsMsgs = await request(runtime, "/api/messages?room=ops", 200, { headers: aliceHeaders });
  assert.equal(opsMsgs.room, "ops");
  assert.equal(opsMsgs.messages.length, 1);
  assert.equal(opsMsgs.messages[0].id, mOps.id);

  // Allow non-blocking waitUntil room registration to complete and check GET /api/rooms
  await new Promise((r) => setTimeout(r, 50));
  const aliceRooms = await request(runtime, "/api/rooms", 200, { headers: aliceHeaders });
  assert.equal(aliceRooms.ok, true);
  assert.ok(aliceRooms.rooms.includes("general"));
  assert.ok(aliceRooms.rooms.includes("dev"));
  assert.ok(aliceRooms.rooms.includes("ops"));
  assert.ok(aliceRooms.rooms.includes("release-2"));
  assert.equal(mCustom.text, "in release room");

  // Per-token room ACL: ops-bot only has rooms: ["ops"]
  const opsRooms = await request(runtime, "/api/rooms", 200, { headers: opsHeaders });
  assert.deepEqual(opsRooms, { ok: true, rooms: ["ops"] });

  await request(runtime, "/api/messages?room=general", 403, { headers: opsHeaders });
  await request(runtime, "/api/messages?room=general", 403, {
    method: "POST",
    headers: opsHeaders,
    body: JSON.stringify({ text: "blocked" }),
  });
  await request(runtime, "/api/bots?room=general", 403, { headers: opsHeaders });
  await request(runtime, `/api/messages/${encodeURIComponent(mGen.id)}?room=general`, 403, {
    method: "PATCH",
    headers: opsHeaders,
    body: JSON.stringify({ text: "blocked edit" }),
  });

  // ops-bot succeeds in room=ops
  const opsRead = await request(runtime, "/api/messages?room=ops", 200, { headers: opsHeaders });
  assert.equal(opsRead.messages.length, 1);
  const opsSent = await post(runtime, "ops ack", { headers: opsHeaders, room: "ops" });
  assert.equal(opsSent.from, "ops-bot");
});

test("PUBLIC_STATUS=false gates /api/status to participant token or STATUS_TOKEN only", async (t) => {
  const STATUS_TOKEN = "status-only-secret-token";
  const runtime = startRuntime({
    tokens: DEFAULT_TOKENS,
    bindings: {
      PUBLIC_STATUS: "false",
      STATUS_TOKEN,
    },
  });
  t.after(() => runtime.dispose());

  // Unauthenticated /api/status rejected
  await request(runtime, "/api/status", 401);
  await request(runtime, "/api/status?room=ops", 401);

  // Participant token allowed on authorized room, 403 on unauthorized room
  const aliceStatus = await request(runtime, "/api/status?room=general", 200, { headers: aliceHeaders });
  assert.equal(aliceStatus.ok, true);
  assert.equal(aliceStatus.room, "general");

  await request(runtime, "/api/status?room=general", 403, { headers: opsHeaders });
  const opsStatus = await request(runtime, "/api/status?room=ops", 200, { headers: opsHeaders });
  assert.equal(opsStatus.ok, true);
  assert.equal(opsStatus.room, "ops");

  // STATUS_TOKEN works on /api/status for any room, but gets 401 on all other endpoints
  const statusHeaders = { Authorization: `Bearer ${STATUS_TOKEN}`, "Content-Type": "application/json" };
  const stGeneral = await request(runtime, "/api/status?room=general", 200, { headers: statusHeaders });
  assert.equal(stGeneral.ok, true);
  const stOps = await request(runtime, "/api/status?room=ops", 200, { headers: statusHeaders });
  assert.equal(stOps.ok, true);

  await request(runtime, "/api/messages", 401, { headers: statusHeaders });
  await request(runtime, "/api/messages", 401, {
    method: "POST",
    headers: statusHeaders,
    body: JSON.stringify({ text: "should fail" }),
  });
  await request(runtime, "/api/bots", 401, { headers: statusHeaders });
  await request(runtime, "/api/me", 401, { headers: statusHeaders });
  await request(runtime, "/api/rooms", 401, { headers: statusHeaders });
  await request(runtime, "/api/admin/tokens", 401, { headers: statusHeaders });
});

test("ALLOWED_ORIGINS dynamic CORS allowlist echoes allowed origins with Vary: Origin and rejects others", async (t) => {
  const runtime = startRuntime({
    tokens: DEFAULT_TOKENS,
    bindings: {
      ALLOWED_ORIGINS: "https://chat.example.com, https://admin.example.com",
    },
  });
  t.after(() => runtime.dispose());

  // Allowed origin on OPTIONS preflight
  const preAllowed = await runtime.dispatchFetch(origin + "/api/messages", {
    method: "OPTIONS",
    headers: { Origin: "https://chat.example.com" },
  });
  assert.equal(preAllowed.status, 204);
  assert.equal(preAllowed.headers.get("Access-Control-Allow-Origin"), "https://chat.example.com");
  assert.equal(preAllowed.headers.get("Vary"), "Origin");
  assert.match(preAllowed.headers.get("Access-Control-Allow-Methods") || "", /PATCH/);
  assert.match(preAllowed.headers.get("Access-Control-Allow-Methods") || "", /DELETE/);
  assert.match(preAllowed.headers.get("Access-Control-Allow-Headers") || "", /X-Filename/);

  // Allowed origin on GET API response
  const getAllowed = await runtime.dispatchFetch(origin + "/api/health", {
    headers: { Origin: "https://admin.example.com" },
  });
  assert.equal(getAllowed.status, 200);
  assert.equal(getAllowed.headers.get("Access-Control-Allow-Origin"), "https://admin.example.com");
  assert.equal(getAllowed.headers.get("Vary"), "Origin");

  // Disallowed origin omits Access-Control-Allow-Origin and includes Vary: Origin
  const preEvil = await runtime.dispatchFetch(origin + "/api/messages", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example.com" },
  });
  assert.equal(preEvil.status, 204);
  assert.equal(preEvil.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(preEvil.headers.get("Vary"), "Origin");

  const getEvil = await runtime.dispatchFetch(origin + "/api/health", {
    headers: { Origin: "https://evil.example.com" },
  });
  assert.equal(getEvil.status, 200);
  assert.equal(getEvil.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(getEvil.headers.get("Vary"), "Origin");
});

test("reply_to + reply_preview, status validation, attachment-only messages, and PATCH /api/messages/:id", async (t) => {
  const runtime = startRuntime({ tokens: DEFAULT_TOKENS });
  t.after(() => runtime.dispose());

  const longOriginal = "O".repeat(120);
  const orig = await post(runtime, longOriginal, { headers: bobHeaders });

  // Invalid status rejected
  await request(runtime, "/api/messages", 400, {
    method: "POST",
    headers: assistantHeaders,
    body: JSON.stringify({ text: "bad status", status: "running" }),
  });

  // Valid reply_to + status="thinking"
  const reply = await post(runtime, "Working on it...", {
    headers: assistantHeaders,
    extra: { reply_to: orig.id, status: "thinking", client_id: "re:" + orig.id },
  });
  assert.equal(reply.reply_to, orig.id);
  assert.deepEqual(reply.reply_preview, {
    id: orig.id,
    from: "bob",
    from_name: "Bob",
    text: longOriginal.slice(0, 80),
  });
  assert.equal(reply.status, "thinking");
  assert.equal(reply.updated_at, undefined);

  // Attachment-only message allowed; bad attachment URL rejected
  await request(runtime, "/api/messages", 400, {
    method: "POST",
    headers: aliceHeaders,
    body: JSON.stringify({
      text: "",
      attachments: [{ key: "general/a.png", name: "a.png", content_type: "image/png", size: 10, url: "https://evil.example/x.png" }],
    }),
  });
  const attOnly = await request(runtime, "/api/messages", 201, {
    method: "POST",
    headers: aliceHeaders,
    body: JSON.stringify({
      text: "",
      attachments: [{ key: "general/a.png", name: "a.png", content_type: "image/png", size: 10, url: "/api/uploads/general/a.png" }],
    }),
  });
  assert.equal(attOnly.message.text, "");
  assert.equal(attOnly.message.attachments.length, 1);

  // PATCH /api/messages/:id — sender allowed, sets updated_at
  const patched = await request(runtime, `/api/messages/${encodeURIComponent(reply.id)}`, 200, {
    method: "PATCH",
    headers: assistantHeaders,
    body: JSON.stringify({ text: "Final answer!", status: "done" }),
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.message.id, reply.id);
  assert.equal(patched.message.seq, reply.seq);
  assert.equal(patched.message.text, "Final answer!");
  assert.equal(patched.message.status, "done");
  assert.ok(typeof patched.message.updated_at === "string" && !Number.isNaN(Date.parse(patched.message.updated_at)));

  // Non-sender (human) gets 403
  await request(runtime, `/api/messages/${encodeURIComponent(reply.id)}`, 403, {
    method: "PATCH",
    headers: bobHeaders,
    body: JSON.stringify({ text: "hijack" }),
  });

  // Admin allowed to edit another sender's message and clear status with null
  const adminPatched = await request(runtime, `/api/messages/${encodeURIComponent(reply.id)}`, 200, {
    method: "PATCH",
    headers: aliceHeaders,
    body: JSON.stringify({ status: null }),
  });
  assert.equal(adminPatched.message.status, undefined);
  assert.equal(adminPatched.message.text, "Final answer!");
  assert.ok(adminPatched.message.updated_at);

  // Validation errors on PATCH: invalid status, empty text, empty body, missing ID
  await request(runtime, `/api/messages/${encodeURIComponent(reply.id)}`, 400, {
    method: "PATCH",
    headers: assistantHeaders,
    body: JSON.stringify({ status: "bogus" }),
  });
  await request(runtime, `/api/messages/${encodeURIComponent(reply.id)}`, 400, {
    method: "PATCH",
    headers: assistantHeaders,
    body: JSON.stringify({ text: "   " }),
  });
  await request(runtime, `/api/messages/${encodeURIComponent(reply.id)}`, 400, {
    method: "PATCH",
    headers: assistantHeaders,
    body: JSON.stringify({}),
  });
  await request(runtime, "/api/messages/nonexistent-id", 404, {
    method: "PATCH",
    headers: aliceHeaders,
    body: JSON.stringify({ text: "ghost" }),
  });
});

test("WebSocket Hibernation: header & first-frame auth, unauthed isolation, ACL/spoof protection, ping/pong, typing, and broadcasts", async (t) => {
  const runtime = startRuntime({ tokens: DEFAULT_TOKENS });
  t.after(() => runtime.dispose());
  const baseUrl = (await runtime.ready).toString().replace(/\/+$/, "");
  const wsBase = baseUrl.replace(/^http/, "ws");

  // Non-upgrade returns 426
  await request(runtime, "/api/ws?room=general", 426, { headers: aliceHeaders });

  // Header Bearer auth failure: invalid token -> 401; unauthorized room -> 403
  assert.equal(
    (await rawUpgradeStatus(baseUrl, "/api/ws?room=general", { Authorization: "Bearer invalid-token" })).status,
    401
  );
  assert.equal(
    (await rawUpgradeStatus(baseUrl, "/api/ws?room=general", { Authorization: `Bearer ${OPS_TOKEN}` })).status,
    403
  );

  // Security regression: spoofed X-Lounge-Room header MUST NOT bypass room ACL!
  assert.equal(
    (await rawUpgradeStatus(baseUrl, "/api/ws?room=general", {
      Authorization: `Bearer ${OPS_TOKEN}`,
      "X-Lounge-Room": "ops",
    })).status,
    403
  );
  const spoofFirstFrame = await openRealWs(wsBase, "/api/ws?room=general", {
    "X-Lounge-Room": "ops",
  });
  spoofFirstFrame.ws.send(JSON.stringify({ type: "auth", token: OPS_TOKEN }));
  const spoofErr = await spoofFirstFrame.queue.nextMessage();
  assert.deepEqual(spoofErr, { type: "error", error: "unauthorized" });
  const spoofClose = await spoofFirstFrame.queue.waitForClose();
  assert.equal(spoofClose.code, 4001);

  // Bad first-frame auth rejected with error + close 4001
  const badWs = await openRealWs(wsBase, "/api/ws?room=general");
  badWs.ws.send(JSON.stringify({ type: "auth", token: "wrong-token" }));
  assert.deepEqual(await badWs.queue.nextMessage(), { type: "error", error: "unauthorized" });
  assert.equal((await badWs.queue.waitForClose()).code, 4001);

  // Open 3 sockets in #general:
  // 1) Alice via Header Bearer auth
  // 2) Assistant via first-frame { type: "auth", token }
  // 3) Unauthenticated socket (never sends auth — must receive ZERO broadcasts!)
  const aliceSock = await openRealWs(wsBase, "/api/ws?room=general", {
    Authorization: `Bearer ${ALICE_TOKEN}`,
  });
  const assistantSock = await openRealWs(wsBase, "/api/ws?room=general");
  const unauthedSock = await openRealWs(wsBase, "/api/ws?room=general");
  // Plus a 4th socket in #ops to verify cross-room isolation
  const opsSock = await openRealWs(wsBase, "/api/ws?room=ops", {
    Authorization: `Bearer ${OPS_TOKEN}`,
  });

  t.after(() => {
    for (const s of [aliceSock, assistantSock, unauthedSock, opsSock]) {
      try { s.ws.close(1000); } catch {}
    }
  });

  // First-frame auth succeeds
  assistantSock.ws.send(JSON.stringify({ type: "auth", token: ASSISTANT_TOKEN }));
  const authOk = await assistantSock.queue.nextMessage();
  assert.deepEqual(authOk, {
    type: "auth_ok",
    me: { id: "assistant", name: "Assistant", role: "bot" },
    room: "general",
  });

  // ping -> pong
  aliceSock.ws.send(JSON.stringify({ type: "ping" }));
  assert.deepEqual(await aliceSock.queue.nextMessage(), { type: "pong" });

  // typing -> broadcast to other authed sockets in same room only
  aliceSock.ws.send(JSON.stringify({ type: "typing" }));
  const typingFrame = await assistantSock.queue.nextMessage();
  assert.deepEqual(typingFrame, {
    type: "typing",
    room: "general",
    from: "alice",
    from_name: "Alice",
  });

  // POST /api/messages -> real-time "message" broadcast to both authed sockets in #general
  const posted = await post(runtime, "Hello via WS", { headers: aliceHeaders, room: "general" });
  const mFrameAlice = await aliceSock.queue.nextMessage();
  const mFrameAssistant = await assistantSock.queue.nextMessage();
  assert.equal(mFrameAlice.type, "message");
  assert.equal(mFrameAlice.room, "general");
  assert.equal(mFrameAlice.message.id, posted.id);
  assert.equal(mFrameAssistant.type, "message");
  assert.equal(mFrameAssistant.message.id, posted.id);

  // PATCH /api/messages/:id -> real-time "message_updated" broadcast
  const updated = await request(runtime, `/api/messages/${encodeURIComponent(posted.id)}?room=general`, 200, {
    method: "PATCH",
    headers: aliceHeaders,
    body: JSON.stringify({ text: "Edited via WS", status: "done" }),
  });
  const uFrameAlice = await aliceSock.queue.nextMessage();
  const uFrameAssistant = await assistantSock.queue.nextMessage();
  assert.equal(uFrameAlice.type, "message_updated");
  assert.equal(uFrameAlice.message.text, "Edited via WS");
  assert.equal(uFrameAlice.message.status, "done");
  assert.equal(uFrameAssistant.type, "message_updated");
  assert.equal(uFrameAssistant.message.id, updated.message.id);

  // Verify unauthenticated socket and #ops socket received ZERO broadcasts!
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(unauthedSock.queue.bufferedCount, 0, "Unauthenticated socket must receive zero broadcasts");
  assert.equal(opsSock.queue.bufferedCount, 0, "Other room socket must receive zero broadcasts");

  // Cleanly close all open WebSockets before disposing Miniflare
  for (const s of [aliceSock, assistantSock, unauthedSock, opsSock]) {
    try { s.ws.close(1000, "test done"); } catch {}
  }
  await Promise.allSettled(
    [aliceSock, assistantSock, unauthedSock, opsSock].map((s) => s.queue.waitForClose(500))
  );
});

test("Presence in GET /api/bots reflects active callers and inactive participants", async (t) => {
  const runtime = startRuntime({ tokens: DEFAULT_TOKENS });
  t.after(() => runtime.dispose());

  // Alice queries /api/bots?room=general (touches Alice's presence; Assistant/Bob/Ops have not been active)
  const res1 = await request(runtime, "/api/bots?room=general", 200, { headers: aliceHeaders });
  assert.equal(res1.ok, true);
  assert.equal(res1.room, "general");
  assert.deepEqual(res1.me, { id: "alice", name: "Alice", role: "admin" });
  assert.deepEqual(res1.capabilities, { uploads: false, websocket: true, rooms: true });

  const byId1 = Object.fromEntries(res1.bots.map((b) => [b.id, b]));
  assert.equal(byId1.alice.online, true);
  assert.ok(typeof byId1.alice.last_seen_at === "string" && !Number.isNaN(Date.parse(byId1.alice.last_seen_at)));
  assert.equal(byId1.assistant.online, false);
  assert.equal(byId1.assistant.last_seen_at, null);
  assert.equal(byId1.bob.online, false);
  assert.equal(byId1.bob.last_seen_at, null);

  // Assistant posts in general -> becomes online with last_seen_at
  await post(runtime, "checking in", { headers: assistantHeaders, room: "general" });
  const res2 = await request(runtime, "/api/bots?room=general", 200, { headers: aliceHeaders });
  const byId2 = Object.fromEntries(res2.bots.map((b) => [b.id, b]));
  assert.equal(byId2.assistant.online, true);
  assert.ok(typeof byId2.assistant.last_seen_at === "string");
  assert.equal(byId2.bob.online, false);
  assert.equal(byId2.bob.last_seen_at, null);
});

test("Optional R2 attachments: 501 when unbound; multipart/raw upload, limits, MIME, and ACL-gated downloads when bound", async (t) => {
  // Without UPLOADS R2 bucket -> 501
  const noR2 = startRuntime({ tokens: DEFAULT_TOKENS, r2: false });
  t.after(() => noR2.dispose());
  await request(noR2, "/api/uploads?room=general", 501, {
    method: "POST",
    headers: { Authorization: `Bearer ${ALICE_TOKEN}`, "Content-Type": "text/plain", "X-Filename": "a.txt" },
    body: "hello",
  });
  await request(noR2, "/api/uploads/general/file.txt", 501, { headers: aliceHeaders });

  // With UPLOADS R2 bucket bound
  const withR2 = startRuntime({ tokens: DEFAULT_TOKENS, r2: true });
  t.after(() => withR2.dispose());

  const health = await request(withR2, "/api/health");
  assert.equal(health.capabilities.uploads, true);

  // Real local HTTP server for true multipart/form-data upload via FormData
  const baseUrl = (await withR2.ready).toString().replace(/\/+$/, "");

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const form = new FormData();
  form.append("file", new Blob([pngBytes], { type: "image/png" }), "../my image!.png");

  const mpRes = await fetch(`${baseUrl}/api/uploads?room=ops`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPS_TOKEN}` },
    body: form,
  });
  assert.equal(mpRes.status, 201);
  const mpData = await mpRes.json();
  assert.equal(mpData.ok, true);
  assert.equal(mpData.attachment.content_type, "image/png");
  assert.equal(mpData.attachment.size, pngBytes.byteLength);
  assert.ok(mpData.attachment.key.startsWith("ops/"));
  assert.ok(!mpData.attachment.key.includes(".."));
  assert.equal(mpData.attachment.url, `/api/uploads/${mpData.attachment.key}`);

  // Raw body upload in general
  const rawPayload = "hello attachment raw body";
  const rawRes = await withR2.dispatchFetch(origin + "/api/uploads?room=general", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ALICE_TOKEN}`,
      "Content-Type": "text/plain",
      "X-Filename": "notes.txt",
    },
    body: rawPayload,
  });
  assert.equal(rawRes.status, 201);
  const rawData = await rawRes.json();
  assert.equal(rawData.attachment.content_type, "text/plain");
  assert.equal(rawData.attachment.size, Buffer.byteLength(rawPayload));
  assert.ok(rawData.attachment.key.startsWith("general/"));

  // Size limit (> 5 MB) -> 413
  const tooBig = new Uint8Array(5 * 1024 * 1024 + 1);
  const bigRes = await withR2.dispatchFetch(origin + "/api/uploads?room=general", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ALICE_TOKEN}`,
      "Content-Type": "text/plain",
      "X-Filename": "big.txt",
    },
    body: tooBig,
  });
  assert.equal(bigRes.status, 413);

  // Disallowed MIME -> 415
  const badMime = await withR2.dispatchFetch(origin + "/api/uploads?room=general", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ALICE_TOKEN}`,
      "Content-Type": "text/html",
      "X-Filename": "xss.html",
    },
    body: "<script>alert(1)</script>",
  });
  assert.equal(badMime.status, 415);

  // Unauthorized room upload -> 403
  await request(withR2, "/api/uploads?room=general", 403, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPS_TOKEN}`, "Content-Type": "text/plain", "X-Filename": "nope.txt" },
    body: "nope",
  });

  // Authenticated GET /api/uploads/:room/:file
  // 401 without auth
  await request(withR2, rawData.attachment.url, 401);
  // 403 when ops-bot tries to read general attachment
  await request(withR2, rawData.attachment.url, 403, { headers: opsHeaders });
  // 400 on traversal attempt
  await request(withR2, "/api/uploads/general/%2e%2e%2fsecret.txt", 400, { headers: aliceHeaders });
  // 404 on missing file
  await request(withR2, "/api/uploads/general/does-not-exist.txt", 404, { headers: aliceHeaders });
  // 200 authorized download with nosniff + inline
  const dl = await withR2.dispatchFetch(origin + rawData.attachment.url, { headers: aliceHeaders });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("Content-Type"), "text/plain");
  assert.equal(dl.headers.get("Content-Disposition"), "inline");
  assert.equal(dl.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(await dl.text(), rawPayload);

  // ops-bot CAN read its own ops attachment
  const opsDl = await withR2.dispatchFetch(origin + mpData.attachment.url, { headers: opsHeaders });
  assert.equal(opsDl.status, 200);
  assert.equal(opsDl.headers.get("Content-Type"), "image/png");
  assert.equal(opsDl.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(new Uint8Array(await opsDl.arrayBuffer()), pngBytes);
});

test("Dynamic Token Management (/api/admin/tokens) and SSRF webhook URL validation", async (t) => {
  const ADMIN_TOKEN = "super-secret-admin-master-token";
  const runtime = startRuntime({
    tokens: DEFAULT_TOKENS,
    bindings: { ADMIN_TOKEN },
  });
  t.after(() => runtime.dispose());

  const masterHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };

  // Health reports admin capability
  const health = await request(runtime, "/api/health");
  assert.equal(health.capabilities.admin, true);

  // Auth checks: 401 unauth, 403 non-admin (bot / human)
  await request(runtime, "/api/admin/tokens", 401);
  await request(runtime, "/api/admin/tokens", 403, { headers: assistantHeaders });
  await request(runtime, "/api/admin/tokens", 403, { headers: bobHeaders });
  await request(runtime, "/api/admin/tokens", 403, {
    method: "POST",
    headers: bobHeaders,
    body: JSON.stringify({ id: "rogue" }),
  });

  // SSRF rejection for private/loopback/non-HTTPS webhook URLs
  const badWebhookUrls = [
    "http://hooks.example.com/lounge",
    "https://127.0.0.1/hook",
    "https://localhost/hook",
    "https://sub.localhost/hook",
    "https://192.168.1.1/hook",
    "https://10.0.0.1/hook",
    "https://172.16.0.5/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/hook",
    "https://[fe80::1]/hook",
    "https://[fc00::1]/hook",
    "https://service.local/hook",
    "https://metadata.google.internal/hook",
    "https://user:pass@hooks.example.com/hook",
  ];
  for (const badUrl of badWebhookUrls) {
    await request(runtime, "/api/admin/tokens", 400, {
      method: "POST",
      headers: masterHeaders,
      body: JSON.stringify({ id: "ssrf-bot", webhook_url: badUrl }),
    });
  }

  // Create a dynamic token using ADMIN_TOKEN
  const webhookSecret = "whsec-very-secret-hmac-key";
  const created = await request(runtime, "/api/admin/tokens", 201, {
    method: "POST",
    headers: masterHeaders,
    body: JSON.stringify({
      id: "dyn-bot",
      name: "Dynamic Bot",
      role: "bot",
      rooms: ["ops"],
      webhook_url: "https://hooks.example.com/lounge",
      webhook_secret: webhookSecret,
    }),
  });
  assert.equal(created.ok, true);
  assert.match(created.token, /^[0-9a-f]{48}$/);
  assert.equal(created.participant.id, "dyn-bot");
  assert.equal(created.participant.source, "dynamic");
  assert.equal(created.participant.has_webhook, true);

  // Dynamic token authenticates /api/me and /api/messages (and enforces rooms ACL!)
  const dynHeaders = { Authorization: `Bearer ${created.token}`, "Content-Type": "application/json" };
  const dynMe = await request(runtime, "/api/me", 200, { headers: dynHeaders });
  assert.deepEqual(dynMe, { ok: true, me: { id: "dyn-bot", name: "Dynamic Bot", role: "bot" } });
  await request(runtime, "/api/messages?room=general", 403, { headers: dynHeaders });
  const dynMsg = await post(runtime, "hello from dynamic bot", { headers: dynHeaders, room: "ops" });
  assert.equal(dynMsg.from, "dyn-bot");

  // GET /api/admin/tokens (using role === "admin" participant Alice) never leaks raw tokens, hashes, or webhook_secret!
  const tokenHash = crypto.createHash("sha256").update(created.token).digest("hex");
  const listRes = await runtime.dispatchFetch(origin + "/api/admin/tokens", { headers: aliceHeaders });
  assert.equal(listRes.status, 200);
  const listRaw = await listRes.text();
  for (const secret of [ALICE_TOKEN, ASSISTANT_TOKEN, OPS_TOKEN, ADMIN_TOKEN, created.token, tokenHash, webhookSecret]) {
    assert.ok(!listRaw.includes(secret), `GET /api/admin/tokens leaked sensitive material`);
  }
  const listJson = JSON.parse(listRaw);
  const dynEntry = listJson.tokens.find((t) => t.id === "dyn-bot");
  assert.ok(dynEntry);
  assert.equal(dynEntry.source, "dynamic");
  assert.equal(dynEntry.has_webhook, true);
  assert.equal(dynEntry.webhook_url, "https://hooks.example.com/lounge");
  assert.equal(dynEntry.webhook_secret, undefined);

  // DELETE /api/admin/tokens/:id immediately revokes dynamic token
  const del = await request(runtime, "/api/admin/tokens/dyn-bot", 200, {
    method: "DELETE",
    headers: aliceHeaders,
  });
  assert.deepEqual(del, { ok: true, revoked: 1 });

  await request(runtime, "/api/me", 401, { headers: dynHeaders });
  await request(runtime, "/api/messages?room=ops", 401, { headers: dynHeaders });
});

test("keeps only the latest 500 and imports legacy data only once across restarts", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "cf-bot-lounge-test-"));
  let runtime = startRuntime({ persist, kv: true });
  t.after(async () => {
    try { await runtime.dispose(); }
    finally { await rm(persist, { recursive: true, force: true }); }
  });
  const old = Array.from({ length: 500 }, (_, i) => ({
    ...legacy,
    id: "mwo1fzri" + String(i).padStart(6, "0"),
  }));
  const kv = await runtime.getKVNamespace("BOT_CHAT");
  await kv.put("messages", JSON.stringify(old));
  const sent = await post(runtime, "after import");
  await runtime.dispose();

  runtime = startRuntime({ persist, kv: true });
  const freshKv = await runtime.getKVNamespace("BOT_CHAT");
  await freshKv.put("messages", JSON.stringify([{ ...legacy, id: "late-legacy" }]));
  const status = await request(runtime, "/api/status");
  assert.equal(status.count, 500);
  assert.equal(status.latest_id, sent.id);
  assert.equal(status.latest_seq, 501);
  const retained = await request(runtime, "/api/messages?since=0&limit=2", 200, { headers: aliceHeaders });
  assert.deepEqual(retained.messages, [
    { ...old[1], seq: 2 },
    { ...old[2], seq: 3 },
  ]);
  const latest = await request(runtime, "/api/messages?limit=500", 200, { headers: aliceHeaders });
  assert.equal(latest.messages.length, 200);
  assert.deepEqual(latest.messages.at(-1), sent);
});

test("client_id makes retried sends idempotent per sender", async (t) => {
  const runtime = startRuntime({
    tokens: {
      [ALICE_TOKEN]: { id: "alice", name: "Alice", role: "human" },
      [ASSISTANT_TOKEN]: { id: "assistant", name: "Assistant", role: "bot" },
    },
  });
  t.after(() => runtime.dispose());
  const send = (h, body) =>
    runtime.dispatchFetch(origin + "/api/messages", {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });

  // Eight simultaneous retries of one reply: one stored, seven echo it back.
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      send(aliceHeaders, { text: "回复", to: "assistant", client_id: "re:abc" })
    )
  );
  const results = await Promise.all(responses.map((r) => r.json()));
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map((r) => r.message.id)).size, 1);
  assert.equal(results.filter((r) => r.duplicate === true).length, 7);
  assert.equal(results[0].message.client_id, "re:abc");

  // Same key from another sender, or a new key, is a separate message.
  assert.equal((await send(assistantHeaders, { text: "回复", client_id: "re:abc" })).status, 201);
  assert.equal((await send(aliceHeaders, { text: "回复", client_id: "re:def" })).status, 201);
  assert.equal((await send(aliceHeaders, { text: "无 key" })).status, 201);
  assert.equal((await request(runtime, "/api/status")).count, 4);

  for (const client_id of [42, "", "x".repeat(129)]) {
    assert.equal((await send(aliceHeaders, { text: "bad", client_id })).status, 400);
  }
  assert.equal((await request(runtime, "/api/status")).count, 4);
});

test("client_id is forgotten once its message leaves the 500 window", async (t) => {
  const runtime = startRuntime({ kv: true });
  t.after(() => runtime.dispose());
  const kv = await runtime.getKVNamespace("BOT_CHAT");
  await kv.put(
    "messages",
    JSON.stringify(
      Array.from({ length: 499 }, (_, i) => ({
        ...legacy,
        id: "mwo1fzri" + String(i).padStart(6, "0"),
      }))
    )
  );
  const send = (body) =>
    runtime.dispatchFetch(origin + "/api/messages", {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify(body),
    });
  const first = await (await send({ text: "keyed", client_id: "k1" })).json();
  assert.equal((await request(runtime, "/api/status")).count, 500);
  assert.equal((await send({ text: "keyed", client_id: "k1" })).status, 200);

  for (let i = 0; i < 500; i += 50) {
    await Promise.all(Array.from({ length: 50 }, (_, j) => send({ text: "fill " + (i + j) })));
  }
  const latest = await request(runtime, "/api/messages?limit=200", 200, { headers: aliceHeaders });
  assert.ok(!latest.messages.some((m) => m.id === first.message.id));
  const again = await send({ text: "keyed", client_id: "k1" });
  assert.equal(again.status, 201);
  assert.notEqual((await again.json()).message.id, first.message.id);
  assert.equal((await request(runtime, "/api/status")).count, 500);
});

test("rejects prototype-chain tokens, missing Bearer prefix, non-participant entries, and malformed TOKENS_JSON", async (t) => {
  const runtime = startRuntime({
    tokens: {
      [ALICE_TOKEN]: { id: "alice", name: "Alice", role: "human" },
      _comment: "do not treat comments as credentials",
    },
  });
  t.after(() => runtime.dispose());

  for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "_comment"]) {
    const badHeaders = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
    await request(runtime, "/api/messages", 401, { headers: badHeaders });
    await request(runtime, "/api/messages", 401, {
      method: "POST",
      headers: badHeaders,
      body: JSON.stringify({ text: "bypass attempt" }),
    });
    await request(runtime, "/api/bots", 401, { headers: badHeaders });
    await request(runtime, "/api/me", 401, { headers: badHeaders });
    await request(runtime, "/api/rooms", 401, { headers: badHeaders });
  }

  await request(runtime, "/api/messages", 401, { headers: { Authorization: ALICE_TOKEN } });
  await request(runtime, "/api/bots", 401, { headers: { Authorization: ALICE_TOKEN } });
  await request(runtime, "/api/me", 401, { headers: { Authorization: ALICE_TOKEN } });

  const meRes = await request(runtime, "/api/me", 200, { headers: aliceHeaders });
  assert.deepEqual(meRes.me, { id: "alice", name: "Alice", role: "human" });

  // Malformed TOKENS_JSON fails closed with 401
  const brokenRuntime = startRuntime({ tokensJsonRaw: "{broken-json" });
  t.after(() => brokenRuntime.dispose());
  await request(brokenRuntime, "/api/me", 401, { headers: aliceHeaders });
  await request(brokenRuntime, "/api/bots", 401, { headers: aliceHeaders });
  await request(brokenRuntime, "/api/messages", 401, { headers: aliceHeaders });
});

test("handles default CORS preflight, method restrictions, input normalization, fallback names, and token secrecy", async (t) => {
  const secretAlice = "secret-token-alice-9999";
  const secretBot = "secret-token-bot-8888";
  const runtime = startRuntime({
    tokens: {
      [secretAlice]: { id: "alice", name: "Alice", role: "human" },
      [secretBot]: { id: "helper-bot", role: "bot" },
    },
  });
  t.after(() => runtime.dispose());
  const authHeaders = { Authorization: `Bearer ${secretAlice}`, "Content-Type": "application/json" };

  // Default OPTIONS CORS preflight returns 204 with wildcard CORS + v2 methods/headers
  const preflight = await runtime.dispatchFetch(origin + "/api/messages", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(preflight.headers.get("Access-Control-Allow-Methods") || "", /GET.*POST.*PATCH.*DELETE.*OPTIONS/);
  assert.match(preflight.headers.get("Access-Control-Allow-Headers") || "", /Authorization.*Content-Type.*X-Filename/);

  // Non-GET methods on /api/health and /api/status are rejected
  for (const path of ["/api/health", "/api/status"]) {
    for (const method of ["POST", "PUT", "DELETE"]) {
      await request(runtime, path, 401, { method });
      await request(runtime, path, 404, { method, headers: authHeaders });
    }
  }

  // Invalid JSON body on POST /api/messages returns 400
  const badJson = await runtime.dispatchFetch(origin + "/api/messages", {
    method: "POST",
    headers: authHeaders,
    body: "{not-valid-json",
  });
  assert.equal(badJson.status, 400);

  // Blank to: "   " normalizes to "all" and text > 4000 chars truncates to 4000
  const longText = "a".repeat(4500);
  const normalized = await request(runtime, "/api/messages", 201, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ text: longText, to: "   " }),
  });
  assert.equal(normalized.message.to, "all");
  assert.equal(normalized.message.text.length, 4000);

  // Fallback from_name / name when participant omits name, and /api/bots never leaks token strings
  const botsRaw = await runtime.dispatchFetch(origin + "/api/bots", { headers: authHeaders });
  assert.equal(botsRaw.status, 200);
  const botsText = await botsRaw.text();
  assert.ok(!botsText.includes(secretAlice));
  assert.ok(!botsText.includes(secretBot));
  const botsData = JSON.parse(botsText);
  assert.equal(botsData.bots.length, 2);
  assert.equal(botsData.bots[1].id, "helper-bot");
  assert.equal(botsData.bots[1].name, "helper-bot");

  const botSent = await request(runtime, "/api/messages", 201, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretBot}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello from unnamed bot" }),
  });
  assert.equal(botSent.message.from, "helper-bot");
  assert.equal(botSent.message.from_name, "helper-bot");
  assert.equal(botSent.message.to, "all");
});
