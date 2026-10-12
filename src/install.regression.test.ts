import { expect, test } from "bun:test";
import { codexTomlBlock, serverEntry } from "./install";

test("接线透传显式库、配置、向量维度和模型源覆盖", () => {
  const values = { MEMOBOX_DB_PATH: "D:/中文 记忆/库.db", MEMOBOX_CONFIG_PATH: "D:/中文配置.json", EMBEDDING_DIM: "512", HF_ENDPOINT: "https://example.invalid" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    expect(serverEntry().env).toMatchObject(values);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("接线 TOML 在中文、空格、单引号和反斜杠路径上实际可解析", () => {
  const entry = { command: "C:\\用户目录\\O'Brien\\bun.exe", args: ["D:\\中文 项目\\src\\cli.ts"], env: { MEMOBOX_DB_PATH: "D:\\中文 记忆\\库.db" } };
  const parsed = Bun.TOML.parse(codexTomlBlock(entry)) as { mcp_servers: { memobox: typeof entry } };
  expect(parsed.mcp_servers.memobox).toEqual(entry);
});
