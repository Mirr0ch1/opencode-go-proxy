# opencode-go-proxy

A zero-dependency reverse proxy that lets any OpenAI-compatible client use the
[OpenCode Go](https://opencode.ai/go) subscription through its public inference
endpoint — with the session header and model-name rewriting that most clients
can't do on their own.

## Why this exists

Since **2026-09-05**, the OpenCode Go API (`https://opencode.ai/inference/go/v1`)
requires every request to carry an `x-opencode-session` header. Without it, the
upstream rejects the request with `400 MissingSessionID`. This header serves two
purposes: **session affinity** (same-session requests are pinned to the same
backend) and **prompt-cache routing** (`usage.cached_tokens` > 0 keeps your bill
down).

The problem: many clients that support custom OpenAI-compatible models
(CodeBuddy's `models.json`, plain OpenAI SDKs, assorted harnesses) can set a
`base_url` and an `api_key`, but **cannot inject a custom header**. There is no
`CUSTOM_HEADERS` escape hatch for third-party model requests in most of them.

This proxy sits in the middle and does the header injection (plus a few other
things) so those clients "just work".

## Features

- **Zero dependencies** — a single Node.js script (`proxy.mjs`), no `npm install`.
- **Injects `x-opencode-session`** with a 3-tier fallback (see below).
- **Rewrites the `model` field** — lets you give clients a prefixed/suffixed model
  alias (e.g. `deepseek-v4-pro-mine`) while the upstream sees the real name.
- **Shared-token auth** — the real subscription key never leaves the proxy host;
  clients only hold a cheap, rotatable token.
- **Key isolation** — the proxy overwrites the client's `Authorization` header with
  the real upstream key, so clients never need it.
- **Streaming (SSE) pass-through** — responses are streamed transparently.
- **Per-request logging** — status, latency, session id, model rewrite; error
  responses also capture the upstream body and a compact request summary.
- **systemd-friendly** — logs to stdout (journald), refuses to start without a token.

## How it works

```
any OpenAI-compatible client
        │  http://<proxy-host>:<port>/chat/completions
        │  Authorization: Bearer <PROXY_TOKEN>
        ▼
┌───────────────────────────────┐
│        opencode-go-proxy      │   zero-dep Node.js
│                               │
│  · verify shared token (401)  │
│  · inject x-opencode-session  │
│  · rewrite model name         │
│  · overwrite Authorization    │
│  · stream SSE response        │
└───────────────────────────────┘
        │  https://opencode.ai/inference/go/v1
        │  Authorization: Bearer <OPENCODE_GO_API_KEY>
        ▼
   OpenCode Go inference endpoint
```

### Session-id fallback (3 tiers)

The `x-opencode-session` value is resolved in order of stability — the goal is a
**stable** session id (for prompt-cache hits), not merely a value that passes the
400 check:

1. **Client-provided id** — `X-Conversation-ID`, `X-Session-ID`, or an existing
   `x-opencode-session` header.
2. **Content hash** — `sha256(system message + first user message)`. For clients
   that don't send a session id, this yields the *same* id across turns of the
   same conversation (the system + first user message don't change), preserving
   cache affinity.
3. **Random UUID** — last resort; still passes the 400 check but loses caching.

## Quick start

```bash
# 1. Create an env file (see .env.example). For a systemd deployment, put it at
#    ~/.config/opencode-go-proxy/opencode.env (see the systemd section below).
cp .env.example opencode.env
#    fill in OPENCODE_GO_API_KEY (required) and PROXY_TOKEN (required)

# 2. Run
PROXY_TOKEN=... OPENCODE_GO_API_KEY=... node proxy.mjs
# or with the env file via systemd EnvironmentFile

# 3. Point any OpenAI-compatible client at it:
curl http://127.0.0.1:18999/chat/completions \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":64}'
```

## Configuration

All configuration is via environment variables.

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `OPENCODE_GO_API_KEY` | ✅ | — | Your real OpenCode Go subscription key. **Never shared with clients.** |
| `PROXY_TOKEN` | ✅ | — | The token clients present as `Authorization: Bearer <PROXY_TOKEN>`. The proxy **refuses to start** without it. |
| `PROXY_PORT` | — | `18999` | Listening port. |
| `PROXY_BIND` | — | `0.0.0.0` | Bind address. Set `127.0.0.1` for local-only. |

## Client setup

Any OpenAI-compatible client works. Three things to configure:

| Setting | Value |
|---------|-------|
| `base_url` | `http://<proxy-host>:<PROXY_PORT>` |
| `api_key` | `<PROXY_TOKEN>` |
| `model` | real upstream name, or a `-opencode`-suffixed alias (suffix is stripped) |

> The default suffix is `-opencode`. Set `custom-local:`-style prefixes or other
> aliases by editing the `SUFFIX` constant in `proxy.mjs`.

**OpenAI SDK example:**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:18999",
    api_key="<PROXY_TOKEN>",
)

resp = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

### CodeBuddy (models.json)

If you use CodeBuddy, add custom models pointing at the proxy and use a suffixed
id so you don't shadow the built-in models:

```json
{
  "models": [
    {
      "id": "deepseek-v4-pro-opencode",
      "name": "DeepSeek V4 Pro (OpenCode Go)",
      "vendor": "opencode-go",
      "apiKey": "<PROXY_TOKEN>",
      "url": "http://127.0.0.1:18999/chat/completions",
      "maxInputTokens": 1000000,
      "maxOutputTokens": 384000,
      "supportsToolCall": true,
      "supportsReasoning": true
    }
  ]
}
```

Then switch with `/model deepseek-v4-pro-opencode`.

## systemd (user service)

Secrets live in a private XDG config dir (`~/.config/opencode-go-proxy/opencode.env`),
separate from the source checkout.

```ini
# ~/.config/systemd/user/opencode-go-proxy.service
[Unit]
Description=opencode-go-proxy (token-auth reverse proxy)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/opencode-go-proxy
EnvironmentFile=%h/.config/opencode-go-proxy/opencode.env
ExecStart=/usr/bin/node /path/to/opencode-go-proxy/proxy.mjs
Restart=always
RestartSec=2
TimeoutStopSec=10

# Hardening (user-service-safe subset).
# Omitted on purpose (they fail in a *user* service with status=218/CAPABILITIES):
#   NoNewPrivileges, ProtectKernel{Tunables,Modules}, ProtectControlGroups.
# Also omitted: MemoryDenyWriteExecute (Node's V8 JIT needs W^X memory).
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
RestrictAddressFamilies=AF_INET AF_INET6
LockPersonality=true

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-go-proxy
```

> If the proxy needs to write files (it doesn't by default — logs go to journald),
> add `ReadWritePaths=` for the specific directory under a strict `ProtectSystem=`.


## Model-name rewriting

The proxy strips `custom-local:` prefixes and a trailing `-opencode` suffix from
the request body's `model` field before forwarding:

```
custom-local:deepseek-v4.1-flash-opencode  →  deepseek-v4.1-flash
deepseek-v4.1-flash                        →  deepseek-v4.1-flash  (pass-through)
```

This is what lets you use a suffixed alias in the client (to avoid shadowing a
built-in model) while the upstream receives the real name.

## Troubleshooting

```bash
# status
systemctl --user status opencode-go-proxy

# per-request logs (status, latency, session, model rewrite, error bodies)
journalctl --user -u opencode-go-proxy -n 30

# restart
systemctl --user restart opencode-go-proxy
```

| Error | Meaning |
|-------|---------|
| `400 MissingSessionID` | You hit the upstream directly, bypassing the proxy (which injects the header). |
| `400 Model is unavailable` | ① suffixed model name without the proxy's rewrite; ② transient upstream outage (~1 min, self-recovers). |
| `401 unauthorized` | Missing or wrong `PROXY_TOKEN`. |

## Security notes

- The **real subscription key** lives only in the env file (chmod 600) on the
  proxy host — e.g. `~/.config/opencode-go-proxy/opencode.env`. Clients hold only
  the rotatable `PROXY_TOKEN`.
- Rotating the token = edit `PROXY_TOKEN` in that env file + restart + update
  clients. Rotating the real key = do it in the OpenCode console and update the
  env file.
- Client → proxy is **plain HTTP** (unencrypted) by default. If you expose the
  proxy beyond your loopback, prefer an encrypted path (Tailscale/WireGuard) or
  put TLS in front of it.
- The proxy **refuses to start without `PROXY_TOKEN`** — fail-fast rather than
  exposing your quota to the network with no auth.

## License

MIT — see [LICENSE](LICENSE).
