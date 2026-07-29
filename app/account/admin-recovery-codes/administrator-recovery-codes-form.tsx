"use client";

import { Check, Copy, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { FormEvent, useState } from "react";

type Response = { recoveryCodes?: string[]; error?: string };

export default function AdministratorRecoveryCodesForm() {
  const [userCode, setUserCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/admin-recovery-codes", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userCode }) });
      const payload = await response.json().catch(() => ({})) as Response;
      if (!response.ok || !Array.isArray(payload.recoveryCodes) || payload.recoveryCodes.length === 0) throw new Error(payload.error || "恢复码生成失败，请重试。");
      setRecoveryCodes(payload.recoveryCodes);
      setUserCode("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "恢复码生成失败，请重试。");
      setUserCode("");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (recoveryCodes) return <section className="setup-recovery-codes" aria-live="polite"><div className="login-challenge-heading"><ShieldCheck size={20} aria-hidden="true" /><div><strong>保存新的恢复码</strong><p>每个恢复码只能使用一次，关闭后无法再次查看。</p></div></div><div className="recovery-code-list">{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><button type="button" className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(recoveryCodes.join("\n")); setMessage("恢复码已复制，请离线保存。"); } catch { setMessage("无法自动复制，请手动离线保存。 "); } }}><Copy size={16} />复制全部</button>{message && <p className="login-note" role="status">{message}</p>}<Link className="login-action" href="/"><Check size={19} />已安全保存，返回系统</Link></section>;

  return <form className="selfhost-login-form" onSubmit={submit}><label htmlFor="recovery-codes-totp">Google 验证码<input id="recovery-codes-totp" required autoFocus inputMode="numeric" autoComplete="one-time-code" value={userCode} onChange={(event) => setUserCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位验证码" /></label>{message && <p className="login-error" role="alert">{message}</p>}<button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoaderCircle className="button-spinner" size={19} /> : <KeyRound size={19} />}{isSubmitting ? "正在生成" : "生成新的恢复码"}</button></form>;
}
