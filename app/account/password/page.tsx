import { KeyRound, ShieldCheck } from "lucide-react";
import { BackgroundGradientAnimation } from "../../components/ui/background-gradient-animation";
import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "../../selfhost-session";
import { hasVerifiedSecurityEmail } from "../../lib/user-store";
import ChangePasswordForm from "./change-password-form";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage({ searchParams }: { searchParams: Promise<{ first_login?: string }> }) {
  const viewer = await getAuthenticatedUser();
  if (!viewer) redirect("/login?return_to=%2Faccount%2Fpassword");
  if (!await hasVerifiedSecurityEmail(viewer.email)) redirect("/account/security-email?setup=1");
  const firstLogin = (await searchParams).first_login === "1";

  return (
    <BackgroundGradientAnimation interactive={false}>
      <main className="login-shell">
      <section className="login-intro" aria-label="djmima 密码更新说明">
        <div className="login-brand"><span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} strokeWidth={2.25} /></span><span>djmima</span></div>
        <div><p className="login-kicker">ACCOUNT SECURITY</p><h1>{firstLogin ? "更新密码后，\n进入工作台。" : "更新登录密码。"}</h1><p>更新后，旧登录会话会立即失效。</p></div>
      </section>
      <section className="login-panel" aria-labelledby="change-password-title">
        <div className="login-card">
          <span className="login-card-icon" aria-hidden="true"><KeyRound size={24} /></span>
          <p className="eyebrow">{firstLogin ? "首次登录保护" : "账户安全"}</p>
          <h2 id="change-password-title">{firstLogin ? "请替换临时密码" : "修改登录密码"}</h2>
          <p className="login-copy">{firstLogin ? "初始密码仅可使用一次。" : "请确认当前密码和 Google 验证码。"}</p>
          <ChangePasswordForm />
        </div>
      </section>
      </main>
    </BackgroundGradientAnimation>
  );
}
