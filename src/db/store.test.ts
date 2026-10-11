import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DrizzleStore } from "./store";
import { getDb } from "./index";
import { memories, queryLog } from "./schema";

/**
 * Integration tests against the real Postgres from .env
 * (docker compose up -d). Skipped when DATABASE_URL is not set.
 */
const dbAvailable = Boolean(process.env.DATABASE_URL);
const maybe = dbAvailable ? test : test.skip;

const store = new DrizzleStore();
const TAG = "test-integration";

describe("DrizzleStore", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await getDb().delete(memories).where(eq(memories.source, TAG));
    await getDb().delete(queryLog).where(eq(queryLog.query, "test-integration-query"));
  });

  maybe("save persists and returns the row", async () => {
    const row = await store.save({
      content: "integration test memory about memobox persistence",
      kind: "fact",
      entities: ["memobox"],
      source: TAG,
    });
    expect(row.id).toMatch(/[0-9a-f-]{36}/);
    expect(row.content).toContain("persistence");
  });

  maybe("search finds saved rows by keyword", async () => {
    const hits = await store.search("persistence", 5);
    expect(hits.some((h) => h.source === TAG)).toBe(true);
  });

  maybe("search writes query_log entries", async () => {
    const before = await store.stats();
    await store.search("test-integration-query", 3);
    const after = await store.stats();
    expect(after.searches).toBe(before.searches + 1);
  });

  maybe("stats counts memories", async () => {
    const s = await store.stats();
    expect(s.total).toBeGreaterThanOrEqual(1);
  });

  maybe("list returns recent rows", async () => {
    const rows = await store.list(10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].createdAt).toBeGreaterThan(0);
  });
});
