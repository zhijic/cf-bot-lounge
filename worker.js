// CF Bot Lounge Worker v2.0.
// Serves the bundled web UI without requiring KV, shards chat rooms across
// SQLite-backed Durable Objects (ChatHistory), supports WebSocket Hibernation,
// per-token room ACLs, in-memory presence, optional R2 attachments, dynamic
// admin-managed tokens (in reserved "__auth__" DO), and SSRF-safe webhooks.
import { DurableObject } from "cloudflare:workers";
import PAGE_HTML from "./page.html";

const VERSION = "2.0.0";
const MAX_MESSAGES = 500;
const MAX_TEXT = 4000;
const MAX_CLIENT_ID = 128;
const MAX_REPLY_TO = 128;
const MAX_ATTACHMENTS = 5;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const PRESENCE_ONLINE_MS = 120_000;

const DEFAULT_ROOM = "general";
const AUTH_DO_NAME = "__auth__";
const DEFAULT_ROOMS = ["general", "dev", "ops"];

const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PARTICIPANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const SAFE_FILENAME_RE = /^[a-zA-Z0-9._-]+$/;
const VALID_STATUSES = new Set(["thinking", "done", "error"]);
const VALID_ROLES = new Set(["bot", "human", "admin"]);
const ALLOWED_UPLOAD_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "text/plain",
  "application/pdf",
  "application/json",
]);

const BASE_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Filename",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function corsHeaders(env, req) {
  const headers = { ...BASE_CORS_HEADERS };
  const raw = env && typeof env.ALLOWED_ORIGINS === "string" ? env.ALLOWED_ORIGINS.trim() : "";
  if (!raw || raw === "*") {
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }
  headers["Vary"] = "Origin";
  const reqOrigin = req?.headers?.get("Origin") || "";
  if (reqOrigin && allowed.includes(reqOrigin)) {
    headers["Access-Control-Allow-Origin"] = reqOrigin;
  }
  return headers;
}

function json(data, status = 200, env = null, req = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env, req),
    },
  });
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
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

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomId6() {
  return Math.random().toString(36).slice(2).padEnd(6, "0").slice(0, 6);
}

function getDoStub(env, name) {
  if (typeof env.CHAT_HISTORY.getByName === "function") {
    return env.CHAT_HISTORY.getByName(name);
  }
  return env.CHAT_HISTORY.get(env.CHAT_HISTORY.idFromName(name));
}

function getDefaultRoom(env) {
  const raw = typeof env?.DEFAULT_ROOM === "string" ? env.DEFAULT_ROOM.trim().toLowerCase() : "";
  if (raw && raw !== "default" && ROOM_RE.test(raw)) return raw;
  return DEFAULT_ROOM;
}

function parseRoom(url, env) {
  const raw = url.searchParams.get("room");
  if (raw === null || raw === "") return getDefaultRoom(env);
  const norm = raw.toLowerCase();
  if (norm === "default") return getDefaultRoom(env);
  if (!ROOM_RE.test(norm)) return null;
  return norm;
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

function normalizeRoomsField(rawRooms, env) {
  if (rawRooms === undefined || rawRooms === null) return ["*"];
  if (!Array.isArray(rawRooms)) return [];
  const def = getDefaultRoom(env);
  const out = [];
  for (const item of rawRooms) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().toLowerCase();
    if (!trimmed) continue;
    out.push(trimmed === "default" ? def : trimmed);
  }
  return out;
}

function normalizeParticipant(entry, source = "static", env = null) {
  const rooms = normalizeRoomsField(entry.rooms, env);
  const webhook_url = typeof entry.webhook_url === "string" && entry.webhook_url.trim()
    ? entry.webhook_url.trim()
    : null;
  const webhook_secret = typeof entry.webhook_secret === "string" && entry.webhook_secret
    ? entry.webhook_secret
    : null;
  return {
    id: entry.id,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id,
    role: typeof entry.role === "string" && entry.role.trim() ? entry.role.trim() : "bot",
    rooms,
    webhook_url,
    webhook_secret,
    source,
    created_at: entry.created_at ?? null,
  };
}

function toPublicMe(me) {
  return {
    id: me.id,
    name: me.name || me.id,
    role: me.role,
  };
}

function canAccessRoom(participant, room, env) {
  if (!participant) return false;
  if (participant.rooms === undefined || participant.rooms === null) return true;
  if (!Array.isArray(participant.rooms)) return false;
  const def = getDefaultRoom(env);
  for (const allowed of participant.rooms) {
    if (allowed === "*") return true;
    if (typeof allowed === "string") {
      const low = allowed.trim().toLowerCase();
      if ((low === "default" ? def : low) === room) return true;
    }
  }
  return false;
}

function parseTokenMap(env) {
  let parsed;
  try {
    parsed = JSON.parse(env?.TOKENS_JSON || "{}");
  } catch {
    return {};
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function extractBearerToken(req) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.trim().match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

function isPublicStatus(env) {
  const raw = env?.PUBLIC_STATUS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return String(raw).trim().toLowerCase() !== "false";
}

function isPrivateIpv4(a, b, c, d) {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isSafeWebhookUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim() || rawUrl.length > 2048) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;

  let host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return false;

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    return false;
  }

  // IPv6 literal
  if (host.startsWith("[") || host.includes(":")) {
    const v6 = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (!v6 || v6.includes("%")) return false;
    if (v6 === "::" || v6 === "::1" || v6.startsWith("::") || v6.startsWith("64:ff9b:")) return false;
    const first = v6.split(":")[0];
    const firstNum = parseInt(first, 16);
    if (Number.isNaN(firstNum)) return false;
    // Unspecified/loopback/embedded (0000::/8), discard (0100::/64), ULA (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
    if (firstNum === 0 || firstNum === 0x0100 || firstNum >= 0xfc00) return false;
    return true;
  }

  // IPv4 literal (WHATWG URL normalizes decimal/hex/octal IPv4 forms to dotted-quad)
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map((x) => parseInt(x, 10));
    if (isPrivateIpv4(octets[0], octets[1], octets[2], octets[3])) return false;
  }

  return true;
}

