import { KeyRound, ShieldCheck } from "lucide-react";
import { BackgroundGradientAnimation } from "../components/ui/background-gradient-animation";
import PasswordRecoveryForm from "./password-recovery-form";

export const dynamic = "force-dynamic";

export default function PasswordRecoveryPage() {
  return <BackgroundGradientAnimation interactive={false}><main className="login-shell"><section className="login-intro" aria-label="djmima 密码恢复"><div className="login-brand"><span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} /></span><span>djmima</span></div><div><p className="login-kicker">PASSWORD RECOVERY</p><h1>安全恢复<br />访问权限。</h1><p>恢复码只发送到已登记的安全邮箱。</p></div><ul className="login-principles"><li><KeyRound size={18} aria-hidden="true" /><span>恢复码仅可使用一次</span></li><li><ShieldCheck size={18} aria-hidden="true" /><span>恢复后会结束其他会话</span></li></ul></section><section className="login-panel" aria-labelledby="recovery-title"><div className="login-card"><span className="login-card-icon" aria-hidden="true"><KeyRound size={24} /></span><p className="eyebrow">密码恢复</p><h2 id="recovery-title">重设登录密码</h2><p className="login-copy">先获取安全邮箱中的恢复码，再设置新密码。</p><PasswordRecoveryForm /></div><p className="login-footer">若无法访问安全邮箱，请联系管理员。</p></section></main></BackgroundGradientAnimation>;
}
