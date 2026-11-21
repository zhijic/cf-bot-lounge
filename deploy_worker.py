#!/usr/bin/env python3
"""Deploy the CF Bot Lounge Worker: KV namespace, TOKENS_JSON secret, script, and page.html upload.

Authenticates to the Cloudflare v4 API using CLOUDFLARE_API_TOKEN (Bearer token)
and CLOUDFLARE_ACCOUNT_ID (or --account-id). Never prints secret token values.

Reads in this dir: worker.js, page.html, tokens-secret.json (or tokens.json).
Prints only non-secret results: namespace id, script id, subdomain, health
and auth checks (status codes only).

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


def pick_first_valid_token(tokens):
    if not isinstance(tokens, dict):
        return None
    for key, entry in tokens.items():
        if (
            isinstance(key, str)
            and key
            and isinstance(entry, dict)
            and isinstance(entry.get("id"), str)
            and entry["id"]
        ):
            return key
    return None


def main():
    parser = argparse.ArgumentParser(description="Deploy CF Bot Lounge to Cloudflare Workers.")
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
        "--kv-title",
        default=os.environ.get("CF_KV_TITLE", "BOT_CHAT"),
        help="KV namespace title (default: CF_KV_TITLE env var or BOT_CHAT)",
    )
    parser.add_argument("--test", action="store_true", help="Run smoke tests against the deployed Worker")
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

    script_name = args.script_name
    kv_title = args.kv_title

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

    # 1. KV namespace (find or create)
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
        print(f"kv namespace {kv_title} exists:", ns_id)
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
        print(f"kv namespace {kv_title} created:", ns_id)

    # 2. Upload Worker script with KV and SQLite Durable Object bindings
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": "2026-11-19",
        "bindings": [
            {"type": "kv_namespace", "name": "BOT_CHAT", "namespace_id": ns_id},
            {"type": "durable_object_namespace", "name": "CHAT_HISTORY", "class_name": "ChatHistory"},
        ],
    }
    if migration != HISTORY_MIGRATION:
        metadata["migrations"] = {
            "new_tag": HISTORY_MIGRATION,
            "new_sqlite_classes": ["ChatHistory"],
        }
    body, ctype = multipart([
        ("metadata", None, "application/json", json.dumps(metadata).encode()),
        ("worker.js", "worker.js", "application/javascript+module", script),
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
    print("script uploaded:", payload["result"].get("id"), "etag:", payload["result"].get("etag"))

    # 3. Set TOKENS_JSON secret
    status, payload = api(
        "PUT",
        f"/client/v4/accounts/{account}/workers/scripts/{script_name}/secrets",
        api_token,
        {"name": "TOKENS_JSON", "text": secret_text, "type": "secret_text"},
    )
    if not payload.get("success"):
        print("secret set failed:", status, json.dumps(payload)[:500])
        return 1
    print("secret TOKENS_JSON set")

    # 3b. Upload the chat page HTML to KV (key "page"); the Worker serves it at GET /.
    status, payload = api(
        "PUT",
        f"/client/v4/accounts/{account}/storage/kv/namespaces/{ns_id}/values/page",
        api_token,
        page,
        content_type="text/html",
    )
    if not payload.get("success"):
        print("page upload failed:", status, json.dumps(payload)[:500])
        return 1
    print("page uploaded to KV (key 'page'):", len(page), "bytes")

    # 4. Subdomain + health check
    status, payload = api("GET", f"/client/v4/accounts/{account}/workers/subdomain", api_token)
    if not payload.get("success"):
        print("subdomain lookup failed:", json.dumps(payload)[:500])
        print("Worker is deployed but the public URL is unknown; open the Workers & Pages page once to create the subdomain, then re-run with --test.")
        return 1
    sub = payload["result"]["subdomain"]
    base_url = f"https://{script_name}.{sub}.workers.dev"
    print("worker url:", base_url)

    if args.test:
        # Cloudflare's Browser Integrity Check on workers.dev blocks the
        # default Python-urllib User-Agent with error 1010. Send a normal UA.
        ua = {"User-Agent": "cf-bot-lounge-poller/1.0 (curl-compatible)"}
        try:
            req = urllib.request.Request(base_url + "/api/health", headers=ua)
            with urllib.request.urlopen(req, timeout=15) as resp:
                print("health:", resp.status, resp.read().decode("utf-8", errors="replace")[:200])
                if resp.status != 200:
                    return 1
        except Exception as exc:
            print("health check failed:", exc)
            return 1
        try:
            req = urllib.request.Request(base_url + "/api/status", headers=ua)
            with urllib.request.urlopen(req, timeout=15) as resp:
                _ = resp.read().decode("utf-8", errors="replace")
                print("status:", resp.status)
                if resp.status != 200:
                    return 1
        except Exception as exc:
            print("status check failed:", exc)
            return 1
        req = urllib.request.Request(
            base_url + "/api/me",
            headers={"Authorization": "Bearer " + valid_token, **ua},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                _ = resp.read().decode("utf-8", errors="replace")
                print("authed me:", resp.status)
                if resp.status != 200:
                    return 1
        except urllib.error.HTTPError as exc:
            print("authed me failed:", exc.code)
            return 1
        except Exception as exc:
            print("authed me failed:", exc)
            return 1
        req = urllib.request.Request(
            base_url + "/api/messages",
            headers={"Authorization": "Bearer " + valid_token, **ua},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                _ = resp.read().decode("utf-8", errors="replace")
                print("authed read:", resp.status)
                if resp.status != 200:
                    return 1
        except urllib.error.HTTPError as exc:
            print("authed read failed:", exc.code)
            return 1
        except Exception as exc:
            print("authed read failed:", exc)
            return 1
        bad = urllib.request.Request(
            base_url + "/api/messages",
            headers={"Authorization": "Bearer invalid-token", **ua},
        )
        try:
            with urllib.request.urlopen(bad, timeout=15) as resp:
                _ = resp.read().decode("utf-8", errors="replace")
                print("bad-token read unexpectedly succeeded:", resp.status)
                return 1
        except urllib.error.HTTPError as exc:
            if exc.code != 401:
                print("bad-token read returned unexpected status:", exc.code)
                return 1
            print("bad-token read correctly rejected:", exc.code)
        except Exception as exc:
            print("bad-token check failed:", exc)
            return 1
        # The chat page is served at GET / from the KV "page" key.
        req = urllib.request.Request(base_url + "/", headers=ua)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="replace")
                ok = (resp.status == 200) and ("Bot Lounge" in html) and ("发给" in html)
                print("page:", resp.status, resp.headers.get("Content-Type"), "len", len(html), "markers ok:", ok)
                if not ok:
                    return 1
        except Exception as exc:
            print("page check failed:", exc)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
