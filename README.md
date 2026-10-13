# memobox

Local long-term memory for AI coding agents: one CLI, stdio MCP, and SQLite file. Keyword search works immediately. Optional local semantic inference or an OpenAI-compatible embedding endpoint adds hybrid BM25/cosine/RRF retrieval and entity-linked recall. No listening port or shared daemon.

[中文](README.zh-CN.md) · [Acceptance evidence](docs/DEVELOPMENT-2.6.3.md) · [Automatic releases](docs/AUTO-RELEASE.md)

## Install and connect

The 2.6.3 npm distribution requires **Node.js 22+**; no separate Bun installation:

```sh
npm install -g memobox
memobox save "Development uses port 3100" --entities project-a --kind decision
memobox search "development port" --entity project-a
memobox install claude
memobox install codex
memobox install pi
memobox doctor --json --strict
```

Restart the clients after installation. They share `~/.memobox/memobox.db`; `MEMOBOX_DB_PATH` selects another database. Claude uses `~/.claude.json`, Codex uses `~/.codex/config.toml`. Pi uses a generated, automatically discovered `extensions/memobox.js` adapter alongside `mcp.json`, since Pi does not natively read that MCP configuration. The adapter forwards `memobox_memory_*` tools to the same stdio server; no additional storage implementation or npm dependency. `PI_CODING_AGENT_DIR` is supported.

Installed entries use an absolute native executable path with empty args. `memobox install` prints the generic stdio entry. Installation is idempotent; after upgrades, `install <client> --force` backs up the complete original files and updates only memobox entries, preserving other settings. Restart clients afterward.

The npm package has zero production dependencies and downloads only your platform's native gzip from the same-version GitHub Release. Streamed SHA256 verification precedes atomic caching in `~/.memobox/bin/<version>/<platform>`. If install scripts are disabled, the first command performs the download. Supported and natively tested: Windows x64, Linux x64/arm64 (glibc), macOS x64/arm64. Windows download is approximately 39.3 MiB, executable 85.2 MiB; see manifests for other platforms. Alpine/musl and Windows arm64 are outside this release's platform set.

