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
| 检索 | JS 余弦语义检索（配 `EMBEDDING_API_*` 启用）+ 关键词回退 + 实体图谱扩展 |
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
- v2.2+ 候选：npm 发布（待 Soren 注册 npm 账号）；记忆压缩/摘要

## 约定

- **代码与配置的注释一律用中文**（Soren 要求）；对外文案（CLI 输出、MCP 工具 description、README）保持英文
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

- bun:sqlite 多语句 exec 在 patch 版本间有漂移（1.4.3 建表即崩过）——本机/CI 固定 bun 1.4.2 基线
- drizzle bun-sqlite 的 `.run()` 类型是 void（拿不到 changes）——「插没插进去」要 SELECT-then-insert（importMemories 的做法）
- 测试确定性：同毫秒连续 save 分不出先后，排序断言用显式 createdAt 造数
- **Windows Git Bash 里 curl -d 带中文 = GBK 灾难**（请求体按系统 ANSI 码页转码后才交给 curl）；往任何 HTTP 端点灌中文都要 python 写 UTF-8 文件 + `curl --data-binary @file`
- Claude Code 的 MCP 拉起参数里**不要用 ~ 或相对路径**——一律绝对路径（Windows 下 bun.exe 用正斜杠路径即可）
- **别直接改 `~/.codex/config.toml`**（Soren 的日常主力配置，权限敏感）——给片段让他自己贴，或走 `memobox install codex`（由用户本人执行）
- `memobox install claude` 依赖 `claude` CLI 在 PATH 上；没有时打印手动片段降级
- 旧部署的库文件在 `<repo>/data/memobox.db`，v2.0 默认路径改到 `~/.memobox/memobox.db`——不自动搬家（拷贝文件或 `memobox export/import` 均可，格式不变）
