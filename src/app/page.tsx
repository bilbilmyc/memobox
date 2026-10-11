import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center font-sans">
      <p className="font-mono text-sm text-muted-foreground">
        memobox v1.1.0
      </p>
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
        Self-hosted long-term memory for your AI agents
      </h1>
      <p className="max-w-xl text-lg leading-8 text-muted-foreground">
        给 Claude Code / Cursor / 任何 MCP 客户端装上跨会话记忆。本地模式一个
        SQLite 文件零依赖；服务端模式一个 Docker 容器，Postgres + pgvector——都自带管理后台。
      </p>
      <div className="flex gap-3">
        <Link href="/admin" className={buttonVariants()}>
          管理后台
        </Link>
        <Link
          href="/login"
          className={buttonVariants({ variant: "outline" })}
        >
          登录
        </Link>
      </div>
      <code className="mt-4 rounded-lg bg-muted px-3 py-2 font-mono text-sm text-muted-foreground">
        claude mcp add --transport http memobox http://localhost:3100/mcp
      </code>
    </div>
  );
}
