"use client";

import { Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";

type ChangePasswordResponse = { next?: string; error?: string };

export default function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [userCode, setUserCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    if (newPassword !== confirmation) {
      setMessage("两次输入的新密码不一致。");
      return;
    }
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, userCode }),
      });
      const payload = await response.json().catch(() => ({})) as ChangePasswordResponse;
      if (!response.ok) throw new Error(payload.error || "密码更新未完成，请稍后重试。");
      window.location.assign(payload.next?.startsWith("/") ? payload.next : "/login");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "密码更新未完成，请稍后重试。");
      setNewPassword("");
      setConfirmation("");
      setUserCode("");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="selfhost-login-form" onSubmit={submit}>
      <label htmlFor="current-password">当前登录密码
        <span className="login-password-field"><input id="current-password" type={showPassword ? "text" : "password"} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /><button type="button" className="icon-button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "隐藏密码" : "显示密码"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>
      </label>
      <label htmlFor="new-password">新登录密码
        <input id="new-password" type={showPassword ? "text" : "password"} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={14} maxLength={512} required aria-describedby="new-password-note" />
        <small id="new-password-note">至少 14 位，建议使用随机密码。</small>
      </label>
      <label htmlFor="confirm-password">确认新登录密码
        <input id="confirm-password" type={showPassword ? "text" : "password"} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={14} maxLength={512} required />
      </label>
      <label htmlFor="change-user-code">Google 验证码
        <input id="change-user-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" value={userCode} onChange={(event) => setUserCode(event.target.value.replace(/\D/g, "").slice(0, 6))} required placeholder="6 位验证码" />
      </label>
      {message && <p className="login-error" role="alert">{message}</p>}
      <button className="login-action" type="submit" disabled={isSubmitting}>
        {isSubmitting ? <LoaderCircle className="button-spinner" size={19} aria-hidden="true" /> : <ShieldCheck size={19} aria-hidden="true" />}
        {isSubmitting ? "正在更新" : "确认并更新密码"}
      </button>
      <p className="login-note"><KeyRound size={15} aria-hidden="true" /> 更新后需使用新密码重新登录。</p>
    </form>
  );
}
