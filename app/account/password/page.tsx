import { KeyRound, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "../../selfhost-session";
import ChangePasswordForm from "./change-password-form";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage({ searchParams }: { searchParams: Promise<{ first_login?: string }> }) {
  const viewer = await getAuthenticatedUser();
  if (!viewer) redirect("/login?return_to=%2Faccount%2Fpassword");
  const firstLogin = (await searchParams).first_login === "1";

  return (
    <main className="login-shell">
      <section className="login-intro" aria-label="djmima 密码更新说明">
        <div className="login-brand"><span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} strokeWidth={2.25} /></span><span>djmima</span></div>
        <div><p className="login-kicker">ACCOUNT SECURITY</p><h1>{firstLogin ? "先更新密码，\n再进入密码库。" : "更新你的\n登录密码。"}</h1><p>确认当前密码和本人 Google 验证器后，系统会立即结束所有旧登录会话。</p></div>
      </section>
      <section className="login-panel" aria-labelledby="change-password-title">
        <div className="login-card">
          <span className="login-card-icon" aria-hidden="true"><KeyRound size={24} /></span>
          <p className="eyebrow">{firstLogin ? "首次登录保护" : "账户安全"}</p>
          <h2 id="change-password-title">{firstLogin ? "请替换临时密码" : "修改登录密码"}</h2>
          <p className="login-copy">{firstLogin ? "管理员提供的初始密码只能使用一次。完成更新后，使用新密码重新登录。" : "为避免会话被滥用，请同时验证当前密码和本人 Google 验证器。"}</p>
          <ChangePasswordForm />
        </div>
      </section>
    </main>
  );
}
