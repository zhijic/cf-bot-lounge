// CF Bot Lounge Worker. KV serves the chat page and holds any legacy KV messages for one-time import.
// ChatHistory serializes message reads and writes in its own SQLite storage.
import { DurableObject } from "cloudflare:workers";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const MAX_MESSAGES = 500;
const MAX_TEXT = 4000;
const MAX_CLIENT_ID = 128;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const encoder = new TextEncoder();

function constantTimeEqual(a, b) {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(ab, bb);
  }
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function isValidParticipant(entry) {
  return Boolean(
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof entry.id === "string" &&
    entry.id.length > 0
  );
}

function parseTokenMap(env) {
  let parsed;
  try {
    parsed = JSON.parse(env.TOKENS_JSON || "{}");
  } catch {
    return {};
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function caller(env, req) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.trim().match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const token = match[1];
  const map = parseTokenMap(env);
  let matched = null;
  for (const [key, entry] of Object.entries(map)) {
    if (!isValidParticipant(entry)) continue;
    if (constantTimeEqual(token, key)) matched = entry;
  }
  return matched;
}

// One SQLite-backed object owns this room. Synchronous transactions keep
// appends, the polling cursor and the retained history in the same order.
export class ChatHistory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS history (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
      )`);
      // (sender, client_id) -> message id, so a retried POST is stored once.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS client_ids (
        from_id TEXT NOT NULL, client_id TEXT NOT NULL, id TEXT NOT NULL,
        PRIMARY KEY (from_id, client_id)
      )`);
      this.sql.exec("CREATE TABLE IF NOT EXISTS legacy_import (done INTEGER PRIMARY KEY)");
      if (this.sql.exec("SELECT done FROM legacy_import").toArray().length) return;

      const rawLegacy = await env.BOT_CHAT.get("messages", "json");
      const legacy = Array.isArray(rawLegacy)
        ? rawLegacy.filter((message) => message && typeof message.id === "string" && message.id)
        : [];
      const byId = new Map(legacy.map((message) => [message.id, message]));
      const ids = [...byId.keys()].sort().slice(-MAX_MESSAGES);
      ctx.storage.transactionSync(() => {
        for (const id of ids) {
          this.sql.exec("INSERT INTO history (id, payload) VALUES (?, ?)",
            id, JSON.stringify(byId.get(id)));
        }
        this.sql.exec("INSERT INTO legacy_import VALUES (1)");
      });
    });
  }

  latest() {
    return this.sql.exec("SELECT seq, payload FROM history ORDER BY seq DESC LIMIT 1")
      .toArray()[0];
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/status" && req.method === "GET") {
      const latest = this.latest();
      const message = latest ? JSON.parse(latest.payload) : null;
      return json({
        ok: true,
        latest_id: message?.id ?? "",
        latest_from: message?.from ?? "",
        latest_to: message?.to ?? "",
        count: latest ? Math.min(latest.seq, MAX_MESSAGES) : 0,
      });
    }

    const me = caller(this.env, req);
    if (!me) return json({ ok: false, error: "unauthorized" }, 401);

    if (req.method === "GET") {
      const since = url.searchParams.get("since") || "";
      const requested = parseInt(url.searchParams.get("limit") || "100", 10);
      const limit = requested > 0 ? Math.min(requested, 200) : 100;
      // Initial load is the latest page. A cursor drains the backlog forward.
      const rows = since
        ? this.sql.exec("SELECT payload FROM history WHERE id > ? ORDER BY id LIMIT ?", since, limit).toArray()
        : this.sql.exec("SELECT payload FROM history ORDER BY seq DESC LIMIT ?", limit).toArray().reverse();
      return json({ ok: true, messages: rows.map(({ payload }) => JSON.parse(payload)) });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return json({ ok: false, error: "text required" }, 400);
    }
    // Optional idempotency key: the same sender repeating a client_id gets
    // the original message back (HTTP 200, duplicate: true) instead of a copy.
    const clientId = body.client_id ?? null;
    if (clientId !== null &&
        (typeof clientId !== "string" || !clientId || clientId.length > MAX_CLIENT_ID)) {
      return json({ ok: false, error: `client_id must be a 1-${MAX_CLIENT_ID} char string` }, 400);
    }

    const { message, duplicate } = this.ctx.storage.transactionSync(() => {
      if (clientId) {
        const seen = this.sql.exec(
          `SELECT h.payload FROM client_ids c JOIN history h ON h.id = c.id
           WHERE c.from_id = ? AND c.client_id = ?`, me.id, clientId).toArray()[0];
        if (seen) return { message: JSON.parse(seen.payload), duplicate: true };
      }
      const latest = this.latest();
      const lastTime = latest ? Date.parse(JSON.parse(latest.payload).ts) || 0 : 0;
      const time = Math.max(Date.now(), lastTime + 1);
      const next = {
        id: time.toString(36) + Math.random().toString(36).slice(2).padEnd(6, "0").slice(0, 6),
        ts: new Date(time).toISOString(),
        from: me.id,
        from_name: me.name || me.id,
        to: typeof body.to === "string" && body.to.trim() ? body.to.trim() : "all",
        text: body.text.trim().slice(0, MAX_TEXT),
      };
      if (clientId) next.client_id = clientId;
      this.sql.exec("INSERT INTO history (id, payload) VALUES (?, ?)", next.id, JSON.stringify(next));
      if (clientId) {
        this.sql.exec("INSERT OR REPLACE INTO client_ids (from_id, client_id, id) VALUES (?, ?, ?)",
          me.id, clientId, next.id);
      }
      if (latest && latest.seq >= MAX_MESSAGES) {
        this.sql.exec("DELETE FROM history WHERE seq <= ?", latest.seq + 1 - MAX_MESSAGES);
        this.sql.exec("DELETE FROM client_ids WHERE id NOT IN (SELECT id FROM history)");
      }
      return { message: next, duplicate: false };
    });
    return duplicate
      ? json({ ok: true, message, duplicate: true }, 200)
      : json({ ok: true, message }, 201);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/health" && req.method === "GET") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    if ((url.pathname === "/api/status" && req.method === "GET") ||
        (url.pathname === "/api/messages" && ["GET", "POST"].includes(req.method))) {
      const room = env.CHAT_HISTORY.getByName("bot-chat");
      return room.fetch(req);
    }

    // The chat page itself (public; no token needed to load it — the API
    // behind it stays token-gated). HTML lives in KV key "page", uploaded
    // from page.html.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const page = await env.BOT_CHAT.get("page");
      if (!page) return new Response("page not deployed", { status: 404 });
      return new Response(page, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    const me = caller(env, req);
    if (!me) return json({ ok: false, error: "unauthorized" }, 401);

    const meInfo = { id: me.id, name: me.name ?? me.id, role: me.role };

    if (url.pathname === "/api/me" && req.method === "GET") {
      return json({ ok: true, me: meInfo });
    }

    if (url.pathname === "/api/bots" && req.method === "GET") {
      const map = parseTokenMap(env);
      const bots = Object.values(map)
        .filter(isValidParticipant)
        .map((b) => ({
          id: b.id,
          name: b.name ?? b.id,
          role: b.role,
        }));
      return json({ ok: true, me: meInfo, bots });
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
