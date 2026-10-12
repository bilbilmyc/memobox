import { createServer } from "node:http";
import { join } from "node:path";
import assert from "node:assert/strict";
import { mcpClient, runProcess } from "./process.mjs";

/** 原生/安装包确实经过 HTTP、超时、向量落库和两个常驻进程，不替换生产 provider。 */
export async function validateEndpoint(command, prefix, root, inherited) {
  let hung = false,
    requests = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests++;
    assert.equal(body.model, "acceptance-endpoint");
    assert.equal(typeof body.input, "string");
    if (hung) return;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ data: [{ embedding: [1, 0, 0, 0], index: 0 }] }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const env = {
    ...inherited,
    HOME: join(root, "endpoint-home"),
    USERPROFILE: join(root, "endpoint-home"),
    MEMOBOX_DB_PATH: join(root, "端点共享.db"),
    MEMOBOX_CONFIG_PATH: join(root, "端点配置.json"),
    EMBEDDING_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
    EMBEDDING_MODEL: "acceptance-endpoint",
    EMBEDDING_DIM: "4",
    EMBEDDING_TIMEOUT_MS: "100",
  };
  const a = mcpClient(command, prefix, env),
    b = mcpClient(command, prefix, env);
  try {
    for (const client of [a, b])
      await client.call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "endpoint-product", version: "1" },
      });
    await a.tool("memory_save", {
      content: "endpoint_shared 端点模式记忆甲",
      entities: ["端点项目"],
    });
    await b.tool("memory_save", {
      content: "endpoint_shared 端点模式记忆乙",
      entities: ["端点项目"],
    });
    for (const client of [a, b]) {
      const result = await client.tool("memory_search", {
        query: "HTTP 提供的共享长期记忆",
        entity: "端点项目",
        explain: true,
      });
      assert.equal(
        result.structuredContent.explanation.semantic.status,
        "used",
      );
      assert.equal(result.structuredContent.memories.length, 2);
    }
    hung = true;
    const start = performance.now();
    const fallback = await a.tool("memory_search", {
      query: "endpoint_shared",
      explain: true,
    });
    assert(performance.now() - start < 3000, "Hung endpoint did not time out");
    assert.equal(
      fallback.structuredContent.explanation.semantic.reason,
      "embedding_failed",
    );
    assert.equal(fallback.structuredContent.memories.length, 2);
    const doctor = JSON.parse(
      (
        await runProcess(command, [...prefix, "doctor", "--json", "--strict"], {
          env,
        })
      ).stdout,
    );
    assert.equal(doctor.database.vectors.valid, 2);
    assert.equal(doctor.model.mode, "endpoint");
    assert(requests >= 5);
  } finally {
    await a.close();
    await b.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  return true;
}
