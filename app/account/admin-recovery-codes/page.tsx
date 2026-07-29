import { KeyRound, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { BackgroundGradientAnimation } from "../../components/ui/background-gradient-animation";
import { isInitialAdminAccount } from "../../lib/initial-admin";
import { getAuthenticatedUser } from "../../selfhost-session";
import { hasVerifiedSecurityEmail } from "../../lib/user-store";
import AdministratorRecoveryCodesForm from "./administrator-recovery-codes-form";

export const dynamic = "force-dynamic";

export default async function AdministratorRecoveryCodesPage() {
  const viewer = await getAuthenticatedUser();
  if (!viewer) redirect("/login?return_to=%2Faccount%2Fadmin-recovery-codes");
  if (!await hasVerifiedSecurityEmail(viewer.email)) redirect("/account/security-email?setup=1");
  if (!isInitialAdminAccount(viewer.email)) redirect("/");

  return <BackgroundGradientAnimation interactive={false}><main className="login-shell"><section className="login-intro" aria-label="管理员恢复码说明"><div className="login-brand"><span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} /></span><span>djmima</span></div><div><p className="login-kicker">OFFLINE RECOVERY</p><h1>轮换离线<br />恢复码。</h1><p>生成后，尚未使用的旧恢复码会立即失效。</p></div></section><section className="login-panel" aria-labelledby="admin-recovery-codes-title"><div className="login-card"><span className="login-card-icon" aria-hidden="true"><KeyRound size={24} /></span><p className="eyebrow">初始管理员</p><h2 id="admin-recovery-codes-title">生成新的恢复码</h2><p className="login-copy">输入当前 Google 验证码后，系统只显示一次新的恢复码。</p><AdministratorRecoveryCodesForm /></div></section></main></BackgroundGradientAnimation>;
}