async function signWebhookPayload(secret, bodyText) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(bodyText));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function lookupDynamicToken(env, token) {
  if (!env?.CHAT_HISTORY) return null;
  const tokenHash = await sha256Hex(token);
  const authStub = getDoStub(env, AUTH_DO_NAME);
  const res = await authStub.fetch("https://internal/internal/auth/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token_hash: tokenHash }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data && data.participant ? normalizeParticipant(data.participant, "dynamic", env) : null;
}

async function fetchDynamicTokens(env) {
  if (!env?.CHAT_HISTORY) return [];
  const authStub = getDoStub(env, AUTH_DO_NAME);
  const res = await authStub.fetch("https://internal/internal/auth/list", { method: "GET" });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return Array.isArray(data?.tokens) ? data.tokens.map((t) => normalizeParticipant(t, "dynamic", env)) : [];
}

async function fetchKnownRooms(env) {
  if (!env?.CHAT_HISTORY) return [];
  const authStub = getDoStub(env, AUTH_DO_NAME);
  const res = await authStub.fetch("https://internal/internal/auth/rooms", { method: "GET" });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return Array.isArray(data?.rooms) ? data.rooms : [];
}

async function recordKnownRoom(env, room) {
  if (!env?.CHAT_HISTORY || !ROOM_RE.test(room)) return;
  try {
    const authStub = getDoStub(env, AUTH_DO_NAME);
    await authStub.fetch("https://internal/internal/auth/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room }),
    });
  } catch {
    // Non-critical room registry write
  }
}

async function authenticateToken(env, token) {
  if (!token) return null;
  const map = parseTokenMap(env);
  let matched = null;
  for (const [key, entry] of Object.entries(map)) {
    if (!isValidParticipant(entry)) continue;
    if (constantTimeEqual(token, key)) matched = entry;
  }
  if (matched) return normalizeParticipant(matched, "static", env);
  return lookupDynamicToken(env, token);
}

async function caller(env, req) {
  const token = extractBearerToken(req);
  if (!token) return null;
  return authenticateToken(env, token);
}

async function resolveAdmin(env, req) {
  const token = extractBearerToken(req);
  if (!token) return { status: 401, admin: null };
  if (typeof env?.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.length > 0 && constantTimeEqual(token, env.ADMIN_TOKEN)) {
    return {
      status: 200,
      admin: { id: "admin", name: "Admin", role: "admin", rooms: ["*"] },
    };
  }
  const me = await authenticateToken(env, token);
  if (!me) return { status: 401, admin: null };
  if (me.role !== "admin") return { status: 403, admin: null };
  return { status: 200, admin: me };
}

async function listMergedParticipants(env) {
  const map = parseTokenMap(env);
  const byId = new Map();
  for (const entry of Object.values(map)) {
    if (!isValidParticipant(entry)) continue;
    const norm = normalizeParticipant(entry, "static", env);
    if (!byId.has(norm.id)) byId.set(norm.id, norm);
  }
  const dynamicList = await fetchDynamicTokens(env);
  for (const norm of dynamicList) {
    byId.set(norm.id, norm);
  }
  return [...byId.values()];
}

function getConfiguredRooms(env) {
  const def = getDefaultRoom(env);
  const fallback = [def, ...DEFAULT_ROOMS.filter((r) => r !== def)];
  const raw = env && typeof env.ROOMS === "string" ? env.ROOMS.trim() : "";
  if (!raw) return fallback;
  const rooms = [];
  for (const part of raw.split(",")) {
    const low = part.trim().toLowerCase();
    const norm = low === "default" ? def : low;
    if (ROOM_RE.test(norm) && !rooms.includes(norm)) rooms.push(norm);
  }
  return rooms.length > 0 ? rooms : fallback;
}

function sanitizeFilename(rawName) {
  const base = String(rawName || "upload").split(/[\\/]/).pop() || "upload";
  let safe = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "");
  if (!safe) safe = "upload";
  if (safe.length > 64) {
    const dot = safe.lastIndexOf(".");
    if (dot > 0 && safe.length - dot <= 12) {
      const ext = safe.slice(dot);
      safe = safe.slice(0, 64 - ext.length) + ext;
    } else {
      safe = safe.slice(0, 64);
    }
  }
  return safe;
}

function validateAttachments(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) return null;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (typeof item.key !== "string" || !item.key || item.key.length > 256 || item.key.includes("..")) return null;
    if (typeof item.name !== "string" || !item.name || item.name.length > 256) return null;
    if (typeof item.content_type !== "string" || !item.content_type || item.content_type.length > 128) return null;
    if (typeof item.size !== "number" || !Number.isFinite(item.size) || item.size < 0) return null;
    if (
      typeof item.url !== "string" ||
      !item.url.startsWith("/api/uploads/") ||
      item.url.length > 512 ||
      item.url.includes("..")
    ) {
      return null;
    }
    out.push({
      key: item.key,
      name: item.name,
      content_type: item.content_type,
      size: Math.floor(item.size),
      url: item.url,
    });
  }
  return out;
}

function parseHistoryRow(row) {
  const parsed = JSON.parse(row.payload);
  return { ...parsed, seq: Number(row.seq) };
}

function forwardToRoom(env, room, req, extraHeaders = {}) {
  const headers = new Headers(req.headers);
  headers.delete("X-Lounge-Me");
  headers.delete("X-Lounge-Room");
  headers.delete("X-Lounge-Touch");
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (v !== undefined && v !== null) headers.set(k, v);
  }
  const forwarded = new Request(req, { headers });
  return getDoStub(env, room).fetch(forwarded);
}

