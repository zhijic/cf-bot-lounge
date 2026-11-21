#!/usr/bin/env python3
"""Deploy the CF Bot Lounge v2.0 Worker (Zero-KV default).

Authenticates to the Cloudflare v4 API using CLOUDFLARE_API_TOKEN (Bearer token)
and CLOUDFLARE_ACCOUNT_ID (or --account-id). Never prints secret token values.

Bundles worker.js and page.html together in a single Worker multipart upload
(matching `import PAGE_HTML from "./page.html";`), attaches the SQLite Durable
Object binding (CHAT_HISTORY), and sets TOKENS_JSON (plus optional ADMIN_TOKEN
and STATUS_TOKEN secrets when configured).

Optional bindings:
  --legacy-kv              Attach legacy BOT_CHAT KV namespace for v1 message import
  --r2-bucket <bucket>     Attach UPLOADS R2 bucket for file attachments

Usage:
  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... python3 deploy_worker.py [--test]
"""
import argparse
import json
import os
import secrets
import sys
import urllib.error
import urllib.request

HISTORY_MIGRATION = "chat-history-sqlite-v1"
COMPATIBILITY_DATE = "2026-11-19"
EXPECTED_VERSION = "2.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def api(method, path, api_token, body=None, content_type=None):
    url = "https://api.cloudflare.com" + path
    data = None
    headers = {
        "Authorization": f"Bearer {api_token}",
    }
    if body is not None:
        if isinstance(body, (dict, list)):
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        else:
            data = body
            if content_type:
                headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=60) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            payload = json.loads(raw.decode("utf-8", errors="replace"))
        except (ValueError, UnicodeDecodeError):
            payload = {"success": False, "errors": [{"message": raw.decode("utf-8", errors="replace")[:500]}]}
        return exc.code, payload


def multipart(fields):
    """fields: list of (name, filename_or_None, content_type, bytes)."""
    boundary = "----botchat" + secrets.token_hex(16)
    body = b""
    for name, filename, ctype, data in fields:
        disp = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disp += f'; filename="{filename}"'
        body += f"--{boundary}\r\n".encode()
        body += f"{disp}\r\nContent-Type: {ctype}\r\n\r\n".encode()
        body += data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def _allows_general_room(entry):
    rooms = entry.get("rooms")
    if rooms is None:
        return True
    if not isinstance(rooms, list):
        return False
    return "*" in rooms or "general" in rooms


def pick_first_valid_token(tokens):
    if not isinstance(tokens, dict):
        return None
    fallback = None
    for key, entry in tokens.items():
        if (
            isinstance(key, str)
            and key
            and isinstance(entry, dict)
            and isinstance(entry.get("id"), str)
            and entry["id"]
        ):
            if _allows_general_room(entry):
                return key
            if fallback is None:
                fallback = key
    return fallback


def resolve_optional_secret(explicit_env_name, default_env_name, label):
    """Return (secret_value_or_None, error_message_or_None).

    If the CLI flag was explicitly provided, require that env var to be non-empty.
    Otherwise check default_env_name and upload it automatically when set.
    """
    if explicit_env_name is not None:
        env_name = explicit_env_name.strip()
        if not env_name:
            return None, None
        val = os.environ.get(env_name, "").strip()
        if not val:
            return None, f"Error: {label} requested via env var '{env_name}', but it is not set or empty."
        return val, None
    val = os.environ.get(default_env_name, "").strip()
    return (val or None), None


def put_worker_secret(account, script_name, api_token, secret_name, secret_value):
    status, payload = api(
        "PUT",
        f"/client/v4/accounts/{account}/workers/scripts/{script_name}/secrets",
        api_token,
        {"name": secret_name, "text": secret_value, "type": "secret_text"},
    )
    if not payload.get("success"):
        print(f"secret {secret_name} set failed:", status, json.dumps(payload)[:500])
        return False
    print(f"secret {secret_name} set")
    return True


def fetch_json_check(url, headers, label):
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(raw) if raw else {}
            except ValueError:
                print(f"{label} returned non-JSON body:", resp.status)
                return None, None
            return resp.status, data
    except urllib.error.HTTPError as exc:
        print(f"{label} failed:", exc.code)
        return exc.code, None
    except Exception as exc:
        print(f"{label} failed:", exc)
        return None, None


