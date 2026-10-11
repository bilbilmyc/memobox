# memobox

自托管的 AI agent 长期记忆。**一个容器 = MCP 服务 + 治理后台 + Postgres（pgvector）。**

Agent 会忘事。memobox 给任何支持 MCP（Model Context Protocol）的客户端（Claude Code、
以及所有说这套协议的 IDE / agent）一个可持久写入、可随时召回的记忆——并自带治理后台，
让你能看见、能审计 agent 到底记住了什么。

[English docs](./README.md)

## 为什么是 memobox

- **MCP 优先。** 不是某人 API 的包装，而是一个独立的
  [Streamable HTTP](https://modelcontextprotocol.io) MCP 服务，暴露
  `memory_save` / `memory_search` 两个工具。
- **双部署模式。** *本地模式*：零依赖——Bun 内置的 `bun:sqlite`，一个进程 +
  一个文件。*服务端模式*：一条 `docker compose up`，Postgres +
  [pgvector](https://github.com/pgvector/pgvector)。两种模式都不需要 Redis、
  Neo4j 或任何额外组件。
- **可插拔 embedding。** 任何 OpenAI 兼容的 `/embeddings` 端点都能用
  （OpenAI、SiliconFlow `bge-m3`、Ollama……）。没配 key？自动降级为关键词检索，
  不会罢工。
- **治理后台。** 内置 `/admin`：浏览记忆、查看检索日志（agent 问过什么、
  召回了什么、耗时多少）——这是检索评测集的第一手原料，从 day 1 就开始积累。
- **Bun + Next.js 16** 驱动；单进程、小镜像。

## 快速开始

### 本地模式 —— 不用 Docker、不用 Postgres（需要 [Bun](https://bun.sh) ≥ 1.4）

```bash
git clone https://github.com/bilbilmyc/memobox && cd memobox
bun install
bun run build && bun run start
```

单进程跑在 **http://localhost:3100**；记忆落在一个 `./data/memobox.db`
文件里（`MEMOBOX_DB_PATH` 可挪位置）。

### 服务端模式 —— Docker Compose

```bash
docker compose up -d
```

会启动 Postgres（pgvector）、自动执行迁移，应用跑在 **http://localhost:3100**。

两种模式下都是：

- MCP 端点：`http://localhost:3100/mcp`
- 治理后台：`http://localhost:3100/admin` —— 首次登录
  `admin@memobox.local` / `ADMIN_PASSWORD`（默认 `memobox-dev`，**请到 `.env` 里改掉**）

### 接入 agent（以 Claude Code 为例）

```bash
claude mcp add --transport http memobox http://localhost:3100/mcp
```

然后直接说：*"记住我用 tab 不用空格"*，过会儿再问 *"你知道我的缩进偏好吗？"*
—— agent 会通过 `memory_save` / `memory_search` 持久化并召回记忆。

### 接入只支持 stdio 的客户端

有些客户端只会说 stdio 传输。`scripts/stdio-bridge.ts` 是零依赖的单文件适配器：
把 stdin 的每一行转发给 HTTP 端点，因此永远和服务端的工具集保持一致。客户端
机器上只需要装 Bun：

```bash
# 拷走这一个文件，指向你的服务
MEMOBOX_URL=http://your-server:3100 bun stdio-bridge.ts
# 服务端配了 MCP_TOKEN？同值传 MEMOBOX_TOKEN 即可：
MEMOBOX_URL=... MEMOBOX_TOKEN=... bun stdio-bridge.ts

# Claude Code 走 stdio：
claude mcp add memobox --env MEMOBOX_URL=http://your-server:3100 -- bun /path/to/stdio-bridge.ts
```

Codex CLI 用户：在 `~/.codex/config.toml` 里加——

```toml
[mcp_servers.memobox]
command = 'C:/Users/you/.bun/bin/bun.exe'
args = ['D:/path/to/memobox/scripts/stdio-bridge.ts']

[mcp_servers.memobox.env]
MEMOBOX_URL = "http://your-server:3100"
```


Codex / 其他 agent 不会自觉用记忆——把下面这段贴进 `AGENTS.md`（或系统提示）激活：

```markdown
## 长期记忆（memobox）

`memobox` MCP 服务给你跨会话的持久记忆。

- 需要项目上下文或过往决策时，先用关键词调 `memory_search` 检索。
- 学到持久事实——用户偏好、项目决定、踩过的坑——用 `memory_save` 存下
  （尽量带 entities 标签）。
- 别存一次性的琐事；存「未来会话会想知道」的东西。
```

### 备份与迁移

后台自带「备份」页：一键把全部记忆导出成单个 JSON 文件（向量不进备份——
导入时按当前 embedding 配置重算，文件因此可跨部署搬运），导入幂等——
id 已存在的条目跳过、绝不覆盖。从 SQLite 本地模式导出、再导入 Postgres
服务端模式（或反向），就把整个记忆库在两种部署形态之间搬了家。

## 配置

全部走环境变量（compose 读 `.env`，模板见 `.env.example`）：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `ADMIN_PASSWORD` | `memobox-dev` | 首次启动播种初始管理员（admin@memobox.local）；兜底充当会话密钥 |
| `ADMIN_EMAIL` | `admin@memobox.local` | 播种管理员的邮箱 |
| `BETTER_AUTH_SECRET` | — | 会话签名密钥——**公网部署务必设置**（`openssl rand -base64 32`） |
| `MEMOBOX_ENABLE_SIGNUP` | — | `1` = 开放自助注册管理员（默认关闭——单管理员是自托管常态） |
| `MCP_TOKEN` | — | 配了则 `/mcp` 要求 `Authorization: Bearer <同值>`——公网部署的防线 |
| `DATABASE_URL` | — | 配了 = 服务端模式（Postgres）；不配 = 本地模式（SQLite） |
| `MEMOBOX_DB_PATH` | `data/memobox.db` | SQLite 文件路径（本地模式） |
| `MEMOBOX_BACKEND` | — | `stub` = 内存演示模式，不落盘 |
| `APP_PORT` | `3100` | 应用容器映射到宿主机的端口 |
| `EMBEDDING_API_BASE` | — | OpenAI 兼容端点 base URL；不配 = 关键词检索 |
| `EMBEDDING_API_KEY` | — | embedding 端点的 API key |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | 模型名 |
| `EMBEDDING_DIM` | `1536` | 向量维度——**由首次迁移锁定**（服务端模式），只有全新库才能改 |

后台用邮箱 + 密码认证（开源 [Better Auth](https://better-auth.com)，账号和
记忆同库）：初始管理员由 `ADMIN_PASSWORD` 首次启动播种。自助注册**默认关闭**
——单管理员是自托管的常态；小团队共用记忆库才设 `MEMOBOX_ENABLE_SIGNUP=1`。

### Embedding 服务商

任何说 OpenAI `/embeddings` 方言的端点都可以：

| 服务商 | `EMBEDDING_API_BASE` | `EMBEDDING_MODEL` | `EMBEDDING_DIM` |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` | 1536（默认） |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `BAAI/bge-m3` | 1024（仅全新库） |
| Ollama（本机） | `http://host.docker.internal:11434/v1` | `nomic-embed-text` | 看模型卡片 |

写入时 embedding API 挂了？记忆照存（不带向量）；检索时 memobox 自动回退为
对最近若干条做关键词打分。可用性优先于聪明。

## 架构

```
MCP 客户端 ──HTTP──▶  Next.js 16（Bun 运行时，standalone）
                        │  ├── /mcp        JSON-RPC 2.0，无状态
                        │  ├── /admin      治理后台（多管理员，Better Auth）
                        │  └── /login      登录 / 注册
                        ▼
                   Postgres 17 + pgvector
                     memories ── query_log（评测集原料）
```

## 本地开发

需要 Bun ≥ 1.4 和 Docker：

```bash
docker compose up -d db   # Postgres + pgvector，端口 5433
bun install
bun run dev               # http://localhost:3100
bun test                  # 单测 + 集成（.env 配好后连真实 pgvector）
bun run build             # 生产构建（standalone）
```

## 路线图

- [x] v0.1 — MCP 端点、后台壳、schema、compose
- [x] v0.2 — Postgres 接线、检索日志、关键词检索
- [x] v0.3 — 可插拔 embedding、pgvector 语义检索、检索日志后台
- [x] v1.0 — Dockerfile（standalone、自动迁移）、中英双语文档
- [x] v1.1 — SQLite 本地模式（`bun:sqlite`、JS 余弦、零依赖）
- [x] v1.2 — 实体图谱检索、`memory_entities` 工具、后台编辑与遗忘、评测报表（p50/p95、零召回清单、CSV 导出）
- [x] v1.3 — 标注式检索基准：后台对查询结果标注相关/无关（含补标漏检），评测页出 recall@k 与 precision，CSV 导出带 `relevant_ids`
- [x] v1.4 — stdio 桥：给只支持 stdio 传输的客户端的零依赖单文件适配器（`scripts/stdio-bridge.ts`）
- [x] v1.5 — 管理后台认证（Better Auth，ADMIN_PASSWORD 播种首个管理员；注册默认关、`MEMOBOX_ENABLE_SIGNUP=1` 开团队模式）+ 可选 `MCP_TOKEN` 令牌认证（公网部署防线，桥与 registry 清单已带）
- [x] v1.6 — 备份与迁移：后台一键导出全部记忆为单 JSON 文件，幂等导入（已有 id 跳过）——也是 SQLite 本地模式 ↔ Postgres 服务端模式的整体搬家通道
- [ ] 待定 — 听用户的
