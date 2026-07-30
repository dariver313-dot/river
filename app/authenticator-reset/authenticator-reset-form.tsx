"use client";

import { Check, Copy, KeyRound } from "lucide-react";
import { FormEvent, useState } from "react";
import { LoadingMark } from "../components/loading-indicator";

type ResetStage = { setupKey: string; confirmationCode: string; expiresAt: string };

function cleanCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 64);
}

export default function AuthenticatorResetForm() {
  const [code, setCode] = useState("");
  const [userCode, setUserCode] = useState("");
  const [stage, setStage] = useState<ResetStage | null>(null);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true); setMessage("");
    try {
      const response = await fetch("/api/auth/authenticator-reset", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      const payload = await response.json().catch(() => ({})) as ResetStage & { error?: string };
      if (!response.ok || !payload.setupKey || !payload.confirmationCode) throw new Error(payload.error || "验证器恢复未开始。");
      setStage({ setupKey: payload.setupKey, confirmationCode: payload.confirmationCode, expiresAt: payload.expiresAt });
      setCode("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "验证器恢复未开始。"); } finally { setIsSubmitting(false); }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stage || isSubmitting) return;
    setIsSubmitting(true); setMessage("");
    try {
      const response = await fetch("/api/auth/authenticator-reset", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm", code: stage.confirmationCode, userCode }) });
      const payload = await response.json().catch(() => ({})) as { completed?: boolean; error?: string };
      if (!response.ok || !payload.completed) throw new Error(payload.error || "验证器确认未完成。");
      window.location.assign("/login");
    } catch (error) { setMessage(error instanceof Error ? error.message : "验证器确认未完成。"); setUserCode(""); } finally { setIsSubmitting(false); }
  }

  if (stage) return <form className="selfhost-login-form" onSubmit={confirm}><section className="setup-secret"><h3>Google Authenticator Setup Key</h3><span><code>{stage.setupKey}</code><button type="button" className="icon-button" onClick={() => void navigator.clipboard.writeText(stage.setupKey)} aria-label="复制 Setup Key"><Copy size={16} /></button></span></section><p className="login-note">完成扫码后输入 6 位 Google 验证码。此密钥仅显示一次。</p><label htmlFor="reset-user-code">Google 验证码<input id="reset-user-code" required autoFocus inputMode="numeric" autoComplete="one-time-code" value={userCode} onChange={(event) => setUserCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位验证码" /></label>{message && <p className="login-error" role="alert">{message}</p>}<button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoadingMark className="button-loading-mark" /> : <Check size={19} />}{isSubmitting ? "正在确认" : "确认新的验证器"}</button></form>;

  return <form className="selfhost-login-form" onSubmit={begin}><label htmlFor="reset-code">安全邮箱恢复码<input id="reset-code" required autoFocus autoComplete="one-time-code" value={code} onChange={(event) => setCode(cleanCode(event.target.value))} placeholder="例如 ABCDE-FGHIJ-…" /></label>{message && <p className="login-error" role="alert">{message}</p>}<button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoadingMark className="button-loading-mark" /> : <KeyRound size={19} />}{isSubmitting ? "正在验证" : "继续恢复"}</button><a className="login-text-link" href="/login">返回登录</a></form>;
}
