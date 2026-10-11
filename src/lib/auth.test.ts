import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import {
  AUTH_TABLES_SQL,
  account,
  session,
  user,
  verification,
} from "@/db/schema-sqlite";
import { createAuth, seedInitialAdmin } from "@/lib/auth";

/**
 * 认证往返测试（内存 SQLite）：注册 → 登录 → 会话解析 → 重复注册冲突。
 * 这是 schema 与 Better Auth 约定是否对齐的真值验证——跑通了，
 * pg 版（同一套列名 + 迁移）即对齐。
 */

/** 建一个带认证表的内存库 + 绑好适配器的 auth 实例 */
function makeAuth() {
  const client = new Database(":memory:");
  client.exec("PRAGMA foreign_keys = ON;");
  client.exec(AUTH_TABLES_SQL);
  const db = drizzle(client, {
    // Better Auth 会自检四张表都要在 schema 里（缺 verification 直接报错）
    schema: { user, session, account, verification },
  });
  return {
    auth: createAuth(drizzleAdapter(db, { provider: "sqlite" })),
    db,
  };
}

const EMAIL = "alice@example.com";

describe("Better Auth round-trip (sqlite)", () => {
  test("signup creates user + account with hashed password", async () => {
    const { auth, db } = makeAuth();
    const res = await auth.api.signUpEmail({
      body: { name: "Alice", email: EMAIL, password: "password123" },
      headers: new Headers(),
    });
    expect(res.user.email).toBe(EMAIL);

    const rows = db.select().from(user).all();
    expect(rows.length).toBe(1);
    // 密码以哈希落库，绝不存明文
    const acct = db.select().from(account).all()[0];
    expect(acct.password).toBeTruthy();
    expect(acct.password).not.toBe("password123");
    expect(acct.providerId).toBe("credential");
  });

  test("signup then signIn yields a resolvable session cookie", async () => {
    const { auth, db } = makeAuth();
    await auth.api.signUpEmail({
      body: { name: "Alice", email: EMAIL, password: "password123" },
      headers: new Headers(),
    });
    // asResponse 才能拿到 set-cookie；cookie 值 = 裸token.签名（URL 编码）
    const res = await auth.api.signInEmail({
      body: { email: EMAIL, password: "password123" },
      headers: new Headers(),
      asResponse: true,
    });
    const line = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("better-auth.session_token="));
    expect(line).toBeDefined();
    const cookieValue = line!.split(";")[0]!.slice(
      "better-auth.session_token=".length
    );

    // 会话行已落库且未过期（timestamp 模式读出来是 Date）
    const rawToken = decodeURIComponent(cookieValue).split(".")[0];
    const row = db.select().from(session).where(eq(session.token, rawToken)).all()[0];
    expect(row).toBeDefined();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // cookie → getSession（这就是 /admin 布局守卫走的路径）
    const resolved = await auth.api.getSession({
      headers: new Headers({
        cookie: `better-auth.session_token=${cookieValue}`,
      }),
    });
    expect(resolved?.user.email).toBe(EMAIL);

    // 无 cookie = 未登录
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
  });

  test("duplicate email and wrong password are rejected", async () => {
    const { auth } = makeAuth();
    await auth.api.signUpEmail({
      body: { name: "Alice", email: EMAIL, password: "password123" },
      headers: new Headers(),
    });
    await expect(
      auth.api.signUpEmail({
        body: { name: "Clone", email: EMAIL, password: "password456" },
        headers: new Headers(),
      })
    ).rejects.toThrow();
    await expect(
      auth.api.signInEmail({
        body: { email: EMAIL, password: "wrong-password" },
        headers: new Headers(),
      })
    ).rejects.toThrow();
  });

  test("seedInitialAdmin bootstraps from ADMIN_PASSWORD once", async () => {
    const prev = process.env.ADMIN_PASSWORD;
    process.env.ADMIN_PASSWORD = "bootstrap-secret";
    try {
      const { auth, db } = makeAuth();
      const count = () =>
        Promise.resolve(db.select().from(user).all().length);
      await seedInitialAdmin(auth, count);
      const admin = db.select().from(user).all()[0];
      expect(admin?.email).toBe("admin@memobox.local");
      // 幂等：已有用户时不再播种
      process.env.ADMIN_PASSWORD = "second-secret";
      await seedInitialAdmin(auth, count);
      expect(db.select().from(user).all().length).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_PASSWORD;
      else process.env.ADMIN_PASSWORD = prev;
    }
  });
});
