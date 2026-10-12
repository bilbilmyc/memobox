# memobox 2.6.2 发布验收

日期：2026-10-12。状态：已发布至 npm，latest 为 2.6.2；registry 的 integrity 与已验收 tarball 一致，重新安装验收全部通过。

## 修复范围

- 单一参数规格驱动校验和中文帮助；修复版本参数、等号赋值、布尔选项、文本分隔符和未知选项。所有参数错误在存储/模型操作前拒绝，退出码为 2。
- CLI、MCP、保存、更新及整批导入共用内容/类型校验，禁止新增纯空白记录。doctor 提示旧库中的非法记录及手动修复步骤，不自动清理。
- 中文表头、类型、实体标签、模式、模型进度、错误和环境变量说明；表格按终端列宽对齐、按字素截断。JSON/MCP 字段保持英文兼容，调试输出隐藏密钥和 URL 凭据。
- 安装器透传库/配置路径、模型、维度和下载源；TOML 支持中文、空格和单引号路径。doctor 显示实际来源及配置优先级。
- 结构化 query 下推 SQLite，覆盖全库并支持 offset 分页；补算报告检查、待算、成功、跳过和失败数，失败返回非零退出码。
- 拆分 CLI 参数、展示和模型模块，CLI 与 MCP 版本取自 package.json。

架构仍是 CLI + stdio MCP + SQLite；无新增生产依赖、Web 服务或数据库服务。本版本仍需要 Bun ≥ 1.4。按最新路线，免 Bun 分发、记忆维护与检索评测统一归入 2.6.3，见 [开发路线](../ROADMAP.md)。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `npm run prepublishOnly` | 177 项测试通过，0 失败；751 次断言；TypeScript 检查通过 |
| 待发布 tarball 的隔离 npm 安装 | 3 个包，包含 memobox、Drizzle、Zod；无模型运行库 |
| 安装包的真实 CLI 场景 | 87/87 通过；覆盖中文命令、错误退出码、备份、2002 条全库过滤、模型补算和运行时要求 |
| 安装包的真实双进程 MCP | 4/4 通过；178 次断言；覆盖关键词/混合检索、预热、并发保存、外部删除，以及实际生成的 Codex 配置 |
| 85 条现有真实记忆的隔离副本 | 查询/检索通过；原库和副本的内容、元数据校验值均保持一致 |
| Windows npm 生成的 `memobox.cmd --version` | 输出 2.6.2 |
| tarball 内容检查 | 27 个文件，无测试、用户库、密钥、配置或模型缓存 |
| 官方 registry 重新安装 | 独立缓存与 prefix 安装；87/87 CLI 场景、4/4 双进程测试通过 |

混合检索的自动测试使用确定性的本地嵌入端点；真实记忆副本本次验证关键词检索。此前真实模型补算结果不作为本次新测试的替代证据。

## 发布包

- 文件：`memobox-2.6.2.tgz`
- 压缩体积：52,898 字节；解包体积：151,946 字节。
- SHA-256：`3d579ba0add908a05252ccf2d73ef47017934a77bda612de6824762e3fb9a332`
- npm integrity：`sha512-UFkPUeBq1VPYfeibQezZbsAy0tq9ZEq/ZBkLYel3U4tPzOxVmHYBfw725byTyABN4rwJN7XLMxPVGIrwi7vk3Q==`

已完成设备验证，并发布同一份已验收 tarball。npm latest/integrity 已核对，官方 registry 重新安装及复测全部通过。包页面：https://www.npmjs.com/package/memobox/v/2.6.2
