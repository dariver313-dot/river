"use client";

import { FormEvent, useState } from "react";
import { LoaderCircle, MailCheck, ShieldCheck } from "lucide-react";

type RequestResponse = { unchanged?: boolean; expiresAt?: string; error?: string };
type ConfirmResponse = { updated?: boolean; requiresRelogin?: boolean; error?: string };

export default function SecurityEmailForm({ requiresGoogleCode }: { requiresGoogleCode: boolean }) {
  const [securityEmail, setSecurityEmail] = useState("");
  const [code, setCode] = useState("");
  const [userCode, setUserCode] = useState("");
  const [step, setStep] = useState<"request" | "confirm">("request");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/security-email", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ securityEmail, userCode }),
      });
      const payload = await response.json().catch(() => ({})) as RequestResponse;
      if (!response.ok) throw new Error(payload.error || "暂时无法发送确认码。");
      if (payload.unchanged) { setMessage("该邮箱已是当前安全邮箱。"); return; }
      setStep("confirm");
      setMessage("确认码已发送到新邮箱。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "暂时无法发送确认码。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function confirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/security-email", {
        method: "PATCH", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ securityEmail, code }),
      });
      const payload = await response.json().catch(() => ({})) as ConfirmResponse;
      if (!response.ok) throw new Error(payload.error || "确认未完成，请重试。");
      if (payload.requiresRelogin) {
        window.location.assign("/login");
        return;
      }
      setMessage("安全邮箱已验证。");
      setCode("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "确认未完成，请重试。");
      setCode("");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (step === "confirm") {
    return <form className="selfhost-login-form" onSubmit={confirmCode}>
      <label htmlFor="security-email-code">邮箱确认码
        <input id="security-email-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 80))} autoComplete="one-time-code" required placeholder="输入安全邮箱中的确认码" />
      </label>
      {message && <p className="login-error" role="status">{message}</p>}
      <button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoaderCircle className="button-spinner" size={19} /> : <MailCheck size={19} />}确认并更新</button>
      <button type="button" className="login-text-button" onClick={() => { setStep("request"); setCode(""); setMessage(""); }} disabled={isSubmitting}>更换邮箱</button>
    </form>;
  }

  return <form className="selfhost-login-form" onSubmit={requestCode}>
    <label htmlFor="security-email">新安全邮箱
      <input id="security-email" type="email" value={securityEmail} onChange={(event) => setSecurityEmail(event.target.value)} autoComplete="email" required placeholder="name@example.com" />
    </label>
    {requiresGoogleCode && <label htmlFor="security-email-user-code">Google 验证码
      <input id="security-email-user-code" required value={userCode} onChange={(event) => setUserCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="输入当前 6 位验证码" />
    </label>}
    {message && <p className="login-error" role="status">{message}</p>}
    <button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoaderCircle className="button-spinner" size={19} /> : <ShieldCheck size={19} />}发送确认码</button>
  </form>;
}
