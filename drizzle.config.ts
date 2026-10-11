import { defineConfig } from "drizzle-kit";

// drizzle-kit 配置：仅服务 Postgres 模式（SQLite 本地模式是幂等内联 DDL，不走这里）
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle", // 生成的 SQL 迁移目录，Dockerfile 会拷进镜像供启动时执行
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
