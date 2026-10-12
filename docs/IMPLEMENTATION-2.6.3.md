# 2.6.3 剩余实现与验收地图

本次按统一路线完成剩余项，在 `codex/2.6.3-complete` 开发；功能、性能、原生平台及实际发行物全部通过后才合并/发布。地图已逐项对照现有源码自审。

| 模块 | 修改及依赖 | 公共行为验收 |
| --- | --- | --- |
| `src/cli/doctor.ts`、`src/lib/database-diagnostics.ts`、`src/install.ts` | 只读库完整性/向量/元数据检查，客户端同库及原生接线诊断 | CLI 中文/JSON，旧库不迁移、不写入；临时客户端配置接线 |
| `src/lib/maintenance.ts`、`src/db/sqlite-store.ts`、`src/lib/memory.ts` | 重复/过旧/潜在冲突建议；带内容指纹的预览，备份后原子批量删除/agent 压缩 | 预览不写入，错误整批回滚，外部修改后拒绝旧计划，两个 MCP 可见 |
| `src/cli/maintenance.ts`、`src/lib/mcp.ts` | 同一计划/执行契约，CLI --yes/MCP confirm 明确确认，自动备份 | CLI/MCP schema、未知参数拒绝、备份回导、压缩保留主编号 |
| `src/lib/memory.ts`、`src/db/sqlite-store.ts` | 稀有/常用词与冷启热点分析；无服务的轻量算法优化 | 固定中文/英文质量集及独立语义留出集，100/1000/10000 规模报告 |
| `src/runtime.ts`、`src/lib/local-embedder.ts`、模型管理 | 编译入口检测、按需外部 ML 加载、真实模型缓存/安装 | 源码与原生真模型、缺依赖/网络失败回退，诊断不加载模型 |
| `scripts/native/*`、`bin/memobox.js`、npm manifest | 同版本平台可执行包，Node 启动器、校验、离线安装及信号 | 无 Bun、中文路径、双 MCP、升级旧库、stdout 和退出码 |
| `.github/workflows/ci.yml`、`publish.yml`、发行脚本 | 所有目标原平台安装/协议/可选模型验证；复用已测制品自动发布 | Windows x64、Linux x64/arm64、macOS x64/arm64，PR 及 main 门禁 |
| 双语 README、路线和发行记录 | 首次安装、升级、平台体积/校验、模型及维护说明 | 按文档执行真实安装和客户端流程 |

风险：批量写入需要 SQLite 事务但不增加服务；新增 MemoryStore 方法需同步 StubStore/协议测试桩；原生发行带运行时会增大下载体积，按平台分发，不把 ONNX 放进基础包。测试只使用临时配置和合成/脱敏内容；真实旧库只在只读备份副本验收。

测试边界继续沿用已约定的 CLI、MemoryStore、MCP 协议、实际安装包/客户端进程。源码单测、模型质量、性能、平台安装、发布后 registry 验收分别保留证据。
