import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { memoryStore } from "@/lib/memory-store";

/**
 * 落地页即产品说明书：第一屏回答「这是干嘛的、怎么开始用」，
 * 并带实时库统计——空库时引导接入，有数据时证明它在工作。
 */
export default async function Home() {
  const { total, searches } = await memoryStore.stats();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-6 py-16 text-center font-sans">
      <div>
        <p className="font-mono text-sm text-muted-foreground">memobox v1.6.0</p>
        <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          给 AI agent 装上跨会话记忆
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg leading-8 text-muted-foreground">
          agent 每次会话都是失忆的——上周说过的话、做过的决定，这次全不记得。
          memobox 让 agent 把重要的事存进来，之后的任何会话都能检索回来。
        </p>
      </div>

      <div className="grid w-full max-w-2xl gap-3 text-left sm:grid-cols-3">
        {[
          {
            n: "1",
            title: "一行命令接入",
            body: "Claude Code / Cursor / 任何 MCP 客户端，指向本机 /mcp 端点。",
          },
          {
            n: "2",
            title: "让 agent 记住",
            body: "「记住：这个项目 dev 用 3100 端口」——agent 自己调 memory_save 存入。",
          },
          {
            n: "3",
            title: "任何会话取回",
            body: "「我对端口有什么偏好？」——agent 调 memory_search 查回并回答。",
          },
        ].map((s) => (
          <div
            key={s.n}
            className="flex flex-col gap-2 rounded-lg border p-4"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted font-mono text-xs">
              {s.n}
            </span>
            <p className="text-sm font-medium">{s.title}</p>
            <p className="text-sm leading-6 text-muted-foreground">{s.body}</p>
          </div>
        ))}
      </div>

      <code className="max-w-full overflow-x-auto whitespace-nowrap rounded-lg bg-muted px-3 py-2 font-mono text-sm text-muted-foreground">
        claude mcp add --transport http memobox http://localhost:3100/mcp
      </code>

      <div className="flex items-center gap-3">
        <Link href="/admin" className={buttonVariants()}>
          进入管理后台
        </Link>
        <Link href="/login" className={buttonVariants({ variant: "outline" })}>
          登录
        </Link>
      </div>

      <p className="text-sm text-muted-foreground">
        当前库里已有{" "}
        <span className="font-mono font-medium text-foreground">{total}</span>{" "}
        条记忆 · 累计检索{" "}
        <span className="font-mono font-medium text-foreground">{searches}</span>{" "}
        次
        {total === 0
          ? "——接入 agent 存第一条后，这里和后台就会活起来"
          : "——后台可逐条查看、编辑、遗忘、备份"}
      </p>
    </div>
  );
}
