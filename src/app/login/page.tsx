import { headers } from "next/headers";
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
import { getAuth, signupEnabled } from "@/lib/auth";

// 登录页读运行时数据（seeding/cookie）——读了 headers() 即按请求时渲染

async function login(formData: FormData) {
  "use server";
  const { auth } = getAuth();
  let ok = false;
  try {
    await auth.api.signInEmail({
      body: {
        email: String(formData.get("email") ?? ""),
        password: String(formData.get("password") ?? ""),
      },
      headers: await headers(),
    });
    ok = true;
  } catch {
    // 密码不对 / 账号不存在等，统一回错误提示
  }
  // redirect() 会抛异常，必须放在 try 外
  redirect(ok ? "/admin" : "/login?e=1");
}

async function signup(formData: FormData) {
  "use server";
  const { auth, countUsers } = getAuth();
  // 注册默认关：仅显式开启（团队模式）或引导态（库里还没有任何用户）放行
  if (!signupEnabled() && (await countUsers()) > 0) redirect("/login");
  let ok = false;
  try {
    // signUpEmail 成功即已建立会话
    await auth.api.signUpEmail({
      body: {
        name: String(formData.get("name") ?? "").trim() || "member",
        email: String(formData.get("email") ?? ""),
        password: String(formData.get("password") ?? ""),
      },
      headers: await headers(),
    });
    ok = true;
  } catch {
    // 邮箱已存在 / 密码太短等
  }
  redirect(ok ? "/admin" : "/login?e=2");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string }>;
}) {
  const { ready, countUsers } = getAuth();
  await ready; // 确保首次启动的播种（ADMIN_PASSWORD → 初始管理员）已完成
  const [{ e }, total] = await Promise.all([searchParams, countUsers()]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>管理员登录</CardTitle>
          <CardDescription>
            {total > 0
              ? total === 1
                ? "单管理员模式 · 管理后台与记忆数据需要会话"
                : `当前 ${total} 个管理员账号`
              : "还没有任何账号——注册第一个，或配 ADMIN_PASSWORD 重启自动播种"}
          </CardDescription>
        </CardHeader>
        <form action={login}>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">密码</Label>
              <Input id="password" name="password" type="password" required />
            </div>
            {e === "1" && (
              <p className="text-sm text-destructive">邮箱或密码不对</p>
            )}
            {e === "2" && (
              <p className="text-sm text-destructive">
                注册失败（邮箱可能已存在，或密码至少 8 位）
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

      {(signupEnabled() || total === 0) && (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-base">
              {total === 0 ? "创建第一个管理员" : "注册新管理员"}
            </CardTitle>
            <CardDescription>
              {total === 0
                ? "创建后注册自动关闭（单管理员为默认形态）"
                : "团队模式已开启（MEMOBOX_ENABLE_SIGNUP=1）：小团队共用一个记忆库"}
            </CardDescription>
          </CardHeader>
          <form action={signup}>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">称呼</Label>
                <Input id="name" name="name" type="text" />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="signup-email">邮箱</Label>
                <Input id="signup-email" name="email" type="email" required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="signup-password">密码（至少 8 位）</Label>
                <Input
                  id="signup-password"
                  name="password"
                  type="password"
                  required
                  minLength={8}
                />
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" variant="outline" className="w-full">
                注册并进入
              </Button>
            </CardFooter>
          </form>
        </Card>
      )}
    </div>
  );
}
