# memobox 2.6.1 CLI 中文与可用性审查

日期：2026-10-12（Asia/Shanghai）。对象：从 npm 下载的 memobox@2.6.1，Windows x64、Bun 1.4.2。审查操作使用临时中文用户目录、临时数据库和配置，不写入日常记忆库或真实客户端配置。

## 结论

中文文本保存、关键词检索、中文实体/来源过滤、含空格的中文文件路径、正常备份回导、Codex 记忆迁移都可用。19 个顶层命令均有中文说明。

当前版本不能称为“完整中文且所有选项可靠”：专项审查 86 个场景中 65 个符合预期、21 个不符合预期；这些失败场景包含同一根因的多个表现，不代表 21 个独立缺陷。另做了终端宽度、emoji 截断、TOML 路径转义三个定向探针。已有 146 个测试和类型检查全部通过，说明现有测试未覆盖这些边界。

本轮完成审查和开发规划，未修改生产实现、升级版本或再次发布 npm。原始结果的精简副本见 [cli-audit-evidence.json](./cli-audit-evidence.json)。

## npm 安装为什么仍然需要 Bun

当前 package.json 的 bin 指向 bin/memobox.js，其首行是 `#!/usr/bin/env bun`。入口继续加载 TypeScript，并使用 bun:sqlite 和 Bun.spawn；npm 安装生成命令入口，不会把 Bun 运行时编进包或自动安装 Bun。因此，当前发行版仍要求 Bun ≥ 1.4。

