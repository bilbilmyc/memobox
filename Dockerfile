# syntax=docker/dockerfile:1
# Multi-stage build → Next.js standalone output running on Bun.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Standalone tree carries the traced node_modules; Turbopack bundles
# server-side imports into .next chunks, so drizzle-orm / postgres.js are
# NOT resolvable there — copy them from the deps stage for the migrator
# (both packages have zero runtime deps of their own).
COPY --from=build /app/.next/standalone ./
COPY --from=deps /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=deps /app/node_modules/postgres ./node_modules/postgres
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts/migrate.ts ./scripts/migrate.ts
EXPOSE 3000
# Apply pending migrations, then serve.
CMD ["sh", "-c", "bun scripts/migrate.ts && exec bun server.js"]
