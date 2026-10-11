# 提交 memobox 到 MCP Registry（给 Soren 的操作手册）

官方 MCP Registry（registry.modelcontextprotocol.io）本身就是 modelcontextprotocol
开源项目——我们不需要自建任何注册设施，只需要一次 GitHub 授权 + 一条发布命令。
本文件是完整步骤；`server.json`（仓库根目录）已经按远程服务器（remote）的清单格式写好。

## 前置条件（只有你能做）

1. **仓库公开**：把 memobox 推到你的 GitHub，然后把仓库里所有 `your-name`
   占位符替换成你的 GitHub 用户名（`server.json`、`README.md`、`README.zh-CN.md`）。
2. **GitHub 账号**：发布用 GitHub 设备码授权，registry 的命名空间要求
   `io.github.<你的用户名>/memobox`——`server.json` 里的 `name` 必须与之一致。

## 发布步骤

```powershell
# 1) 安装官方发布 CLI（Windows；macOS/Linux 用 brew install mcp-publisher）
$arch = "amd64"; Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"; tar xf mcp-publisher.tar.gz mcp-publisher.exe

# 2) GitHub 授权（会给出 https://github.com/login/device 的设备码）
mcp-publisher login github

# 3) 发布（读取当前目录的 server.json）
mcp-publisher publish

# 4) 验证
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=memobox"
```

## 备注

- Registry 目前是 preview 状态（API freeze v0.1），数据理论上可能重置；
  版本更新后重复 `publish` 即可覆盖。
- `server.json` 里 `remotes.url` 用了 `https://{host}/mcp` 模板变量：memobox
  是自托管服务，用户填自己的域名。`headers` 声明了可选的 Bearer 令牌
  （对应服务端的 `MCP_TOKEN`）。
- 另一个零成本曝光渠道：给 [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
  提一个 PR（加一行即可），同样只需要 GitHub 账号。
- 以后如果想把 stdio 桥发布成 npm 包（`@你的scope/memobox-bridge`），在
  `server.json` 里追加 `packages` 字段并让 `package.json` 带 `mcpName`——
  那是「先引入开源的、再搞自己的」的下一步，不急。
