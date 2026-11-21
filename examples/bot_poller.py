#!/usr/bin/env python3
"""Reference stdlib-only bot poller for CF Bot Lounge v2.0.

Demonstrates:
- Multi-room targeting (--room / LOUNGE_ROOM)
- Integer `since_seq` cursor tracking with atomic state persistence and
  backwards-compatible migration from legacy v1 string message-ID cursors
- Threaded replies (`reply_to`) with two-step status updates:
    1. POST /api/messages?room=...  (status="thinking", client_id="re:<msg_id>")
    2. PATCH /api/messages/<id>?room=...  (final text + status="done" / "error")

Configuration via environment variables:
  LOUNGE_URL      Base URL of the deployed Worker (e.g. https://cf-bot-lounge.example.workers.dev)
  LOUNGE_TOKEN    Bearer token assigned to this bot
  LOUNGE_ROOM     Room name to poll (default: "general")
  BOT_ID          Participant ID for this bot (default: "assistant")
  POLL_INTERVAL   Seconds between /api/status checks (default: "60")
  STATE_FILE      Optional file path to persist the cursor across restarts / --once runs

Usage:
  python3 examples/bot_poller.py --room general
  python3 examples/bot_poller.py --room ops --once --state-file .bot-lounge-cursor
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

USER_AGENT = "cf-bot-lounge-poller/2.0"
RUNNING = True


@dataclass
class CursorState:
    """Tracks either a v2 integer sequence cursor or a legacy v1 string message ID."""

    seq: int | None = None
    legacy_id: str | None = None


def _handle_signal(signum: int, _frame: Any) -> None:
    global RUNNING
    print(f"[poller] received signal {signum}, shutting down...", flush=True)
    RUNNING = False


def api_request(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}{path}"
    headers: dict[str, str] = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    data: bytes | None = None
    if payload is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        return json.loads(raw) if raw else {}


def load_state(path: str) -> CursorState:
    """Load persisted cursor from state file.

    Supports:
      - Integer seq strings (v2 format, e.g. "42")
      - JSON objects containing {"seq": 42}
      - Legacy v1 string message IDs (e.g. "m3r5a1b2c3d4") for seamless upgrade
      - Empty existing file (v1 empty-room baseline -> seq=0)
    """
    if not path or not os.path.exists(path):
        return CursorState()
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
    except OSError as exc:
        print(f"[poller] failed to read state file {path}: {exc}", file=sys.stderr, flush=True)
        return CursorState()

    if raw == "":
        return CursorState(seq=0)

    if raw.isdigit():
        return CursorState(seq=int(raw))

    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            if isinstance(data, dict) and isinstance(data.get("seq"), int) and data["seq"] >= 0:
                return CursorState(seq=data["seq"])
        except ValueError:
            pass

    return CursorState(legacy_id=raw)


def save_state(path: str, last_seq: int | None) -> None:
    """Atomically persist integer last_seq cursor via temp file and os.replace."""
    if not path or last_seq is None:
        return
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp_path = f"{path}.tmp.{os.getpid()}"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(f"{last_seq}\n")
    os.replace(tmp_path, path)


def build_reply(msg: dict[str, Any], bot_id: str) -> str:
    """Generate the final response text for an incoming message.

    Replace this function with your own LLM / agent call.
    """
    sender = msg.get("from_name") or msg.get("from") or "user"
    text = (msg.get("text") or "").strip()
    return f"[{bot_id}] received from {sender}: {text}"


def respond_to_message(
    base_url: str,
    token: str,
    room: str,
    bot_id: str,
    msg: dict[str, Any],
) -> None:
    """Two-step status reply: POST thinking placeholder, then PATCH final answer."""
    mid = str(msg["id"])
    sender = msg.get("from")
    target = msg.get("to") or "all"
    reply_target = "all" if target == "all" else (sender or "all")
    room_qs = urllib.parse.urlencode({"room": room})

    # Step 1: Acknowledge immediately with reply_to + status="thinking" + idempotent client_id.
    created = api_request(
        base_url,
        f"/api/messages?{room_qs}",
        method="POST",
        token=token,
        payload={
            "to": reply_target,
            "text": f"[{bot_id}] thinking...",
            "reply_to": mid,
            "status": "thinking",
            "client_id": f"re:{mid}",
        },
    )

    reply_msg = created.get("message") or {}
    reply_id = reply_msg.get("id")
    is_duplicate = bool(created.get("duplicate"))

    # If a previous run already finalized this idempotent reply, do not overwrite it.
    if not reply_id or (is_duplicate and reply_msg.get("status") != "thinking"):
        return

    patch_path = f"/api/messages/{urllib.parse.quote(str(reply_id), safe='')}?{room_qs}"

    # Step 2: Produce final output and PATCH the placeholder in place.
    try:
        final_text = build_reply(msg, bot_id)
        api_request(
            base_url,
            patch_path,
            method="PATCH",
            token=token,
            payload={
                "text": final_text,
                "status": "done",
            },
        )
    except Exception as exc:  # noqa: BLE001
        api_request(
            base_url,
            patch_path,
            method="PATCH",
            token=token,
            payload={
                "text": f"[{bot_id}] failed to generate reply: {exc}",
                "status": "error",
            },
        )
        raise


def poll_once(
    base_url: str,
    token: str,
    room: str,
    bot_id: str,
    cursor: CursorState,
    state_file: str = "",
) -> CursorState:
    """Check /api/status and drain/reply to new messages only when latest_seq advances."""
    room_qs = urllib.parse.urlencode({"room": room})
    status = api_request(base_url, f"/api/status?{room_qs}", token=token)
    latest_seq = int(status.get("latest_seq") or 0)
    latest_id = str(status.get("latest_id") or "")

    # Rule 1: First-start baseline initialization — align cursor to current
    # latest_seq without replaying or replying to historical messages.
    if cursor.seq is None and cursor.legacy_id is None:
        if state_file:
            save_state(state_file, latest_seq)
        return CursorState(seq=latest_seq)

    # Backwards-compatible transition from a legacy v1 string message-ID cursor.
    if cursor.seq is None and cursor.legacy_id is not None:
        if not latest_id or latest_id == cursor.legacy_id:
            if state_file:
                save_state(state_file, latest_seq)
            return CursorState(seq=latest_seq)
    elif cursor.seq is not None and latest_seq <= cursor.seq:
        return cursor

    last_seq = cursor.seq
    legacy_id = cursor.legacy_id

    while True:
        params: dict[str, str] = {"room": room, "limit": "100"}
        if last_seq is not None:
            params["since_seq"] = str(last_seq)
        elif legacy_id:
            params["since"] = legacy_id

        res = api_request(
            base_url,
            f"/api/messages?{urllib.parse.urlencode(params)}",
            token=token,
        )
        messages = res.get("messages") or []
        if not messages:
            if last_seq is None:
                last_seq = latest_seq
                legacy_id = None
                if state_file:
                    save_state(state_file, last_seq)
            break

        prev_seq = last_seq
        prev_legacy_id = legacy_id
        for msg in messages:
            mid = msg.get("id")
            seq = msg.get("seq")
            sender = msg.get("from")
            target = msg.get("to") or "all"

            if mid and sender != bot_id and target in ("all", bot_id):
                respond_to_message(base_url, token, room, bot_id, msg)

            if isinstance(seq, int):
                last_seq = seq
                legacy_id = None
                if state_file:
                    save_state(state_file, last_seq)
            elif mid and last_seq is None:
                legacy_id = str(mid)

        if len(messages) < 100 or (last_seq == prev_seq and legacy_id == prev_legacy_id):
            break

    return CursorState(seq=last_seq, legacy_id=legacy_id)


def main() -> int:
    parser = argparse.ArgumentParser(description="CF Bot Lounge v2.0 reference poller")
    parser.add_argument(
        "--room",
        default=os.environ.get("LOUNGE_ROOM", "general"),
        help="Room name to poll (default: LOUNGE_ROOM env var or 'general')",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single poll cycle and exit",
    )
    parser.add_argument(
        "--state-file",
        default=os.environ.get("STATE_FILE", ""),
        help="Optional file path to persist the integer last_seq cursor (default: STATE_FILE env var or empty)",
    )
    args = parser.parse_args()

    base_url = os.environ.get("LOUNGE_URL", "").strip().rstrip("/")
    token = os.environ.get("LOUNGE_TOKEN", "").strip()
    room = (args.room or "general").strip() or "general"
    bot_id = os.environ.get("BOT_ID", "assistant").strip() or "assistant"
    state_file = (args.state_file or "").strip()
    try:
        interval = max(1, int(os.environ.get("POLL_INTERVAL", "60").strip()))
    except ValueError:
        interval = 60

    if not base_url or not token:
        print(
            "Error: LOUNGE_URL and LOUNGE_TOKEN environment variables are required.",
            file=sys.stderr,
        )
        return 2

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    cursor = load_state(state_file) if state_file else CursorState()
    while RUNNING:
        try:
            cursor = poll_once(base_url, token, room, bot_id, cursor, state_file=state_file)
        except urllib.error.HTTPError as exc:
            print(f"[poller] HTTP {exc.code}: {exc.reason}", file=sys.stderr, flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[poller] error: {exc}", file=sys.stderr, flush=True)

        if args.once:
            break

        for _ in range(interval):
            if not RUNNING:
                break
            time.sleep(1)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
