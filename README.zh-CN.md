# memobox

给 AI 编程 agent 的本地长期记忆。一个命令、一个 SQLite 文件、零服务——
agent 跨会话记住事情，记忆保存在本机。默认关键词和内置模型在本机运行；
若配置云端嵌入端点，保存内容和查询会发送到该端点计算向量。

memobox = stdio MCP 服务 + CLI，开箱支持 **Claude Code、Codex、pi**。

```
你：  记住这个项目 dev 用 3100 端口
agent：（调用 memory_save）
……下周，新会话……
你：  dev 用哪个端口来着？
agent：（调用 memory_search）—— 3100
```

## 安装

需要 [Bun](https://bun.sh) ≥ 1.4。

```bash
npm i -g memobox         # 从 npm 安装——关键词检索开箱即用
```

或从源码运行：

```bash
git clone https://github.com/bilbilmyc/memobox
cd memobox
bun install
bun src/cli.ts            # 这就是全部——没有服务要启动
```

说明：2.6.2 的源码 tarball 约 52.9 kB，安装后依赖与 Bun 的体积另计，不带 ML 运行时。之后若启用内置
小模型（`memobox model enable --lite`），它会提示再执行
`npm i -g @huggingface/transformers`（首次使用时另下约 25MB 模型）。

## 接入你的 agent

一家一条命令（幂等，重复执行安全）：

```bash
memobox install claude   # 执行 claude mcp add --scope user memobox -- bun …/src/cli.ts
memobox install codex    # 往 ~/.codex/config.toml 追加 [mcp_servers.memobox]
memobox install pi       # 往 ~/.pi/agent/mcp.json 合并 mcpServers.memobox
```

写进三家配置的是同一个入口：`bun <路径>/src/cli.ts` 不带参数 = stdio MCP 服务。

其他任何 stdio MCP 客户端（Cursor、Windsurf、opencode……）：跑 `memobox install`
（不带参数）会打印通用接法——同一对 command + args 填进它的 MCP 配置即可。

<details>
<summary>手动片段（喜欢自己改配置的话）</summary>

**Codex** —— `~/.codex/config.toml`：

```toml
[mcp_servers.memobox]
command = 'C:\Users\you\.bun\bin\bun.exe'
args = ['D:\path\to\memobox\src\cli.ts']
```

**pi** —— `~/.pi/agent/mcp.json`：

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

**Claude Code**：

```bash
claude mcp add --scope user memobox -- bun D:/path/to/memobox/src/cli.ts
```

</details>

### 让 agent 真的用起来

agent 不会主动调记忆工具——在你的 `AGENTS.md` / `CLAUDE.md` 里加一段激活指令：

```markdown
- 记忆：已接入 memobox MCP 服务。
  - 当我表达偏好、决定或值得长期记住的事实时，用 memory_save 存入
    （相关的项目名/人名放进 entities）。
  - 反问我之前，先用 memory_search 查一下可能已经知道的事。
```

## 自己也能用

CLI 的人类输出全部是中文；数据与 MCP 协议文案保持原样。每条命令都支持 `--help`：

```bash
memobox help / memobox <命令> --help
```

```bash
memobox save "这个仓库用 tab 缩进" --entities style
memobox search "缩进"
memobox list / forget <id> / entities / stats / path
memobox doctor                       # 自检：库、检索模式、客户端接线（还会探测本机 Ollama）

# 语义检索一键启用（写 ~/.memobox/config.json，自动补算历史向量）
memobox model enable --lite   # 内置小模型：约 25MB 进程内推理，零外部依赖（推荐）
memobox model enable          # 或走本机 Ollama：bge-m3，能力更强（约 1.2GB）
memobox model reindex         # 按当前配置补算缺失、旧模型或旧库来源未知的向量

# 结构化过滤（条件 AND 组合），终端表格或 --json
memobox query "端口" --kind preference --entity ports --since 7d
memobox get <id>                     # 单条记忆完整 JSON

# 直连 SQLite 的只读 SQL
memobox sql "SELECT source, count(*) AS n FROM memories GROUP BY source"
memobox sql "SELECT content FROM memories WHERE kind = 'decision' LIMIT 5" --json

memobox export backup.json     # 全量备份（memobox-backup v1 格式）
memobox import backup.json     # 幂等导入——相同 id 自动跳过

# 迁移 Codex 原生记忆（~/.codex/memories/）进 memobox——
# 让 Claude Code / pi 也能检索到同一份；幂等，--dry-run 先预览
memobox import-codex
```

## 工作原理

### 2.6.3 开发版：完整操作与性能验收

以下是工作区 `2.6.3-dev.0` 已实现的能力，尚未发布到 npm；npm latest 仍为 2.6.2。

```bash
bun src/cli.ts update <id> "新端口 3200" --kind 决策 --entities 项目甲 --json
bun src/cli.ts update <id> --clear-entities
bun src/cli.ts search "端口" --entity 项目甲 --source cli --kind 决策 --since 7d --json
bun src/cli.ts search "端口" --entity 项目甲 --explain --json
bun src/cli.ts import backup.json --dry-run --json
bun src/cli.ts config show --json
bun src/cli.ts config set embedding.timeoutMs 5000
bun src/cli.ts config get embedding.base
bun src/cli.ts config reset embedding.timeoutMs
```

检索范围在关键词/语义排名和图谱扩展前生效，条件按 AND 组合；`--entity`
使用完整标签，项目可直接标为实体。MCP 新增 `memory_get`、`memory_update`、
`memory_forget`、`memory_query`；`memory_search` 支持相同范围及结构化结果，
`since` 用 Unix 毫秒。修改内容会更新向量；修改元数据保留向量。

`search --explain` 显示关键词/语义排名、分数、融合贡献、实体扩展和安全的降级原因。
加 `--json` 返回含 `memories` 与 `explanation` 的对象；普通检索 JSON 仍是数组。
MCP 使用 `explain: true`。`import --dry-run` 先校验备份，再通过只读连接预览新增、
跳过、备份内重复编号和冲突，不建库、不加载模型。正式导入保留当前或首条同编号记忆；
其他客户端在预览后写入时，实际计数可能变化。

配置支持 `embedding.base/model/key/local/dimensions/timeoutMs`。密钥默认脱敏，
用 `config set embedding.key --stdin` 从标准输入设置，避免进入命令参数历史。
全量 `config reset` 先备份原文件，坏 JSON 也保留原始字节。端点超时默认 5000ms，
可设置 100–120000ms；失败回退关键词。`dimensions`、`model` 和 `timeoutMs`
是端点模式设置，内置 lite 模式使用固定的模型与维度；切换模式先重置另一模式的设置。
修改模型配置后重启 MCP；向量模型/维度变化后运行 `model reindex`。

功能与性能共同验收；实现和实测边界见 [开发记录](./docs/DEVELOPMENT-2.6.3.md)。
免 Bun 分发、完整诊断、批量维护及真实模型质量验收仍在统一 2.6.3 范围中。

### 2.6.2：中文 CLI 和参数校验

`memobox --version`、`--help/-h`、`--limit=1` 和 `--` 文本分隔均可用。
未知选项、缺少值、非法数字及空白记忆在写入前拒绝。退出码：0 成功，
1 执行失败，2 参数错误。`forget` 直接删除，不支持 `--dry-run`，该选项会报错。

人用表格、类型、实体及错误提示为中文；JSON/MCP 字段保持稳定英文。
类型可用 `事实/偏好/事件/决策`，保存时映射为原英文枚举。表格按终端列宽
对齐，截断保留完整 emoji。`--debug` 可查看脱敏技术错误。

```bash
memobox help model enable
memobox query --json "开发端口" --kind 决策 --limit=20 --offset=0
memobox doctor
```

`query` 在 SQLite 全库过滤后分页，不再限制最新 2000 条。`model reindex`
报告成功、跳过和失败数量，有失败时非零退出。`install` 透传显式库、配置、
维度及模型源覆盖；`doctor` 显示配置来源，并提示需要人工检查的旧非法记忆。
数据库格式兼容现有版本，无新增运行依赖；本版本仍需 Bun ≥ 1.4。

- **存储**：单 SQLite 文件 `~/.memobox/memobox.db`（`MEMOBOX_DB_PATH` 可改）。
  无守护进程、无端口、无 Postgres。
- **跨 agent 一致性**：保存、编辑、遗忘和逐条导入使用事务；数据库触发器维护
  共享记忆版本，其他 MCP 进程下次检索自动刷新缓存。关键词、语义排名与实体
  扩展读取同一快照；并发启动和写入由 SQLite 锁等待协调，无新增服务或依赖。
- **检索（v2.6 混合式）**：BM25 关键词排名（进程内全库索引缓存、全库 IDF、
  整句加成、实体加成）与语义余弦排名经 RRF 倒数融合——精确匹配与近义改写
  都能上榜，互为补充；实体图谱扩展补满名额。语义模式下向量以 Float32 BLOB
  落库（免 JSON 解析）并缓存于进程内：真实 85 条库实测热检索约 5-8ms。
- **向量兼容与相关性**：向量记录模型、维度、端点与处理版本的空间指纹，
  只与同一空间、相同维度的查询向量比较。语义候选默认要求余弦相似度
  ≥ 0.35；关键词命中独立保留。修改分类或实体时保留向量，修改正文才重算。
  `model enable` 会补算不兼容的历史向量；手动切换端点或模型后可运行
  `memobox model reindex`，并重启已有 MCP 客户端让新模型配置生效。
  旧数据库自动补充字段并保留记忆，来源未知的旧向量在补算前仅参与关键词检索。
- **语义模式（可选增强）**：`memobox model enable --lite` = 内置量化小模型
  （bge-small-zh，约 25MB）进程内推理——无服务、无端口、无 Ollama，
  模型惰性加载（keyword 模式的进程不占任何资源）。
  `memobox model enable` = 本机 Ollama（bge-m3，能力更强）。
  也可手动设 `EMBEDDING_API_BASE` 与 `EMBEDDING_MODEL`
  （OpenAI、SiliconFlow 都行；`_KEY` 可选——本地端点免鉴权）。
- **为什么不能直接借用 agent 自带的大模型？** MCP 服务是被客户端拉起的子进程，
  协议里没有「回调客户端帮你算向量」的通道。语义检索需要的只是文本转向量——
  内置小模型在本进程里就能算。

## 开发

```bash
git switch -c codex/my-feature
bun run prepublishOnly
node scripts/release/package.mjs pack-and-test
```

推送开发分支并向 `main` 创建 PR；审查后等待 Windows/Linux CI（含实际安装包、中文 CLI
和两个 MCP 进程）全部通过再合并。主分支的新正式版本按 [自动发布规则](./docs/AUTO-RELEASE.md) 发布。

MIT 协议。