Standalone programs from [GitHub Releases](https://github.com/bilbilmyc/memobox/releases) run core CLI and stdio MCP without Node, npm, or Bun. Source development uses Bun 1.4.2: `bun install --frozen-lockfile`, then `bun src/cli.ts --help`.

## CLI workflow

Human output and help are Chinese. JSON fields and MCP descriptions are English.

```sh
memobox help
memobox help maintain plan
memobox query "port" --source me --limit 20 --offset 0 --json
memobox get <id>
memobox update <id> "Development now uses port 3200" --json
memobox search "port" --entity project-a --kind decision --explain --json
memobox forget <id>
memobox entities
memobox stats
memobox path
```

Scope filters use AND, before lexical/semantic ranking and graph expansion: exact kind/source/entity, plus `--since` date or Unix milliseconds. `query` scans the full filtered corpus with stable pagination and no embedding request. Updates retain ID/creation time; content changes invalidate old vectors while metadata-only edits preserve vectors. `search --json` remains an array; `--explain` adds actual ranks, RRF contributions, graph links and sanitized semantic fallback reasons.

Unicode content, paths, tags, emoji, Chinese kind aliases, `--flag=value` and `--` are supported. Invalid values/unknown options fail before mutations. Exit codes: 0 success, 2 argument error, 1 execution failure. Single-record `forget` directly deletes; batch deletion requires a maintenance preview.

```sh
memobox export backup.json
memobox import backup.json --dry-run --json
memobox import backup.json
memobox maintain scan --entity project-a --before 90d --json
memobox maintain plan --ids "<id1>,<id2>" --out plan.json
memobox maintain apply plan.json --yes --json
memobox restore <returned-backup-path> --dry-run --json
memobox restore <returned-backup-path> --yes --json
```

Import preserves existing IDs and commits the validated batch atomically. Maintenance suggests duplicates, possible numeric/negation conflicts and age candidates; suggestions do not establish invalid facts. Plans preview deletion, or consolidation with `--summary-file <UTF-8-file>`. The user/agent supplies summaries; memobox never silently calls an LLM. Consolidation retains the first ID/creation time, inherits omitted metadata and combines entity tags.

Apply requires confirmation, backs up original content/metadata, rejects stale targets and rolls back SQL failures. Restore changes only IDs present in the backup, backs up overwritten records first, and recomputes vectors with the current model. Backups contain neither vectors nor credentials. `import-codex --dry-run` previews idempotent Codex MEMORY.md migration. Development evaluation scripts generate separate quality and MCP performance reports; see the development record.

## Local retrieval feedback (2.6.4-dev.1 development build)

These commands are available in the source development build; npm latest remains 2.6.3.

```bash
memobox search "project port" --explain --json  # returns queryId
memobox eval recent --unlabeled --limit 20 --json
memobox eval show <query-id> --json
memobox eval label <query-id> <memory-id> relevant
memobox eval label <query-id> <memory-id> irrelevant
memobox eval unlabel <query-id> <memory-id>
memobox eval report --json
```

A relevant label can add a missed existing memory; an irrelevant label must refer to an originally returned memory. MCP clients use `memory_search` with `explain=true`, then `memory_feedback({queryId, memoryId, relevant: true/false/null})`; null removes a label. Feedback stays in local SQLite and does not train a model, change ranking, or upload data.

Reported recall uses only labeled relevant memories; precision uses only labeled returned items. Unjudged items are unknown, not negative, and these figures are not complete Recall@5/Precision@5. Logs retain original IDs/order; displayed memory text is current, and forgetting a memory removes its labels. Reading history/reports creates no searches.

## Optional semantic retrieval

```sh
memobox model enable --lite
memobox model status
memobox model reindex
memobox model disable
memobox config show --json
memobox config set embedding.base http://localhost:11434/v1
memobox config set embedding.model bge-m3
memobox config set embedding.dimensions 1024
memobox config set embedding.key --stdin
memobox config reset
```

Lite installs an optional pinned ML runtime into `~/.memobox/runtime`, then caches the approximately 25 MB public BGE q8 model in `~/.memobox/models`. It uses the executable's own runtime, without separately installed Bun/Node/npm. A per-client model helper exits with its owning CLI/MCP process; macOS Intel uses compatible ONNX runtime 1.23.2. Local inference sends no memories to a model service; first use downloads public weights. Default source: hf-mirror, then Hugging Face.

BGE uses normalized CLS pooling and query-only instruction encoding. **Upgrading from 2.6.2 lite requires `model reindex` to replace old mean-pooling vectors.** Content, IDs and timestamps remain. A bounded cache reuses recent query vectors, never retrieval results; external updates/deletions and scope changes remain visible. Failed inference falls back to keyword retrieval with explanations.

Without `--lite`, model enable detects/starts local Ollama, pulls a model, writes configuration and backfills vectors. Bring your own Ollama or compatible embeddings API. Endpoint mode sends saved content and queries to that endpoint. Restart MCP after model configuration changes. Precedence: environment > configuration file > keyword defaults.

| Environment | Purpose |
| --- | --- |
| `MEMOBOX_DB_PATH`, `MEMOBOX_CONFIG_PATH` | Database/configuration locations |
| `EMBEDDING_API_BASE`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL` | Compatible `/embeddings` endpoint, credential and model |
| `EMBEDDING_DIM`, `EMBEDDING_TIMEOUT_MS` | Dimension and 100–120000ms timeout |
| `MEMOBOX_RUNTIME_PATH`, `MEMOBOX_MODELS_PATH` | Optional runtime and public model cache |
| `HF_ENDPOINT` | Preferred public model download host |
| `MEMOBOX_BINARY_CACHE`, `MEMOBOX_DOWNLOAD_BASE` | Native cache and mirror, retaining manifest SHA256 verification |
| `MEMOBOX_BINARY_PATH` | Offline same-version executable; fully hash-verified on use |
| `PI_CODING_AGENT_DIR` | Pi configuration/extension directory |

Config keys: `embedding.base/model/key/local/dimensions/timeoutMs`. Writes are atomic; reset backs up the original. Credentials and URL credentials are masked. Doctor is read-only: integrity, corrupt/missing/incompatible vectors, dimension, configuration precedence and shared-client wiring. It neither migrates the database nor loads a model; strict diagnostics exit 1 when unhealthy.

## MCP tools

`memory_save`, `memory_search`, `memory_entities`, `memory_get`, `memory_update`, `memory_forget`, `memory_query`, `memory_maintenance_scan`, `memory_maintenance_plan`, `memory_maintenance_apply`. Tools use the same storage/validation rules as CLI. Maintenance apply requires `confirm: true`; schema annotations and structured outputs describe destructive operations and previews. MCP stdout contains JSON-RPC only; diagnostics use stderr.

## Troubleshooting and development

Download failures: check GitHub access, use a trusted `MEMOBOX_DOWNLOAD_BASE` mirror, or supply a manually downloaded same-version executable through `MEMOBOX_BINARY_PATH`. Hash mismatches refuse execution. Old client executable paths: run `install <client> --force`, then restart. Different memories across clients: compare doctor database/configuration paths and inherited environment. Missing semantic matches: inspect `search --explain --json`, doctor and reindex. Similarity is not a truth guarantee; review historical conflicts manually.

Use `codex/*` branches, behavior regressions, `bun run prepublishOnly`, and `node scripts/release/package.mjs pack-and-test`. Retrieval changes additionally require frozen heldout quality and genuine disk/MCP performance at 100/1000/10000 memories. Merge through PR only after complete product acceptance. A new stable version on main alone publishes through npm OIDC; beta candidates are tested as Actions artifacts and do not change npm latest. Publish reuses the exact tested tarball and all five native assets.

MIT License.
