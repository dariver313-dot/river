"use client";

import { Check, Copy, LoaderCircle, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";

type ActivationStage = { setupKey: string; confirmationCode: string; expiresAt: string };

function cleanCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 64);
}

export default function ActivateAccountForm() {
  const [activationCode, setActivationCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [stage, setStage] = useState<ActivationStage | null>(null);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/activate", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ code: activationCode, password }) });
      const payload = await response.json().catch(() => ({})) as ActivationStage & { error?: string };
      if (!response.ok || !payload.setupKey || !payload.confirmationCode || !payload.expiresAt) throw new Error(payload.error || "账号激活未开始。");
      setStage({ setupKey: payload.setupKey, confirmationCode: payload.confirmationCode, expiresAt: payload.expiresAt });
      setPassword("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "账号激活未开始。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function finish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stage || isSubmitting) return;
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/activate", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ action: "confirm", code: stage.confirmationCode, userCode: confirmation }) });
      const payload = await response.json().catch(() => ({})) as { completed?: boolean; error?: string };
      if (!response.ok || !payload.completed) throw new Error(payload.error || "验证器确认未完成。");
      window.location.assign("/login");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "验证器确认未完成。");
      setConfirmation("");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copySetupKey() {
    if (!stage) return;
    try { await navigator.clipboard.writeText(stage.setupKey); setMessage("Setup Key 已复制。完成扫码后继续确认。"); } catch { setMessage("无法自动复制，请手动记录 Setup Key。"); }
  }

  if (stage) {
    return <form className="selfhost-login-form" onSubmit={finish}>
      <section className="setup-secret"><h3>Google Authenticator Setup Key</h3><span><code>{stage.setupKey}</code><button type="button" className="icon-button" onClick={copySetupKey} aria-label="复制 Setup Key"><Copy size={16} /></button></span></section>
      <p className="login-note">在 Google Authenticator 中选择“输入设置密钥”，类型选“基于时间”。确认码不会被保存。</p>
      <label htmlFor="activation-user-code">Google 验证码<input id="activation-user-code" required autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" value={confirmation} onChange={(event) => setConfirmation(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位验证码" /></label>
      {message && <p className="login-error" role="alert">{message}</p>}
      <button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoaderCircle className="button-spinner" size={19} /> : <Check size={19} />}{isSubmitting ? "正在确认" : "确认并启用账号"}</button>
    </form>;
  }

  return <form className="selfhost-login-form" onSubmit={begin}>
    <label htmlFor="activation-code">一次性激活码<input id="activation-code" required autoComplete="one-time-code" value={activationCode} onChange={(event) => setActivationCode(cleanCode(event.target.value))} placeholder="例如 ABCDE-FGHIJ-…" /></label>
    <label htmlFor="activation-password">设置登录密码<input id="activation-password" required type="password" minLength={14} maxLength={512} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 14 位" /></label>
    <p className="login-note">下一步将生成仅供你扫码的 Google 验证器密钥。</p>
    {message && <p className="login-error" role="alert">{message}</p>}
    <button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoaderCircle className="button-spinner" size={19} /> : <ShieldCheck size={19} />}{isSubmitting ? "正在准备" : "继续设置验证器"}</button>
  </form>;
}
