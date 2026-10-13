# GitHub main 自动发布 npm

发布策略：用户修改 `package.json` 版本号后提交到 `main`，新正式版本自动发布。
其他分支、PR、tag 不发布；已发布版本重复运行时跳过；`-dev/-beta/-rc` 等预发行版本跳过。

本任务的 context-map 已对照代码检查：

| 文件 | 职责与验证 |
| --- | --- |
| `.github/workflows/publish.yml` | main 推送、版本判定、源码回归、五平台原生/安装、质量/性能门禁、资产验证、OIDC 发布 |
| `scripts/release/plan.mjs` 与测试 | 公开的发布资格规则；main、仓库、正式版本、幂等与防版本回退 |
| `scripts/release/package.mjs` | 打包同一份 tarball，隔离 npm 安装后运行 CLI 和真实双进程 MCP |
| `bun.lock` | 与已有 package.json 的依赖分类保持一致，支持 frozen-lockfile |
| `.github/workflows/ci.yml` | main/PR 单测、类型检查、五平台发行物和 Product acceptance 总门禁 |

原生资产自带运行时并沿用同一 SQLite 实现；需要 GitHub `npm` 环境和 npm Trusted Publisher 的账户配置。
上述模块地图已审查，发布策略按用户确认采用手动升版本、自动发布。

## 自动发布流程

`main push → 判定版本 → 完整 CI（源码、五平台原生/无 Bun 安装、真实模型留出质量和磁盘 MCP 性能）→ 核对同一 tarball/资产 → GitHub Release → OIDC npm 发布 → 核对 latest/integrity/provenance → 公开 npm/GitHub 重装`。

- 主分支固定为 `main`，仓库固定为 `bilbilmyc/memobox`；没有 PR、tag 或其他分支的发布入口。
- 新正式版本必须大于 npm latest；已有版本跳过，registry 查询故障明确失败，不伪装成未发布。
- Linux/Windows 源码回归与五个平台原机验收全部通过。覆盖中文操作、真实模型与端点、配置/Pi 扩展、维护恢复、双 MCP、退出信号和无 Bun 的同一 npm tarball。Linux 另执行冻结留出集质量及 100/1000/10000 条磁盘 MCP 新旧对比，任何失败阻止发布。
- 发布阶段下载 npm-candidate 和五个平台资产，核对版本、commit SHA、tarball SHA-512、原生/压缩 SHA256 及各平台真实模型/端点/Pi 验收 receipt；不重新编译或打包。GitHub Release 先以 draft 上传，只补缺失资产，下载核对字节后公开；标签必须指向当前提交，已有冲突资产不能覆盖。
- 草稿通过带权限的 Release 列表查找（公开标签接口对草稿返回 404）。失败重跑复用同提交草稿；修复 PR 合并后，仅无标签且无附件的空草稿可更新到新提交，并重新读取确认。已有标签或附件的其他提交草稿继续拒绝，不自动覆盖。
- 发布串行执行，正式标签为 `latest`；发布前再核对版本，防止重复发布或把 latest 回退。registry 的版本、来源证明和 latest 可能分别延迟，最多查询 60 次、间隔 2 秒，只重试查询，不重试 publish；字节不符或权限错误仍立即失败。公开重装运行正常 postinstall，并核对官方 tarball 完整性和实际 CLI/MCP 产品流程。
- GitHub `npm` 环境只允许 `main` 类型为 branch 的规则；该环境不设置人工审批，因此合法新版本可以全自动发布。
- 只在发布 job 授予 `id-token: write`，使用短期 OIDC 身份，不设置 NPM_TOKEN。依赖安装及检查 job 没有发布身份权限。

## 一次性账号绑定

2026-10-12 已完成设备验证，npm CLI 确认 Trusted Publisher 创建成功。GitHub 环境限制已复核，仅允许 main 分支。绑定值如下：

| 设置 | 值 |
| --- | --- |
| Package | `memobox` |
| Provider | GitHub Actions |
| Organization / user | `bilbilmyc` |
| Repository | `memobox` |
| Workflow filename | `publish.yml`（只写文件名） |
| Environment | `npm` |
| Allowed action | 允许 `npm publish` 直接发布 |

