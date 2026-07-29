import { KeyRound, ShieldCheck } from "lucide-react";
import { BackgroundGradientAnimation } from "../components/ui/background-gradient-animation";
import AdministratorRecoveryForm from "./administrator-recovery-form";

export const dynamic = "force-dynamic";

export default function AdministratorRecoveryPage() {
  return <BackgroundGradientAnimation interactive={false}><main className="login-shell"><section className="login-intro" aria-label="djmima 管理员恢复"><div className="login-brand"><span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} /></span><span>djmima</span></div><div><p className="login-kicker">OFFLINE ADMIN RECOVERY</p><h1>使用离线恢复码<br />恢复管理员。</h1><p>仅用于初始管理员遗失密码或验证器的紧急情况。</p></div><ul className="login-principles"><li><KeyRound size={18} aria-hidden="true" /><span>每个离线恢复码只能使用一次</span></li><li><ShieldCheck size={18} aria-hidden="true" /><span>恢复后所有会话都会结束</span></li></ul></section><section className="login-panel" aria-labelledby="admin-recovery-title"><div className="login-card"><span className="login-card-icon" aria-hidden="true"><KeyRound size={24} /></span><p className="eyebrow">管理员恢复</p><h2 id="admin-recovery-title">重建登录凭据</h2><p className="login-copy">输入离线恢复码后，设置新密码和 Google 验证器。</p><AdministratorRecoveryForm /></div><p className="login-footer">只应在离线恢复码已安全保存时使用。</p></section></main></BackgroundGradientAnimation>;
}
