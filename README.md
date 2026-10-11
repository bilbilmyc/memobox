# memobox

Local long-term memory for AI coding agents. One command, one SQLite file,
zero servers — your agent remembers across sessions, and the data never
leaves your machine.

memobox is an MCP server (stdio) and a CLI in one. Works with
**Claude Code, Codex, and pi** out of the box.

```
you:  remember that this project uses port 3100 in dev
agent: (calls memory_save)
…next week, new session…
you:  which port do I use in dev?
agent: (calls memory_search) — 3100
```

## Install

Requires [Bun](https://bun.sh) ≥ 1.4.

```bash
git clone https://github.com/bilbilmyc/memobox
cd memobox
bun install
bun src/cli.ts            # that's the whole binary — no server to start
```

Optionally make it global: `bun link` (then `memobox` works anywhere).
`npm i -g memobox` once published to npm.

## Wire up your agent

One command per client (idempotent — safe to re-run):

```bash
memobox install claude   # runs: claude mcp add --scope user memobox -- bun …/src/cli.ts
memobox install codex    # appends [mcp_servers.memobox] to ~/.codex/config.toml
memobox install pi       # merges mcpServers.memobox into ~/.pi/agent/mcp.json
```

The entry written for every client is the same: `bun <path>/src/cli.ts`
with no arguments — that runs the stdio MCP server.

Any other stdio MCP client (Cursor, Windsurf, opencode…): run `memobox install`
with no arguments — it prints the universal command + args to paste into that
client's MCP config.

<details>
<summary>Manual snippets (if you prefer editing configs yourself)</summary>

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.memobox]
command = 'C:\Users\you\.bun\bin\bun.exe'
args = ['D:\path\to\memobox\src\cli.ts']
```

**pi** — `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "memobox": {
      "command": "bun",
      "args": ["D:/path/to/memobox/src/cli.ts"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add --scope user memobox -- bun D:/path/to/memobox/src/cli.ts
```

</details>

### Make the agent actually use it

Agents don't call memory tools unprompted — add an activation line to your
`AGENTS.md` / `CLAUDE.md`:

```markdown
- Memory: a memobox MCP server is available.
  - When I state a preference, decision, or durable fact, save it with
    memory_save (include project/person names as entities when relevant).
  - Before asking me something you might already know, try memory_search.
```

## Use it yourself

Human-facing CLI output is in Chinese (the author is a Chinese speaker);
data and MCP protocol text stay as-is. Every command supports `--help`:

```bash
memobox help / memobox <command> --help
```

```bash
memobox save "prefer tabs in this repo" --entities style
memobox search "tabs"
memobox list / forget <id> / entities / stats / path
memobox doctor                       # health check: db, retrieval, wiring (also detects local Ollama)

# one-command semantic search (writes ~/.memobox/config.json, backfills vectors)
memobox model enable --lite          # built-in small model: ~25MB in-process, zero external deps (recommended)
memobox model enable                 # or local Ollama: bge-m3, stronger (~1.2GB)

# structured filter (AND-combined), terminal table or --json
memobox query "port" --kind preference --entity ports --since 7d
memobox get <id>                     # one memory, full JSON

# raw read-only SQL over the SQLite database
memobox sql "SELECT source, count(*) AS n FROM memories GROUP BY source"
memobox sql "SELECT content FROM memories WHERE kind = 'decision' LIMIT 5" --json

memobox export backup.json     # full backup (memobox-backup v1 format)
memobox import backup.json     # idempotent — same ids are skipped

# migrate Codex's native memories (~/.codex/memories/) into memobox
# so Claude Code / pi can recall them too — idempotent, --dry-run previews
memobox import-codex
```

## How it works

- **Storage**: single SQLite file at `~/.memobox/memobox.db`
  (`MEMOBOX_DB_PATH` to move it). No daemon, no port, no Postgres.
- **Retrieval**: entity-graph expansion always on; keyword scoring upgraded
  to BM25 in v2.5 (term-frequency saturation, document-length normalization,
  IDF, entity boost) with CJK bigram tokenization; semantic mode adds cosine
  over embeddings.
- **Semantic mode (optional upgrade)**: `memobox model enable --lite` =
  built-in quantized small model (bge-small-zh, ~25MB) running in-process —
  no server, no port, no Ollama; the model is lazily loaded (keyword-mode
  processes pay nothing). `memobox model enable` = local Ollama (bge-m3,
  stronger). Or set `EMBEDDING_API_BASE` / `EMBEDDING_MODEL` manually
  (OpenAI, SiliconFlow…; `_KEY` optional — local endpoints need none).
- **Why can't it reuse the agent's own model?** An MCP server is a child
  process spawned by the client; the protocol has no channel to call back
  into the client's model. Semantic search only needs text→vector math —
  the built-in small model computes it right inside the process.

## Development

```bash
bun test          # 120 tests
bun run typecheck
```

MIT license.
