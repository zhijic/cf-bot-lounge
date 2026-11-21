const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { Miniflare } = require("miniflare");

const origin = "https://cf-bot-lounge.test";
const headers = { Authorization: "Bearer test-alice", "Content-Type": "application/json" };
const legacy = {
  id: "mwo1fzri0nlq13", ts: "2026-11-19T21:00:00.000Z",
  from: "assistant", from_name: "Assistant", to: "all", text: "旧历史",
};

function startRuntime(persist, tokens = { "test-alice": { id: "alice", name: "Alice", role: "human" } }) {
  return new Miniflare({
    modules: true,
    cf: false,
    scriptPath: join(__dirname, "..", "worker.js"),
    compatibilityDate: "2026-06-25",
    kvNamespaces: ["BOT_CHAT"],
    durableObjects: { CHAT_HISTORY: { className: "ChatHistory", useSQLite: true } },
    durableObjectsPersist: persist,
    bindings: { TOKENS_JSON: JSON.stringify(tokens) },
  });
}

async function request(runtime, path, status = 200, init) {
  const response = await runtime.dispatchFetch(origin + path, init);
  assert.equal(response.status, status);
  return response.json();
}

async function post(runtime, text) {
  const result = await request(runtime, "/api/messages", 201, {
    method: "POST", headers, body: JSON.stringify({ text, to: "assistant", from: "spoof" }),
  });
  return result.message;
}

test("imports legacy KV history and all concurrent sends read back in cursor order", async (t) => {
  const runtime = startRuntime();
  t.after(() => runtime.dispose());
  const kv = await runtime.getKVNamespace("BOT_CHAT");
  await kv.put("messages", JSON.stringify([legacy]));
  await kv.put("page", "<html>CF Bot Lounge</html>");

  const page = await runtime.dispatchFetch(origin + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CF Bot Lounge/);
  assert.equal((await request(runtime, "/api/health")).ok, true);
  await request(runtime, "/api/messages", 401);
  await request(runtime, "/api/me", 401);
  assert.deepEqual(await request(runtime, "/api/me", 200, { headers }), {
    ok: true,
    me: { id: "alice", name: "Alice", role: "human" },
  });
  assert.deepEqual(await request(runtime, "/api/bots", 200, { headers }), {
    ok: true,
    me: { id: "alice", name: "Alice", role: "human" },
    bots: [{ id: "alice", name: "Alice", role: "human" }],
  });
  await request(runtime, "/api/messages", 400, {
    method: "POST", headers, body: JSON.stringify({ text: "  " }),
  });
  assert.deepEqual(await request(runtime, "/api/status"), {
    ok: true, latest_id: legacy.id, latest_from: "assistant", latest_to: "all", count: 1,
  });

  const sent = await Promise.all(Array.from({ length: 24 }, (_, i) => post(runtime, "并发 " + i)));
  const ordered = [...sent].sort((a, b) => a.id < b.id ? -1 : 1);
  assert.equal(new Set(sent.map((m) => m.id)).size, 24);
  for (const message of sent) {
    assert.equal(message.from, "alice");
    assert.equal(message.to, "assistant");
  }
  const first = await request(runtime, "/api/messages?since=" + legacy.id + "&limit=10", 200, { headers });
  assert.deepEqual(first.messages, ordered.slice(0, 10));
  const next = await request(runtime, "/api/messages?since=" + first.messages.at(-1).id, 200, { headers });
  assert.deepEqual(next.messages, ordered.slice(10));
  assert.deepEqual((await request(runtime, "/api/messages", 200, { headers })).messages,
    [legacy, ...ordered]);
  assert.deepEqual(await request(runtime, "/api/status"), {
    ok: true, latest_id: ordered.at(-1).id, latest_from: "alice", latest_to: "assistant", count: 25,
  });
  assert.equal(await kv.get("messages"), JSON.stringify([legacy]));
});

