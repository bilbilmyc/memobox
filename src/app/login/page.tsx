import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// 登录页读取 searchParams（运行时数据），阻塞渲染而非流式占位
export const instant = false;

async function login(formData: FormData) {
  "use server";
  const password = String(formData.get("password") ?? "");
  const expected = process.env.ADMIN_PASSWORD;
  if (expected && password === expected) {
    (await cookies()).set("memobox_admin", "granted", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    redirect("/admin");
  }
  redirect("/login?e=1");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string }>;
}) {
  const failed = Boolean((await searchParams).e);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>memobox 管理后台</CardTitle>
          <CardDescription>
            单管理员模式：密码来自环境变量 ADMIN_PASSWORD
          </CardDescription>
        </CardHeader>
        <form action={login}>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                autoFocus
              />
            </div>
            {failed && (
              <p className="text-sm text-destructive">
                密码不对{process.env.ADMIN_PASSWORD ? "" : "（服务端未设置 ADMIN_PASSWORD）"}
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full">
              进入后台
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
