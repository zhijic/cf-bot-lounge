const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { join } = require("node:path");
const readline = require("node:readline");
const { test } = require("node:test");
const { Miniflare } = require("miniflare");

const ROOT = join(__dirname, "..");
const MCP_SERVER_PATH = join(ROOT, "mcp", "server.mjs");

const ALICE_TOKEN = "mcp-test-alice-token";
const ASSISTANT_TOKEN = "mcp-test-assistant-token";

const TOKENS = {
  [ALICE_TOKEN]: { id: "alice", name: "Alice", role: "admin" },
  [ASSISTANT_TOKEN]: { id: "assistant", name: "Assistant", role: "bot", rooms: ["*"] },
};

function startMiniflare() {
  return new Miniflare({
    modules: true,
    modulesRoot: ROOT,
    modulesRules: [{ type: "Text", include: ["**/*.html"] }],
    cf: false,
    scriptPath: join(ROOT, "worker.js"),
    compatibilityDate: "2026-06-25",
    durableObjects: { CHAT_HISTORY: { className: "ChatHistory", useSQLite: true } },
    bindings: {
      TOKENS_JSON: JSON.stringify(TOKENS),
    },
  });
}

function spawnMcpClient(envOverrides) {
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...envOverrides },
  });

  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));

  const pending = new Map();
  const unexpected = [];
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      unexpected.push({ raw: trimmed, error: err.message });
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    } else {
      unexpected.push(msg);
    }
  });

  let nextId = 1;

  function request(method, params = {}, timeoutMs = 10_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request ${method} (id=${id}) timed out. stderr=${stderrChunks.join("")}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async function close() {
    rl.close();
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    request,
    notify,
    close,
    get unexpected() {
      return unexpected;
    },
    get stderr() {
      return stderrChunks.join("");
    },
  };
}

function parseToolJson(rpcResponse) {
  assert.equal(rpcResponse.jsonrpc, "2.0");
  assert.equal(rpcResponse.error, undefined, `Unexpected JSON-RPC error: ${JSON.stringify(rpcResponse.error)}`);
  assert.ok(rpcResponse.result);
  assert.ok(Array.isArray(rpcResponse.result.content));
  assert.equal(rpcResponse.result.content[0].type, "text");
  return {
    isError: Boolean(rpcResponse.result.isError),
    data: JSON.parse(rpcResponse.result.content[0].text),
  };
}

