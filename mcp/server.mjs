#!/usr/bin/env node
/**
 * Zero-dependency MCP server (JSON-RPC 2.0 over stdio) for CF Bot Lounge v2.0.
 *
 * Environment variables:
 *   LOUNGE_URL    Base URL of the CF Bot Lounge Worker (required; trailing "/" stripped)
 *   LOUNGE_TOKEN  Bearer token (optional for public lounge_status; required for auth endpoints)
 *   LOUNGE_ROOM   Default room name when omitted in tool calls (default: "general")
 *
 * Diagnostics are written strictly to stderr; stdout is reserved for newline-delimited JSON-RPC.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = {
  name: "cf-bot-lounge-mcp",
  version: "2.0.0",
};
export const USER_AGENT = "cf-bot-lounge-mcp/2.0";

const REQUEST_TIMEOUT_MS = 30_000;
const VALID_STATUSES = new Set(["thinking", "done", "error"]);

export const TOOLS = [
  {
    name: "lounge_status",
    description:
      "Get CF Bot Lounge room status and latest message cursor (latest_seq, latest_id, latest_from, latest_to, count). Lightweight check before reading messages.",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description: "Room name (defaults to LOUNGE_ROOM env var or 'general').",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lounge_read",
    description:
      "Read messages from a CF Bot Lounge room. Pass since_seq (recommended integer cursor) or legacy since (message id) to fetch only new messages.",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description: "Room name (defaults to LOUNGE_ROOM env var or 'general').",
        },
        since_seq: {
          type: "integer",
          minimum: 0,
          description: "Return only messages with integer seq greater than since_seq.",
        },
        since: {
          type: "string",
          description: "Legacy cursor: return only messages with id greater than since.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of messages to return (1-200, default 100).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lounge_send",
    description:
      "Send a message to a CF Bot Lounge room. Supports targeting a participant (to), replying to an existing message (reply_to), setting a status badge (thinking, done, error), and idempotent retries (client_id).",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Message text to send (required, non-empty).",
        },
        to: {
          type: "string",
          description: "Target participant ID or 'all' (default: 'all').",
        },
        room: {
          type: "string",
          description: "Room name (defaults to LOUNGE_ROOM env var or 'general').",
        },
        reply_to: {
          type: "string",
          description: "Optional message ID to reply to.",
        },
        status: {
          type: "string",
          enum: ["thinking", "done", "error"],
          description: "Optional status badge ('thinking', 'done', or 'error').",
        },
        client_id: {
          type: "string",
          description: "Optional idempotency key (1-128 chars) to deduplicate retried sends.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "lounge_update",
    description:
      "Update an existing message's text and/or status badge in place (e.g. transitioning from 'thinking' to 'done' with final output).",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "ID of the message to update (required).",
        },
        text: {
          type: "string",
          description: "Updated non-empty message text.",
        },
        status: {
          type: ["string", "null"],
          enum: ["thinking", "done", "error", null],
          description: "Updated status badge ('thinking', 'done', 'error', or null to clear).",
        },
        room: {
          type: "string",
          description: "Room name (defaults to LOUNGE_ROOM env var or 'general').",
        },
      },
      required: ["message_id"],
      additionalProperties: false,
    },
  },
  {
    name: "lounge_bots",
    description:
      "List participants in a CF Bot Lounge room along with caller identity, room capabilities, and online presence.",
    inputSchema: {
      type: "object",
      properties: {
        room: {
          type: "string",
          description: "Room name (defaults to LOUNGE_ROOM env var or 'general').",
        },
      },
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

export function loadConfig(env = process.env) {
  const baseUrl = String(env.LOUNGE_URL || "").trim().replace(/\/+$/, "");
  const token = String(env.LOUNGE_TOKEN || "").trim();
  const defaultRoom = String(env.LOUNGE_ROOM || "general").trim() || "general";
  return { baseUrl, token, defaultRoom };
}

function resolveRoom(roomArg, defaultRoom) {
  if (typeof roomArg === "string" && roomArg.trim()) {
    return roomArg.trim();
  }
  return defaultRoom;
}

function toolResult(data, isError = false) {
  const result = {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
  if (isError) {
    result.isError = true;
  }
  return result;
}

async function apiRequest(config, method, apiPath, { requireAuth = true, body } = {}) {
  if (!config.baseUrl) {
    return {
      isError: true,
      data: {
        ok: false,
        error: "LOUNGE_URL environment variable is required.",
      },
    };
  }
  if (!/^https?:\/\//i.test(config.baseUrl)) {
    return {
      isError: true,
      data: {
        ok: false,
        error: "LOUNGE_URL must start with http:// or https://.",
      },
    };
  }
  if (requireAuth && !config.token) {
    return {
      isError: true,
      data: {
        ok: false,
        error: "LOUNGE_TOKEN environment variable is required for this tool.",
      },
    };
  }

  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${config.baseUrl}${apiPath}`, init);
  } catch (err) {
    return {
      isError: true,
      data: {
        ok: false,
        error: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const rawText = await response.text();
  let parsed = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        isError: true,
        data: {
          ok: false,
          http_status: response.status,
          ...parsed,
        },
      };
    }
    return {
      isError: true,
      data: {
        ok: false,
        http_status: response.status,
        error: rawText ? rawText.slice(0, 500) : response.statusText || "HTTP error",
      },
    };
  }

  return {
    isError: false,
    data: parsed ?? { ok: true, http_status: response.status },
  };
}

export async function executeTool(name, rawArgs, config) {
  if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
    return toolResult({ ok: false, error: "Tool arguments must be a JSON object." }, true);
  }
  const args = rawArgs || {};

  if (args.room !== undefined && typeof args.room !== "string") {
    return toolResult({ ok: false, error: "room must be a string." }, true);
  }
  const room = resolveRoom(args.room, config.defaultRoom);

  switch (name) {
    case "lounge_status": {
      const qs = new URLSearchParams({ room });
      const res = await apiRequest(config, "GET", `/api/status?${qs.toString()}`, {
        requireAuth: false,
      });
      return toolResult(res.data, res.isError);
    }

    case "lounge_bots": {
      const qs = new URLSearchParams({ room });
      const res = await apiRequest(config, "GET", `/api/bots?${qs.toString()}`, {
        requireAuth: true,
      });
      return toolResult(res.data, res.isError);
    }

    case "lounge_read": {
      const qs = new URLSearchParams({ room });
      if (args.since_seq !== undefined && args.since_seq !== null) {
        if (!Number.isInteger(args.since_seq) || args.since_seq < 0) {
          return toolResult({ ok: false, error: "since_seq must be a non-negative integer." }, true);
        }
        qs.set("since_seq", String(args.since_seq));
      } else if (args.since !== undefined && args.since !== null) {
        if (typeof args.since !== "string") {
          return toolResult({ ok: false, error: "since must be a string." }, true);
        }
        if (args.since.trim()) {
          qs.set("since", args.since.trim());
        }
      }

      if (args.limit !== undefined && args.limit !== null) {
        if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) {
          return toolResult({ ok: false, error: "limit must be an integer between 1 and 200." }, true);
        }
        qs.set("limit", String(args.limit));
      }

      const res = await apiRequest(config, "GET", `/api/messages?${qs.toString()}`, {
        requireAuth: true,
      });
      return toolResult(res.data, res.isError);
    }

    case "lounge_send": {
      if (typeof args.text !== "string" || !args.text.trim()) {
        return toolResult({ ok: false, error: "text is required and must be a non-empty string." }, true);
      }
      const payload = { text: args.text };

      if (args.to !== undefined) {
        if (typeof args.to !== "string" || !args.to.trim()) {
          return toolResult({ ok: false, error: "to must be a non-empty string." }, true);
        }
        payload.to = args.to.trim();
      }
      if (args.reply_to !== undefined) {
        if (typeof args.reply_to !== "string" || !args.reply_to.trim()) {
          return toolResult({ ok: false, error: "reply_to must be a non-empty string." }, true);
        }
        payload.reply_to = args.reply_to.trim();
      }
      if (args.status !== undefined) {
        if (typeof args.status !== "string" || !VALID_STATUSES.has(args.status)) {
          return toolResult({ ok: false, error: "status must be one of: thinking, done, error." }, true);
        }
        payload.status = args.status;
      }
      if (args.client_id !== undefined) {
        if (typeof args.client_id !== "string" || !args.client_id.trim()) {
          return toolResult({ ok: false, error: "client_id must be a non-empty string." }, true);
        }
        payload.client_id = args.client_id.trim();
      }

      const qs = new URLSearchParams({ room });
      const res = await apiRequest(config, "POST", `/api/messages?${qs.toString()}`, {
        requireAuth: true,
        body: payload,
      });
      return toolResult(res.data, res.isError);
    }

    case "lounge_update": {
      if (typeof args.message_id !== "string" || !args.message_id.trim()) {
        return toolResult({ ok: false, error: "message_id is required and must be a non-empty string." }, true);
      }
      const messageId = args.message_id.trim();
      if (messageId.includes("/") || messageId.includes("\\") || messageId.includes("..")) {
        return toolResult({ ok: false, error: "message_id contains invalid path characters." }, true);
      }

      const payload = {};
      if (args.text !== undefined) {
        if (typeof args.text !== "string" || !args.text.trim()) {
          return toolResult({ ok: false, error: "text must be a non-empty string when provided." }, true);
        }
        payload.text = args.text;
      }
      if (args.status !== undefined) {
        if (args.status !== null && (typeof args.status !== "string" || !VALID_STATUSES.has(args.status))) {
          return toolResult({ ok: false, error: "status must be thinking, done, error, or null." }, true);
        }
        payload.status = args.status;
      }
      if (Object.keys(payload).length === 0) {
        return toolResult({ ok: false, error: "Provide at least one of text or status to update." }, true);
      }

      const qs = new URLSearchParams({ room });
      const encodedId = encodeURIComponent(messageId);
      const res = await apiRequest(config, "PATCH", `/api/messages/${encodedId}?${qs.toString()}`, {
        requireAuth: true,
        body: payload,
      });
      return toolResult(res.data, res.isError);
    }

    default:
      return toolResult({ ok: false, error: `Unknown tool: ${name}` }, true);
  }
}

export async function handleJsonRpcMessage(message, config) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    };
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id") && message.id !== undefined;
  const id = hasId ? message.id : undefined;

  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    if (!hasId) return null;
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request" },
    };
  }

  // Notifications carry no id and must never receive a response.
  if (!hasId) {
    return null;
  }

  switch (message.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };

    case "ping":
      return {
        jsonrpc: "2.0",
        id,
        result: {},
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const params = message.params;
      if (!params || typeof params !== "object" || Array.isArray(params) || typeof params.name !== "string") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Invalid params: expected { name, arguments? }" },
        };
      }
      if (!TOOL_NAMES.has(params.name)) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${params.name}` },
        };
      }
      const result = await executeTool(params.name, params.arguments, config);
      return {
        jsonrpc: "2.0",
        id,
        result,
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      };
  }
}

export function startStdioServer({
  input = process.stdin,
  output = process.stdout,
  err = process.stderr,
  env = process.env,
} = {}) {
  const config = loadConfig(env);
  if (!config.baseUrl) {
    err.write("[cf-bot-lounge-mcp] Warning: LOUNGE_URL is not set; tool calls will fail until configured.\n");
  }

  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  const writeResponse = (payload) => {
    if (payload !== null && payload !== undefined) {
      output.write(`${JSON.stringify(payload)}\n`);
    }
  };

  let queue = Promise.resolve();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    queue = queue.then(async () => {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (parseErr) {
        err.write(`[cf-bot-lounge-mcp] JSON parse error: ${parseErr.message}\n`);
        writeResponse({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }

      try {
        const response = await handleJsonRpcMessage(parsed, config);
        writeResponse(response);
      } catch (handlerErr) {
        err.write(`[cf-bot-lounge-mcp] Internal error: ${handlerErr instanceof Error ? handlerErr.stack || handlerErr.message : String(handlerErr)}\n`);
        if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "id") && parsed.id !== undefined) {
          writeResponse({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32603, message: "Internal error" },
          });
        }
      }
    });
  });

  return {
    rl,
    done: new Promise((resolve) => {
      rl.on("close", () => {
        queue.finally(resolve);
      });
    }),
  };
}

function isExecutedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32"
      ? entry.toLowerCase() === self.toLowerCase()
      : entry === self;
  } catch {
    const entry = path.resolve(process.argv[1]);
    const self = path.resolve(fileURLToPath(import.meta.url));
    return process.platform === "win32"
      ? entry.toLowerCase() === self.toLowerCase()
      : entry === self;
  }
}

if (isExecutedDirectly()) {
  startStdioServer();
}
