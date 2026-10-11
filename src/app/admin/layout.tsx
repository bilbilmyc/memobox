import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";

// 布局读 cookies 做登录守卫，整组 /admin 路由按请求时渲染
export const instant = false;

async function logout() {
  "use server";
  (await cookies()).delete("memobox_admin");
  redirect("/login");
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const granted = (await cookies()).get("memobox_admin")?.value === "granted";
  if (!granted) redirect("/login");

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <span className="font-mono font-semibold">memobox</span>
            <span className="text-sm text-muted-foreground">管理后台</span>
          </div>
          <form action={logout}>
            <Button type="submit" variant="ghost" size="sm">
              退出
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
