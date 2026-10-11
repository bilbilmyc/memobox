# memobox

Self-hosted long-term memory for AI agents: MCP-first 服务，一个 Docker 容器 =
MCP server + Web 管理后台 + Postgres(pgvector)。

## 决策日志（2026-10-11 grilling 会话产物，改主意先改这里）

| 节点 | 决定 |
|---|---|
| 定位 | 认真做 + 业余维护，要有真实用户（Q9=b） |
| 市场 | 全球/GitHub 分发优先，中文文档做差异化（Q10=b） |
| 架构 | 单 Next 服务：Web 后台 + REST + MCP Streamable HTTP 全挂 route handlers；stdio 桥后补 |
| 检索 | MVP = pgvector + 实体标签；图谱表 schema 已预留（v1.1 实现）；**评测集 day 1 就建**（query_log 表） |
| 后台 | 同应用 /admin 路由组，单管理员（ADMIN_PASSWORD 环境变量口令） |
| ORM | Drizzle + drizzle-kit（postgres.js 驱动） |
| UI | shadcn/ui + Tailwind v4（shadcn 新 CLI 默认 Base UI 底座，非 Radix） |
| 测试 | bun:test 单测 + Playwright 关键路径 E2E |
| Bun | 全运行时 `bun --bun`；Docker 用 standalone 多阶段；**锁 Bun ≥1.4 + Next 16.x**，升级 Next 小版本先跑完整构建 |
| 备选 | ②自托管转写/字幕工作台 = 下季度候选（骨架可复用）；③CC 生态中枢已否决 |

差异化护栏（对竞品 mem0/letta/codebase-memory-mcp）：自托管体验（本地零依赖
SQLite / 服务端一条 docker compose）、图谱质量检索、治理后台（编辑/遗忘/来源
追溯）、中文文档、评测集。

## 路线图

