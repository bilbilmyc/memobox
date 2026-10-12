# memobox

Local long-term memory for AI coding agents. One command, one SQLite file,
zero servers — your agent remembers across sessions with a local database.
Keyword search and the built-in model run locally. If you configure a cloud
embedding endpoint, memory text and queries are sent there to compute vectors.

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
npm i -g memobox         # from npm — keyword retrieval works out of the box
```

Or run from source:

```bash
git clone https://github.com/bilbilmyc/memobox
cd memobox
bun install
bun src/cli.ts            # that's the whole binary — no server to start
```

Note: the 2.6.2 source tarball is about 52.9 kB; installed dependencies and Bun
add separate size. It includes no ML runtime. If you later enable the built-in lite model
(`memobox model enable --lite`), it will ask you to also run
`npm i -g @huggingface/transformers` (~25MB model downloads on first use).

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
memobox model reindex                # rebuild missing, incompatible or untracked legacy vectors using the current configuration

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

### 2.6.3 development: maintenance, scoped retrieval and performance

These features are implemented in the `2.6.3-dev.0` workspace, not published.
The npm latest release remains 2.6.2.

```bash
bun src/cli.ts update <id> "新的中文内容" --kind 决策 --entities 项目甲 --json
bun src/cli.ts update <id> --clear-entities
bun src/cli.ts search "端口" --entity 项目甲 --source cli --kind 决策 --since 7d --json
bun src/cli.ts search "端口" --entity 项目甲 --explain --json
bun src/cli.ts import backup.json --dry-run --json
bun src/cli.ts config show --json
bun src/cli.ts config set embedding.timeoutMs 5000
bun src/cli.ts config reset embedding.timeoutMs
```

Search applies AND scope filters before keyword/semantic ranking and graph
expansion. Use a full entity tag for a project. MCP adds `memory_get`,
`memory_update`, `memory_forget`, `memory_query`; `memory_search` supports the
same scope and structured results. MCP `since` uses Unix milliseconds.
Content edits refresh vectors; metadata edits retain them.

`search --explain` shows keyword/semantic ranks, scores, RRF contributions,
graph links and safe fallback reasons. With `--json`, it returns an object with
`memories` and `explanation`; default search JSON remains an array. MCP uses
`explain: true`. `import --dry-run` validates the backup and previews additions,
skips, duplicate IDs and conflicts through a read-only connection. It does not
create a database or load a model. Import keeps existing IDs and the first
occurrence within a backup; counts may change if other clients write later.

Configuration supports `embedding.base/model/key/local/dimensions/timeoutMs`.
Secrets are masked; `config set embedding.key --stdin` reads from standard input.
A full reset backs up the original file, including malformed JSON. Endpoint
timeouts default to 5000ms (100–120000ms configurable), with keyword fallback.
Model, dimensions and timeout settings apply to endpoint mode; lite uses its
fixed model and dimensions. Reset the other mode before switching. Restart MCP
after configuration changes and reindex when the vector model/dimensions change.

Functionality and performance are both release gates. See the
[development record](./docs/DEVELOPMENT-2.6.3.md) for measured results and unfinished
native distribution, diagnostics, restore previews and real-model evaluation.

### 2.6.2: CLI validation and Chinese output

Global `--version`, `--help/-h`, `--limit=1`, and the `--` text separator work.
Unknown options, missing values, invalid numbers and blank memories are rejected
before writes. Exit codes: 0 success, 1 execution failure, 2 argument error.
`forget` deletes directly; its unsupported `--dry-run` option is rejected.

Human tables, type/entity labels and error context are Chinese; JSON/MCP fields
remain stable. Chinese kind aliases map to the original English enums. Tables
use terminal column widths and preserve complete emoji when truncated. `--debug`
adds redacted technical details. See `memobox help model enable` for nested help.

Structured `query` filters the entire SQLite database before pagination, using
`--limit` and `--offset`. Reindex reports successes, skips and failures, returning
a nonzero code on failure. Installers forward explicit database/configuration,
dimension and model-source overrides; doctor reports their sources and flags
invalid legacy memories for manual review. No additional runtime dependency or
database migration is required. This release still requires Bun ≥ 1.4.

- **Storage**: single SQLite file at `~/.memobox/memobox.db`
  (`MEMOBOX_DB_PATH` to move it). No daemon, no port, no Postgres.
- **Cross-agent consistency**: saves, edits, deletes and individual imports are
  transactional. Database triggers maintain a shared memory revision; other MCP
  processes refresh their caches on their next search. Keyword ranking, semantic
  ranking and graph expansion read one snapshot. SQLite lock waiting coordinates
  concurrent startup and writes, with no additional service or dependency.
- **Retrieval** (v2.6): hybrid. BM25 keyword ranking (full-corpus index
  cached in-process, IDF over the whole library, exact-phrase boost,
  entity boost) fused with semantic cosine ranking via Reciprocal Rank
  Fusion — exact matches and paraphrases both surface. Entity-graph
  expansion tops up the result list. In semantic mode, vectors are stored
  as Float32 BLOBs (no JSON parsing) and cached in-process: warm searches
  measure ~5-8ms on a real 85-memory library.
- **Vector compatibility and relevance**: vectors carry a space fingerprint of
  their model, dimensions, endpoint and processing version. Only vectors from the
  same space and dimension are compared. Semantic candidates require cosine
  similarity ≥ 0.35; keyword matches remain independent. Metadata edits preserve
  vectors, while content edits recompute them. `model enable` rebuilds incompatible
  historical vectors; after manually changing an endpoint or model, run
  `memobox model reindex` and restart existing MCP clients to load the new config.
  Old databases gain the new field automatically without losing memories;
  untracked legacy vectors use keyword retrieval until rebuilt.
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
git switch -c codex/my-feature
bun run prepublishOnly
node scripts/release/package.mjs pack-and-test
```

Push the development branch and open a PR to `main`. Review the change and wait
for Windows/Linux CI (including installed CLI and two MCP processes) before
merging. Stable version bumps on `main` follow [automatic releases](./docs/AUTO-RELEASE.md).

MIT license.
