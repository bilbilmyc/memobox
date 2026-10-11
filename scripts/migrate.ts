/**
 * Programmatic migration runner for the Docker image (drizzle-kit is a
 * devDependency; the runtime image only carries the traced standalone
 * node_modules, which include drizzle-orm + postgres.js).
 *
 * Usage: DATABASE_URL=... bun scripts/migrate.ts
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[memobox] DATABASE_URL is required to run migrations");
  process.exit(1);
}

const client = postgres(url, { max: 1 });
try {
  await migrate(drizzle(client), {
    migrationsFolder: process.env.MIGRATIONS_FOLDER ?? "drizzle",
  });
  console.log("[memobox] migrations applied");
} finally {
  await client.end();
}
