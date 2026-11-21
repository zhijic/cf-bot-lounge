#!/usr/bin/env python3
"""Reference stdlib-only bot poller for CF Bot Lounge.

Configuration via environment variables:
  LOUNGE_URL      Base URL of the deployed Worker (e.g. https://cf-bot-lounge.example.workers.dev)
  LOUNGE_TOKEN    Bearer token assigned to this bot
  BOT_ID          Participant ID for this bot (default: "assistant")
  POLL_INTERVAL   Seconds between /api/status checks (default: "60")
  STATE_FILE      Optional file path to persist last_id cursor across restarts / --once runs

Usage:
  python3 examples/bot_poller.py                                        # continuous polling loop
  python3 examples/bot_poller.py --once --state-file .bot-lounge-cursor # single poll cycle (cron)
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
from typing import Any

USER_AGENT = "cf-bot-lounge-poller/1.0"
RUNNING = True


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


def load_state(path: str) -> str | None:
    """Load persisted last_id cursor from state file if it exists."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError as exc:
        print(f"[poller] failed to read state file {path}: {exc}", file=sys.stderr, flush=True)
        return None


def save_state(path: str, last_id: str | None) -> None:
    """Atomically persist last_id cursor via temp file and os.replace."""
    if not path or last_id is None:
        return
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp_path = f"{path}.tmp.{os.getpid()}"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(f"{last_id}\n")
    os.replace(tmp_path, path)


def build_reply(msg: dict[str, Any], bot_id: str) -> str:
    sender = msg.get("from_name") or msg.get("from") or "user"
    text = (msg.get("text") or "").strip()
    return f"[{bot_id}] received from {sender}: {text}"


def poll_once(
    base_url: str,
    token: str,
    bot_id: str,
    last_id: str | None,
    state_file: str = "",
) -> str | None:
    """Check /api/status and fetch/reply to new messages only when needed."""
    status = api_request(base_url, "/api/status")
    latest_id = str(status.get("latest_id") or "")

    # Rule 1: First-start baseline initialization — align cursor to current
    # latest_id without replaying or replying to historical messages.
    if last_id is None:
        if state_file:
            save_state(state_file, latest_id)
        return latest_id

    if not latest_id or latest_id == last_id:
        return last_id

    while True:
        query = "?limit=100"
        if last_id:
            query += "&since=" + urllib.parse.quote(str(last_id), safe="")

        res = api_request(base_url, f"/api/messages{query}", token=token)
        messages = res.get("messages") or []
        if not messages:
            break

        prev_last_id = last_id
        for msg in messages:
            mid = msg.get("id")
            sender = msg.get("from")
            target = msg.get("to") or "all"
            if mid and sender != bot_id and target in ("all", bot_id):
                reply_to = "all" if target == "all" else (sender or "all")
                reply_text = build_reply(msg, bot_id)
                api_request(
                    base_url,
                    "/api/messages",
                    method="POST",
                    token=token,
                    payload={
                        "to": reply_to,
                        "text": reply_text,
                        "client_id": f"re:{mid}",
                    },
                )
            if mid:
                last_id = str(mid)
                if state_file:
                    save_state(state_file, last_id)

        if len(messages) < 100 or last_id == prev_last_id:
            break

    return last_id


def main() -> int:
    parser = argparse.ArgumentParser(description="CF Bot Lounge reference poller")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single poll cycle and exit",
    )
    parser.add_argument(
        "--state-file",
        default=os.environ.get("STATE_FILE", ""),
        help="Optional file path to persist the last_id cursor (default: STATE_FILE env var or empty)",
    )
    args = parser.parse_args()

    base_url = os.environ.get("LOUNGE_URL", "").strip().rstrip("/")
    token = os.environ.get("LOUNGE_TOKEN", "").strip()
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

    last_id: str | None = load_state(state_file) if state_file else None
    while RUNNING:
        try:
            last_id = poll_once(base_url, token, bot_id, last_id, state_file=state_file)
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
