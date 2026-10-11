# syntax=docker/dockerfile:1
# 多阶段构建 → Next.js standalone 产物跑在 Bun 上

# 依赖层：只拷 lockfile 相关文件，命中缓存最快
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# 构建层：跑 next build 产出 .next/standalone
FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# 运行层：slim 基础镜像 + standalone 产物
FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# standalone 自带被追踪的 node_modules；但 Turbopack 会把服务端依赖打进
# bundle，.next/standalone/node_modules 里没有 drizzle-orm/postgres.js 可解析
# 副本——从 deps 阶段补拷这两个包给启动迁移脚本用（两者都零运行时依赖）
COPY --from=build /app/.next/standalone ./
COPY --from=deps /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=deps /app/node_modules/postgres ./node_modules/postgres
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts/migrate.ts ./scripts/migrate.ts
EXPOSE 3000
# 先执行未应用的迁移，再起服务
CMD ["sh", "-c", "bun scripts/migrate.ts && exec bun server.js"]
