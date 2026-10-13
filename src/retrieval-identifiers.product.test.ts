import { test, expect } from "bun:test";
import { SQLiteStore } from "./db/sqlite-store";
import { StubStore } from "./lib/memory-store";

for (const backend of ["sqlite", "stub"]) test(`${backend} 标识符检索与范围过滤、更新、删除一致`, async () => {
  const store = backend === "sqlite" ? new SQLiteStore(null, ":memory:") : new StubStore();
  try {
    const target = await store.save({ content: "requestTimeout = 5000", entities: ["cache_invalidation"], source: "synthetic-a" });
    await store.save({ content: "Django dashboard", entities: ["Go"], source: "synthetic-b" });
    expect((await store.search("request timeout", 5)).map(row => row.id)).toEqual([target.id]);
    expect((await store.search("cache invalidation", 5)).map(row => row.id)).toEqual([target.id]);
    expect(await store.search("go", 5, { source: "synthetic-a" })).toEqual([]);
    await store.update(target.id, { content: "retryBudget = 3", entities: ["lease_duration"] });
    expect(await store.search("request timeout", 5)).toEqual([]);
    expect(await store.search("cache invalidation", 5)).toEqual([]);
    expect((await store.search("retry budget", 5)).map(row => row.id)).toEqual([target.id]);
    expect((await store.search("lease duration", 5)).map(row => row.id)).toEqual([target.id]);
    await store.forget(target.id);
    expect(await store.search("retry budget", 5)).toEqual([]);
    expect(await store.search("lease duration", 5)).toEqual([]);
  } finally { if (store instanceof SQLiteStore) store.close(); }
});
