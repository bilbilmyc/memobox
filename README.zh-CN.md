# memobox

给 AI 编程 agent 的本地长期记忆：CLI + stdio MCP + 一个 SQLite 文件。默认关键词检索开箱即用；可选本机中文语义模型或 OpenAI 兼容嵌入端点。没有常驻服务、端口或第二套数据库实现。

[English](README.md) · [开发验收](docs/DEVELOPMENT-2.6.3.md) · [自动发布](docs/AUTO-RELEASE.md)

## 安装和第一次使用

2.6.3 的 npm 发行物需要 **Node.js 22+**，无需另装 Bun：

```bash
npm i -g memobox
memobox --version
memobox save "开发端口使用 3100" --kind 决策 --entities "项目甲" --source "我"
memobox search "开发端口" --entity "项目甲"
memobox doctor
```

npm 主包仅为轻量 Node 启动器，无生产 npm 依赖。安装时下载当前平台的同版本原生程序；禁用安装脚本时，第一次运行再下载。程序流式校验 SHA256 后原子缓存到 `~/.memobox/bin/<版本>/<平台>/`，后续启动复用缓存。Windows x64、Linux x64/arm64（glibc）、macOS x64/arm64 在原平台跑安装和实际 MCP 验证。Windows 原生 gzip 约 39.3 MiB，解压约 85.2 MiB；其他平台以发布清单为准。

