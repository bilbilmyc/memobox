import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle> | undefined;

/** Throws with a readable message when DATABASE_URL is missing. */
export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — copy .env.example to .env and start the db with `docker compose up -d`"
    );
  }
  _db ??= drizzle(postgres(url, { max: 10, idle_timeout: 20 }), { schema });
  return _db;
}

export const hasDb = () => Boolean(process.env.DATABASE_URL);
