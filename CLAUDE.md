# memobox

给 AI 编程 agent 的本地长期记忆：**一个 CLI 工具 + stdio MCP 服务**，
SQLite 单文件存储，零服务、零端口、零依赖。

## 决策日志（2026-10-11 grilling 会话产物，改主意先改这里）

| 节点 | 决定 |
|---|---|
| 定位 | 认真做 + 业余维护，要有真实用户（Q9=b） |
| 市场 | 全球/GitHub 分发优先，中文文档做差异化（Q10=b） |
| 架构 | **v2.0 转向：纯 CLI 工具（Bun 单运行时）**。默认动作 = stdio MCP 服务；Postgres / Next Web 后台 / HTTP 端点 / Docker 全部移除（2026-10-11 Soren 拍板「pgsql 完全不要、不看管理后台、整体做成 cli 工具」） |
| 存储 | 仅 SQLite（bun:sqlite 内置，零依赖），默认 `~/.memobox/memobox.db`（`MEMOBOX_DB_PATH` 可改） |
| 客户端 | 首发三件套：Claude Code / Codex / pi（`memobox install <client>` 自动接线） |
| 检索 | BM25 关键词 + 语义余弦 RRF 混合（v2.6）+ 实体图谱扩展；语义为可选增强（内置小模型 / Ollama / 端点） |
| 分发 | npm 名 `memobox` 已确认空闲；bin 入口 `src/cli.ts`（`#!/usr/bin/env bun`，要求用户装 Bun） |
| 测试 | bun:test 单测（协议 / 存储 / 备份 / CLI / 安装器）+ 真 CLI 进程 e2e |
| 备选 | ②自托管转写/字幕工作台 = 下季度候选；③CC 生态中枢已否决 |

差异化护栏（对竞品 mem0/letta/codebase-memory-mcp）：本地零依赖、
一条命令接入三大客户端、图谱质量检索、备份/迁移、中文文档、评测集。

## 路线图

