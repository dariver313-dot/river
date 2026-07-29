import { KeyRound, ShieldCheck, UsersRound } from "lucide-react";
import { BackgroundGradientAnimation } from "../components/ui/background-gradient-animation";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <BackgroundGradientAnimation interactive={false}>
      <main className="login-shell">
      <section className="login-intro" aria-label="djmima 安全登录">
        <div className="login-brand">
          <span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} strokeWidth={2.25} /></span>
          <span>djmima</span>
        </div>
        <div>
          <p className="login-kicker">SECURE WORKSPACE</p>
          <h1>安全访问，<br />简洁管理。</h1>
          <p>登录信息与验证器集中管理。</p>
        </div>
        <ul className="login-principles">
          <li><ShieldCheck size={18} aria-hidden="true" /><span>登录密码安全存储</span></li>
          <li><KeyRound size={18} aria-hidden="true" /><span>Google 验证器保护登录</span></li>
          <li><UsersRound size={18} aria-hidden="true" /><span>敏感操作需要再次验证</span></li>
        </ul>
      </section>

      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-card">
          <div className="login-card-heading">
            <span className="login-card-icon" aria-hidden="true"><KeyRound size={22} /></span>
            <h2 id="login-title"><span>安全登录</span>进入工作台</h2>
          </div>
          <LoginForm />
        </div>
      </section>
      </main>
    </BackgroundGradientAnimation>
  );
}
