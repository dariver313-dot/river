import { KeyRound, ShieldCheck } from "lucide-react";
import { BackgroundGradientAnimation } from "../components/ui/background-gradient-animation";
import ActivateAccountForm from "./activate-account-form";

export const dynamic = "force-dynamic";

export default function ActivateAccountPage() {
  return (
    <BackgroundGradientAnimation interactive={false}>
      <main className="login-shell">
        <section className="login-intro" aria-label="djmima 账号激活">
          <div className="login-brand"><span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} strokeWidth={2.25} /></span><span>djmima</span></div>
          <div><p className="login-kicker">ACCOUNT ACTIVATION</p><h1>完成你的<br />安全配置。</h1><p>密码与验证器只由你自己设置。</p></div>
          <ul className="login-principles"><li><KeyRound size={18} aria-hidden="true" /><span>激活码仅可使用一次</span></li><li><ShieldCheck size={18} aria-hidden="true" /><span>Google 验证器确认后才启用</span></li></ul>
        </section>
        <section className="login-panel" aria-labelledby="activate-title"><div className="login-card"><span className="login-card-icon" aria-hidden="true"><KeyRound size={24} /></span><p className="eyebrow">账号激活</p><h2 id="activate-title">设置登录凭据</h2><p className="login-copy">输入管理员发送给你的激活码。</p><ActivateAccountForm /></div><p className="login-footer">激活完成后，从登录页进入系统。</p></section>
      </main>
    </BackgroundGradientAnimation>
  );
}