- v0.1–v1.0 ✅ HTTP MCP 服务 + Web 后台 + Postgres/pgvector 时代（详见 git 历史：单 Next 服务、DrizzleStore、落地页、Docker 发布）
- v1.1 ✅ SQLite 本地模式（bun:sqlite 零依赖 + JS 余弦，`DATABASE_URL` 双模式选择）
- v1.2 ✅ 图谱检索（save 同步 entity_nodes/edges，检索按共享实体补名额）+ MCP 工具 memory_entities + 后台编辑/遗忘
- v1.3 ✅ 标注式检索基准（eval_labels 表 + recall@k/precision）
- v1.4 ✅ stdio 桥（scripts/stdio-bridge.ts，stdin 逐行转发 HTTP /mcp）
- v1.5 ✅ 多管理员（Better Auth）+ MCP 令牌 + registry 物料
- v1.6 ✅ 备份与迁移（memobox-backup v1 单 JSON，幂等导入；向量不进备份可重算）
- v1.7 ✅ stdio 直连本地模式（scripts/mcp-local.ts 复用 handleRpcBody + SQLiteStore，无 HTTP/端口/pg）——v2.0 的直接前身
- v2.0 ✅ **CLI 转向**（2026-10-11 Soren 拍板）：整个产品 = `memobox` 命令。默认（无参数/`serve`）= stdio MCP 服务（吸收自 mcp-local.ts → src/mcp-server.ts）；人用子命令 `save/search/list/forget/stats/entities/path`；`export/import` 备份；`install claude|codex|pi` 自动写客户端配置（幂等）。存储只留 SQLite（默认 `~/.memobox/memobox.db`），删掉 Next/React/Better Auth/Postgres/Docker/pg schema 全家。**已知遗留**：旧 `data/memobox.db` 不自动迁移（用 `memobox import` 或直接拷贝）；npm 发布待 Soren 本人 `npm publish`
- v2.1 ✅ **CJK 关键词检索 + doctor 自检**（2026-10-11）：①修掉 v1.x 起的已知失效——`tokenize()`（src/lib/memory.ts）CJK 连续段切 bigram、拉丁部分按 `\p{L}\p{N}` 切，scoreMemories 与图谱锚点（sqlite-store search 的 anchors）都换用它，中文整句「端口有什么偏好」关键词模式即可命中；②`memobox doctor`——库文件/记忆数/检索模式 + 三家客户端接线探测（detectCodex/Pi/Claude 与安装器同判据；claude 查 `~/.claude.json` 的 mcpServers.memobox）。71 测试全绿。本机已由本人授权接线 Codex（`memobox install codex`）
- v2.2 ✅ **终端查询**（2026-10-11，Soren 要求「类似 sql 查询、全终端操作」）：①`memobox query [text] --kind/--entity/--source/--since/--limit/--json`——结构化 AND 过滤（--since 支持 7d/12h/30m 与 ISO 日期），renderTable 终端对齐表格（超宽截断，完整走 --json/get）；②`memobox sql "SELECT ..."`——bun:sqlite readonly 直开库文件透传 SQL（白名单 SELECT/WITH/PRAGMA，写语句拒绝）；③`memobox get <id>` 单条完整 JSON。79 测试全绿
- v2.3 ✅ **中文化 + 帮助体系 + Codex 记忆迁移**（2026-10-11，Soren 要求）：①CLI 全部人类输出改中文（命令规格表 COMMANDS 渲染总帮助；`help <命令>` 与任意命令 `--help` 给单命令帮助；MCP 协议内文案保持英文）；②`memobox import-codex`——解析 `~/.codex/memories/`（MEMORY.md 任务组 → 每任务一条 event，keywords 进 entities、状态尾缀保留；memory_summary.md 的 User Profile → 一条 preference），id = sha1(组名|标题) 前缀 `codex-`，重复导入幂等；--dry-run 预览。**Codex 的总结是现成的（会话结束 agent 自己写），迁移只做零 LLM 结构化重组**。本机已实迁 84 条（Soren 的 30 个任务组全量）+ 用户画像。88 测试全绿
- v2.3.1 ✅ **端点可选化 + 通用接法**（2026-10-11，Soren 问「mcp 工具还用接入 ai 端点吗？直接用 ai 工具自身不可以吗」）：①`EMBEDDING_API_KEY` 变可选——本地 Ollama（OpenAI 兼容、无鉴权）只设 `EMBEDDING_API_BASE` 即启用语义检索，无 key 时不送 authorization 头；②`memobox doctor` keyword 模式下自动探测本机 Ollama（`probeOllama`，500ms 超时，优先推荐 bge/m3/embed/gte 类模型），打印完整 env 提示——只提示不自动启用；runCli 第 4 参注入探测函数保测试确定性；③`memobox install` 无参数 = 打印任意 stdio MCP 客户端通用接法（command/args；env 只列键名防 KEY 泄漏）；④`.env.example` / README 双语改写：零配置优先 + 解释为什么不能借用 agent 自带模型（MCP 是被客户端拉起的子进程，协议无回调通道）。94 测试全绿
- v2.4.0 ✅ **本地小模型自管理（Soren 要求「像 CherryStudio 那样自己启动小模型，做成可配置项」）**：①`~/.memobox/config.json` 配置文件（src/lib/config.ts，MEMOBOX_CONFIG_PATH 可覆盖）——`createEmbedder()` 改为 env 优先、其次配置文件，**被客户端拉起的 MCP 服务也能拿到配置，不用重装客户端**；②`memobox model <status|enable|disable>`——enable 全链路：检测 Ollama（PATH 上 --version，ollama/ollama.exe 双名）→ 没起服务就后台 spawn `ollama serve` 并轮询端口（≤20s）→ 缺模型就 POST /api/pull 流式拉取（NDJSON 解析 + 进度节流）→ 写配置 → `backfillEmbeddings()` 补算存量向量（新加的 MemoryStore 接口方法；单条失败跳过、不动 updated_at）；disable 只删配置段（env 还配着会提醒它优先）；③doctor 的 Ollama 提示改为指向 `memobox model enable`，服务没跑但装了也给提示；④runCli 第 4 参改为 CliTools 注入对象（probeOllama/ollamaVersion/ensureServer/listModels/pull），测试零网络。110 测试全绿
- v2.5.0 ✅ **轻量化双管齐下（Soren：「有没有更轻量的方案，本身就是一个 mcp 现在越来越重了」→ 选定 1+2 一起做）**：①**BM25** 替换朴素命中计数（scoreMemories：k1=1.2 / b=0.75、候选集内 IDF、实体命中 ×1.5 加成、子串实体匹配保留）——零依赖，keyword 模式排序质量实质提升；②**内置小模型 `memobox model enable --lite`**——@huggingface/transformers@4.3.1（**动态 import**：keyword 模式进程完全不加载 transformers）+ Xenova/bge-small-zh-v1.5 q8（约 25MB、512 维、中英），缓存在 ~/.memobox/models，源 hf-mirror.com 优先、失败自动换 huggingface.co、HF_ENDPOINT 可覆盖；**Bun 1.4.2 实测 3-8ms/条**（先写探针脚本验证可行才接线）；③config.embedding 二态：base（端点）/ local（内置）；enable --lite 先预检（真加载模型 embed 一条自检，失败不写配置不留半启用状态）再写配置 + 补算；doctor 无 Ollama 时提示 --lite。**已在本机实启 lite：85 条全量补算，近义查询（「怎么装 jdk」→「Windows 开发环境与全量工具链升级」）命中，doctor=semantic**。120 测试全绿
- v2.6.0 ✅ **检索双路优化：BM25 全库索引 + RRF 混合融合 + BLOB 向量**（2026-10-11，Soren 要求「关键词 语义都要优化，看看找算法还是自己写算法」→ 全部自写、零新依赖）：①**KeywordIndex**（src/lib/memory.ts）——BM25 中间产物（tokenize/词频表/df/avgdl）缓存在进程内，save/forget/update/import 增量维护，砍掉旧「只搜最近 500 条」上限，IDF 升为全库口径；新增整句子串加成（查 id/精确串不被 bigram 稀释）；scoreMemories 改为现挖现建索引的薄封装（单一 BM25 实现防漂移）；②**RRF 混合检索**——语义模式下 BM25 与余弦两路排名 1/(60+rank) 倒数融合（旧版语义模式下关键词分完全丢弃），桩测试验证「关键词命中的与语义命中的都进榜」；③**向量存储 Float32 BLOB**（旧 JSON 文本启动时自动迁移，实测 85/85 转换）+ 进程内向量缓存（写路径增量维护，update 失效有桩测试防过期向量霸榜）；本机实测常驻进程热检索 5-8ms（冷启 245ms 含模型加载）。**评估过不引入的**：HNSW/ANN（个人规模 <1 万条全量扫描够快，引库不值）、int8 量化（JS 里 Float32Array 才有 SIMD 优化，int8 反而慢）。SQLiteStore 新增 close()（Windows 不关句柄锁库文件）。130 测试全绿
- v2.4+ 候选：npm 发布（待 Soren 注册 npm 账号）；memobox 自己的记忆压缩/摘要（需 LLM，或复用 Codex 式 agent 端总结）

