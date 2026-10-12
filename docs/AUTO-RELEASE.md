# GitHub main 自动发布 npm

发布策略：用户修改 `package.json` 版本号后提交到 `main`，新正式版本自动发布。
其他分支、PR、tag 不发布；已发布版本重复运行时跳过；`-dev/-beta/-rc` 等预发行版本跳过。

本任务的 context-map 已对照代码检查：

| 文件 | 职责与验证 |
| --- | --- |
| `.github/workflows/publish.yml` | main 推送、版本判定、Linux/Windows 检查、发行物验证、OIDC 发布 |
| `scripts/release/plan.mjs` 与测试 | 公开的发布资格规则；main、仓库、正式版本、幂等与防版本回退 |
| `scripts/release/package.mjs` | 打包同一份 tarball，隔离 npm 安装后运行 CLI 和真实双进程 MCP |
| `bun.lock` | 与已有 package.json 的依赖分类保持一致，支持 frozen-lockfile |
| `.github/workflows/ci.yml` | 保留普通 main/PR 的单测、类型检查及 CLI 冒烟 |

无运行时/API/数据库迁移；需要 GitHub `npm` 环境和 npm Trusted Publisher 的账户配置。
上述模块地图已审查，发布策略按用户确认采用手动升版本、自动发布。

## 自动发布流程

`main push → 判定版本 → Linux/Windows 单测与类型检查 → tarball 安装验证 → OIDC 发布 → 核对 npm latest/integrity`。

- 主分支固定为 `main`，仓库固定为 `bilbilmyc/memobox`；没有 PR、tag 或其他分支的发布入口。
- 新正式版本必须大于 npm latest；已有版本跳过，registry 查询故障明确失败，不伪装成未发布。
- Linux 与 Windows 都必须通过回归和实际包测试。测试覆盖中文保存/检索、版本、备份回导、两个长驻 MCP 双向共享以及 CLI 删除可见性。
- 发布阶段下载已验收的 Linux tarball，核对版本、commit SHA、SHA-512 和文件清单；不重新打包，也不运行打包后的生命周期脚本。
- 发布串行执行，正式标签为 `latest`；发布前再核对版本，防止重复发布或把 latest 回退。registry 入库延迟只重试查询，不重试 publish。
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
git push origin main
```

通过 feature 分支和 PR 合并到 main 也会触发相同流程。普通提交未升版本时，CI 仍检查代码，发布流程记录已发布版本并跳过。开发中的 `2.6.3-dev.0` 不会发布。

不要为测试流水线临时升正式版本或发布空壳版本。当前功能开发还需完成统一产品验收后，才能将 dev 改为正式版本。

## 本地验证

本次工作区：194 测试、897 次断言、TypeScript 检查通过；新增 4 个发布策略测试验证分支、仓库、开发版、幂等、版本回退和 registry 故障。actionlint 1.7.12 检查发布与现有 CI 通过。

`node scripts/release/package.mjs pack-and-test` 使用隔离配置和合成记忆，实际 tarball 安装后的 CLI 与双进程 MCP 验证通过。无需发布真实新版本即可重复运行。

GitHub 实际验证：[CI](https://github.com/bilbilmyc/memobox/actions/runs/38231920695) 通过，136 个测试、415 次断言、类型检查及 CLI 冒烟通过；[发布工作流](https://github.com/bilbilmyc/memobox/actions/runs/38231920678) 从 main 正确触发，并将已发布的 2.6.1 判为幂等跳过。GitHub 当前源代码与尚未提交的 2.6.3 开发工作区分别验收，不能混用测试数量。

npm 账号绑定已完成，正式 latest 仍为 2.6.2，本次没有发布新版本。第一个新正式版本的 OIDC 发布及 Linux/Windows 发行物矩阵将在版本号更新后的 main 推送中执行；现有绑定成功和跳过测试不代表该发布路径已实际运行。
