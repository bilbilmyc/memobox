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
- **Postgres-only.** One `docker compose up`. No Redis, no Neo4j, no extra
  moving parts; embeddings live in [pgvector](https://github.com/pgvector/pgvector).
- **Pluggable embeddings.** Any OpenAI-compatible `/embeddings` endpoint works
  (OpenAI, SiliconFlow `bge-m3`, Ollama, ...). No key configured? memobox
  degrades gracefully to keyword retrieval instead of breaking.
- **Governance console.** Built-in `/admin`: browse memories, inspect the
  query log (what agents asked, what they got, how fast) — the raw material
  for a retrieval eval set, from day one.
- **Bun + Next.js 16** under the hood; single process, tiny image.

## Quickstart

```bash
git clone https://github.com/your-name/memobox && cd memobox
docker compose up -d
```

That starts Postgres (pgvector), applies migrations, and serves the app on
**http://localhost:3100**.

- MCP endpoint: `http://localhost:3100/mcp`
- Admin console: `http://localhost:3100/admin` — password from
  `ADMIN_PASSWORD` (default `memobox-dev`; **change it** in `.env`)

### Connect an agent (Claude Code)

```bash
claude mcp add --transport http memobox http://localhost:3100/mcp
```

Then just ask: *"Remember that I prefer tabs over spaces"* and later
*"What do you know about my formatting preferences?"* — the agent persists
and recalls via `memory_save` / `memory_search`.

## Configuration

Everything is env-driven (`.env` for compose, see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | `memobox-dev` | Password for the single-admin console |
| `APP_PORT` | `3100` | Host port for the app container |
| `EMBEDDING_API_BASE` | — | OpenAI-compatible base URL; unset = keyword retrieval |
| `EMBEDDING_API_KEY` | — | API key for the embedding endpoint |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Model name |
| `EMBEDDING_DIM` | `1536` | Vector dimensions — **locked by the first migration**, only changeable on a fresh database |

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
                        │  └── /login      single-admin password
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
- [ ] v1.1 — graph retrieval (`entity_nodes` / `memory_entity_edges`), memory
      editing & forgetting in the console, retrieval eval report
