# 2.6.4 开发记录：本地检索反馈

基线：2.6.3 已通过 GitHub/npm OIDC 发布及公开重装。当前开发版本使用 `2.6.4-dev.1`，不发布到 npm latest。

本轮延续路线工作包 C 的持续使用验证：把已有 SQLite 检索日志和标注能力接到 CLI/MCP，记录误召回与漏召回，为下一轮独立评测收集证据。标注不自动训练模型、不修改排名、不上传内容，也不声称本轮已经改善召回率。

## Context Map

已对照源码、调用关系和测试自审，按下表实施。

| 文件 | 修改与依赖 |
| --- | --- |
| `src/lib/memory.ts`、`search-report.ts` | 明确日志详情契约，解释输出增加可选 queryId；保留普通 search 数组兼容 |
| `src/db/sqlite-store.ts` | 复用 query_log/eval_labels；事务校验标注对象；查询详情保留当时 ID 顺序，只加载涉及的记忆；队列 SQL 过滤 |
| `src/lib/memory-store.ts` | StubStore 支持同样的日志/标注语义，避免静默成功 |
| `src/cli/eval.ts`、`arguments.ts`、`cli.ts`、`search.ts` | eval recent/show/label/unlabel/report，中文帮助/输出及 JSON；参数校验先于存储 |
| `src/lib/feedback.ts`、`mcp.ts` | 统一反馈输入与错误；memory_feedback 用 queryId/memoryId/relevant 标注，null 撤销 |
| `src/feedback.product.test.ts`、`scripts/native/validate.mjs` | CLI/MCP/双连接、零命中、漏召回、改标、撤销、删除记忆、非法输入及发行物验收 |
| `README.md`、`README.zh-CN.md`、`ROADMAP.md`、`package.json` | 标明预发布功能及指标解释，更新已发布基线与待办 |

无需数据库迁移或新增依赖。保留历史查询的召回 ID，但详情显示当前仍存在的记忆文本；删除记忆仍级联删除它的标注，不保存额外正文快照。误召回标注必须指向当时返回的记忆；相关标注允许补充漏掉的现存记忆。指标仅统计人工标注样本，未知不算不相关。

## 验收门槛

- 回归覆盖真实临时 SQLite 的搜索→编号→标注→报告→撤销；CLI/MCP 共用同一行为。
- 无效参数先拒绝，不创建数据库；帮助不启动模型；日志/标注读取不新增查询日志。
- 实际独立程序和 npm tarball 测试新命令及两个 MCP 的反馈共享。
- `prepublishOnly`、`pack-and-test`、检索质量与 100/1000/10000 条磁盘 MCP 基准；记录结果与限制。
- 经审查和 Windows/Linux/五平台 CI 全绿合并，主分支再次确认；本轮保留开发版本。

## 本地验收结果

- 234 项测试、1190 次断言和 TypeScript 检查通过；新增反馈行为覆盖 SQLite/Stub、CLI/MCP、无效参数、未标注队列及历史编号/当前正文的区别。
- `pack-and-test` 通过：13,431 字节 npm 入口、0 生产依赖；实际安装、无 Bun CLI、新 eval 命令、双 MCP 跨进程反馈，以及生成的 Pi 扩展 boolean/null 标注透传。
- 冻结留出集四种检索方式的 112 个结果列表与 2.6.3 全部一致，未改排名。混合+图谱 Recall@5 83.33%、MRR@5 88.33%，无关问题有结果率仍为 50%；本轮没有解决既有漏召回/误匹配。
- Windows 100/1000/10000 条 × 关键词/端点/local 共 9 场景通过既有性能门禁。10000 条热检索最大 P95 分别为 10.85/19.08/12.27ms；相应写入 P95 为 9.29/22.00/31.02ms。完整对比摘要见 [验收数据](./perf/feedback-2.6.4.json)。基准为公开 2.6.2，与 2.6.3 的比较仅核对质量，不宣称相对 2.6.3 性能改善。
- 独立代码审查未发现阻塞问题。完整平台与合并验收以开发分支 PR 和 main CI 记录为准；保持 `2.6.4-dev.1`，正式 npm 仍是 2.6.3。

首次 PR Windows 包验收发现既有端点测试把正常保存/检索与故障注入共用 100ms 超时，造成一条记忆无向量，最终 doctor strict 拒绝。加入 200ms 正常响应延迟后稳定复现；现将健康请求设为正常 5000ms 预算，独立客户端保留 100ms 故障超时、3 秒内降级、2 条有效向量和 HTTP 请求数量断言。新增测试与独立审查通过，生产嵌入超时未修改。

同一首次提交的分支性能任务出现 4 个热查询 P95 超过 50ms（73.68–100.97ms），对应 PR 的完整性能门禁通过；保持原门槛，由修复提交重新验收。此性能波动不能归因于上述端点功能测试，底层原因仍未确定。

原始本地报告在 `artifacts/feedback-acceptance/`，由下列命令生成，全部使用临时库和合成记忆；CI 将同类原始报告上传为 acceptance-reports。

```bash
bun run prepublishOnly
node scripts/release/package.mjs pack-and-test
node scripts/run-acceptance.mjs artifacts/win32-x64/memobox.exe artifacts/feedback-acceptance
```
