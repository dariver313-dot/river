"use client";

import { Check, Copy, LoaderCircle, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";

type RecoveryStage = { setupKey: string; confirmationCode: string };
const cleanCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 64);

export default function AdministratorRecoveryForm() {
  const [recoveryCode, setRecoveryCode] = useState("");
  const [password, setPassword] = useState("");
  const [userCode, setUserCode] = useState("");
  const [stage, setStage] = useState<RecoveryStage | null>(null);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (isSubmitting) return;
    setIsSubmitting(true); setMessage("");
    try {
      const response = await fetch("/api/auth/admin-recovery", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ recoveryCode, password }) });
      const payload = await response.json().catch(() => ({})) as RecoveryStage & { error?: string };
      if (!response.ok || !payload.setupKey || !payload.confirmationCode) throw new Error(payload.error || "无法开始管理员恢复。");
      setStage({ setupKey: payload.setupKey, confirmationCode: payload.confirmationCode }); setPassword("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法开始管理员恢复。"); } finally { setIsSubmitting(false); }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!stage || isSubmitting) return;
    setIsSubmitting(true); setMessage("");
    try {
      const response = await fetch("/api/auth/admin-recovery", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ action: "confirm", recoveryCode, confirmationCode: stage.confirmationCode, userCode }) });
      const payload = await response.json().catch(() => ({})) as { completed?: boolean; error?: string };
      if (!response.ok || !payload.completed) throw new Error(payload.error || "管理员恢复未完成。");
      window.location.assign("/login");
    } catch (error) { setMessage(error instanceof Error ? error.message : "管理员恢复未完成。"); setUserCode(""); } finally { setIsSubmitting(false); }
  }

  if (stage) return <form className="selfhost-login-form" onSubmit={confirm}><section className="setup-secret"><h3>新的 Google Authenticator Setup Key</h3><span><code>{stage.setupKey}</code><button type="button" className="icon-button" onClick={() => void navigator.clipboard.writeText(stage.setupKey).then(() => setMessage("Setup Key 已复制。"), () => setMessage("无法自动复制，请手动记录 Setup Key。"))} aria-label="复制 Setup Key"><Copy size={16} /></button></span></section><label htmlFor="admin-recovery-totp">Google 验证码<input id="admin-recovery-totp" required autoFocus inputMode="numeric" autoComplete="one-time-code" value={userCode} onChange={(event) => setUserCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位验证码" /></label>{message && <p className="login-error" role="alert">{message}</p>}<button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoaderCircle className="button-spinner" size={19} /> : <Check size={19} />}{isSubmitting ? "正在恢复" : "确认并恢复管理员"}</button></form>;
  return <form className="selfhost-login-form" onSubmit={begin}><label htmlFor="admin-recovery-code">离线恢复码<input id="admin-recovery-code" required autoComplete="one-time-code" value={recoveryCode} onChange={(event) => setRecoveryCode(cleanCode(event.target.value))} placeholder="例如 ABCDE-FGHIJ-…" /></label><label htmlFor="admin-recovery-password">新的登录密码<input id="admin-recovery-password" required type="password" minLength={14} maxLength={512} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 14 位" /></label>{message && <p className="login-error" role="alert">{message}</p>}<button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoaderCircle className="button-spinner" size={19} /> : <ShieldCheck size={19} />}{isSubmitting ? "正在验证" : "继续设置验证器"}</button></form>;
}
