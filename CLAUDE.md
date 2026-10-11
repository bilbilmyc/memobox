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

差异化护栏（对竞品 mem0/letta/codebase-memory-mcp）：自托管体验（一条
docker compose）、图谱质量检索、治理后台（编辑/遗忘/来源追溯）、中文文档、评测集。

## 路线图

- v0.1 ✅ 骨架：MCP POST-only stateless 端点（stub store）+ /admin 壳 + schema + compose
- v0.2 ✅ Postgres 接线：DrizzleStore（save/search/list/stats）+ query_log 逐查记录 + 关键词窗口检索（近 500 条打分）+ 协议逻辑抽离 `src/lib/mcp.ts`（13 测试全绿）
- v0.3 embedding provider（**维度首次迁移已锁定 1536，改维度=破坏性迁移**，旋钮 `EMBEDDING_DIM` 留给全新部署）+ pgvector 语义检索替换关键词窗口 + 评测集报表（query_log → 标注 → 检索质量基准）
- v1.0 发布闭环：Dockerfile standalone、README 中英、MCP 注册表提交
- v1.1 图谱检索（entity_nodes / memory_entity_edges 启用）

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
