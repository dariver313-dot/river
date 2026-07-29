"use client";

import { Check, Copy, Eye, EyeOff, LoaderCircle, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";

export default function CompleteSetupButton({ token }: { token: string }) {
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [securityEmail, setSecurityEmail] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving) return;
    if (password !== passwordConfirmation) {
      setMessage("两次输入的登录密码不一致。");
      return;
    }
    setIsSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/setup/complete", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, securityEmail }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; recoveryCodes?: string[] };
      if (!response.ok) throw new Error(payload.error ?? "初始化令牌无效或已失效。");
      if (!Array.isArray(payload.recoveryCodes) || payload.recoveryCodes.length === 0) throw new Error("恢复码未能生成；请勿继续登录，联系部署管理员检查。 ");
      setRecoveryCodes(payload.recoveryCodes);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "确认未完成，请稍后重试。");
      setIsSaving(false);
    }
  }

  if (recoveryCodes) {
    return <section className="setup-recovery-codes" aria-live="polite"><div className="login-challenge-heading"><ShieldCheck size={20} aria-hidden="true" /><div><strong>保存管理员恢复码</strong><p>每个恢复码只能使用一次，关闭后无法再次查看。</p></div></div><div className="recovery-code-list">{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><button type="button" className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(recoveryCodes.join("\n")); setMessage("恢复码已复制，请存入离线安全存储。"); } catch { setMessage("无法自动复制，请手动保存恢复码。"); } }}><Copy size={16} />复制全部</button>{message && <p className="login-note">{message}</p>}<button className="login-action" type="button" onClick={() => window.location.replace("/login")}><Check size={19} />已安全保存，进入登录</button></section>;
  }

  return <form className="selfhost-login-form setup-complete-form" onSubmit={complete}>
    <label htmlFor="initial-login-password">设置管理员登录密码
      <span className="login-password-field"><input id="initial-login-password" type={isPasswordVisible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={14} maxLength={512} autoComplete="new-password" required placeholder="至少 14 位" /><button type="button" className="icon-button" onClick={() => setIsPasswordVisible((value) => !value)} aria-label={isPasswordVisible ? "隐藏登录密码" : "显示登录密码"}>{isPasswordVisible ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>
      <small>至少 14 位，建议使用随机密码。</small>
    </label>
    <label htmlFor="initial-login-password-confirm">再次输入登录密码
      <input id="initial-login-password-confirm" type={isPasswordVisible ? "text" : "password"} value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} minLength={14} maxLength={512} autoComplete="new-password" required />
    </label>
    <label htmlFor="initial-security-email">安全邮箱
      <input id="initial-security-email" type="email" value={securityEmail} onChange={(event) => setSecurityEmail(event.target.value)} autoComplete="email" required placeholder="用于新国家登录确认与恢复" />
      <small>请填写你能稳定访问的邮箱，不建议使用临时邮箱。</small>
    </label>
    <p className="login-note">首次登录采用账号、密码和 Google 验证码；网络位置异常时会向安全邮箱发送额外确认码。</p>
    <button className="login-action" type="submit" disabled={isSaving}>{isSaving ? <LoaderCircle className="button-spinner" size={19} aria-hidden="true" /> : <Check size={19} aria-hidden="true" />}{isSaving ? "正在确认" : "完成初始化并进入登录"}</button>
    {message && <p className="login-error" role="alert">{message}</p>}
  </form>;
}
