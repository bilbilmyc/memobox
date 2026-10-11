import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getAuth } from "@/lib/auth";

// 布局读会话 cookie 做登录守卫，整组 /admin 路由按请求时渲染
export const instant = false;

async function logout() {
  "use server";
  const { auth } = getAuth();
  await auth.api.signOut({ headers: await headers() });
  redirect("/login");
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Better Auth 会话守卫：任何 /admin 页面都必须有有效会话
  const { auth, ready } = getAuth();
  await ready;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <span className="font-mono font-semibold">memobox</span>
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/admin" className="text-muted-foreground hover:text-foreground">
                总览
              </Link>
              <Link href="/admin/eval" className="text-muted-foreground hover:text-foreground">
                评测
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {session.user.name}
            </span>
            <form action={logout}>
              <Button type="submit" variant="ghost" size="sm">
                退出
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