“CLI”描述交互方式，与“是否需要运行时”是两件事。npm 可以分发脚本，也可以分发原生程序。参考 [npm bin 文档](https://docs.npmjs.com/cli/v12/configuring-npm/package-json/#bin)。

本机当前 PATH 中没有全局 memobox；本次检查使用隔离安装后的真实包入口，也验证了 Windows 的 memobox.cmd。去掉 PATH 中的 Bun 后，该命令不能运行，符合当前发行版的运行时要求。

## 命令和选项覆盖

命令、参数标识和 JSON/MCP 字段保持稳定英文是合理设计；人类可见的说明、表头、错误和枚举展示需要中文。不要翻译用户自定义 SQL 列名或机器协议字段。

| 命令 | 已有选项/参数 | 实测结果与限制 |
|---|---|---|
| serve / 无参数 | --help | 帮助中文；无参数启动 stdio MCP；在真人终端仍进入等待协议状态 |
| save | 文本、--kind、--entities、--source | 中文内容/emoji/实体/来源保存正确；空白内容和任意 kind 会被接受 |
| search | 查询、--limit | 中文整句检索正常；entities 标签仍英文；limit 缺值/非法值未拒绝 |
| list | --limit | 中文内容正常；负数 limit 未拒绝；等号形式未正确识别 |
| query | 文本、--kind、--entity、--source、--since、--limit、--json | 正常组合过滤通过；布尔选项可能吞文本；表头英文；只扫描最新 2000 条 |
| get | id | 完整 JSON 的中文和 emoji 保真；字段名英文属于机器输出 |
| sql | SQL、--json | 中文结果和写语句拒绝通过；SQL 语法错误直接显示英文 |
| forget | id | 正常删除中文提示；未知选项不拒绝，--dry-run 被忽略并实际删除 |
| entities | --limit | 中文实体名称与计数正常；limit 的校验缺口同类 |
| stats | 无 | 中文统计正常 |
| path | 无 | 自定义中文带空格数据库路径正常 |
| doctor | 无 | 中文主说明正常；keyword/semantic 原始模式名仍英文；不验证模型实际可用性 |
| model status | 无 | 主说明中文；模式名仍英文 |
| model enable | --model、--lite | 既有注入测试覆盖 Ollama 链路；npm 包缺 lite 依赖时中文安装提示正常；本次不安装/拉取真实模型 |
| model disable | 无 | 仅测试临时配置，状态和停用提示正常 |
| model reindex | 无 | 真进程配本地嵌入桩成功补算，重复为零；端点全部失败仍返回退出码 0 |
| export | 文件路径 | 正常中文路径导出通过；文件写入失败直接显示 fatal/ENOENT 英文 |
| import | 文件路径 | 正常备份回导、中文保真、重复导入跳过通过；自身保存的空白内容导出后无法回导 |
| import-codex | --file、--dry-run | 中文 fixture 预览、迁移和幂等通过；不读取用户原生记忆 |
| install | claude / codex / pi 或无参数 | 通用接法正常；自定义库/配置/维度不透传；含单引号的路径生成非法 TOML |
| version | 子命令、-v | 两种通过；--version 失效 |
| help | 命令、--help、-h | 19 个顶层命令中文说明通过；嵌套 model 帮助不够具体；未知命令带 --help 成功退出 |

说明：Ollama 启动/拉模型和三家客户端的真实在线安装未在本轮执行；安装器已有纯函数/临时目录测试通过。真实双 MCP 进程的共享回归包含在 146 个测试中。语义补算使用确定性本地嵌入桩，不代表新增真实模型准确率评测。

## 优先修复的实际问题

### P1：统一参数解析及校验

定位：src/cli.ts:116、181、195、210、405、577。

- `memobox --version`：被解析为普通旗标，没有位置参数，于是进入 serve。实测 stdout 没版本号、stderr 为 MCP 就绪提示，并创建测试数据库。交互式 stdin 会继续等待。
- `memobox query --json 开发端口`：--json 把“开发端口”当成自己的值，查询文本丢失，返回无过滤结果。
- `--limit=1` 被当成旗标名“limit=1”，不限制为一条；缺值、负数、非数字和拼错的旗标不报错。
- `save -- --literal` 不能保存以 -- 开头的文本。
- 未知选项在写命令中同样被忽略。`forget <测试id> --dry-run` 实际删除了测试记忆。当前 forget 并不声明支持 dry-run；问题是遇到未知选项应拒绝，不能继续执行删除。
- --kind 的取值直接进入存储，没有统一枚举验证。

建议：命令规格统一声明位置参数、布尔/值选项、别名、枚举、默认值、数字上下界；据此解析、校验和生成帮助。先复用 Node 标准库 util.parseArgs，再在本项目内做命令级语义校验，不为此引入框架依赖。所有校验发生在建库/写入之前。退出码建议参数错误 2、执行失败 1、成功 0。

### P1：空白记忆破坏备份回导

定位：src/cli.ts:195、src/lib/mcp.ts 保存参数、src/db/sqlite-store.ts:321、src/lib/backup.ts 内容验证。

`save "   "` 成功，但导出后 import 会以“第 1 条记忆缺少 content”拒绝该备份。需要在共享存储入口统一禁止纯空白内容，覆盖 CLI、MCP 和导入；为已有空白记录提供可审查的修复方式，保留备份。

### P1：客户端接线遗漏配置来源

定位：src/install.ts:30、40。

PASSTHROUGH_ENV 只包含 EMBEDDING_API_BASE、KEY、MODEL。MEMOBOX_DB_PATH、MEMOBOX_CONFIG_PATH、EMBEDDING_DIM 及显式 HF_ENDPOINT 没被记录到接线配置。CLI 指向自定义库或模型配置时，独立启动的 MCP 可能回到默认库/默认配置，导致“同机不同记忆”。

需要透传这些显式覆盖值；doctor 显示实际库和配置来源，并核对接线条目。敏感值不回显。现有同库缓存共享测试仍然有效，但不覆盖安装器把客户端接到不同库这一层。

### P1：结构化查询遗漏旧记录

定位：src/cli.ts:418。

query 先 list(2000)，然后在内存中过滤。2002 条 fixture 中，最早的唯一旧记忆能被 search 找到，query 却返回 []。应把过滤条件和 limit 下推 SQLite，显式提供分页；保证全库查询语义与 search 一致。

### P1：补算失败仍被视为成功

定位：src/db/sqlite-store.ts:679、706，src/cli.ts:294。

本地测试嵌入端点全部返回 HTTP 500 时，reindex 打印“已补算 0 条”，退出码仍为 0，无法区分“不需要补算”和“全部失败”。应报告检查/需要补算/尝试/成功/跳过/失败数量，明确失败退出码，支持中断和重试，保留既有内容与向量指纹保护。

### P2：中文呈现与帮助仍有遗漏

定位：src/cli.ts:76、105、135、140、432、481、616，bin/memobox.js:19，src/lib/ollama.ts:formatPullStatus。

- query 人用表头为 id/created/kind/entities/source/content；实体展示为 entities:；类型和检索模式也直接显示英文枚举。
- SQL 和文件写入的异常直接展示英文；应增加中文上下文与修复建议，原始技术错误只在调试模式展开。
- model enable --help 只返回 model 总览，没有该子命令的选项说明、示例、默认值、下载/配置影响。
- 总帮助未完整解释 MEMOBOX_CONFIG_PATH、EMBEDDING_DIM、HF_ENDPOINT 和配置优先级。
- 中文/emoji 表格按 JS length 对齐和截断。定向探针的两行 source 列分别从终端第 10、9 列开始；emoji 在边界被截成孤立代理项。可用 [Bun.stringWidth](https://bun.sh/docs/runtime/utils#bun-stringwidth) 测量显示宽度，再按字素簇截断。
- JSON 和 MCP 的稳定英文标识不是中文化缺陷；表格中文化应与机器输出分离。
- 中文 kind 别名可做“事实/偏好/事件/决策 → fact/preference/event/decision”，存储仍使用原枚举。

### P2：含单引号的路径损坏 Codex TOML

定位：src/install.ts:55。

TOML 单引号字符串不能通过 \\' 转义单引号。生成 `C:\用户目录\O'Brien\bun.exe` 的配置后，Python 标准库 tomllib 实际解析失败。改用合法 TOML 基本字符串编码，测试中文、空格、单引号、反斜杠组合。

## 免安装 Bun 的可行性验证

在临时目录用 Bun 1.4.2 编译，外置可选的 @huggingface/transformers：

```powershell
bun build --compile --minify --external @huggingface/transformers ./bin/memobox.js --outfile <临时目录>/memobox-probe.exe
```

产物 86,290,432 字节（约 82.3 MiB）。在 PATH 不包含 Bun 的环境中，version、中文 save/search、两个原生 MCP 进程的共享检索全部通过。说明运行时可随可执行文件发布，使用者可以不另装 Bun。[Bun 官方独立可执行文件文档](https://bun.sh/docs/bundler/executables)。

但这只是验证原型：

- install 的 args 仍输出 `B:\~BUN\root\cli.ts` 虚拟路径；原生模式必须直接启动 exe，无需源文件参数。
- lite 的外部依赖加载、ONNX 原生库和模型缓存尚未验证。
- 只验证 Windows x64，没有宣称跨平台通过。
- 44.8 kB 的当前源码 tarball 与包含运行时的约 82 MiB 原生程序不是同一种体积口径。需要测量平台压缩包下载体积，不能继续宣传相同安装体积。

## 上下文图与后续修改范围

| 文件 | 作用 | 后续修改 |
|---|---|---|
| src/cli.ts | 参数、帮助、命令调度和输出 | 统一规格与校验，命令分模块，中文展示 |
| bin/memobox.js | npm 入口 | 当前 Bun 入口；原生分发时引入 Node 启动器 |
| src/install.ts | 接线和探测 | 配置透传、TOML 编码、源码/原生两种入口 |
| src/db/sqlite-store.ts | 存储与向量管理 | 查询下推、校验不变量、补算统计 |
| src/lib/memory-store.ts | 存储接口 | 结构化查询与补算报告契约 |
| src/lib/mcp.ts | MCP 协议 | 复用存储校验，保持机器协议兼容 |
| src/lib/config.ts / paths.ts | 配置与库路径 | 路径来源说明、配置校验和可诊断错误 |
| src/lib/local-embedder.ts / ollama.ts | 可选模型 | 本地依赖管理、中文进度和失败诊断 |
| src/cli.test.ts / install.test.ts | 现有 CLI/接线测试 | 补入已复现的参数和中文边界 |
| src/mcp-sharing.test.ts | 真 MCP 双进程测试 | 增加安装包、原生入口和自定义配置覆盖 |
| README 双语 / package.json | 文档与分发 | 运行时说明、命令示例、版本单一来源 |
| CI / 发布脚本（待建） | 发行验收 | 无 Bun 消费环境、平台矩阵、包清单和校验值 |

边界：保留 CLI + stdio MCP + SQLite；本轮不做数据库迁移、不动生产配置、不引入后台服务。后续执行以 ROADMAP.md 的验收条件为准。
