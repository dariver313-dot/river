"use client";

import { Check, LoaderCircle, Mail, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";

function cleanCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 64);
}

export default function PasswordRecoveryForm() {
  const [account, setAccount] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [requested, setRequested] = useState(false);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true); setMessage("");
    try {
      await fetch("/api/auth/password-recovery", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ account }) });
      setRequested(true);
      setMessage("如账号已登记安全邮箱，恢复码会在几分钟内送达。");
    } catch { setMessage("请求已提交；请检查安全邮箱。 "); } finally { setIsSubmitting(false); }
  }

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true); setMessage("");
    try {
      const response = await fetch("/api/auth/password-recovery", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ action: "complete", code, password }) });
      const payload = await response.json().catch(() => ({})) as { completed?: boolean; error?: string };
      if (!response.ok || !payload.completed) throw new Error(payload.error || "密码恢复未完成。");
      window.location.assign("/login");
    } catch (error) { setMessage(error instanceof Error ? error.message : "密码恢复未完成。"); } finally { setIsSubmitting(false); }
  }

  if (requested) return <form className="selfhost-login-form" onSubmit={complete}><label htmlFor="recovery-code">一次性恢复码<input id="recovery-code" required autoComplete="one-time-code" value={code} onChange={(event) => setCode(cleanCode(event.target.value))} placeholder="例如 ABCDE-FGHIJ-…" /></label><label htmlFor="recovery-password">新的登录密码<input id="recovery-password" required type="password" minLength={14} maxLength={512} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 14 位" /></label>{message && <p className="login-note" role="status">{message}</p>}<button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoaderCircle className="button-spinner" size={19} /> : <Check size={19} />}{isSubmitting ? "正在恢复" : "重设密码"}</button></form>;
  return <form className="selfhost-login-form" onSubmit={requestCode}><label htmlFor="recovery-account">登录账号<input id="recovery-account" required value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="username" placeholder="name@example.com 或 dajiang01" /></label>{message && <p className="login-note" role="status">{message}</p>}<button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoaderCircle className="button-spinner" size={19} /> : <Mail size={19} />}{isSubmitting ? "正在发送" : "发送恢复码"}</button><a className="login-text-link" href="/login"><ShieldCheck size={15} />返回登录</a></form>;
}
