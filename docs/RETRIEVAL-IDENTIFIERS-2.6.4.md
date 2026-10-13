# 2.6.4 技术标识符检索

基线为 main `5a51842`（2.6.4-dev.1），正式 npm 仍为 2.6.3。本轮保留预发布版本。

## Context Map

已对照调用关系自审；实现前记录如下。

| 文件 | 责任与修改 |
| --- | --- |
| `src/lib/memory.ts` | 共用切词、BM25 与实体匹配；保留完整标识符，同时索引组成词；拉丁匹配检查边界 |
| `src/db/sqlite-store.ts`、`src/lib/memory-store.ts` | 依赖共用 KeywordIndex；验证真实 SQLite、Stub、更新和删除后的缓存行为 |
| `src/lib/keyword-relevance.test.ts`、`src/lib/memory.test.ts` | 漏召回、词内误匹配、完整符号串、CJK 和实体复数兼容 |
| `scripts/fixtures/retrieval-identifiers.json` | 独立审查者编写新合成训练/留出集；先冻结再验收 |
| `scripts/embed-fixture.ts`、`scripts/quality-eval.ts` | 支持显式 fixture，默认原冻结集不变；同一真实向量比较修改前后 |
| 双语 README、ROADMAP、package.json | 开发状态、使用行为与明确限制 |

公共 CLI/MCP 契约、数据库结构和配置不变；无新增依赖。参考既有 CJK bigram、BM25 全库 IDF 和缓存增量维护；语义模型、阈值、RRF 与图谱规则不调参。

## 诊断与预定策略

修改前四个独立最小复现全部失败：自然空格查询找不到 `cache_invalidation` / `requestTimeout`；查询 `django` 命中 Go 实体，查询 `go` 命中 Django 正文。

1. 最可能的漏召回原因：小写化抹去驼峰边界，连接符把多个词合为一个 token。保留原串并增加结构化分词。
2. 最可能的误召回原因：实体和精确串加成使用任意 `includes`。改为拉丁词边界/组成词匹配，保留 CJK 子串和实体 port/ports 兼容。
3. 后续候选融合可能放大影响：不直接修改语义门槛，分别比较 BM25、semantic、RRF、hybrid+graph，记录尚存误召回。

## 验收约束

新语料训练/留出主题隔离；策略在打开留出结果之前固定。原 2.6.3 留出集只做回归，不能用于调参。使用同一真实 q8 向量比较本轮基线与候选，报告每例退化和局限；再跑既有完整质量/100–10000 条 MCP 性能门禁。修复只解决词法层缺陷，不宣称解决所有跨语言、语义和图谱噪声。

## 质量结果

独立审查者先编写新语料，未执行检索；SHA256（统一 LF）为 `c51eec64cf2bc334129931d5cabd80a135d88836fe87f46f51ad9ca04c302475`。训练与留出各 12 条合成记忆、16 个查询，其中各 4 个负例。先完成策略和训练验证，再打开留出结果；未据留出结果调参。两侧共享真实 BGE q8 文档/查询向量，模型、阈值和融合规则不变。

| 新留出集 | 基线 dev.1 | 候选 dev.2 |
| --- | --- | --- |
| BM25 Recall@5 / MRR@5 | 66.67% / 66.67% | 100% / 100% |
| RRF、混合+图谱 Recall@5 / MRR@5 | 75% / 75% | 100% / 100% |
| 混合+图谱 Precision@5 | 15% | 20% |
| 混合+图谱无关查询有结果 | 3/4 | 0/4 |
| 纯语义 Recall@5 | 58.33% | 58.33% |

Precision@5 分母固定为 5；本集每个正例只有一条相关记忆，20% 是该指标的上限，不能解读成返回项只有两成相关。训练集有同样的聚合数值，但主题、正文和查询不同。新增冻结集也进入关键词行为回归。

原冻结集四路共 112 个查询结果的召回/MRR 均无单例退化；最终混合+图谱 Recall@5 从 83.33% 升至 87.5%，MRR@5 从 88.33% 升至 89.93%，Precision@5 从 21.67% 升至 22.5%。原集合无关查询有结果率仍为 50%，纯语义结果不变。

局限：这是小型人工诊断集，不代表用户查询分布；没有证明复杂多义性、纯跨语言查询和图谱噪声已解决。ASCII 驼峰与缩写边界适用于常见代码标识符，不是通用语言形态分析；CJK 仍采用既有 bigram。实体 port/ports 仅保留简单尾 s 兼容，不是完整词形还原。

## 审查与可复现验收

独立审查发现并修复了单字中文实体反向包含退化和非 BMP Unicode 边界遗漏，均加入行为回归。真实 SQLite/Stub 覆盖范围过滤及更新删除后的缓存；原生发行物验收增加 CLI 保存、其他常驻 MCP 检索、更新后旧词消失与误匹配为空的流程。所有数据使用隔离的临时库。

新评测的原始数据在 `artifacts/identifiers/`，完整既有门禁在 `artifacts/identifiers-acceptance/`。性能门禁仍比较公开 2.6.2，不宣称相对 dev.1 或 2.6.3 的性能改善。

首次完整性能门禁发现 10000 条关键词写入 P95 31.82ms，超过当次基线 12.07ms 对应的 23.69ms 门槛。进一步用 30 次独立索引重建定位额外分配：dev.1 P50 52.84ms，初版候选 105.69ms。改为普通词快速路径、复用有界实体切词缓存（最多 128 个缓存入口）且不重复建立 CJK 实体 bigram 索引后，候选重建 P50 65.94ms；保留了新切词的额外成本，没有宣称微基准比基线更快。针对真实 MCP 失败场景的复测写入 P95 6.99ms，并发 P95 95.99ms。初次失败报告保存在 `artifacts/identifiers-acceptance/first-attempt/`；原门槛未放宽。

最终源码回归 243 项、1312 个断言及类型检查通过；实际 npm tarball 安装、独立程序和跨客户端检索验收通过。独立复审覆盖缓存淘汰、重复实体、增量更新删除与重建的一致性，无剩余阻塞问题。

优化后重新顺序运行新旧版本，100/1000/10000 条 × keyword/endpoint/local 九场景全部通过原质量与性能门禁。完整指标、逐例质量退化检查和基线来源见[验收数据](./perf/retrieval-identifiers-2.6.4.json)。平台证据为本地 Windows；Linux/macOS 与合并后的主分支状态以本轮 PR/CI 为准。

```bash
bun run prepublishOnly
node scripts/release/package.mjs pack-and-test
bun run scripts/embed-fixture.ts --fixture scripts/fixtures/retrieval-identifiers.json --split training --out artifacts/identifiers/vectors.json
bun run scripts/embed-fixture.ts --fixture scripts/fixtures/retrieval-identifiers.json --split heldout --out artifacts/identifiers/vectors.json
bun run scripts/quality-eval.ts --fixture scripts/fixtures/retrieval-identifiers.json --vectors artifacts/identifiers/vectors.json --split heldout --out artifacts/identifiers/heldout-candidate.json
# 同样命令附加 --package <5a51842 的源码目录>，使用同一份向量得到基线。
node scripts/run-acceptance.mjs artifacts/win32-x64/memobox.exe artifacts/identifiers-acceptance
```