以下命令供以后重建绑定时参考；当前绑定已完成，无需重复执行。可在 [npm 包设置](https://www.npmjs.com/package/memobox/access) 管理：

```bash
npm trust github memobox --repo bilbilmyc/memobox --file publish.yml --env npm --allow-publish --yes
```

npm 会要求管理员完成一次设备/2FA 验证；这是账户绑定，不是日后每次 CI 的发布流程。已有绑定时先查看，避免覆盖其他配置。

官方依据：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[npm trust](https://docs.npmjs.com/cli/v12/commands/npm-trust/)、[GitHub 环境分支限制](https://docs.github.com/en/rest/deployments/branch-policies)。

## 日常发版

功能和性能验收完成后，设置新的正式版本，例如：

```bash
npm version 2.6.3 --no-git-tag-version
git add package.json
git commit -m "release: prepare memobox 2.6.3"
git push origin HEAD
# 创建 PR；审查并等待 Windows/Linux CI 全绿后合并到 main
```

日常功能及发版准备均在开发分支完成，经 PR 测试/审查后合并到 main。`codex/**` 推送和面向 main 的 PR 会运行 Windows/Linux 源码与实际安装包验证。普通提交未升版本时，发布流程跳过；dev/beta 发行物只保存在 Actions artifacts，不进入 npm latest。

不要为测试流水线临时升正式版本或发布空壳版本。统一 beta 产品验收通过后才准备正式版本 PR；审查问题修复和 Product acceptance 全绿后合并。

## 本地验证

本次工作区：194 测试、897 次断言、TypeScript 检查通过；新增 4 个发布策略测试验证分支、仓库、开发版、幂等、版本回退和 registry 故障。actionlint 1.7.12 检查发布与现有 CI 通过。

`node scripts/release/package.mjs pack-and-test` 使用隔离配置和合成记忆，实际 tarball 安装后的 CLI 与双进程 MCP 验证通过。无需发布真实新版本即可重复运行。

GitHub 实际验证：[CI](https://github.com/bilbilmyc/memobox/actions/runs/38231920695) 通过，136 个测试、415 次断言、类型检查及 CLI 冒烟通过；[发布工作流](https://github.com/bilbilmyc/memobox/actions/runs/38231920678) 从 main 正确触发，并将已发布的 2.6.1 判为幂等跳过。GitHub 当前源代码与尚未提交的 2.6.3 开发工作区分别验收，不能混用测试数量。

npm 账号绑定已完成，正式 latest 仍为 2.6.2，本次没有发布新版本。第一个新正式版本的 OIDC 发布及 Linux/Windows 发行物矩阵将在版本号更新后的 main 推送中执行；现有绑定成功和跳过测试不代表该发布路径已实际运行。

## 2.6.3 完整门禁

2026-10-13 排查：10 月 12 日的两次 main 发布在 GitHub 资产阶段失败，尚未执行 npm OIDC 发布。[第一次](https://github.com/bilbilmyc/memobox/actions/runs/38268088759) 在新标签不存在时查询提交收到 422（已由 PR #3 修复）；[第二次](https://github.com/bilbilmyc/memobox/actions/runs/38270889197) 创建草稿后查询公开标签接口收到 404，留下无标签、无附件的草稿。本次补齐草稿查询与空草稿恢复行为回归。排查时 npm latest 为 2.6.2；本机 npm 登录过期不代表 CI 的 OIDC 绑定失效，实际联动仍需由新 main 发布工作流验证。

修复本地验证：222 项测试、1093 次断言和 TypeScript 检查通过；`pack-and-test` 的隔离安装、无外部 Bun 的 Node CLI、双 MCP 通过。本次只修改发行编排，不改检索/存储热点；完整质量和性能门禁由 PR/main CI 再执行。

2026-10-13 实际发行完成：[PR #4](https://github.com/bilbilmyc/memobox/pull/4) 合并到 `ca379c0` 后，[main CI](https://github.com/bilbilmyc/memobox/actions/runs/38357984526) 全绿，[发布流程](https://github.com/bilbilmyc/memobox/actions/runs/38357984842) 成功恢复草稿、公开 7 个资产，并通过 OIDC 发布 npm 2.6.3。官方 latest、tarball SHA-512 和来源证明已核对；工作流 Linux 与本机 Windows 均从公开 npm/GitHub 重装并通过实际 CLI/双 MCP/接线/Pi/端点验证。这两次公开重装未额外重跑可选本地模型（五个平台发行门禁已覆盖）。

该次发布第 2 次尝试暴露独立缺陷：`npm publish` 成功后，版本接口已可见，而完整包元数据的 latest 仍为 2.6.2；旧代码立即断言失败。第 3 次尝试按已发布版本幂等跳过上传并完成公开重装。后续修复把 latest/来源证明延迟纳入同一有界查询循环，并用真实故障响应顺序作回归，不需要再发新版本来测试。

CI 波动保留记录：PR #4 的分支验收曾测到 100 条端点写入 P95 136.99ms，原门槛重跑为 1.58ms（同提交 PR 为 2.99ms）；main 发布首次 Windows 批量导入用例超过默认 5 秒超时，同提交 main CI 为 101ms，重跑通过。没有放宽性能或测试门槛；这些波动的底层原因尚未定位。

开发版完整 CI [38265380668](https://github.com/bilbilmyc/memobox/actions/runs/38265380668) 的 15 项检查通过，包括五个平台真实可选模型、Node 安装及质量/性能。正式版本在最新 PR 和 main 发布工作流再次执行相同门禁。Trusted Publisher 保持原 publish.yml / npm 环境绑定，不需要长期 token。发行验收与原始数据见 [开发记录](./DEVELOPMENT-2.6.3.md)。
