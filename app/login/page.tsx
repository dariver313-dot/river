import { KeyRound, ShieldCheck, UsersRound } from "lucide-react";
import { chatGPTSignInPath } from "../chatgpt-auth";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="login-shell">
      <section className="login-intro" aria-label="djmima 安全登录说明">
        <div className="login-brand">
          <span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} strokeWidth={2.25} /></span>
          <span>djmima</span>
        </div>
        <div>
          <p className="login-kicker">PERSONAL VAULT</p>
          <h1>共同守护，<br />但不共享秘密。</h1>
          <p>你的身份解锁密码库；需要额外保护的操作，再由协作人独立确认。</p>
        </div>
        <ul className="login-principles">
          <li><ShieldCheck size={18} aria-hidden="true" /><span>不在 djmima 中输入账号或密码</span></li>
          <li><KeyRound size={18} aria-hidden="true" /><span>使用已验证的安全身份进入</span></li>
          <li><UsersRound size={18} aria-hidden="true" /><span>高风险操作保留双人确认位</span></li>
        </ul>
      </section>

      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-card">
          <span className="login-card-icon" aria-hidden="true"><KeyRound size={24} /></span>
          <p className="eyebrow">安全登录</p>
          <h2 id="login-title">进入你的密码库</h2>
          <p className="login-copy">无需在 djmima 中输入账号或密码。使用 ChatGPT 账号继续。</p>
          <a className="login-action" href={chatGPTSignInPath("/")}>
            <ShieldCheck size={19} aria-hidden="true" />
            使用 ChatGPT 继续
          </a>
          <p className="login-note">登录后会创建当前设备的安全会话。密码库数据不会保存到浏览器。</p>
        </div>
        <p className="login-footer">djmima 将登录与密码库数据分开处理。</p>
      </section>
    </main>
  );
}