async function dispatchWebhooks(env, room, message, senderId) {
  try {
    const participants = await listMergedParticipants(env);
    const targets = participants.filter(
      (p) =>
        p.id !== senderId &&
        p.webhook_url &&
        isSafeWebhookUrl(p.webhook_url) &&
        canAccessRoom(p, room, env) &&
        (message.to === "all" || message.to === p.id)
    );
    if (!targets.length) return;
    const bodyText = JSON.stringify({ event: "message.created", room, message });
    await Promise.allSettled(
      targets.map(async (p) => {
        try {
          const headers = {
            "Content-Type": "application/json",
            "User-Agent": `cf-bot-lounge-webhook/${VERSION}`,
          };
          if (p.webhook_secret) {
            headers["X-Bot-Lounge-Signature"] = await signWebhookPayload(p.webhook_secret, bodyText);
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          try {
            await fetch(p.webhook_url, {
              method: "POST",
              headers,
              body: bodyText,
              redirect: "manual",
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // Swallow webhook delivery failures so message persistence never fails
        }
      })
    );
  } catch {
    // Swallow dispatch errors
  }
}

// One SQLite-backed Durable Object class handles both per-room chat storage
// (with WebSocket Hibernation and in-memory presence) and the reserved "__auth__"
// instance for dynamic SHA-256 tokens and the room registry.
export class ChatHistory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.presence = new Map();
    this.roomSchemaReady = false;
    this.authSchemaReady = false;
    this.legacyChecked = false;
    this.legacyImportPromise = null;
    this.roomRegistered = false;
  }

  ensureRoomSchema() {
    if (this.roomSchemaReady) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS history (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS client_ids (
      from_id TEXT NOT NULL, client_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY (from_id, client_id)
    )`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS legacy_import (done INTEGER PRIMARY KEY)");
    this.roomSchemaReady = true;
  }

  ensureAuthSchema() {
    if (this.authSchemaReady) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dynamic_tokens (
      token_hash TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      rooms TEXT,
      webhook_url TEXT,
      webhook_secret TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_dynamic_tokens_id ON dynamic_tokens (id)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS known_rooms (room TEXT PRIMARY KEY)");
    this.authSchemaReady = true;
  }

  async ensureLegacyImport(room) {
    this.ensureRoomSchema();
    if (room !== getDefaultRoom(this.env) || !this.env.BOT_CHAT || this.legacyChecked) return;
    if (!this.legacyImportPromise) {
      this.legacyImportPromise = this.ctx.blockConcurrencyWhile(async () => {
        if (this.sql.exec("SELECT done FROM legacy_import").toArray().length) {
          this.legacyChecked = true;
          return;
        }
        const rawLegacy = await this.env.BOT_CHAT.get("messages", "json");
        const legacy = Array.isArray(rawLegacy)
          ? rawLegacy.filter((message) => message && typeof message.id === "string" && message.id)
          : [];
        const byId = new Map(legacy.map((message) => [message.id, message]));
        const ids = [...byId.keys()].sort().slice(-MAX_MESSAGES);
        this.ctx.storage.transactionSync(() => {
          if (this.sql.exec("SELECT done FROM legacy_import").toArray().length) return;
          for (const id of ids) {
            this.sql.exec(
              "INSERT OR IGNORE INTO history (id, payload) VALUES (?, ?)",
              id,
              JSON.stringify(byId.get(id))
            );
          }
          this.sql.exec("INSERT OR REPLACE INTO legacy_import VALUES (1)");
        });
        this.legacyChecked = true;
      }).catch((err) => {
        this.legacyImportPromise = null;
        throw err;
      });
    }
    await this.legacyImportPromise;
  }

  touchPresence(id) {
    if (typeof id === "string" && id) {
      this.presence.set(id, Date.now());
    }
  }

  latest() {
    return this.sql.exec("SELECT seq, payload FROM history ORDER BY seq DESC LIMIT 1").toArray()[0];
  }

  broadcast(payload, excludeWs = null) {
    const frame = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excludeWs) continue;
      const att = ws.deserializeAttachment();
      if (!att || !att.authed) continue;
      try {
        ws.send(frame);
      } catch {
        // Ignore broken/closing sockets
      }
    }
  }

  async handleAuthInternal(req, url) {
    this.ensureAuthSchema();

    if (url.pathname === "/internal/auth/lookup" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const tokenHash = typeof body?.token_hash === "string" ? body.token_hash : "";
      if (!tokenHash) return json({ ok: true, participant: null });
      const row = this.sql.exec(
        `SELECT id, name, role, rooms, webhook_url, webhook_secret, created_at
         FROM dynamic_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
        tokenHash
      ).toArray()[0];
      if (!row) return json({ ok: true, participant: null });
      return json({
        ok: true,
        participant: {
          id: row.id,
          name: row.name,
          role: row.role,
          rooms: row.rooms ? JSON.parse(row.rooms) : null,
          webhook_url: row.webhook_url || null,
          webhook_secret: row.webhook_secret || null,
          created_at: row.created_at,
        },
      });
    }

    if (url.pathname === "/internal/auth/list" && req.method === "GET") {
      const rows = this.sql.exec(
        `SELECT id, name, role, rooms, webhook_url, webhook_secret, created_at
         FROM dynamic_tokens WHERE revoked_at IS NULL ORDER BY created_at ASC`
      ).toArray();
      const tokens = rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        rooms: row.rooms ? JSON.parse(row.rooms) : null,
        webhook_url: row.webhook_url || null,
        webhook_secret: row.webhook_secret || null,
        created_at: row.created_at,
      }));
      return json({ ok: true, tokens });
    }

    if (url.pathname === "/internal/auth/create" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.token_hash !== "string" || typeof body.id !== "string") {
        return json({ ok: false, error: "invalid payload" }, 400);
      }
      this.sql.exec(
        `INSERT INTO dynamic_tokens
         (token_hash, id, name, role, rooms, webhook_url, webhook_secret, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        body.token_hash,
        body.id,
        body.name || body.id,
        body.role || "bot",
        body.rooms ? JSON.stringify(body.rooms) : null,
        body.webhook_url || null,
        body.webhook_secret || null,
        body.created_at || new Date().toISOString()
      );
      return json({ ok: true }, 201);
    }

    if (url.pathname === "/internal/auth/revoke" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const id = typeof body?.id === "string" ? body.id : "";
      if (!id) return json({ ok: false, error: "id required" }, 400);
      const revoked = this.ctx.storage.transactionSync(() => {
        const countRow = this.sql.exec(
          "SELECT COUNT(*) AS count FROM dynamic_tokens WHERE id = ? AND revoked_at IS NULL",
          id
        ).toArray()[0];
        const count = Number(countRow?.count ?? 0);
        if (count > 0) {
          this.sql.exec(
            "UPDATE dynamic_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            new Date().toISOString(),
            id
          );
        }
        return count;
      });
      return json({ ok: true, revoked });
    }

    if (url.pathname === "/internal/auth/rooms" && req.method === "GET") {
      const rows = this.sql.exec("SELECT room FROM known_rooms ORDER BY room ASC").toArray();
      return json({ ok: true, rooms: rows.map((r) => r.room) });
    }

    if (url.pathname === "/internal/auth/rooms" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const room = typeof body?.room === "string" ? body.room : "";
      if (ROOM_RE.test(room)) {
        this.sql.exec("INSERT OR IGNORE INTO known_rooms (room) VALUES (?)", room);
      }
      return json({ ok: true });
    }

    return json({ ok: false, error: "not found" }, 404);
  }

  handlePresenceInternal(url) {
    const touchId = url.searchParams.get("touch");
    if (touchId) this.touchPresence(touchId);

    const activeWs = new Set();
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.authed && att.me && att.me.id) {
        activeWs.add(att.me.id);
        if (!this.presence.has(att.me.id)) {
          this.presence.set(att.me.id, now);
        }
      }
    }

    const seen = {};
    for (const [id, ts] of this.presence.entries()) {
      seen[id] = ts;
    }
    return json({ ok: true, seen, active_ws: [...activeWs] });
  }

  async resolveCallerFromRequest(req) {
    const encoded = req.headers.get("X-Lounge-Me");
    if (encoded) {
      try {
        return JSON.parse(decodeURIComponent(encoded));
      } catch {
        return null;
      }
    }
    return caller(this.env, req);
  }

  async fetch(req) {
    const url = new URL(req.url);

    // Reserved "__auth__" DO routes — never call caller() or "__auth__" recursively.
    if (url.pathname.startsWith("/internal/auth/")) {
      return this.handleAuthInternal(req, url);
    }

    if (url.pathname === "/internal/presence" && req.method === "GET") {
      return this.handlePresenceInternal(url);
    }

    const room = parseRoom(url, this.env);
    if (!room) {
      return json({ ok: false, error: "invalid room" }, 400, this.env, req);
    }

    // WebSocket upgrade (Hibernation API)
    if (url.pathname === "/api/ws" && req.method === "GET") {
      const upgrade = req.headers.get("Upgrade") || "";
      if (upgrade.toLowerCase() !== "websocket") {
        return json({ ok: false, error: "upgrade required" }, 426, this.env, req);
      }

      await this.ensureLegacyImport(room);

      const authHeader = req.headers.get("Authorization");
      let authedMe = null;
      if (authHeader !== null && authHeader.trim() !== "") {
        const me = await caller(this.env, req);
        if (!me) return json({ ok: false, error: "unauthorized" }, 401, this.env, req);
        if (!canAccessRoom(me, room, this.env)) return json({ ok: false, error: "forbidden" }, 403, this.env, req);
        authedMe = me;
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      if (authedMe) {
        const meInfo = toPublicMe(authedMe);
        server.serializeAttachment({ authed: true, me: meInfo, room });
        this.touchPresence(meInfo.id);
      } else {
        server.serializeAttachment({ authed: false, room });
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    await this.ensureLegacyImport(room);

    if (url.pathname === "/api/status" && req.method === "GET") {
      const touchId = req.headers.get("X-Lounge-Touch");
      if (touchId) this.touchPresence(touchId);

      const latest = this.latest();
      const countRow = this.sql.exec("SELECT COUNT(*) AS count FROM history").toArray()[0];
      const message = latest ? JSON.parse(latest.payload) : null;
      return json({
        ok: true,
        room,
        latest_seq: latest ? Number(latest.seq) : 0,
        latest_id: message?.id ?? "",
        latest_from: message?.from ?? "",
        latest_to: message?.to ?? "",
        count: Number(countRow?.count ?? 0),
      }, 200, this.env, req);
    }

    const me = await this.resolveCallerFromRequest(req);
    if (!me) return json({ ok: false, error: "unauthorized" }, 401, this.env, req);
    if (!canAccessRoom(me, room, this.env)) return json({ ok: false, error: "forbidden" }, 403, this.env, req);
    this.touchPresence(me.id);

    // GET /api/messages
    if (url.pathname === "/api/messages" && req.method === "GET") {
      const hasSinceSeq = url.searchParams.has("since_seq");
      let sinceSeq = null;
      if (hasSinceSeq) {
        const rawSeq = url.searchParams.get("since_seq");
        if (!rawSeq || !/^\d+$/.test(rawSeq)) {
          return json({ ok: false, error: "invalid since_seq" }, 400, this.env, req);
        }
        sinceSeq = Number(rawSeq);
        if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
          return json({ ok: false, error: "invalid since_seq" }, 400, this.env, req);
        }
      }

      const since = url.searchParams.get("since") || "";
      const requested = parseInt(url.searchParams.get("limit") || "100", 10);
      const limit = requested > 0 ? Math.min(requested, 200) : 100;

      let rows;
      if (hasSinceSeq) {
        rows = this.sql.exec(
          "SELECT seq, payload FROM history WHERE seq > ? ORDER BY seq ASC LIMIT ?",
          sinceSeq,
          limit
        ).toArray();
      } else if (since) {
        rows = this.sql.exec(
          "SELECT seq, payload FROM history WHERE id > ? ORDER BY id ASC LIMIT ?",
          since,
          limit
        ).toArray();
      } else {
        rows = this.sql.exec(
          "SELECT seq, payload FROM history ORDER BY seq DESC LIMIT ?",
          limit
        ).toArray().reverse();
      }

      return json({ ok: true, room, messages: rows.map(parseHistoryRow) }, 200, this.env, req);
    }

    // POST /api/messages
    if (url.pathname === "/api/messages" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ ok: false, error: "invalid json body" }, 400, this.env, req);
      }

      let attachments = null;
      if (body.attachments !== undefined) {
        attachments = validateAttachments(body.attachments);
        if (!attachments) {
          return json({ ok: false, error: "invalid attachments" }, 400, this.env, req);
        }
      }

      if (body.text !== undefined && typeof body.text !== "string") {
        return json({ ok: false, error: "text must be a string" }, 400, this.env, req);
      }
      const trimmedText = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
      if (!trimmedText && (!attachments || attachments.length === 0)) {
        return json({ ok: false, error: "text or attachments required" }, 400, this.env, req);
      }

      const clientId = body.client_id ?? null;
      if (
        clientId !== null &&
        (typeof clientId !== "string" || !clientId || clientId.length > MAX_CLIENT_ID)
      ) {
        return json({ ok: false, error: `client_id must be a 1-${MAX_CLIENT_ID} char string` }, 400, this.env, req);
      }

      const status = body.status ?? null;
      if (status !== null && (typeof status !== "string" || !VALID_STATUSES.has(status))) {
        return json({ ok: false, error: "invalid status" }, 400, this.env, req);
      }

      const replyTo = body.reply_to ?? null;
      if (
        replyTo !== null &&
        (typeof replyTo !== "string" || !replyTo.trim() || replyTo.length > MAX_REPLY_TO)
      ) {
        return json({ ok: false, error: "invalid reply_to" }, 400, this.env, req);
      }
      const cleanReplyTo = replyTo ? replyTo.trim() : null;

      const { message, duplicate } = this.ctx.storage.transactionSync(() => {
        if (clientId) {
          const seen = this.sql.exec(
            `SELECT h.seq, h.payload FROM client_ids c JOIN history h ON h.id = c.id
             WHERE c.from_id = ? AND c.client_id = ?`,
            me.id,
            clientId
          ).toArray()[0];
          if (seen) return { message: parseHistoryRow(seen), duplicate: true };
        }

        const latest = this.latest();
        const lastTime = latest ? Date.parse(JSON.parse(latest.payload).ts) || 0 : 0;
        const time = Math.max(Date.now(), lastTime + 1);
        const next = {
          seq: 0,
          id: time.toString(36) + randomId6(),
          ts: new Date(time).toISOString(),
          from: me.id,
          from_name: me.name || me.id,
          to: typeof body.to === "string" && body.to.trim() ? body.to.trim().slice(0, 64) : "all",
          text: trimmedText,
        };
        if (clientId) next.client_id = clientId;
        if (cleanReplyTo) {
          next.reply_to = cleanReplyTo;
          const origRow = this.sql.exec(
            "SELECT payload FROM history WHERE id = ? LIMIT 1",
            cleanReplyTo
          ).toArray()[0];
          if (origRow) {
            const orig = JSON.parse(origRow.payload);
            next.reply_preview = {
              id: orig.id,
              from: orig.from,
              from_name: orig.from_name || orig.from,
              text: typeof orig.text === "string" ? orig.text.slice(0, 80) : "",
            };
          }
        }
        if (status) next.status = status;
        if (attachments && attachments.length > 0) next.attachments = attachments;

        this.sql.exec("INSERT INTO history (id, payload) VALUES (?, ?)", next.id, JSON.stringify(next));
        const seqRow = this.sql.exec("SELECT last_insert_rowid() AS seq").toArray()[0];
        next.seq = Number(seqRow.seq);
        this.sql.exec("UPDATE history SET payload = ? WHERE seq = ?", JSON.stringify(next), next.seq);

        if (clientId) {
          this.sql.exec(
            "INSERT OR REPLACE INTO client_ids (from_id, client_id, id) VALUES (?, ?, ?)",
            me.id,
            clientId,
            next.id
          );
        }

        const countRow = this.sql.exec("SELECT COUNT(*) AS count FROM history").toArray()[0];
        if (Number(countRow.count) > MAX_MESSAGES) {
          this.sql.exec(
            "DELETE FROM history WHERE seq NOT IN (SELECT seq FROM history ORDER BY seq DESC LIMIT ?)",
            MAX_MESSAGES
          );
          this.sql.exec("DELETE FROM client_ids WHERE id NOT IN (SELECT id FROM history)");
        }
        return { message: next, duplicate: false };
      });

      if (!duplicate) {
        if (room !== getDefaultRoom(this.env) && !this.roomRegistered) {
          this.roomRegistered = true;
          this.ctx.waitUntil(recordKnownRoom(this.env, room));
        }
        this.broadcast({ type: "message", room, message });
        this.ctx.waitUntil(dispatchWebhooks(this.env, room, message, me.id));
      }

      return duplicate
        ? json({ ok: true, message, duplicate: true }, 200, this.env, req)
        : json({ ok: true, message }, 201, this.env, req);
    }

    // PATCH /api/messages/:id
    const patchMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (patchMatch && req.method === "PATCH") {
      let msgId;
      try {
        msgId = decodeURIComponent(patchMatch[1]);
      } catch {
        return json({ ok: false, error: "invalid message id" }, 400, this.env, req);
      }

      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json({ ok: false, error: "invalid json body" }, 400, this.env, req);
      }

      const hasText = Object.prototype.hasOwnProperty.call(body, "text") && body.text !== undefined;
      const hasStatus = Object.prototype.hasOwnProperty.call(body, "status") && body.status !== undefined;
      if (!hasText && !hasStatus) {
        return json({ ok: false, error: "text or status required" }, 400, this.env, req);
      }

      let nextText;
      if (hasText) {
        if (typeof body.text !== "string" || !body.text.trim()) {
          return json({ ok: false, error: "text must be a non-empty string" }, 400, this.env, req);
        }
        nextText = body.text.trim().slice(0, MAX_TEXT);
      }

      if (hasStatus) {
        if (body.status !== null && (typeof body.status !== "string" || !VALID_STATUSES.has(body.status))) {
          return json({ ok: false, error: "invalid status" }, 400, this.env, req);
        }
      }

      const result = this.ctx.storage.transactionSync(() => {
        const row = this.sql.exec(
          "SELECT seq, payload FROM history WHERE id = ? LIMIT 1",
          msgId
        ).toArray()[0];
        if (!row) return { status: 404, error: "not found" };
        const existing = parseHistoryRow(row);
        if (existing.from !== me.id && me.role !== "admin") {
          return { status: 403, error: "forbidden" };
        }
        if (hasText) existing.text = nextText;
        if (hasStatus) {
          if (body.status === null) delete existing.status;
          else existing.status = body.status;
        }
        existing.updated_at = new Date().toISOString();
        this.sql.exec("UPDATE history SET payload = ? WHERE seq = ?", JSON.stringify(existing), existing.seq);
        return { status: 200, message: existing };
      });

      if (result.error) {
        return json({ ok: false, error: result.error }, result.status, this.env, req);
      }

      this.broadcast({ type: "message_updated", room, message: result.message });
      return json({ ok: true, message: result.message }, 200, this.env, req);
    }

    return json({ ok: false, error: "not found" }, 404, this.env, req);
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || { authed: false, room: getDefaultRoom(this.env) };
    const text = typeof raw === "string" ? raw : decoder.decode(raw);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      if (!att.authed) {
        try { ws.send(JSON.stringify({ type: "error", error: "unauthorized" })); } catch {}
        try { ws.close(4001, "unauthorized"); } catch {}
      }
      return;
    }

    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      if (!att.authed) {
        try { ws.send(JSON.stringify({ type: "error", error: "unauthorized" })); } catch {}
        try { ws.close(4001, "unauthorized"); } catch {}
      }
      return;
    }

    if (!att.authed) {
      if (msg.type !== "auth" || typeof msg.token !== "string" || !msg.token) {
        try { ws.send(JSON.stringify({ type: "error", error: "unauthorized" })); } catch {}
        try { ws.close(4001, "unauthorized"); } catch {}
        return;
      }
      const me = await authenticateToken(this.env, msg.token);
      if (!me || !canAccessRoom(me, att.room, this.env)) {
        try { ws.send(JSON.stringify({ type: "error", error: "unauthorized" })); } catch {}
        try { ws.close(4001, "unauthorized"); } catch {}
        return;
      }
      const meInfo = toPublicMe(me);
      ws.serializeAttachment({ authed: true, me: meInfo, room: att.room });
      this.touchPresence(meInfo.id);
      ws.send(JSON.stringify({ type: "auth_ok", me: meInfo, room: att.room }));
      return;
    }

    // Authenticated WebSocket message handling
    this.touchPresence(att.me.id);

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "typing") {
      this.broadcast(
        {
          type: "typing",
          room: att.room,
          from: att.me.id,
          from_name: att.me.name,
        },
        ws
      );
    }
  }

  async webSocketClose(ws, code) {
    try {
      const safeCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
      ws.close(safeCode);
    } catch {
      // Already closed
    }
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, "websocket error");
    } catch {
      // Already closed
    }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, req) });
    }

    if (url.pathname === "/api/health" && req.method === "GET") {
      return json(
        {
          ok: true,
          version: VERSION,
          default_room: getDefaultRoom(env),
          time: new Date().toISOString(),
          capabilities: {
            websocket: true,
            rooms: true,
            uploads: Boolean(env.UPLOADS),
            admin: Boolean(env.ADMIN_TOKEN),
          },
        },
        200,
        env,
        req
      );
    }

    // Public chat page: ASSETS -> optional legacy KV "page" -> bundled PAGE_HTML.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        try {
          const assetRes = await env.ASSETS.fetch(req);
          if (assetRes && assetRes.status === 200) return assetRes;
        } catch {
          // Fall through to KV / bundled HTML
        }
      }
      if (env.BOT_CHAT && typeof env.BOT_CHAT.get === "function") {
        const kvPage = await env.BOT_CHAT.get("page");
        if (kvPage) {
          return new Response(kvPage, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        }
      }
      return new Response(PAGE_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    }

    // GET /api/status?room=<room>
    if (url.pathname === "/api/status" && req.method === "GET") {
      const room = parseRoom(url, env);
      if (!room) return json({ ok: false, error: "invalid room" }, 400, env, req);

      let touchId = null;
      if (!isPublicStatus(env)) {
        const token = extractBearerToken(req);
        if (!token) return json({ ok: false, error: "unauthorized" }, 401, env, req);
        const isStatusToken =
          typeof env?.STATUS_TOKEN === "string" &&
          env.STATUS_TOKEN.length > 0 &&
          constantTimeEqual(token, env.STATUS_TOKEN);
        if (!isStatusToken) {
          const me = await authenticateToken(env, token);
          if (!me) return json({ ok: false, error: "unauthorized" }, 401, env, req);
          if (!canAccessRoom(me, room, env)) return json({ ok: false, error: "forbidden" }, 403, env, req);
          touchId = me.id;
        }
      }
      return forwardToRoom(env, room, req, touchId ? { "X-Lounge-Touch": touchId } : {});
    }

    // GET /api/ws?room=<room>
    if (url.pathname === "/api/ws" && req.method === "GET") {
      const room = parseRoom(url, env);
      if (!room) return json({ ok: false, error: "invalid room" }, 400, env, req);
      const upgrade = req.headers.get("Upgrade") || "";
      if (upgrade.toLowerCase() !== "websocket") {
        return json({ ok: false, error: "upgrade required" }, 426, env, req);
      }
      return forwardToRoom(env, room, req);
    }

    // GET/POST /api/messages & PATCH /api/messages/:id
    if (
      (url.pathname === "/api/messages" && (req.method === "GET" || req.method === "POST")) ||
      (req.method === "PATCH" && /^\/api\/messages\/[^/]+$/.test(url.pathname))
    ) {
      const room = parseRoom(url, env);
      if (!room) return json({ ok: false, error: "invalid room" }, 400, env, req);
      const me = await caller(env, req);
      if (!me) return json({ ok: false, error: "unauthorized" }, 401, env, req);
      if (!canAccessRoom(me, room, env)) return json({ ok: false, error: "forbidden" }, 403, env, req);
      return forwardToRoom(env, room, req, {
        "X-Lounge-Me": encodeURIComponent(JSON.stringify(me)),
      });
    }

    // Optional R2 attachments: POST /api/uploads & GET /api/uploads/:room/:file
    if (
      (url.pathname === "/api/uploads" && req.method === "POST") ||
      (url.pathname.startsWith("/api/uploads/") && req.method === "GET")
    ) {
      if (!env.UPLOADS) {
        return json({ ok: false, error: "uploads not configured" }, 501, env, req);
      }

      if (req.method === "POST") {
        const room = parseRoom(url, env);
        if (!room) return json({ ok: false, error: "invalid room" }, 400, env, req);
        const me = await caller(env, req);
        if (!me) return json({ ok: false, error: "unauthorized" }, 401, env, req);
        if (!canAccessRoom(me, room, env)) return json({ ok: false, error: "forbidden" }, 403, env, req);

        const contentTypeHeader = (req.headers.get("Content-Type") || "").trim();
        const baseMediaType = contentTypeHeader.split(";")[0].trim().toLowerCase();
        let rawName;
        let mimeType;
        let bytes;

        if (baseMediaType === "multipart/form-data") {
          const form = await req.formData().catch(() => null);
          if (!form) return json({ ok: false, error: "invalid multipart form" }, 400, env, req);
          const file = form.get("file");
          if (!file || typeof file === "string") {
            return json({ ok: false, error: "file field required" }, 400, env, req);
          }
          rawName = file.name || "upload";
          mimeType = (file.type || "").split(";")[0].trim().toLowerCase();
          bytes = await file.arrayBuffer();
        } else {
          rawName = req.headers.get("X-Filename") || "upload";
          mimeType = baseMediaType;
          bytes = await req.arrayBuffer();
        }

        if (!bytes || bytes.byteLength === 0) {
          return json({ ok: false, error: "empty file" }, 400, env, req);
        }
        if (bytes.byteLength > MAX_UPLOAD_BYTES) {
          return json({ ok: false, error: "file too large" }, 413, env, req);
        }
        if (!ALLOWED_UPLOAD_MIMES.has(mimeType)) {
          return json({ ok: false, error: "unsupported media type" }, 415, env, req);
        }

        const safeName = sanitizeFilename(rawName);
        const key = `${room}/${Date.now().toString(36)}-${randomId6()}-${safeName}`;
        await env.UPLOADS.put(key, bytes, {
          httpMetadata: { contentType: mimeType },
          customMetadata: {
            originalName: safeName,
            uploadedBy: me.id,
            room,
          },
        });

        return json(
          {
            ok: true,
            attachment: {
              key,
              name: safeName,
              content_type: mimeType,
              size: bytes.byteLength,
              url: `/api/uploads/${key}`,
            },
          },
          201,
          env,
          req
        );
      }

      // GET /api/uploads/<room>/<file>
      const rest = url.pathname.slice("/api/uploads/".length);
      if (rest.includes("..") || /%2e|%2f|%5c|\\/i.test(rest)) {
        return json({ ok: false, error: "invalid path" }, 400, env, req);
      }
      const parts = rest.split("/");
      if (parts.length !== 2) {
        return json({ ok: false, error: "invalid path" }, 400, env, req);
      }
      let uploadRoom;
      let uploadFile;
      try {
        uploadRoom = decodeURIComponent(parts[0]);
        uploadFile = decodeURIComponent(parts[1]);
      } catch {
        return json({ ok: false, error: "invalid path" }, 400, env, req);
      }
      if (!ROOM_RE.test(uploadRoom)) {
        return json({ ok: false, error: "invalid room" }, 400, env, req);
      }
      if (!uploadFile || uploadFile.includes("..") || !SAFE_FILENAME_RE.test(uploadFile)) {
        return json({ ok: false, error: "invalid filename" }, 400, env, req);
      }

      const me = await caller(env, req);
      if (!me) return json({ ok: false, error: "unauthorized" }, 401, env, req);
      if (!canAccessRoom(me, uploadRoom, env)) return json({ ok: false, error: "forbidden" }, 403, env, req);

      const key = `${uploadRoom}/${uploadFile}`;
      const obj = await env.UPLOADS.get(key);
      if (!obj) return json({ ok: false, error: "not found" }, 404, env, req);

      return new Response(obj.body, {
        status: 200,
        headers: {
          "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
          "Content-Disposition": "inline",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=3600",
          ...corsHeaders(env, req),
        },
      });
    }

    // Admin Token Management: GET/POST /api/admin/tokens & DELETE /api/admin/tokens/:id
    if (
      (url.pathname === "/api/admin/tokens" && (req.method === "GET" || req.method === "POST")) ||
      (req.method === "DELETE" && /^\/api\/admin\/tokens\/[^/]+$/.test(url.pathname))
    ) {
      const auth = await resolveAdmin(env, req);
      if (!auth.admin) {
        return json(
          { ok: false, error: auth.status === 403 ? "forbidden" : "unauthorized" },
          auth.status,
          env,
          req
        );
      }

      if (url.pathname === "/api/admin/tokens" && req.method === "GET") {
        const staticMap = parseTokenMap(env);
        const staticTokens = Object.values(staticMap)
          .filter(isValidParticipant)
          .map((entry) => {
            const p = normalizeParticipant(entry, "static");
            return {
              id: p.id,
              name: p.name,
              role: p.role,
              rooms: p.rooms,
              has_webhook: Boolean(p.webhook_url),
              webhook_url: p.webhook_url,
              source: "static",
              created_at: null,
            };
          });
        const dynamicList = await fetchDynamicTokens(env);
        const dynamicTokens = dynamicList.map((p) => ({
          id: p.id,
          name: p.name,
          role: p.role,
          rooms: p.rooms,
          has_webhook: Boolean(p.webhook_url),
          webhook_url: p.webhook_url,
          source: "dynamic",
          created_at: p.created_at,
        }));
        return json({ ok: true, tokens: [...staticTokens, ...dynamicTokens] }, 200, env, req);
      }

      if (url.pathname === "/api/admin/tokens" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json({ ok: false, error: "invalid json body" }, 400, env, req);
        }

        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id || !PARTICIPANT_ID_RE.test(id)) {
          return json({ ok: false, error: "invalid id" }, 400, env, req);
        }

        let name = id;
        if (body.name !== undefined && body.name !== null) {
          if (typeof body.name !== "string") {
            return json({ ok: false, error: "invalid name" }, 400, env, req);
          }
          name = body.name.trim().slice(0, 64) || id;
        }

        let role = "bot";
        if (body.role !== undefined && body.role !== null) {
          if (typeof body.role !== "string" || !VALID_ROLES.has(body.role.trim())) {
            return json({ ok: false, error: "invalid role" }, 400, env, req);
          }
          role = body.role.trim();
        }

        let rooms = null;
        if (body.rooms !== undefined && body.rooms !== null) {
          if (!Array.isArray(body.rooms)) {
            return json({ ok: false, error: "invalid rooms" }, 400, env, req);
          }
          const validated = [];
          for (const item of body.rooms) {
            if (typeof item !== "string") {
              return json({ ok: false, error: "invalid rooms" }, 400, env, req);
            }
            const low = item.trim().toLowerCase();
            if (low === "*") {
              if (!validated.includes("*")) validated.push("*");
              continue;
            }
            const norm = low === "default" ? getDefaultRoom(env) : low;
            if (!ROOM_RE.test(norm)) {
              return json({ ok: false, error: "invalid rooms" }, 400, env, req);
            }
            if (!validated.includes(norm)) validated.push(norm);
          }
          rooms = validated;
        }

        let webhookUrl = null;
        if (body.webhook_url !== undefined && body.webhook_url !== null && body.webhook_url !== "") {
          if (typeof body.webhook_url !== "string" || !isSafeWebhookUrl(body.webhook_url)) {
            return json({ ok: false, error: "invalid webhook_url" }, 400, env, req);
          }
          webhookUrl = body.webhook_url.trim();
        }

        let webhookSecret = null;
        if (body.webhook_secret !== undefined && body.webhook_secret !== null && body.webhook_secret !== "") {
          if (typeof body.webhook_secret !== "string" || body.webhook_secret.length > 256) {
            return json({ ok: false, error: "invalid webhook_secret" }, 400, env, req);
          }
          webhookSecret = body.webhook_secret;
        }

        const rawToken = generateToken();
        const tokenHash = await sha256Hex(rawToken);
        const createdAt = new Date().toISOString();

        const authStub = getDoStub(env, AUTH_DO_NAME);
        const createRes = await authStub.fetch("https://internal/internal/auth/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token_hash: tokenHash,
            id,
            name,
            role,
            rooms,
            webhook_url: webhookUrl,
            webhook_secret: webhookSecret,
            created_at: createdAt,
          }),
        });
        if (!createRes.ok) {
          return json({ ok: false, error: "failed to create token" }, 500, env, req);
        }

        return json(
          {
            ok: true,
            token: rawToken,
            participant: {
              id,
              name,
              role,
              rooms: rooms ?? ["*"],
              has_webhook: Boolean(webhookUrl),
              webhook_url: webhookUrl,
              source: "dynamic",
              created_at: createdAt,
            },
          },
          201,
          env,
          req
        );
      }

      // DELETE /api/admin/tokens/:id
      const delMatch = url.pathname.match(/^\/api\/admin\/tokens\/([^/]+)$/);
      let targetId;
      try {
        targetId = decodeURIComponent(delMatch[1]);
      } catch {
        return json({ ok: false, error: "invalid id" }, 400, env, req);
      }
      if (!targetId) return json({ ok: false, error: "invalid id" }, 400, env, req);

      const authStub = getDoStub(env, AUTH_DO_NAME);
      const revRes = await authStub.fetch("https://internal/internal/auth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: targetId }),
      });
      const revData = await revRes.json().catch(() => ({ revoked: 0 }));
      return json({ ok: true, revoked: Number(revData.revoked || 0) }, 200, env, req);
    }

    // Authenticated endpoints below
    const me = await caller(env, req);
    if (!me) return json({ ok: false, error: "unauthorized" }, 401, env, req);

    const meInfo = toPublicMe(me);

    if (url.pathname === "/api/me" && req.method === "GET") {
      return json({ ok: true, me: meInfo }, 200, env, req);
    }

    if (url.pathname === "/api/rooms" && req.method === "GET") {
      const def = getDefaultRoom(env);
      const configured = getConfiguredRooms(env);
      const known = await fetchKnownRooms(env);
      const combined = [...configured];
      for (const r of known) {
        if (ROOM_RE.test(r) && !combined.includes(r)) combined.push(r);
      }
      const rooms = combined.filter((r) => canAccessRoom(me, r, env));
      return json({ ok: true, default_room: def, rooms }, 200, env, req);
    }

    if (url.pathname === "/api/bots" && req.method === "GET") {
      const room = parseRoom(url, env);
      if (!room) return json({ ok: false, error: "invalid room" }, 400, env, req);
      if (!canAccessRoom(me, room, env)) return json({ ok: false, error: "forbidden" }, 403, env, req);

      const [participants, presenceRes] = await Promise.all([
        listMergedParticipants(env),
        getDoStub(env, room).fetch(
          `https://internal/internal/presence?touch=${encodeURIComponent(me.id)}`,
          { method: "GET" }
        ),
      ]);
      const presenceData = presenceRes.ok
        ? await presenceRes.json().catch(() => ({ seen: {}, active_ws: [] }))
        : { seen: {}, active_ws: [] };
      const seenMap = presenceData.seen || {};
      const activeWsSet = new Set(Array.isArray(presenceData.active_ws) ? presenceData.active_ws : []);
      const now = Date.now();

      const bots = participants.map((p) => {
        const lastSeenMs = typeof seenMap[p.id] === "number" ? seenMap[p.id] : null;
        const online = Boolean(
          activeWsSet.has(p.id) || (lastSeenMs !== null && now - lastSeenMs <= PRESENCE_ONLINE_MS)
        );
        return {
          id: p.id,
          name: p.name,
          role: p.role,
          rooms: p.rooms,
          last_seen_at: lastSeenMs !== null ? new Date(lastSeenMs).toISOString() : null,
          online,
        };
      });

      return json(
        {
          ok: true,
          room,
          me: meInfo,
          capabilities: {
            uploads: Boolean(env.UPLOADS),
            websocket: true,
            rooms: true,
          },
          bots,
        },
        200,
        env,
        req
      );
    }

    return json({ ok: false, error: "not found" }, 404, env, req);
  },
};
