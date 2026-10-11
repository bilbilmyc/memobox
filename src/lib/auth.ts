/**
 * 多管理员认证（v1.5）——直接采用开源库 Better Auth（自托管、Drizzle 适配器、
 * pg/SQLite 双支持），不自研注册/会话系统。
 *
 * 模式与存储后端对齐：DATABASE_URL 有 → pg；无 → SQLite（同一个库文件，
 * 认证表由 AUTH_TABLES_SQL 幂等建出）。stub 后端时认证仍走 SQLite——
 * 认证需要真实持久化，这是刻意的。
 *
 * 引导：首次启动若没有任何用户且配了 ADMIN_PASSWORD，自动播种初始管理员
 * （邮箱 ADMIN_EMAIL，默认 admin@memobox.local；密码即 ADMIN_PASSWORD）——
 * 老部署的口令因此无缝迁移到多管理员模式。
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import { getDb, hasDb } from "@/db/index";
import * as pgSchema from "@/db/schema";
import * as sqliteSchema from "@/db/schema-sqlite";

/**
 * 造一个 Better Auth 实例。database 参数传「已构造好的适配器」，
 * 这样 pg / sqlite 两种 drizzle 方言共用同一份配置。
 */
export function createAuth(database: BetterAuthOptions["database"]) {
  return betterAuth({
    database,
    emailAndPassword: { enabled: true },
    // nextCookies：让 server action / route handler 里调 auth.api.*
    // 时能通过 Next 的 headers() 正确种 cookie
    plugins: [nextCookies()],
    // 会话签名密钥：生产务必显式设 BETTER_AUTH_SECRET；
    // 兜底顺序 ADMIN_PASSWORD → 开发默认值（保证升级后仍能启动）
    secret:
      process.env.BETTER_AUTH_SECRET ??
      process.env.ADMIN_PASSWORD ??
      "memobox-dev-secret",
    baseURL:
      process.env.BETTER_AUTH_URL ??
      `http://localhost:${process.env.APP_PORT ?? 3100}`,
  });
}

export type AuthBundle = {
  auth: ReturnType<typeof createAuth>;
  /** 首次启动播种初始管理员（幂等，失败只打日志不阻塞启动） */
  ready: Promise<void>;
  /** 现有用户数——登录页用来提示「还没有账号」 */
  countUsers: () => Promise<number>;
};

/** sqlite 模式下认证专用的库连接（WAL 允许多连接共存，建表幂等） */
function openSqliteAuthDb() {
  const path = process.env.MEMOBOX_DB_PATH ?? "data/memobox.db";
  if (path !== ":memory:") {
    const dir = path.replace(/[/\\][^/\\]+$/, "");
    if (dir && dir !== path) mkdirSync(dir, { recursive: true });
  }
  const client = new Database(path);
  client.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  client.exec(sqliteSchema.AUTH_TABLES_SQL);
  return drizzle(client, { schema: sqliteSchema });
}

/**
 * 认证单例。与 store 一样挂 globalThis（HMR-safe）——
 * 改本文件或 Better Auth 配置后需重启 dev server 才生效。
 */
export function getAuth(): AuthBundle {
  const g = globalThis as typeof globalThis & { __memoboxAuth?: AuthBundle };
  if (g.__memoboxAuth) return g.__memoboxAuth;

  let bundle: AuthBundle;
  if (hasDb()) {
    // pg 服务端模式：与 DrizzleStore 共用连接池
    const db = getDb();
    const auth = createAuth(drizzleAdapter(db, { provider: "pg" }));
    const countUsers = async () => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pgSchema.user);
      return row?.n ?? 0;
    };
    bundle = { auth, ready: seedInitialAdmin(auth, countUsers), countUsers };
  } else {
    // SQLite 本地模式：独立的认证连接，指向同一个库文件
    const db = openSqliteAuthDb();
    const auth = createAuth(drizzleAdapter(db, { provider: "sqlite" }));
    const countUsers = async () => {
      const [row] = db
        .select({ n: sql<number>`count(*)` })
        .from(sqliteSchema.user)
        .all();
      return row?.n ?? 0;
    };
    bundle = { auth, ready: seedInitialAdmin(auth, countUsers), countUsers };
  }

  g.__memoboxAuth = bundle;
  return bundle;
}

/** 空库 + 配了 ADMIN_PASSWORD → 播种初始管理员（导出供单测） */
export async function seedInitialAdmin(
  auth: ReturnType<typeof createAuth>,
  countUsers: () => Promise<number>
) {
  try {
    if ((await countUsers()) === 0 && process.env.ADMIN_PASSWORD) {
      const email = process.env.ADMIN_EMAIL ?? "admin@memobox.local";
      await auth.api.signUpEmail({
        body: {
          name: "admin",
          email,
          password: process.env.ADMIN_PASSWORD,
        },
        headers: new Headers(),
      });
      console.log(`[memobox] 已播种初始管理员: ${email}`);
    }
  } catch (e) {
    console.error("[memobox] 播种初始管理员失败:", e);
  }
}

/** 注册开关：公网部署想关闭自助注册时设 MEMOBOX_DISABLE_SIGNUP=1 */
export const signupEnabled = () => !process.env.MEMOBOX_DISABLE_SIGNUP;
