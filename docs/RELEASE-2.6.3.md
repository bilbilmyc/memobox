# memobox 2.6.3

This release completes the unified CLI + SQLite roadmap. The npm package is a small Node 22+ launcher with no production npm dependencies; it downloads and SHA256-verifies only the current platform's standalone program. No separate Bun installation is required.

- Native Windows x64, Linux x64/arm64 and macOS x64/arm64: actual CLI, installed npm entry, endpoint retrieval, local q8 model, generated client wiring, sharing, maintenance/restore and termination checks.
- Complete update/forget/scope/explanations, read-only integrity/vector/client diagnostics, atomic configuration and installation upgrades with backups.
- Confirmed batch maintenance, stale-plan rejection, agent-supplied consolidation and selective restore. Atomic batch imports avoid per-record disk commits.
- BGE uses normalized CLS vectors and query instructions; bounded query-vector reuse reduces repeated inference without caching retrieval results.
- Frozen bilingual heldout quality and real disk/MCP benchmarks at 100/1000/10000 memories are release gates. The heldout set still includes unrelated-query false positives and semantic misses; similarity does not establish current factual correctness.

Upgrade lite installations with `memobox model reindex` to recompute incompatible 2.6.2 mean-pooling vectors. After npm upgrades run `memobox install <claude|codex|pi> --force`, then restart the client. pi installs an auto-discovered extension in addition to its MCP configuration. Existing memories retain IDs, content and creation timestamps.

Download the appropriate `.gz` and decompress it for standalone use. `manifest.json` contains executable/compressed sizes and hashes; `SHA256SUMS` lists gzip hashes. npm installation uses this exact manifest. See both READMEs for Chinese examples, offline installation, configuration, backup and recovery.

All source changes enter main through PR. Only a new stable main version publishes through npm OIDC, reusing the exact tested tarball and verified native release assets.