def run_smoke_tests(base_url, valid_token, status_token=None):
    # Cloudflare's Browser Integrity Check on workers.dev blocks the
    # default Python-urllib User-Agent with error 1010. Send a normal UA.
    ua = {"User-Agent": "cf-bot-lounge-deploy/2.0 (curl-compatible)"}
    authed_headers = {"Authorization": "Bearer " + valid_token, **ua}

    # 1. /api/health (200, version 2.0.0)
    code, health = fetch_json_check(base_url + "/api/health", ua, "health")
    if code != 200 or not isinstance(health, dict):
        return False
    version = health.get("version")
    print("health:", code, "version:", version, "capabilities:", json.dumps(health.get("capabilities", {})))
    if not health.get("ok") or version != EXPECTED_VERSION:
        print(f"health check failed: expected ok=true and version={EXPECTED_VERSION}")
        return False

    # 2. /api/status (200; falls back to STATUS_TOKEN / participant token if PUBLIC_STATUS=false)
    req = urllib.request.Request(base_url + "/api/status", headers=ua)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status_data = json.loads(raw) if raw else {}
            print("status:", resp.status, "room:", status_data.get("room"), "latest_seq:", status_data.get("latest_seq"))
            if resp.status != 200 or not status_data.get("ok"):
                return False
    except urllib.error.HTTPError as exc:
        if exc.code == 401 and (status_token or valid_token):
            tok = status_token or valid_token
            code, status_data = fetch_json_check(
                base_url + "/api/status",
                {"Authorization": "Bearer " + tok, **ua},
                "status (authed)",
            )
            if code != 200 or not isinstance(status_data, dict) or not status_data.get("ok"):
                return False
            print("status (authed):", code, "room:", status_data.get("room"), "latest_seq:", status_data.get("latest_seq"))
        else:
            print("status check failed:", exc.code)
            return False
    except Exception as exc:
        print("status check failed:", exc)
        return False

    # 3. /api/me (200)
    code, me_data = fetch_json_check(base_url + "/api/me", authed_headers, "authed me")
    if code != 200 or not isinstance(me_data, dict) or not me_data.get("ok"):
        return False
    print("authed me:", code)

    # 4. /api/bots (200)
    code, bots_data = fetch_json_check(base_url + "/api/bots", authed_headers, "authed bots")
    if code != 200 or not isinstance(bots_data, dict) or not bots_data.get("ok"):
        return False
    print("authed bots:", code, "count:", len(bots_data.get("bots") or []))

    # 5. /api/rooms (200)
    code, rooms_data = fetch_json_check(base_url + "/api/rooms", authed_headers, "authed rooms")
    if code != 200 or not isinstance(rooms_data, dict) or not rooms_data.get("ok"):
        return False
    print("authed rooms:", code, "rooms:", rooms_data.get("rooms"))

    # 6. /api/messages (200)
    code, msgs_data = fetch_json_check(base_url + "/api/messages", authed_headers, "authed read")
    if code != 200 or not isinstance(msgs_data, dict) or not msgs_data.get("ok"):
        return False
    print("authed read:", code)

    # 7. /api/messages with invalid token (401)
    bad = urllib.request.Request(
        base_url + "/api/messages",
        headers={"Authorization": "Bearer invalid-token", **ua},
    )
    try:
        with urllib.request.urlopen(bad, timeout=15) as resp:
            _ = resp.read().decode("utf-8", errors="replace")
            print("bad-token read unexpectedly succeeded:", resp.status)
            return False
    except urllib.error.HTTPError as exc:
        if exc.code != 401:
            print("bad-token read returned unexpected status:", exc.code)
            return False
        print("bad-token read correctly rejected:", exc.code)
    except Exception as exc:
        print("bad-token check failed:", exc)
        return False

    # 8. GET / (bundled page.html, 200 with "Bot Lounge" and "发给")
    req = urllib.request.Request(base_url + "/", headers=ua)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")
            ok = (resp.status == 200) and ("Bot Lounge" in html) and ("发给" in html)
            print("page:", resp.status, resp.headers.get("Content-Type"), "len", len(html), "markers ok:", ok)
            if not ok:
                return False
    except Exception as exc:
        print("page check failed:", exc)
        return False

    return True