test("keeps only the latest 500 and imports legacy data only once across restarts", async (t) => {
  const persist = await mkdtemp(join(tmpdir(), "cf-bot-lounge-test-"));
  let runtime = startRuntime(persist);
  t.after(async () => {
    try { await runtime.dispose(); }
    finally { await rm(persist, { recursive: true, force: true }); }
  });
  const old = Array.from({ length: 500 }, (_, i) => ({
    ...legacy, id: "mwo1fzri" + String(i).padStart(6, "0"),
  }));
  const kv = await runtime.getKVNamespace("BOT_CHAT");
  await kv.put("messages", JSON.stringify(old));
  const sent = await post(runtime, "after import");
  await runtime.dispose();

  runtime = startRuntime(persist);
  const freshKv = await runtime.getKVNamespace("BOT_CHAT");
  await freshKv.put("messages", JSON.stringify([{ ...legacy, id: "late-legacy" }]));
  const status = await request(runtime, "/api/status");
  assert.equal(status.count, 500);
  assert.equal(status.latest_id, sent.id);
  const retained = await request(runtime, "/api/messages?since=0&limit=2", 200, { headers });
  assert.deepEqual(retained.messages, old.slice(1, 3));
  const latest = await request(runtime, "/api/messages?limit=500", 200, { headers });
  assert.equal(latest.messages.length, 200);
  assert.deepEqual(latest.messages.at(-1), sent);
});

test("client_id makes retried sends idempotent per sender", async (t) => {
  const runtime = startRuntime(undefined, {
    "test-alice": { id: "alice", name: "Alice", role: "human" },
    "test-assistant": { id: "assistant", name: "Assistant", role: "bot" },
  });
  t.after(() => runtime.dispose());
  const assistantHeaders = { ...headers, Authorization: "Bearer test-assistant" };
  const send = (h, body) => runtime.dispatchFetch(origin + "/api/messages", {
    method: "POST", headers: h, body: JSON.stringify(body),
  });

  // Eight simultaneous retries of one reply: one stored, seven echo it back.
  const responses = await Promise.all(Array.from({ length: 8 }, () =>
    send(headers, { text: "回复", to: "assistant", client_id: "re:abc" })));
  const results = await Promise.all(responses.map((r) => r.json()));
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(results.map((r) => r.message.id)).size, 1);
  assert.equal(results.filter((r) => r.duplicate === true).length, 7);
  assert.equal(results[0].message.client_id, "re:abc");

  // Same key from another sender, or a new key, is a separate message.
  assert.equal((await send(assistantHeaders, { text: "回复", client_id: "re:abc" })).status, 201);
  assert.equal((await send(headers, { text: "回复", client_id: "re:def" })).status, 201);
  assert.equal((await send(headers, { text: "无 key" })).status, 201);
  assert.equal((await request(runtime, "/api/status")).count, 4);

  for (const client_id of [42, "", "x".repeat(129)]) {
    assert.equal((await send(headers, { text: "bad", client_id })).status, 400);
  }
  assert.equal((await request(runtime, "/api/status")).count, 4);
});

