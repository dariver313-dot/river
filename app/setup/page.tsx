import { KeyRound, ShieldCheck } from "lucide-react";
import { notFound } from "next/navigation";
import { initialAuthenticatorSetup } from "../lib/selfhost-auth";
import CompleteSetupButton from "./complete-button";

export const dynamic = "force-dynamic";

export default async function InitialSetupPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const setup = await initialAuthenticatorSetup(token);
  if (!setup) notFound();

  return (
    <main className="login-shell">
      <section className="login-intro" aria-label="djmima 初始安全配置说明">
        <div className="login-brand"><span className="login-brand-icon" aria-hidden="true"><ShieldCheck size={25} strokeWidth={2.25} /></span><span>djmima</span></div>
        <div><p className="login-kicker">ONE-TIME SETUP</p><h1>先配置验证器，<br />再开启密码库。</h1><p>日常登录使用系统密码和管理员本人保管的 Google 验证码；双人确认只用于导出等高风险操作。</p></div>
        <ul className="login-principles"><li><KeyRound size={18} aria-hidden="true" /><span>密钥只在本次初始化页显示</span></li><li><ShieldCheck size={18} aria-hidden="true" /><span>登录密码只保存不可逆哈希</span></li><li><ShieldCheck size={18} aria-hidden="true" /><span>确认后初始化入口立即失效</span></li></ul>
      </section>
      <section className="login-panel" aria-labelledby="setup-title"><div className="login-card setup-card"><span className="login-card-icon" aria-hidden="true"><KeyRound size={24} /></span><p className="eyebrow">初始安全配置</p><h2 id="setup-title">录入 Google 验证器</h2><p className="login-copy">在 Google Authenticator 中选择“输入设置密钥”，密钥类型选择“基于时间”。请勿截图、转发或保存到普通笔记。</p><div className="setup-account">初始管理员：<strong>{setup.email}</strong></div><section className="setup-secret"><h3>管理员本人验证器</h3><code>{setup.primarySecret}</code></section><CompleteSetupButton /></div><p className="login-footer">确认后，页面和令牌都会失效；后续请从正常登录页进入。</p></section>
    </main>
  );
}