def main():
    parser = argparse.ArgumentParser(
        description="Deploy CF Bot Lounge v2.0 to Cloudflare Workers (Zero-KV default)."
    )
    parser.add_argument(
        "--account-id",
        default=os.environ.get("CLOUDFLARE_ACCOUNT_ID", ""),
        help="Cloudflare Account ID (default: CLOUDFLARE_ACCOUNT_ID env var)",
    )
    parser.add_argument(
        "--script-name",
        default=os.environ.get("CF_WORKER_NAME", "cf-bot-lounge"),
        help="Worker script name (default: CF_WORKER_NAME env var or cf-bot-lounge)",
    )
    parser.add_argument(
        "--legacy-kv",
        action="store_true",
        help="Bind legacy Workers KV namespace (BOT_CHAT) for one-time v1 message import (off by default)",
    )
    parser.add_argument(
        "--kv-title",
        default=os.environ.get("CF_KV_TITLE", "BOT_CHAT"),
        help="KV namespace title used only with --legacy-kv (default: CF_KV_TITLE env var or BOT_CHAT)",
    )
    parser.add_argument(
        "--r2-bucket",
        default=os.environ.get("CF_R2_BUCKET", ""),
        metavar="BUCKET",
        help="Optional R2 bucket name to bind as UPLOADS for file attachments (default: CF_R2_BUCKET env var)",
    )
    parser.add_argument(
        "--admin-token-env",
        nargs="?",
        const="ADMIN_TOKEN",
        default=None,
        metavar="ENV_VAR",
        help="Upload ADMIN_TOKEN secret from ENV_VAR (default: ADMIN_TOKEN env var is uploaded automatically when set)",
    )
    parser.add_argument(
        "--status-token-env",
        nargs="?",
        const="STATUS_TOKEN",
        default=None,
        metavar="ENV_VAR",
        help="Upload STATUS_TOKEN secret from ENV_VAR (default: STATUS_TOKEN env var is uploaded automatically when set)",
    )
    parser.add_argument(
        "--test",
        action="store_true",
        help="Run v2.0 smoke tests against the deployed Worker",
    )
    parser.add_argument(
        "--migrate-messages",
        action="store_true",
        help="Allow the first SQLite rollout on an existing non-SQLite Worker (new Workers auto-apply chat-history-sqlite-v1; see docs/DEPLOYMENT.md)",
    )
    args = parser.parse_args()

    api_token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not api_token:
        print(
            "Error: CLOUDFLARE_API_TOKEN environment variable is required.",
            file=sys.stderr,
        )
        return 1

    account = (args.account_id or "").strip()
    if not account:
        print(
            "Error: Cloudflare Account ID is required. Pass --account-id or set CLOUDFLARE_ACCOUNT_ID.",
            file=sys.stderr,
        )
        return 1

    admin_token, err = resolve_optional_secret(args.admin_token_env, "ADMIN_TOKEN", "ADMIN_TOKEN")
    if err:
        print(err, file=sys.stderr)
        return 1

    status_token, err = resolve_optional_secret(args.status_token_env, "STATUS_TOKEN", "STATUS_TOKEN")
    if err:
        print(err, file=sys.stderr)
        return 1

    script_name = args.script_name.strip()
    kv_title = args.kv_title.strip()
    r2_bucket = (args.r2_bucket or "").strip()

    # Pre-flight local file validation before calling any Cloudflare API.
    worker_path = os.path.join(HERE, "worker.js")
    if not os.path.isfile(worker_path):
        print(f"Error: required file not found: {worker_path}", file=sys.stderr)
        return 1

    page_path = os.path.join(HERE, "page.html")
    if not os.path.isfile(page_path):
        print(f"Error: required file not found: {page_path}", file=sys.stderr)
        return 1

    secret_path = os.path.join(HERE, "tokens-secret.json")
    if not os.path.isfile(secret_path):
        fallback_path = os.path.join(HERE, "tokens.json")
        if os.path.isfile(fallback_path):
            secret_path = fallback_path
        else:
            print(
                "Error: tokens-secret.json (or tokens.json) not found. "
                "Copy tokens.example.json to tokens-secret.json and configure your tokens before deploying.",
                file=sys.stderr,
            )
            return 1

    try:
        with open(secret_path, "rb") as f:
            secret_text = f.read().decode("utf-8")
        tokens = json.loads(secret_text)
    except (OSError, UnicodeDecodeError, ValueError):
        print(
            f"Error: failed to parse {os.path.basename(secret_path)} as valid UTF-8 JSON.",
            file=sys.stderr,
        )
        return 1

    valid_token = pick_first_valid_token(tokens)
    if not valid_token:
        print(
            f"Error: {os.path.basename(secret_path)} must be a JSON object containing at least one "
            'valid participant entry ({ "<token>": { "id": "..." } }).',
            file=sys.stderr,
        )
        return 1

    with open(worker_path, "rb") as f:
        script = f.read()
    with open(page_path, "rb") as f:
        page = f.read()

    # Determine the migration from Cloudflare instead of local deploy state.
    _, workers = api("GET", f"/client/v4/accounts/{account}/workers/scripts", api_token)
    if not workers.get("success"):
        print("Worker migration state lookup failed.")
        return 1
    script_state = next((item for item in workers["result"] if item["id"] == script_name), None)
    migration = script_state.get("migration_tag") if script_state else None
    if migration not in (None, "", HISTORY_MIGRATION):
        print("Unexpected Worker migration tag. Verify the target before deploying.")
        return 1
    if script_state and migration != HISTORY_MIGRATION and not args.migrate_messages:
        print("First SQLite rollout: follow the cutover in docs/DEPLOYMENT.md, then use --migrate-messages.")
        return 1

    bindings = [
        {"type": "durable_object_namespace", "name": "CHAT_HISTORY", "class_name": "ChatHistory"},
    ]

    # 1. Optional legacy KV namespace (ONLY when --legacy-kv is passed)
    if args.legacy_kv:
        status, payload = api(
            "GET",
            f"/client/v4/accounts/{account}/storage/kv/namespaces?per_page=100",
            api_token,
        )
        if not payload.get("success"):
            print("kv list failed:", json.dumps(payload)[:500])
            return 1
        ns_id = None
        for ns in payload.get("result", []):
            if ns.get("title") == kv_title:
                ns_id = ns["id"]
                break
        if ns_id:
            print(f"legacy kv namespace {kv_title} exists:", ns_id)
        else:
            status, payload = api(
                "POST",
                f"/client/v4/accounts/{account}/storage/kv/namespaces",
                api_token,
                {"title": kv_title},
            )
            if not payload.get("success"):
                print("kv create failed:", json.dumps(payload)[:500])
                return 1
            ns_id = payload["result"]["id"]
            print(f"legacy kv namespace {kv_title} created:", ns_id)
        bindings.append({"type": "kv_namespace", "name": "BOT_CHAT", "namespace_id": ns_id})

    # Optional R2 bucket binding for attachments
    if r2_bucket:
        bindings.append({"type": "r2_bucket", "name": "UPLOADS", "bucket_name": r2_bucket})
        print("binding R2 bucket UPLOADS:", r2_bucket)

    # 2. Upload Worker script + bundled page.html text module
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": COMPATIBILITY_DATE,
        "bindings": bindings,
    }
    if migration != HISTORY_MIGRATION:
        metadata["migrations"] = {
            "new_tag": HISTORY_MIGRATION,
            "new_sqlite_classes": ["ChatHistory"],
        }
    body, ctype = multipart([
        ("metadata", None, "application/json", json.dumps(metadata).encode("utf-8")),
        ("worker.js", "worker.js", "application/javascript+module", script),
        ("page.html", "page.html", "text/plain", page),
    ])
    status, payload = api(
        "PUT",
        f"/client/v4/accounts/{account}/workers/scripts/{script_name}",
        api_token,
        body,
        ctype,
    )
    if not payload.get("success"):
        print("script upload failed:", status, json.dumps(payload)[:800])
        return 1
    print(
        "script uploaded (worker.js + page.html):",
        payload["result"].get("id"),
        "etag:",
        payload["result"].get("etag"),
        "page_bytes:",
        len(page),
    )

    # 3. Set TOKENS_JSON (and optional ADMIN_TOKEN / STATUS_TOKEN) secrets
    if not put_worker_secret(account, script_name, api_token, "TOKENS_JSON", secret_text):
        return 1
    if admin_token:
        if not put_worker_secret(account, script_name, api_token, "ADMIN_TOKEN", admin_token):
            return 1
    if status_token:
        if not put_worker_secret(account, script_name, api_token, "STATUS_TOKEN", status_token):
            return 1

    # 4. Subdomain lookup + optional smoke tests
    status, payload = api("GET", f"/client/v4/accounts/{account}/workers/subdomain", api_token)
    if not payload.get("success"):
        print("subdomain lookup failed:", json.dumps(payload)[:500])
        print("Worker is deployed but the public URL is unknown; open the Workers & Pages page once to create the subdomain, then re-run with --test.")
        return 1
    sub = payload["result"]["subdomain"]
    base_url = f"https://{script_name}.{sub}.workers.dev"
    print("worker url:", base_url)

    if args.test:
        if not run_smoke_tests(base_url, valid_token, status_token=status_token):
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
