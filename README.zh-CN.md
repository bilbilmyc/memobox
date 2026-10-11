# memobox

给 AI 编程 agent 的本地长期记忆。一个命令、一个 SQLite 文件、零服务——
agent 跨会话记住事情，数据永远不出本机。

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
git clone https://github.com/bilbilmyc/memobox
cd memobox
bun install
bun src/cli.ts            # 这就是全部——没有服务要启动
```

想全局可用：`bun link`（之后任何目录都能敲 `memobox`）。
发布到 npm 后可直接 `npm i -g memobox`。

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

- **存储**：单 SQLite 文件 `~/.memobox/memobox.db`（`MEMOBOX_DB_PATH` 可改）。
  无守护进程、无端口、无 Postgres。
- **检索**：实体图谱扩展常开；关键词打分 v2.5 起升级为 BM25
  （词频饱和 + 文档长度归一 + IDF + 实体加成），中文 bigram 天然适配；
  配了语义模式则走向量余弦。
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
bun test          # 120 个测试
bun run typecheck
```

MIT 协议。
