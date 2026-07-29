import { MailCheck, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { BackgroundGradientAnimation } from "../../components/ui/background-gradient-animation";
import { getAuthenticatedUser } from "../../selfhost-session";
import { hasVerifiedSecurityEmail } from "../../lib/user-store";
import SecurityEmailForm from "./security-email-form";

export const dynamic = "force-dynamic";

export default async function SecurityEmailPage() {
  const viewer = await getAuthenticatedUser();
  if (!viewer) redirect("/login?return_to=%2Faccount%2Fsecurity-email");
  const requiresGoogleCode = await hasVerifiedSecurityEmail(viewer.email);

  return (
    <BackgroundGradientAnimation interactive={false}>
      <main className="login-shell">
        <section className="login-intro" aria-label="安全邮箱说明">
          <div className="login-brand"><span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} strokeWidth={2.25} /></span><span>djmima</span></div>
          <div><p className="login-kicker">ACCOUNT SECURITY</p><h1>验证安全邮箱。</h1><p>安全邮箱用于登录地点确认和密码恢复。</p></div>
        </section>
        <section className="login-panel" aria-labelledby="security-email-title">
          <div className="login-card">
            <span className="login-card-icon" aria-hidden="true"><MailCheck size={24} /></span>
            <p className="eyebrow">安全邮箱</p>
            <h2 id="security-email-title">确认安全邮箱</h2>
            <p className="login-copy">确认码会发送到该邮箱；完成后才能进入系统。</p>
            <SecurityEmailForm requiresGoogleCode={requiresGoogleCode} />
          </div>
        </section>
      </main>
    </BackgroundGradientAnimation>
  );
}
