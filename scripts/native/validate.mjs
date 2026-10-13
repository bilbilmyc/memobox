import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { mcpClient, runProcess } from "./process.mjs";
import { validateEndpoint } from "./endpoint.mjs";
import { processMemory } from "./process-memory.mjs";

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function assertExited(pids) {
  const deadline = Date.now() + 5000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert(pids.every(pid => !alive(pid)), "Model/launcher descendant remained after MCP exit");
}

export async function validateProduct(command, prefix, { root = mkdtempSync(join(tmpdir(), "memobox-native-")), version, env: extra = {}, lite = false } = {}) {
  mkdirSync(root, { recursive: true });
  const env = { ...process.env, ...extra, MEMOBOX_DB_PATH: join(root, "中文 shared '记忆.db"), MEMOBOX_CONFIG_PATH: join(root, "配置.json"), HOME: root, USERPROFILE: root };
  for (const name of Object.keys(env)) if (name.startsWith("EMBEDDING_") || ["MEMOBOX_BACKEND", "BUN_BE_BUN"].includes(name)) delete env[name];
  const cli = async (args, expected = 0, timeout = 20000) => (await runProcess(command, [...prefix, ...args], { env, expected, timeout })).stdout;
  assert.equal(await cli(["--version"]), version);
  assert((await cli(["--help"])).includes("维护"));
  for (const args of [["save", " "], ["forget", "unknown", "--dry-run"], ["restore", "unknown.json"], ["query", "--limit=NaN"], ["model", "enable", "--lite", "--model", "wrong"]]) await cli(args, 2);
  await cli(["save", "发行物验证：中文目录 ✅", "--entities", "发布项目", "--source", "release", "--kind", "决策"]);
  const saved = JSON.parse(await cli(["query", "--source", "release", "--json"])); assert.equal(saved.length, 1);
  const explained = JSON.parse(await cli(["search", "中文目录", "--entity", "发布项目", "--explain", "--json"]));
  assert.equal(explained.memories.length, 1); assert.equal(explained.explanation.hits[0].keyword.rank, 1);
  assert.equal(typeof explained.queryId, "string");
  await cli(["eval", "label", explained.queryId, saved[0].id, "相关", "--json"]);
  assert.equal(JSON.parse(await cli(["eval", "show", explained.queryId, "--json"])).labels[0].relevant, true);
  assert.equal(JSON.parse(await cli(["eval", "report", "--json"])).benchmark.recall, 1);
  await cli(["eval", "unlabel", explained.queryId, saved[0].id]);
  assert.equal(JSON.parse(await cli(["eval", "report", "--json"])).benchmark.recall, null);
  await cli(["update", saved[0].id, "发行物验证：中文目录已修订", "--json"]);
  assert.equal(JSON.parse(await cli(["get", saved[0].id])).createdAt, saved[0].createdAt);
  const backup = join(root, "备份.json"); await cli(["export", backup]);
  assert.equal(JSON.parse(await cli(["import", backup, "--dry-run", "--json"])).skipped, 1);
  assert.deepEqual(JSON.parse(await cli(["restore", backup, "--dry-run", "--json"])), { total: 1, imported: 0, replaced: 1 });
  const plan = join(root, "维护计划.json"); await cli(["maintain", "plan", "--ids", saved[0].id, "--out", plan]);
  await cli(["maintain", "apply", plan], 2);
  const applied = JSON.parse(await cli(["maintain", "apply", plan, "--yes", "--json"])); assert.equal(applied.deleted, 1);
  assert.equal(JSON.parse(await cli(["restore", applied.backup, "--yes", "--json"])).imported, 1);
  assert.equal(JSON.parse(await cli(["get", saved[0].id])).content, "发行物验证：中文目录已修订");
  await cli(["install", "codex"]); await cli(["install", "pi"]); await cli(["install", "claude"]);
  const pi = JSON.parse(readFileSync(join(root, ".pi", "agent", "mcp.json"), "utf8")).mcpServers.memobox;
  const codex = readFileSync(join(root, ".codex", "config.toml"), "utf8");
  const codexEntry = { command: JSON.parse(codex.match(/^command = (.+)$/m)[1]), args: JSON.parse(codex.match(/^args = (.+)$/m)[1]), env: {} };
  for (const name of ["MEMOBOX_DB_PATH", "MEMOBOX_CONFIG_PATH"]) codexEntry.env[name] = JSON.parse(codex.match(new RegExp(name + ' = ("(?:[^"\\\\]|\\\\.)*")'))[1]);
  assert.equal(pi.env.MEMOBOX_DB_PATH, env.MEMOBOX_DB_PATH); assert.equal(codexEntry.env.MEMOBOX_DB_PATH, env.MEMOBOX_DB_PATH);
  assert.deepEqual(pi.args, []); assert.deepEqual(codexEntry.args, []);
  const claudeEntry = JSON.parse(readFileSync(join(root, ".claude.json"), "utf8")).mcpServers.memobox;
  assert.deepEqual(claudeEntry, pi);
  const piTools = [], piHandlers = new Map();
  const piAdapter = (await import(pathToFileURL(join(root, ".pi", "agent", "extensions", "memobox.js")).href)).default;
  piAdapter({ registerTool: tool => piTools.push(tool), on: (name, handler) => piHandlers.set(name, handler) });
  assert.equal(piTools.length, 11);
  assert(piTools.some(tool => tool.name === "memobox_memory_feedback"));
  try {
    assert.equal((await piTools.find(tool => tool.name === "memobox_memory_get").execute("test", { id: saved[0].id })).details.memory.content, "发行物验证：中文目录已修订");
    const query = JSON.parse(await cli(["search", "中文目录", "--explain", "--json"]));
    const feedback = piTools.find(tool => tool.name === "memobox_memory_feedback");
    for (const relevant of [true, null]) assert.equal((await feedback.execute("feedback", { queryId: query.queryId, memoryId: saved[0].id, relevant })).details.relevant, relevant);
  }
  finally { await piHandlers.get("session_shutdown")(); }
  const a = mcpClient(codexEntry.command, codexEntry.args, { ...env, ...codexEntry.env }), b = mcpClient(pi.command, pi.args, { ...env, ...pi.env });
  const c = mcpClient(claudeEntry.command, claudeEntry.args, { ...env, ...claudeEntry.env });
  try {
    for (const client of [a, b, c]) {
      assert.equal((await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "native-product", version: "1" } })).serverInfo.version, version);
      const tools = await client.call("tools/list", {}); assert.equal(tools.tools.length, 11);
      assert(tools.tools.some(tool => tool.name === "memory_feedback"));
      assert(tools.tools.filter(tool => tool.name.startsWith("memory_maintenance")).every(tool => tool.outputSchema));
      await client.tool("memory_search", { query: "shared_release_marker" });
    }
    // 实际安装后的 CLI 与三个常驻客户端共享新词法规则和缓存失效。
    await cli(["save", "requestTimeout = 5000", "--entities", "cache_invalidation", "--source", "synthetic-identifiers"]);
    const identifierRows = JSON.parse(await cli(["search", "request timeout", "--source", "synthetic-identifiers", "--json"]));
    assert.equal(identifierRows.length, 1);
    const identifierId = identifierRows[0].id;
    assert.equal((await b.tool("memory_search", { query: "cache invalidation", source: "synthetic-identifiers" })).structuredContent.memories[0].id, identifierId);
    await a.tool("memory_update", { id: identifierId, content: "Django dashboard", entities: ["Django"] });
    for (const query of ["go", "request timeout", "cache invalidation"]) {
      assert.equal((await c.tool("memory_search", { query, source: "synthetic-identifiers" })).structuredContent.memories.length, 0);
    }
    await b.tool("memory_forget", { id: identifierId });
    const created = await Promise.all([a.tool("memory_save", { content: "shared_release_marker 共享记忆甲" }), b.tool("memory_save", { content: "shared_release_marker 共享记忆乙" })]);
    const ids = created.map(item => item.content[0].text.match(/saved memory ([\w-]+)/)[1]);
    const feedbackQuery = (await a.tool("memory_search", { query: "shared_release_marker", explain: true })).structuredContent.queryId;
    await b.tool("memory_feedback", { queryId: feedbackQuery, memoryId: ids[0], relevant: false });
    assert.equal(JSON.parse(await cli(["eval", "show", feedbackQuery, "--json"])).labels[0].relevant, false);
    await c.tool("memory_feedback", { queryId: feedbackQuery, memoryId: ids[0], relevant: null });
    assert.deepEqual(JSON.parse(await cli(["eval", "show", feedbackQuery, "--json"])).labels, []);
    for (const client of [a, b, c]) assert.equal((await client.tool("memory_search", { query: "shared_release_marker" })).structuredContent.memories.length, 2);
    const preview = (await a.tool("memory_maintenance_plan", { ids })).structuredContent;
    await b.tool("memory_update", { id: ids[0], content: "shared_release_marker 外部修订", entities: ["项目乙"] });
    assert.equal((await a.tool("memory_maintenance_apply", { plan: preview, confirm: true })).isError, true);
    const fresh = (await b.tool("memory_maintenance_plan", { ids, replacement: { content: "shared_release_marker 合并记忆", entities: ["项目乙"] } })).structuredContent;
    const result = (await a.tool("memory_maintenance_apply", { plan: fresh, confirm: true })).structuredContent;
    assert.equal(result.deleted, 1);
    assert.equal((await b.tool("memory_get", { id: ids[0] })).structuredContent.memory.content, "shared_release_marker 合并记忆");
    assert.equal((await b.tool("memory_search", { query: "shared_release_marker", entity: "项目甲" })).structuredContent.memories.length, 0);
    assert.equal((await b.tool("memory_search", { query: "shared_release_marker", entity: "项目乙" })).structuredContent.memories.length, 1);
    await cli(["restore", result.backup, "--yes"]);
    assert.equal((await a.tool("memory_search", { query: "shared_release_marker" })).structuredContent.memories.length, 2);
    await cli(["forget", ids[0]]);
    for (const client of [a, b]) assert.equal((await client.tool("memory_search", { query: "shared_release_marker" })).structuredContent.memories.length, 1);
  } finally { await a.close(); await b.close(); await c.close(); }
  const signal = mcpClient(command, prefix, env);
  await signal.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "signal-test", version: "1" } });
  await signal.close("SIGTERM");
  const doctor = JSON.parse(await cli(["doctor", "--json", "--strict"])); assert.equal(doctor.database.integrity, "ok");
  await validateEndpoint(command, prefix, root, env);
  if (lite) {
    env.MEMOBOX_RUNTIME_PATH = extra.MEMOBOX_RUNTIME_PATH ?? join(root, "optional-runtime");
    env.MEMOBOX_MODELS_PATH = extra.MEMOBOX_MODELS_PATH ?? join(root, "models");
    await cli(["model", "enable", "--lite", "--debug"], 0, 240000);
    const check = JSON.parse(await cli(["doctor", "--json", "--strict"])); assert.equal(check.model.mode, "local"); assert.equal(check.database.vectors.missing, 0);
    for (const signal of [undefined, "SIGTERM"]) {
    const local = mcpClient(command, prefix, env);
    let descendants = [];
    try {
      await local.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "real-model-test", version: "1" } });
      const started = performance.now();
      const result = await local.tool("memory_search", { query: "中文文件夹中的发行测试", explain: true }, 240000);
      assert(performance.now() - started < 2500, "Cached model cold search regressed above 2.5s");
      assert.equal(result.isError, undefined); assert.equal(result.structuredContent.explanation.mode, "hybrid");
      assert.equal(result.structuredContent.explanation.semantic.status, "used");
      assert(result.structuredContent.memories.some(memory => memory.id === saved[0].id));
      descendants = processMemory(local.child.pid).pids;
      assert(descendants.length >= 2, "Compiled local model helper was not exercised");
    } finally { await local.close(signal); await assertExited(descendants); }
    }
    // 原生启动器和模型助手都必须支持 shell 元字符、中文及空格路径。
    const punctuated = join(root, "中文 %MEMOBOX_NOT_SET% & ' ! 目录"); mkdirSync(punctuated);
    const escaped = join(punctuated, process.platform === "win32" ? "memobox.exe" : "memobox");
    copyFileSync(pi.command, escaped); chmodSync(escaped, 0o700);
    const escapedSearch = JSON.parse((await runProcess(escaped, ["search", "中文文件夹中的发行测试", "--explain", "--json"], { env })).stdout);
    assert.equal(escapedSearch.explanation.semantic.status, "used");
  }
  return { root, version, cliPassed: true, twoProcessMcpPassed: true, generatedClientConfigsPassed: true, piExtensionPassed: true, signalPassed: true, endpointPassed: true, realLocalModelPassed: lite };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const platform = `${process.platform}-${process.arch}`, directory = resolve("artifacts", platform), receiptPath = join(directory, "receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const result = await validateProduct(join(directory, receipt.filename), [], { version: receipt.version, lite: process.env.NATIVE_TEST_LITE === "1",
    env: { PATH: process.platform === "win32" ? join(process.env.SystemRoot, "System32") : "/usr/bin:/bin", ...(process.env.MEMOBOX_TEST_RUNTIME ? { MEMOBOX_RUNTIME_PATH: process.env.MEMOBOX_TEST_RUNTIME } : {}), ...(process.env.MEMOBOX_TEST_MODELS ? { MEMOBOX_MODELS_PATH: process.env.MEMOBOX_TEST_MODELS } : {}) } });
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, nativePassed: true, tests: result }, null, 2)); console.log(JSON.stringify(result));
}
