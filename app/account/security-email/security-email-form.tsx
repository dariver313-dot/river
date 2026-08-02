"use client";

import { FormEvent, useState } from "react";
import { MailCheck, ShieldCheck } from "lucide-react";
import { LoadingMark } from "../../components/loading-indicator";

type RequestResponse = { unchanged?: boolean; step?: "confirm_current" | "confirm_new"; expiresAt?: string; error?: string };
type ConfirmResponse = { updated?: boolean; requiresRelogin?: boolean; error?: string };

export default function SecurityEmailForm() {
  const [securityEmail, setSecurityEmail] = useState("");
  const [code, setCode] = useState("");
  const [userCode, setUserCode] = useState("");
  const [step, setStep] = useState<"request" | "confirm_current" | "confirm_new">("request");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const canRequestCode = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(securityEmail.trim())
    && userCode.length === 6;

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
      const nextStep = payload.step === "confirm_current" ? "confirm_current" : "confirm_new";
      setStep(nextStep);
      setMessage(nextStep === "confirm_current" ? "确认码已发送到当前安全邮箱。" : "确认码已发送到新邮箱。");
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
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          action: step === "confirm_current" ? "confirm_current" : "confirm_new",
          securityEmail,
          code,
        }),
      });
      const payload = await response.json().catch(() => ({})) as ConfirmResponse;
      if (!response.ok) throw new Error(payload.error || "确认未完成，请重试。");
      if (step === "confirm_current") {
        setStep("confirm_new");
        setCode("");
        setMessage("原邮箱已确认，确认码已发送到新邮箱。");
        return;
      }
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

  if (step !== "request") {
    return <form className="selfhost-login-form" onSubmit={confirmCode}>
      <p className="login-note">{step === "confirm_current"
        ? <>确认码已发送到当前已验证的安全邮箱。确认后，系统才会向 <strong>{securityEmail}</strong> 发送新邮箱确认码。</>
        : <>确认码已发送至 <strong>{securityEmail}</strong>。如需修改地址，请返回重新开始。</>}</p>
      <label htmlFor="security-email-code">{step === "confirm_current" ? "原邮箱确认码" : "新邮箱确认码"}
        <input id="security-email-code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 80))} autoComplete="one-time-code" required placeholder={step === "confirm_current" ? "输入原安全邮箱中的确认码" : "输入新安全邮箱中的确认码"} />
      </label>
      {message && <p className="login-error" role="status">{message}</p>}
      <button className="login-action" type="submit" disabled={isSubmitting}>{isSubmitting ? <LoadingMark className="button-loading-mark" /> : <MailCheck size={19} />}{step === "confirm_current" ? "确认原邮箱" : "确认并更新"}</button>
      <button type="button" className="login-text-button" onClick={() => { setStep("request"); setCode(""); setMessage(""); }} disabled={isSubmitting}>返回修改邮箱</button>
    </form>;
  }

  return <form className="selfhost-login-form" onSubmit={requestCode}>
    <label htmlFor="security-email">新安全邮箱
      <input id="security-email" type="email" value={securityEmail} onChange={(event) => setSecurityEmail(event.target.value)} autoComplete="email" required placeholder="name@example.com" />
    </label>
    <label htmlFor="security-email-user-code">Google 验证码
      <input id="security-email-user-code" required value={userCode} onChange={(event) => setUserCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="输入当前 6 位验证码" />
    </label>
    <p className="login-note">首次设置会验证新邮箱；更换已验证邮箱时，会先验证原邮箱，再验证新邮箱。</p>
    {message && <p className="login-error" role="status">{message}</p>}
    <button className="login-action" type="submit" disabled={isSubmitting || !canRequestCode}>{isSubmitting ? <LoadingMark className="button-loading-mark" /> : <ShieldCheck size={19} />}发送确认码</button>
  </form>;
}
