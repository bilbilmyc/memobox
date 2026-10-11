import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone：产物自带最小 node_modules，Dockerfile 多阶段构建的运行层直接拷走用
  output: "standalone",
  // Cache Components（Next 16 默认方向的强化）：静态壳优先，动态数据走流式
  cacheComponents: true,
  // 部分预取：路由预取时允许只拉静态壳，悬停/进入时再补动态部分
  partialPrefetching: true,
  turbopack: {
    rules: {
      // Tailwind v4 走 Turbopack 官方加载器（无 postcss 配置文件方案）
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
