import { KeyRound, ShieldCheck } from "lucide-react";
import { BackgroundGradientAnimation } from "../components/ui/background-gradient-animation";
import AuthenticatorResetForm from "./authenticator-reset-form";

export const dynamic = "force-dynamic";

export default function AuthenticatorResetPage() {
  return <BackgroundGradientAnimation interactive={false}><main className="login-shell"><section className="login-intro" aria-label="验证器恢复说明"><div className="login-brand"><span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} /></span><span>djmima</span></div><div><p className="login-kicker">AUTHENTICATOR RECOVERY</p><h1>恢复 Google<br />验证器。</h1><p>仅在管理员核验身份后使用安全邮箱中的恢复码。</p></div></section><section className="login-panel" aria-labelledby="authenticator-reset-title"><div className="login-card"><span className="login-card-icon" aria-hidden="true"><KeyRound size={24} /></span><p className="eyebrow">验证器恢复</p><h2 id="authenticator-reset-title">绑定新的验证器</h2><p className="login-copy">旧验证器和全部会话已经失效。</p><AuthenticatorResetForm /></div></section></main></BackgroundGradientAnimation>;
}