test("client_id is forgotten once its message leaves the 500 window", async (t) => {
  const runtime = startRuntime();
  t.after(() => runtime.dispose());
  const kv = await runtime.getKVNamespace("BOT_CHAT");
  await kv.put("messages", JSON.stringify(Array.from({ length: 499 }, (_, i) => ({
    ...legacy, id: "mwo1fzri" + String(i).padStart(6, "0"),
  }))));
  const send = (body) => runtime.dispatchFetch(origin + "/api/messages", {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const first = await (await send({ text: "keyed", client_id: "k1" })).json();
  assert.equal((await request(runtime, "/api/status")).count, 500);
  assert.equal((await send({ text: "keyed", client_id: "k1" })).status, 200);

  for (let i = 0; i < 500; i += 50) {
    await Promise.all(Array.from({ length: 50 }, (_, j) => send({ text: "fill " + (i + j) })));
  }
  const latest = await request(runtime, "/api/messages?limit=200", 200, { headers });
  assert.ok(!latest.messages.some((m) => m.id === first.message.id));
  const again = await send({ text: "keyed", client_id: "k1" });
  assert.equal(again.status, 201);
  assert.notEqual((await again.json()).message.id, first.message.id);
  assert.equal((await request(runtime, "/api/status")).count, 500);
});

test("rejects prototype-chain tokens, missing Bearer prefix, and non-participant entries", async (t) => {
  const runtime = startRuntime(undefined, {
    "test-alice": { id: "alice", name: "Alice", role: "human" },
    "_comment": "do not treat comments as credentials",
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
  }

  await request(runtime, "/api/messages", 401, { headers: { Authorization: "test-alice" } });
  await request(runtime, "/api/bots", 401, { headers: { Authorization: "test-alice" } });
  await request(runtime, "/api/me", 401, { headers: { Authorization: "test-alice" } });

  const meRes = await request(runtime, "/api/me", 200, { headers });
  assert.deepEqual(meRes.me, { id: "alice", name: "Alice", role: "human" });

  const botsRes = await request(runtime, "/api/bots", 200, { headers });
  assert.deepEqual(botsRes.me, { id: "alice", name: "Alice", role: "human" });
  assert.deepEqual(botsRes.bots, [{ id: "alice", name: "Alice", role: "human" }]);
});

test("handles CORS preflight, page serving, method restrictions, input normalization, malformed config, and token secrecy", async (t) => {
  const secretAlice = "secret-token-alice-9999";
  const secretBot = "secret-token-bot-8888";
  const runtime = startRuntime(undefined, {
    [secretAlice]: { id: "alice", name: "Alice", role: "human" },
    [secretBot]: { id: "helper-bot", role: "bot" },
  });
  t.after(() => runtime.dispose());
  const authHeaders = { Authorization: `Bearer ${secretAlice}`, "Content-Type": "application/json" };

  // OPTIONS CORS preflight returns 204 with CORS headers
  const preflight = await runtime.dispatchFetch(origin + "/api/messages", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(preflight.headers.get("Access-Control-Allow-Methods") || "", /GET.*POST.*OPTIONS/);
  assert.match(preflight.headers.get("Access-Control-Allow-Headers") || "", /Authorization/);

  // Missing KV page returns 404; once uploaded, GET /index.html serves page
  const missingPage = await runtime.dispatchFetch(origin + "/index.html");
  assert.equal(missingPage.status, 404);
  const kv = await runtime.getKVNamespace("BOT_CHAT");
  await kv.put("page", "<!doctype html><title>CF Bot Lounge</title>");
  const indexPage = await runtime.dispatchFetch(origin + "/index.html");
  assert.equal(indexPage.status, 200);
  assert.match(indexPage.headers.get("Content-Type") || "", /text\/html/);
  assert.match(await indexPage.text(), /CF Bot Lounge/);

  // Non-GET methods on /api/health and /api/status are rejected (401 without auth / 404 with auth)
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
  assert.deepEqual(botsData.bots, [
    { id: "alice", name: "Alice", role: "human" },
    { id: "helper-bot", name: "helper-bot", role: "bot" },
  ]);

  const botSent = await request(runtime, "/api/messages", 201, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretBot}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello from unnamed bot" }),
  });
  assert.equal(botSent.message.from, "helper-bot");
  assert.equal(botSent.message.from_name, "helper-bot");
  assert.equal(botSent.message.to, "all");

  // Malformed TOKENS_JSON fails closed with 401
  const brokenRuntime = new Miniflare({
    modules: true,
    cf: false,
    scriptPath: join(__dirname, "..", "worker.js"),
    compatibilityDate: "2026-06-25",
    kvNamespaces: ["BOT_CHAT"],
    durableObjects: { CHAT_HISTORY: { className: "ChatHistory", useSQLite: true } },
    bindings: { TOKENS_JSON: "{broken-json" },
  });
  t.after(() => brokenRuntime.dispose());
  await request(brokenRuntime, "/api/me", 401, { headers: authHeaders });
  await request(brokenRuntime, "/api/bots", 401, { headers: authHeaders });
  await request(brokenRuntime, "/api/messages", 401, { headers: authHeaders });
});