test("MCP stdio server end-to-end against local Miniflare HTTP server", async (t) => {
  const runtime = startMiniflare();
  t.after(() => runtime.dispose());
  const baseUrl = (await runtime.ready).toString().replace(/\/+$/, "");

  const client = spawnMcpClient({
    LOUNGE_URL: baseUrl + "/",
    LOUNGE_TOKEN: ASSISTANT_TOKEN,
    LOUNGE_ROOM: "general",
  });
  t.after(() => client.close());

  // 1. initialize
  const initRes = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verifier-test", version: "1.0.0" },
  });
  assert.equal(initRes.result.protocolVersion, "2024-11-05");
  assert.deepEqual(initRes.result.serverInfo, { name: "cf-bot-lounge-mcp", version: "2.0.0" });
  assert.deepEqual(initRes.result.capabilities, { tools: {} });

  // 2. notifications/initialized must emit zero stdout lines
  client.notify("notifications/initialized");

  // 3. ping
  const pingRes = await client.request("ping");
  assert.deepEqual(pingRes.result, {});

  // 4. tools/list returns all 5 tools
  const listRes = await client.request("tools/list");
  const toolNames = listRes.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "lounge_bots",
    "lounge_read",
    "lounge_send",
    "lounge_status",
    "lounge_update",
  ]);

  // 5. lounge_status on empty room
  const status0 = parseToolJson(await client.request("tools/call", {
    name: "lounge_status",
    arguments: {},
  }));
  assert.equal(status0.isError, false);
  assert.deepEqual(status0.data, {
    ok: true,
    room: "general",
    latest_seq: 0,
    latest_id: "",
    latest_from: "",
    latest_to: "",
    count: 0,
  });

  // 6. lounge_bots shows caller identity and online presence
  const botsRes = parseToolJson(await client.request("tools/call", {
    name: "lounge_bots",
    arguments: {},
  }));
  assert.equal(botsRes.isError, false);
  assert.equal(botsRes.data.ok, true);
  assert.deepEqual(botsRes.data.me, { id: "assistant", name: "Assistant", role: "bot" });
  const assistantEntry = botsRes.data.bots.find((b) => b.id === "assistant");
  assert.ok(assistantEntry);
  assert.equal(assistantEntry.online, true);

  // Seed an incoming user message directly over HTTP so MCP bot can reply to it
  const seedRes = await fetch(`${baseUrl}/api/messages?room=general`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ALICE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "Please summarize today's build", to: "assistant" }),
  });
  assert.equal(seedRes.status, 201);
  const seedMsg = (await seedRes.json()).message;
  assert.equal(seedMsg.seq, 1);

  // 7. lounge_send with reply_to, status="thinking", and client_id
  const sent = parseToolJson(await client.request("tools/call", {
    name: "lounge_send",
    arguments: {
      text: "Checking build logs...",
      to: "alice",
      reply_to: seedMsg.id,
      status: "thinking",
      client_id: "mcp-re:" + seedMsg.id,
    },
  }));
  assert.equal(sent.isError, false);
  assert.equal(sent.data.ok, true);
  assert.equal(sent.data.message.seq, 2);
  assert.equal(sent.data.message.from, "assistant");
  assert.equal(sent.data.message.to, "alice");
  assert.equal(sent.data.message.reply_to, seedMsg.id);
  assert.equal(sent.data.message.reply_preview.id, seedMsg.id);
  assert.equal(sent.data.message.status, "thinking");
  assert.equal(sent.data.message.client_id, "mcp-re:" + seedMsg.id);

  const replyId = sent.data.message.id;

  // 8. lounge_update transitions message in-place to final text + status="done"
  const updated = parseToolJson(await client.request("tools/call", {
    name: "lounge_update",
    arguments: {
      message_id: replyId,
      text: "All 20 checks passed!",
      status: "done",
    },
  }));
  assert.equal(updated.isError, false);
  assert.equal(updated.data.ok, true);
  assert.equal(updated.data.message.id, replyId);
  assert.equal(updated.data.message.text, "All 20 checks passed!");
  assert.equal(updated.data.message.status, "done");
  assert.ok(updated.data.message.updated_at);

  // 9. lounge_read with since_seq returns only newer messages with updated payload
  const readAfter1 = parseToolJson(await client.request("tools/call", {
    name: "lounge_read",
    arguments: { since_seq: 1, limit: 10 },
  }));
  assert.equal(readAfter1.isError, false);
  assert.equal(readAfter1.data.ok, true);
  assert.equal(readAfter1.data.room, "general");
  assert.equal(readAfter1.data.messages.length, 1);
  assert.equal(readAfter1.data.messages[0].id, replyId);
  assert.equal(readAfter1.data.messages[0].text, "All 20 checks passed!");
  assert.equal(readAfter1.data.messages[0].status, "done");

  // 10. Room isolation via explicit room parameter
  const opsSend = parseToolJson(await client.request("tools/call", {
    name: "lounge_send",
    arguments: { room: "ops", text: "ops alert" },
  }));
  assert.equal(opsSend.isError, false);
  assert.equal(opsSend.data.message.seq, 1);

  const statusGeneral = parseToolJson(await client.request("tools/call", {
    name: "lounge_status",
    arguments: { room: "general" },
  }));
  assert.equal(statusGeneral.data.count, 2);
  assert.equal(statusGeneral.data.latest_seq, 2);

  // 11. Validation error surfaces cleanly via isError: true without crashing server
  const badCall = parseToolJson(await client.request("tools/call", {
    name: "lounge_update",
    arguments: { message_id: replyId },
  }));
  assert.equal(badCall.isError, true);
  assert.equal(badCall.data.ok, false);

  // Verify zero corrupted stdout lines
  assert.deepEqual(client.unexpected, [], `Unexpected stdout messages: ${JSON.stringify(client.unexpected)}`);
});

test("MCP server allows public lounge_status without LOUNGE_TOKEN and errors cleanly on auth tools", async (t) => {
  const runtime = startMiniflare();
  t.after(() => runtime.dispose());
  const baseUrl = (await runtime.ready).toString().replace(/\/+$/, "");

  const client = spawnMcpClient({
    LOUNGE_URL: baseUrl,
    LOUNGE_TOKEN: "",
    LOUNGE_ROOM: "general",
  });
  t.after(() => client.close());

  const pubStatus = parseToolJson(await client.request("tools/call", {
    name: "lounge_status",
    arguments: {},
  }));
  assert.equal(pubStatus.isError, false);
  assert.equal(pubStatus.data.ok, true);
  assert.equal(pubStatus.data.count, 0);

  const missingTokenRead = parseToolJson(await client.request("tools/call", {
    name: "lounge_read",
    arguments: {},
  }));
  assert.equal(missingTokenRead.isError, true);
  assert.equal(missingTokenRead.data.ok, false);
});