- v0.1 ✅ 骨架：MCP POST-only stateless 端点（stub store）+ /admin 壳 + schema + compose
- v0.2 ✅ Postgres 接线：DrizzleStore（save/search/list/stats）+ query_log 逐查记录 + 关键词窗口检索（近 500 条打分）+ 协议逻辑抽离 `src/lib/mcp.ts`（13 测试全绿）
- v0.3 ✅ 可插拔 embedding（OpenAI 兼容 `/embeddings` 通吃：OpenAI/SiliconFlow bge-m3/Ollama；env `EMBEDDING_API_BASE/KEY/MODEL`，不配=关键词模式）+ pgvector cosine 语义检索（provider 挂了自动回退关键词、未嵌入行兜底关键词）+ /admin「最近检索」台账卡片（查询/命中/延迟）+ 版本 0.3.0（21 测试全绿）。**维度首次迁移已锁定 1536，改维度=破坏性迁移**，旋钮 `EMBEDDING_DIM` 留给全新部署
- v0.4 评测集报表（query_log → 标注 → 检索质量基准）
- v1.0 ✅ 发布闭环：Dockerfile 多阶段（bun standalone，启动自动迁移 `scripts/migrate.ts`）+ compose `app` 服务（depends_on db healthy、restart、healthcheck）+ README.md / README.zh-CN.md 双语。剩余：MCP 注册表提交（需 Soren 本人操作，见 docs/mcp-registry.md）
- v1.1 ✅ SQLite 本地模式（2026-10-11 Soren 提议）：`bun:sqlite` 零依赖 + JS 余弦（本地规模全表扫即可）+ 双模式选择（`DATABASE_URL` 有=Postgres 服务端模式，无=SQLite 本地模式，默认 `data/memobox.db`，`MEMOBOX_DB_PATH` 可改，`MEMOBOX_BACKEND=stub` 兜底）+ 内联幂等 DDL（无 drizzle-kit sqlite 迁移负担）（25 测试全绿，sqlite e2e 过）
- v1.2 ✅ 图谱检索 + 治理 + 评测：实体图谱扩展（save 同步 entity_nodes/edges，检索按「共享实体数」补满名额，直接落空时实体即检索入口）、新 MCP 工具 `memory_entities`、search 输出带实体标签、后台 `/admin/memories/[id]` 编辑/遗忘（改内容重算向量、改实体同步边、遗忘级联+清孤儿）、`/admin/eval` 评测报表（总量/零召回/p50/p95 + 实体 Top + 零召回清单 + CSV 导出）（34 测试全绿，全页面 e2e 过）
- v1.3 ✅ 标注式检索基准：`eval_labels` 表（查询×记忆×相关性）、后台 `/admin/eval/[id]` 标注视图（核对召回 + 补标漏检，走 `scoreMemories` 而非 `search()` 以免污染 query_log）、评测页 recall@k / precision 均值（recall 分母含漏检）、待标注队列、CSV `relevant_ids` 列（38 测试全绿，e2e 含 server action 真实标注往返）。踩坑：drizzle 在 select 列表把 `${col}` 渲染成裸列名，被相关子查询的内表同名列遮蔽（`eval_labels.id`），须显式写 `query_log.id`
- v1.4 ✅ stdio 桥：`scripts/stdio-bridge.ts` 零依赖单文件适配器（stdin 逐行 JSON-RPC → POST 转发 /mcp → stdout 回写；批量拆分重组、通知沉默、网络失败合成 -32603、坏行 -32700）；刻意自包含方便单文件分发，`import.meta.main` 守卫让单测可直接 import；`MEMOBOX_URL` 指向服务（45 测试全绿，e2e 真管道往返 + 断连路径过）
- v1.5 ✅ 多管理员 + MCP 令牌：引入开源 **Better Auth**（「先引入开源的别人的，再考虑自研」——2026-10-11 Soren 拍板），邮箱+密码、账号与记忆同库（pg 迁移 0002 / sqlite AUTH_TABLES_SQL）；ADMIN_PASSWORD 首启播种初始管理员（admin@memobox.local，老部署口令无缝迁移）；注册默认关（v1.6 后翻转，原来默认开+DISABLE 关；现 `MEMOBOX_ENABLE_SIGNUP=1` 才开团队模式，零用户引导态例外放行一次）；`MCP_TOKEN` 可选 Bearer 令牌护 /mcp（桥用同名 MEMOBOX_TOKEN）；registry 物料 `server.json` + `docs/mcp-registry.md`（51 测试全绿，e2e：播种→登录→新用户注册→CSV 401→令牌 401/200→桥降级）
- 发布就绪 ✅（v1.5 后的加固，协议版本不动）：容器链路全量复验（迁移自动应用→播种→登录→注册→CSV 鉴权→MCP 令牌→桥降级，全绿）+ **认证旁路封堵**（详见已知事项的 PPR 泄漏条目）+ store 惰性单例（Proxy，next build 收集页面数据不再真建库）+ Dockerfile 钉 `oven/bun:1.4.2` + LICENSE(MIT，版权行占位 bilbilmyc) + `.github/workflows/ci.yml`（bun test/build + main 分支推 GHCR）。52 测试全绿。仓库已推 https://github.com/bilbilmyc/memobox（main 分支）
- v1.6 ✅ 备份与迁移：后台 /admin/backup 一键导出全部记忆为单 JSON（格式 `memobox-backup` v1，`src/lib/backup.ts`；向量刻意不进备份——可重算且维度随部署变），导入幂等（id 已存在跳过不覆盖，上限 5 万条/64MB）；保留原 id/createdAt（迁移后引用不断），非 UUID id（stub 来源）导入 pg 时就地换新 UUID；实体边导入后重长。66 测试全绿，e2e 含真实 multipart 上传往返与坏文件报错。也是 SQLite↔pg 换模式的搬家通道。落地页改版（真实首用户反馈「不知道用处在哪儿」）：中文价值主张 + 三步接入卡 + 实时库统计（动态渲染）
- v1.6+ 候选：听用户反馈（可能方向：记忆压缩/摘要、更多检索策略）。已确认的真实痛点：**关键词模式对 CJK 查询基本失效**——scoreMemories 按空白切词，中文整句「端口有什么偏好」切成单 term 子串匹配必落空（语义模式无此问题）；修法方向：CJK 检测 + 字符 bigram 切词

## 约定

- **代码与配置的注释一律用中文**（2026-10-11 Soren 要求）；对外文案（MCP 工具 description 等 agent 可见面）保持英文
- 提交信息英文、里程碑制，尾行 `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## 常用命令

```bash
docker compose up -d        # pgvector @ localhost:5433
bun run dev                 # bun --bun next dev
bun run db:generate         # drizzle-kit 生成迁移
bun run db:migrate          # 应用迁移
bun test                    # bun:test
```

MCP 接入：`claude mcp add --transport http memobox http://localhost:3100/mcp`（dev 固定用 3100 端口——3000 在本机常被占用）

## 已知事项

