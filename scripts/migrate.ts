/**
 * Docker 镜像用的程序化迁移执行器（drizzle-kit 是 devDependency，
 * 运行镜像只带 standalone 追踪出的 node_modules，里面有 drizzle-orm
 * 和 postgres.js，正好够跑迁移）。
 *
 * 用法：DATABASE_URL=... bun scripts/migrate.ts
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[memobox] 执行迁移需要 DATABASE_URL");
  process.exit(1);
}

const client = postgres(url, { max: 1 });
try {
  await migrate(drizzle(client), {
    migrationsFolder: process.env.MIGRATIONS_FOLDER ?? "drizzle",
  });
  console.log("[memobox] 迁移已应用");
} finally {
  await client.end();
}