## 约定

- **代码与配置的注释一律用中文**（Soren 要求）；**CLI 人类输出也用中文**（2026-10-11 v2.3 Soren 要求「我要的是 cli 工具，你支持中文」）；仅 agent 可见文案（MCP 工具 description、MCP 协议内消息）保持英文；README 双语
- 提交信息英文、里程碑制，尾行 `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## 常用命令

```bash
bun test                     # 全部单测
bun src/cli.ts               # stdio MCP 服务（同 memobox 无参数）
bun src/cli.ts save "..."    # 人用子命令
bun src/cli.ts install codex # 客户端接线
MEMOBOX_DB_PATH=x bun src/cli.ts stats   # 指定库文件
```

## 已知事项

- **transformers.js 的重量账（v2.5 实测）**：运行时惰性（keyword 模式进程零加载、MCP 冷启不变），但 node_modules ≈ 500MB——onnxruntime-node 294MB（transformers.node.mjs **静态 import，甩不掉**，是 3-8ms 推理速度的来源）+ onnxruntime-web 143MB；模型本体只有 25MB。bun 默认拦截 onnxruntime-node/protobufjs 的 postinstall（`bun pm untrusted` 可见），实测推理不受影响，异常时可 `bun pm trust onnxruntime-node`
- **node_modules 会有死重量**：v2.0 删依赖后 next/@next/lucide-react 残留了 360MB 无人清理——大改依赖后要 `rm -rf node_modules && bun install` 复核体积
- bun:sqlite 多语句 exec 在 patch 版本间有漂移（1.4.3 建表即崩过）——本机/CI 固定 bun 1.4.2 基线
- drizzle bun-sqlite 的 `.run()` 类型是 void（拿不到 changes）——「插没插进去」要 SELECT-then-insert（importMemories 的做法）
- 测试确定性：同毫秒连续 save 分不出先后，排序断言用显式 createdAt 造数
- **Windows Git Bash 里 curl -d 带中文 = GBK 灾难**（请求体按系统 ANSI 码页转码后才交给 curl）；往任何 HTTP 端点灌中文都要 python 写 UTF-8 文件 + `curl --data-binary @file`
- Claude Code 的 MCP 拉起参数里**不要用 ~ 或相对路径**——一律绝对路径（Windows 下 bun.exe 用正斜杠路径即可）
- **别直接改 `~/.codex/config.toml`**（Soren 的日常主力配置，权限敏感）——给片段让他自己贴，或走 `memobox install codex`（由用户本人执行）
- `memobox install claude` 依赖 `claude` CLI 在 PATH 上；没有时打印手动片段降级
- 旧部署的库文件在 `<repo>/data/memobox.db`，v2.0 默认路径改到 `~/.memobox/memobox.db`——不自动搬家（拷贝文件或 `memobox export/import` 均可，格式不变）