- bun 拦了 sharp / unrs-resolver 的 postinstall（package.json ignoreScripts）——启用 next/image 优化前需 `bun pm trust` 它们
- TS 5.9.3（DeskLab 已用 TS 7，稳定后可跟进升级）
- landing 页 `/mcp` GET 返回 405 是有意的（无 SSE 通道，POST-only JSON 模式）
- dev 下 HMR 会存留旧 store 单例（globalThis 是刻意的 HMR-safe 设计）——改 MemoryStore 接口/类形状后必须重启 `bun run dev`，否则 /admin 500（v0.3 踩过）
- 本机没配 EMBEDDING_API_* 时 dev 走关键词模式；语义模式已用 fake embedder 对真实 pgvector 验证过（store.test.ts）
- **Turbopack standalone 会把服务端依赖打进 bundle**——`.next/standalone/node_modules` 里没有 drizzle-orm/postgres.js 可解析副本，Dockerfile 里从 deps 阶段 COPY 这两个包给 migrator 用（两者零运行时依赖）。踩过：容器 crash-loop `Cannot find module 'drizzle-orm/postgres-js'`
- dev server 和 compose app 共用宿主机 3100（APP_PORT 可改）——两者别同时起；当前姿势：`docker compose stop app` 后跑 `bun run dev`
- 本地想临时切 SQLite 模式 dev：`DATABASE_URL= bun run dev`（空串覆盖 .env；或干脆删 .env 里的 DATABASE_URL）；SQLite 库文件被 dev 进程锁住（WAL）属正常，停进程才能删
- 认证单例（globalThis.__memoboxAuth）与 store 同样的 HMR 坑——改 src/lib/auth.ts 后必须重启 dev
- Better Auth 的坑：① drizzle schema 自检要求四张表（user/session/account/verification）都传给 drizzle 实例，缺 verification 直接 SchemaMismatchError；② sqlite 时间列必须 `integer(..., { mode: "timestamp" })`，否则它传 Date 进 bun:sqlite 绑定报错；③ cookie 值是 `裸token.URL编码签名`，测试拿会话要 `asResponse: true` 从 set-cookie 取，不能直接用返回的 token
- Better Auth 兜底密钥顺序：BETTER_AUTH_SECRET → ADMIN_PASSWORD → 开发默认值；公网部署必须显式设 BETTER_AUTH_SECRET（README/.env.example 已注明）
- pg 的认证表名就叫 "user"/"session" 等（Better Auth 约定），drizzle 全程带引号没问题，别改名
- **layout 守卫拦不住数据泄漏（发布就绪期实测的严重坑）**：① 开 `cacheComponents`（PPR）时静态壳先流出去，layout 的 redirect 拿得到状态码却拦不住已发出的页面 RSC 数据块——匿名请求 200 拿到完整后台数据；② 即使关掉 PPR，App Router 的 layout 和 page 并行渲染，307 响应体仍带页面 flight chunk。**约定：每个 admin 页面组件第一行 `await requireAdmin()`，页面内每个 server action 也第一行过守卫**（action 是独立 POST 入口，progressive enhancement 下无需 JS 即可调用）。当前 next.config.ts 不开 cacheComponents/partialPrefetching（后者依赖前者），页面也不写 `export const instant`（同样依赖它）
- **store 单例必须惰性**：next build「Collecting page data」会真执行一次模块顶层代码，顶层 `new SQLiteStore()` 在无 .env 的构建容器里建库→首查崩。现用 ES Proxy 惰性代理 globalThis 上的实例；播种逻辑再加 NEXT_PHASE==="phase-production-build" 守卫（构建期 route handler 真跑一次，cookies() 会拒绝）
- **Dockerfile 钉 oven/bun:1.4.2 不是随手写的**：bun:sqlite 的多语句 exec 行为在 patch 版本间漂移（1.4.3 容器构建即触发 `no such table: main.eval_labels`），本地/容器/CI 三处必须同一条基线
- drizzle bun-sqlite 的 `.run()` 类型是 void（拿不到 changes/影响行数）——想知道「插没插进去」要么先 SELECT 再插（importMemories 的做法），要么 `.returning()`（pg 侧）
- pg 的 memories 主键是 uuid 列：任何「外部 id 直插 pg」的路径都要 UUID 校验+兜底换新（importMemories 的做法），否则 psql 直接报 invalid input syntax for type uuid
- server action 上传文件默认 body 上限 1MB——备份导入在 next.config.ts 里 `experimental.serverActions.bodySizeLimit: "64mb"`（页面侧另有 64MB/5 万条校验）。Next 16 此键仍属 experimental，构建会打 "Experiments" 提示，属预期
- 测试确定性两条：① 同毫秒连续 save 分不出先后，排序断言用显式 createdAt（importMemories 造数）；② pg 集成测试按 source=TAG 过滤会吃到其他 describe 的行，认 content 前缀更稳
- **Windows Git Bash 里 curl -d 带中文 = GBK 灾难**：shell 把请求体按系统 ANSI 码页（GBK）转码后才交给 curl，入库即乱码（v1.6 实际发生，用户看到满屏乱码）。往 /mcp 灌中文数据必须 python 写 UTF-8 文件 + `curl --data-binary @file`；验证手段：pg 里 `octet_length(content) ≈ 3 × char_length`（纯中文）
- 后台不是只读报表：总览带「检索试验」（走真实 search() 管线，含图谱扩展与 query_log）和「手动写入」（source=console）——人也能直接用记忆库，不必等 agent 接入（2026-10-11 用户反馈「web 上没什么可操作的」）