也可从 [GitHub Releases](https://github.com/bilbilmyc/memobox/releases) 下载本平台 `.gz` 并解压，直接运行 `memobox` / `memobox.exe`，核心 CLI 和 MCP 连 Node/npm 也无需安装。Alpine/musl、Windows arm64 不在本版支持清单内。

源码开发才需要 Bun 1.4.2：`bun install --frozen-lockfile`，随后 `bun src/cli.ts --help`。

## 接入客户端并共享记忆

```bash
memobox install claude
memobox install codex
memobox install pi
```

重启客户端后，让 agent 保存一条项目偏好，再到另一个客户端检索。默认共用 `~/.memobox/memobox.db`；指定 `MEMOBOX_DB_PATH` 可切换库。安装时透传当前显式库、配置、模型环境变量。

- Claude 合并 `~/.claude.json`；Codex 合并 `~/.codex/config.toml`。
- pi 写入 `~/.pi/agent/mcp.json` 和 `extensions/memobox.js`。pi 不原生读取 MCP 配置，生成的扩展把 `memobox_memory_*` 工具转接到同一个 stdio MCP。支持 `PI_CODING_AGENT_DIR`。
- 原生接线为绝对程序路径 + 空 `args`。`memobox install` 输出通用 command/args，可供其他 stdio 客户端使用。
- 已有接线默认保持；升级版本后执行 `memobox install <客户端> --force`，先备份原文件，再更新自己的条目，保留其他模型和配置。pi 扩展也会备份。

`doctor --json --strict` 只读检查库完整性、向量有效性/空间/维度、配置来源及三家客户端同库接线；不会迁移旧库或加载模型。`--strict` 异常退出 1，修复提示为中文。

## 完整 CLI 流程

```bash
memobox help                     # 中文命令和参数帮助
memobox help maintain plan
memobox query "端口" --source "我" --limit 20 --offset 0 --json
memobox get <id>
memobox update <id> "开发端口改为 3200" --entities "项目甲" --json
memobox search "端口" --kind 决策 --source "我" --entity "项目甲" --explain --json
memobox forget <id>
memobox entities
memobox stats
memobox path
```

范围过滤为 AND；实体是完整标签，来源和类型精确匹配；`--since` 支持日期/毫秒时间戳。`search --json` 仍返回数组；加 `--explain` 返回记忆和实际关键词/语义排名、RRF 贡献、图谱扩展与安全降级原因。`query` 全库过滤和稳定分页，不调用语义模型。更新保留编号/创建时间；内容变化使旧向量失效，元数据更新保留向量。

支持中文内容、路径、实体、类型名、emoji 和 `--选项=值`。纯空白、未知选项、非法数字会在写入前拒绝。`--` 后按正文处理；退出码 0 成功、2 参数错误、1 操作失败。单条 `forget` 直接删除；批量操作使用以下预览流程。

## 检索改进与反馈（2.6.4-dev.2 开发版）

以下功能在源码开发版中；npm latest 仍是 2.6.3。

关键词检索保留 `cache_invalidation`、`requestTimeout`、`HTTPServer` 及点号/连字符名称的原串，并支持组成词查询，例如 `request timeout`。`go` 不再因位于 `Django` 内部而触发关键词命中。语义检索与图谱仍可能返回无关结果，详见[评测及限制](docs/RETRIEVAL-IDENTIFIERS-2.6.4.md)。

```bash
memobox search "项目端口" --explain --json   # 获取 queryId
memobox eval recent --unlabeled --limit 20 --json
memobox eval show <查询编号> --json
memobox eval label <查询编号> <记忆编号> 相关
memobox eval label <查询编号> <记忆编号> 不相关
memobox eval unlabel <查询编号> <记忆编号>
memobox eval report --json
```

相关标注可以补充漏掉的现存记忆；不相关标注必须是当时返回的记忆。标注保存在本地 SQLite，不上传、不调用模型、不自动改变排序。MCP 使用 `memory_search` 的 `explain=true` 取得 `queryId`，再调用 `memory_feedback({queryId, memoryId, relevant: true/false/null})`；null 撤销标注。

报告的召回率只以已标相关记忆为分母，精确率只以已标注召回项为分母；未标注不是不相关，也不能把它当作完整 Recall@5/Precision@5。日志保留当时召回编号，详情正文是当前内容；删除记忆会移除对应标注。读取日志和报告不会新增检索。

## 备份、维护和恢复

```bash
memobox export backup.json
memobox import backup.json --dry-run --json
memobox import backup.json       # 已有编号跳过，整批事务导入
memobox maintain scan --entity "项目甲" --before 90d --json
memobox maintain plan --ids "<id1>,<id2>" --out plan.json
memobox maintain apply plan.json --yes --json
memobox restore <返回的备份路径> --dry-run --json
memobox restore <返回的备份路径> --yes --json
```

`scan` 提供重复、可能的数字/否定冲突、年龄候选，建议不代表事实已失效。`plan` 默认预览删除；合并可传 `--summary-file <UTF-8文件>`，摘要由人或 agent 提供，工具不后台调用 LLM。合并保留首个编号及创建时间，未指定元数据沿用首条并合并实体。

`apply` 必须明确确认；执行前备份原文/元数据，快照已被别的进程修改时拒绝，SQL 或备份失败不会留下部分修改。`restore` 仅覆盖备份涉及的编号，覆盖前再备份，其他记忆保持；向量按当前模型重算。备份不包含向量或密钥。建议把备份放在独立安全位置。

`import-codex --dry-run` 可预览迁移 Codex 的 MEMORY.md；重复迁移幂等。开发评测脚本分别生成质量与 MCP 性能报告，操作和结果见开发记录。

## 可选语义模型和配置

```bash
memobox model enable --lite      # 安装可选运行库，下载约 25MB 模型，补算历史向量
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

内置 BGE 小模型按需安装到 `~/.memobox/runtime`，模型缓存到 `~/.memobox/models`。编译程序使用自身携带的运行时，不要求另外安装 Bun、Node 或 npm；模型助手随所属 CLI/MCP 退出。macOS Intel 使用兼容的 ONNX runtime 1.23.2。本机模式不把记忆发送给模型服务，首次下载仅获取公开模型文件；默认模型源为 hf-mirror，失败后回退 Hugging Face。

BGE 使用 CLS 池化、归一化和查询指令。**从 2.6.2 升级并使用 lite 时，需要 `model reindex` 重算旧 mean 向量**；记忆内容和编号保持。模型或端点失败时检索回退关键词，`--explain` 能看到原因。近期查询向量采用有界缓存；召回结果不缓存，外部更新、删除和范围过滤实时生效。

`model enable`（不带 lite）检测本机 Ollama、拉取模型、写配置并补算；端点模式需自行准备 Ollama 或兼容 API。端点模式会把保存内容/查询发给所配置端点。环境变量优先于文件，模型配置变化后重启 MCP。

| 环境变量 | 用途 |
| --- | --- |
| `MEMOBOX_DB_PATH` / `MEMOBOX_CONFIG_PATH` | 覆盖默认库和配置文件 |
| `EMBEDDING_API_BASE` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` | 兼容 `/embeddings` 端点、密钥、模型 |
| `EMBEDDING_DIM` / `EMBEDDING_TIMEOUT_MS` | 维度、请求超时（100–120000ms） |
| `MEMOBOX_RUNTIME_PATH` / `MEMOBOX_MODELS_PATH` | 可选 ML 运行库和公开模型缓存位置 |
| `HF_ENDPOINT` | 首选模型下载源 |
| `MEMOBOX_BINARY_CACHE` / `MEMOBOX_DOWNLOAD_BASE` | 原生缓存位置、镜像源；仍核对发行清单 SHA256 |
| `MEMOBOX_BINARY_PATH` | 离线原生程序路径；每次按清单核对 SHA256 |
| `PI_CODING_AGENT_DIR` | pi 配置/扩展目录 |

配置键：`embedding.base/model/key/local/dimensions/timeoutMs`。配置写入采用同目录原子替换；重置先备份；密钥和 URL 凭据默认脱敏。不要把包含密钥的配置提交到 Git。

## 常见问题

- **npm 安装还要 Bun？** 2.6.3 发行物无需 Bun；2.6.2 及更早源码包需要。npm 入口需要 Node 22+；独立程序的核心功能不需要 Node。
- **GitHub 下载失败？** 检查网络或设置 `MEMOBOX_DOWNLOAD_BASE` 镜像；也可从 Releases 手动取得同版本程序，用 `MEMOBOX_BINARY_PATH` 离线运行。校验失败会拒绝执行。
- **升级后客户端仍运行旧版？** 运行 `install <client> --force` 再重启；原生接线固化了版本对应的程序路径。
- **两家 agent 看不到同一条记忆？** 用 `doctor --json --strict` 比较显式库/配置路径，核对客户端启动时继承的环境。
- **语义没有结果？** 用 `search --explain --json` 和 `doctor` 检查模型空间及缺失向量，再 `model reindex`。语义相似度不代表事实正确，历史冲突应由用户/agent 审核。

## 开发与发行

在 `codex/*` 分支开发，补行为回归，运行 `bun run prepublishOnly` 和 `node scripts/release/package.mjs pack-and-test`。检索改动还需冻结留出集质量评测和真实 100/1000/10000 规模 MCP 性能验收。PR 的全部产品门禁通过才合并 main；只有 main 的新正式版本自动 OIDC 发布 npm。

beta 候选以 Actions 的 `npm-candidate` 和五个平台制品验收；预发布版本不更新 npm latest。正式发行的同一份已测试 tarball 与 SHA256 平台清单直接进入发布，不重新打包。

MIT License。
