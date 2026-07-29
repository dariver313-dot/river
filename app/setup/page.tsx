import { KeyRound, ShieldCheck } from "lucide-react";
import { BackgroundGradientAnimation } from "../components/ui/background-gradient-animation";
import SetupClient from "./setup-client";

export const dynamic = "force-dynamic";

export default function InitialSetupPage() {
  return (
    <BackgroundGradientAnimation interactive={false}>
      <main className="login-shell">
      <section className="login-intro" aria-label="djmima 初始配置">
        <div className="login-brand"><span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} strokeWidth={2.25} /></span><span>djmima</span></div>
        <div><p className="login-kicker">ONE-TIME SETUP</p><h1>配置初始管理员。</h1><p>设置验证器、登录密码与安全恢复方式。</p></div>
        <ul className="login-principles"><li><KeyRound size={18} aria-hidden="true" /><span>Setup Key 仅显示一次</span></li><li><ShieldCheck size={18} aria-hidden="true" /><span>网络变化不会直接锁定账户</span></li><li><ShieldCheck size={18} aria-hidden="true" /><span>恢复码仅在此页显示一次</span></li></ul>
      </section>
      <section className="login-panel" aria-labelledby="setup-title"><div className="login-card setup-card"><span className="login-card-icon" aria-hidden="true"><KeyRound size={24} /></span><p className="eyebrow">初始配置</p><h2 id="setup-title">添加 Google 验证器</h2><p className="login-copy">选择“输入设置密钥”，类型为“基于时间”。</p><SetupClient /></div><p className="login-footer">完成后从登录页进入系统。</p></section>
      </main>
    </BackgroundGradientAnimation>
  );
}
