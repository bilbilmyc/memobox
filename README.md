# memobox

Self-hosted long-term memory for AI agents. **One container = MCP server + admin console + Postgres (pgvector).**

Agents forget. memobox gives any MCP-capable client (Claude Code, and every
IDE/agent that speaks Model Context Protocol) a durable memory it can write to
and recall from — with a governance console so you can actually see and audit
what your agents remember.

[中文文档](./README.zh-CN.md)

## Why memobox

- **MCP-first.** Not a wrapper around someone's API — a standalone
  [Streamable HTTP](https://modelcontextprotocol.io) MCP server exposing
  `memory_save` / `memory_search`.
- **Two deployment modes.** *Local mode*: zero dependencies — SQLite via
  Bun's built-in `bun:sqlite`, one process + one file. *Server mode*: one
  `docker compose up` with Postgres + [pgvector](https://github.com/pgvector/pgvector).
  No Redis, no Neo4j, no extra moving parts either way.
- **Pluggable embeddings.** Any OpenAI-compatible `/embeddings` endpoint works
  (OpenAI, SiliconFlow `bge-m3`, Ollama, ...). No key configured? memobox
  degrades gracefully to keyword retrieval instead of breaking.
- **Governance console.** Built-in `/admin`: browse memories, inspect the
  query log (what agents asked, what they got, how fast) — the raw material
  for a retrieval eval set, from day one.
- **Bun + Next.js 16** under the hood; single process, tiny image.

## Quickstart

### Local mode — no Docker, no Postgres (needs [Bun](https://bun.sh) ≥ 1.4)

```bash
git clone https://github.com/bilbilmyc/memobox && cd memobox
bun install
bun run build && bun run start
```

Everything runs in one process on **http://localhost:3100**; memories are
persisted to `./data/memobox.db` (move it with `MEMOBOX_DB_PATH`).

### Server mode — Docker Compose

```bash
docker compose up -d
```

That starts Postgres (pgvector), applies migrations, and serves the app on
**http://localhost:3100**.

Either way:

- MCP endpoint: `http://localhost:3100/mcp`
- Admin console: `http://localhost:3100/admin` — first login
  `admin@memobox.local` / `ADMIN_PASSWORD` (default `memobox-dev`; **change
  it** in `.env`)

### Connect an agent (Claude Code)

```bash
claude mcp add --transport http memobox http://localhost:3100/mcp
```

Then just ask: *"Remember that I prefer tabs over spaces"* and later
*"What do you know about my formatting preferences?"* — the agent persists
and recalls via `memory_save` / `memory_search`.

### Connect a stdio-only client

Some clients only speak the stdio transport. `scripts/stdio-bridge.ts` is a
zero-dependency single-file adapter: it forwards each stdin line to the HTTP
endpoint, so it always matches the server's toolset. On the client machine
(all it needs is Bun):

```bash
# copy the one file, point it at your server
MEMOBOX_URL=http://your-server:3100 bun stdio-bridge.ts
# server set MCP_TOKEN? pass the same value:
MEMOBOX_URL=... MEMOBOX_TOKEN=... bun stdio-bridge.ts

# Claude Code via stdio:
claude mcp add memobox --env MEMOBOX_URL=http://your-server:3100 -- bun /path/to/stdio-bridge.ts
```

Codex CLI users: add this to `~/.codex/config.toml` —

```toml
[mcp_servers.memobox]
command = 'C:\Users\you\.bun\bin\bun.exe'
args = ['D:/path/to/memobox/scripts/stdio-bridge.ts']

[mcp_servers.memobox.env]
MEMOBOX_URL = "http://your-server:3100"
```

### Backup & migration

The console ships a **备份 (backup)** page: export every memory to a single
JSON file (vectors are recomputed on import, so the file stays portable), and
import one back idempotently — existing ids are skipped, never overwritten.
Export from SQLite local mode and import into Postgres server mode (or vice
versa) to move an entire store between deployment styles.

## Configuration

Everything is env-driven (`.env` for compose, see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | `memobox-dev` | Seeds the initial admin on first boot (email `admin@memobox.local`); also the fallback session-secret |
| `ADMIN_EMAIL` | `admin@memobox.local` | Email of the seeded initial admin |
| `BETTER_AUTH_SECRET` | — | Session signing key — **set it on public deployments** (`openssl rand -base64 32`) |
| `MEMOBOX_ENABLE_SIGNUP` | — | `1` = open self-serve admin registration (off by default — single admin is the self-hosted norm) |
| `MCP_TOKEN` | — | If set, `/mcp` requires `Authorization: Bearer <same value>` — protects the endpoint on public deploys |
| `DATABASE_URL` | — | Set = server mode (Postgres). Unset = local mode (SQLite) |
| `MEMOBOX_DB_PATH` | `data/memobox.db` | SQLite file path (local mode) |
| `MEMOBOX_BACKEND` | — | `stub` = in-memory demo store, nothing persisted |
| `APP_PORT` | `3100` | Host port for the app container |
| `EMBEDDING_API_BASE` | — | OpenAI-compatible base URL; unset = keyword retrieval |
| `EMBEDDING_API_KEY` | — | API key for the embedding endpoint |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Model name |
| `EMBEDDING_DIM` | `1536` | Vector dimensions — **locked by the first migration** (server mode), only changeable on a fresh database |

The console authenticates with email + password via open-source
[Better Auth](https://better-auth.com) (accounts live in the same database):
the first admin is seeded from `ADMIN_PASSWORD` on first boot. Registration is
**off by default** — single admin is the self-hosted norm; set
`MEMOBOX_ENABLE_SIGNUP=1` only when a small team shares one memory store.

### Embedding providers

Any endpoint speaking the OpenAI `/embeddings` dialect works:

| Provider | `EMBEDDING_API_BASE` | `EMBEDDING_MODEL` | `EMBEDDING_DIM` |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` | 1536 (default) |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `BAAI/bge-m3` | 1024 (fresh DB only) |
| Ollama (local) | `http://host.docker.internal:11434/v1` | `nomic-embed-text` | check model card |

If the embedding API is down at write time, memories are still saved
(un-embedded); at search time memobox falls back to keyword scoring over the
most recent rows. Availability over smartness.

## Architecture

```
MCP client ──HTTP──▶  Next.js 16 (Bun runtime, standalone)
                        │  ├── /mcp        JSON-RPC 2.0, stateless
                        │  ├── /admin      governance console
                        │  └── /login      multi-admin auth (Better Auth)
                        ▼
                   Postgres 17 + pgvector
                     memories ── query_log (eval-set groundwork)
```

## Development

Requires Bun ≥ 1.4 and Docker:

```bash
docker compose up -d db   # Postgres + pgvector on :5433
bun install
bun run dev               # http://localhost:3100
bun test                  # unit + integration (live pgvector when .env set)
bun run build             # production build (standalone)
```

## Roadmap

- [x] v0.1 — MCP endpoint, admin shell, schema, compose
- [x] v0.2 — Postgres wiring, query log, keyword retrieval
- [x] v0.3 — pluggable embeddings, pgvector semantic search, query-log console
- [x] v1.0 — Dockerfile (standalone, auto-migrations), bilingual docs
- [x] v1.1 — SQLite local mode (`bun:sqlite`, JS cosine, zero dependencies)
- [x] v1.2 — entity-graph retrieval, `memory_entities` tool, memory
      editing & forgetting in the console, eval report (p50/p95, zero-recall
      list, CSV export)
- [x] v1.3 — labeled retrieval benchmark: label query results as relevant or
      not (including missed hits) in the console, recall@k & precision on the
      eval page, `relevant_ids` in the CSV export
- [x] v1.4 — stdio bridge: zero-dependency single-file adapter for stdio-only
      clients (`scripts/stdio-bridge.ts`)
- [x] v1.5 — console auth via Better Auth (first admin seeded from
      `ADMIN_PASSWORD`; signup off by default, `MEMOBOX_ENABLE_SIGNUP=1`
      opens team mode), optional `MCP_TOKEN` bearer auth for public
      deployments (bridge + registry manifest included)
- [x] v1.6 — backup & migration: one-click JSON export of all memories in the
      console, idempotent import (existing ids skipped) — also the path for
      moving a store between SQLite local mode and Postgres server mode
- [ ] next — what users ask for
