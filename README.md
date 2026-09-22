# anthropic-agent-sdk-relay

An Anthropic Messages API endpoint that is answered by the Claude Agent SDK
instead of the Claude API, so a self-hosted n8n can use a Claude subscription
rather than per-token API billing.

Point n8n's Anthropic credential at this service and the Agent node works as
usual, tools included.

## What it does

```
n8n Agent node  ──POST /v1/messages──▶  relay  ──▶  Claude Agent SDK  ──▶  Claude
        ▲                                 │
        └────── tool_use / tool_result ───┘
```

The interesting part is tool calling. n8n runs its own tools and expects the
model to emit `tool_use` blocks; the Agent SDK does the opposite and executes
tools itself. The relay closes that gap:

1. Every tool the client declares is registered as an in-process MCP tool.
2. When Claude calls one, the handler's promise is **parked**, not resolved.
3. The HTTP response ends with `stop_reason: "tool_use"` carrying that call.
4. n8n runs the tool and posts a history ending in `tool_result`.
5. The relay matches the result to the parked promise and the **same live
   session** carries on.

Because the session stays open between requests, nothing is replayed and the
agent loop never learns that a tool round-trip crossed a network boundary.

## Requirements

- Bun 1.2 or newer
- A Claude Pro or Max subscription
- Claude Code credentials reachable by the process (see below)

## Quick start

```bash
bun install
cp .env.example .env   # set RELAY_API_KEY
bun run start
```

Or pull the published image, built for amd64 and arm64 on every push to `main`:

```bash
docker run --rm -p 8787:8787 --env-file .env ghcr.io/rinukkusu/anthropic-agent-sdk-relay:latest
```

```bash
curl http://127.0.0.1:8787/v1/messages -H "x-api-key: $RELAY_API_KEY" -H 'content-type: application/json' -d '{"model":"claude-sonnet-5","max_tokens":256,"messages":[{"role":"user","content":"pong?"}]}'
```

## Authentication

Two separate secrets are in play.

**Callers to the relay** present `RELAY_API_KEY` as `x-api-key` or
`Authorization: Bearer`. Set it. Without it the relay refuses to start, unless
you explicitly set `RELAY_ALLOW_ANONYMOUS=1`.

**The relay to Claude** uses Claude Code credentials, in the order the Agent SDK
resolves them:

- `CLAUDE_CODE_OAUTH_TOKEN`, generated with `claude setup-token` on a machine
  that is logged in. This is the option to use in Docker.
- A logged-in `~/.claude` on the host or mounted into the container. Note that
  a credential managed by the Claude desktop app refreshes through that app, so
  a copy of it can expire in a standalone container.
- `ANTHROPIC_API_KEY`, if you would rather pay API rates after all.

The relay strips the ambient `CLAUDE_CODE_*` variables from the subprocess
environment, so running it from inside a Claude Code session does not hand the
spawned CLI a session context that belongs to something else.

## Configuration

Everything is environment variables; see [.env.example](.env.example).

Model names are aliases. A request for a name in the table resolves to that
model with those built-in tools; any other name passes straight through to the
Agent SDK with no tools, so you can ask for a model the relay has never heard of.

| Alias | Model | Built-in tools |
| --- | --- | --- |
| `claude-opus-5` | `claude-opus-5` | none |
| `claude-sonnet-5` | `claude-sonnet-5` | none |
| `claude-haiku-4-5` | `claude-haiku-4-5` | none |
| `claude-opus-5-web` | `claude-opus-5` | `WebSearch`, `WebFetch` |
| `claude-sonnet-5-web` | `claude-sonnet-5` | `WebSearch`, `WebFetch` |

Replace the table with `RELAY_MODELS`. By default a relayed model is a plain
chat model: no filesystem, no shell, no project `CLAUDE.md`, no skills, and no
settings from disk.

## Using it from n8n

1. Run the relay on the same Docker network as n8n; see
   [compose.example.yml](compose.example.yml).
2. Create an Anthropic credential in n8n. API Key is your `RELAY_API_KEY`, and
   the Base URL is `http://relay:8787`.
3. Add an Anthropic Chat Model sub-node to an Agent node and pick a model from
   the table above.
4. Attach tools as usual.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/messages` | Streaming and non-streaming. Supports `tools`, `system`, images. |
| `GET` | `/v1/models` | The alias table, for model pickers. |
| `GET` | `/health` | Unauthenticated. Reports live session count. |

Known gaps: `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences` and
`tool_choice` are accepted and ignored, because the Agent SDK does not expose
them. Token counts come from the SDK's own accounting and are estimates.

Conversation history is replayed to a new session as a transcript in the opening
message, since a fresh Agent SDK session cannot have assistant turns injected
into it. Once a tool call is outstanding the live session carries real context.
The replay is append-only, one block per message with a cache breakpoint after
the newest, so each new turn reads the earlier ones from the prompt cache rather
than writing the whole conversation again. That only holds while the client's
history is append-only too: a memory window that drops the oldest messages, or a
system prompt that embeds the current time, starts the cache over on every turn.
Each finished turn logs its `cache_read` and `cache_write` token counts.

## Testing

```bash
bun test          # unit tests plus an integration test against a scripted SDK
bun run typecheck
```

`bun test` spends nothing. The end-to-end scripts do use the subscription:

```bash
bun run scripts/smoke.ts all     # basic, stream, tools
```

## A note on terms

Anthropic's Agent SDK documentation says third-party developers may not offer
claude.ai login or subscription rate limits to their own customers and end users
without prior approval. A private relay serving your own automation on your own
subscription is personal use, not that. Keep it off the public internet and keep
`RELAY_API_KEY` set.
