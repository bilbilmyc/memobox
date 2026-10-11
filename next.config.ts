import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone：产物自带最小 node_modules，Dockerfile 多阶段构建的运行层直接拷走用
  output: "standalone",
  // 不开 cacheComponents/PPR（连带 partialPrefetching，它依赖前者）：admin
  // 布局的会话守卫靠 redirect() 拦截，PPR 下静态壳先行、页面段并行流式——
  // 守卫拦不住已流出去的内容（v1.5 容器验证实测未认证响应泄漏记忆数据，
  // admin 是内部工具，这点性能收益不值得冒险）
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
