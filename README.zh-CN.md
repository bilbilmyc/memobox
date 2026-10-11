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

```bash
memobox save "这个仓库用 tab 缩进" --entities style
memobox search "缩进"
memobox list / forget <id> / entities / stats / path
memobox doctor                       # 自检：库、检索模式、客户端接线状态
memobox export backup.json     # 全量备份（memobox-backup v1 格式）
memobox import backup.json     # 幂等导入——相同 id 自动跳过
```

## 工作原理

- **存储**：单 SQLite 文件 `~/.memobox/memobox.db`（`MEMOBOX_DB_PATH` 可改）。
  无守护进程、无端口、无 Postgres。
- **检索**：实体图谱扩展常开；配了 OpenAI 兼容端点就走语义检索（向量余弦），
  没配就关键词打分兜底（零配置可用）。
- **语义模式（可选）**：设 `EMBEDDING_API_BASE` / `_KEY` / `_MODEL`
  （OpenAI、SiliconFlow、Ollama 都行）。`memobox install` 会自动把这些
  透传进客户端配置。

## 开发

```bash
bun test          # 59 个测试
bun run typecheck
```

MIT 协议。
