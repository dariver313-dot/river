"use client";

import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { useSearchParams } from "next/navigation";

type LoginResponse = { next?: string; error?: string };

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [userCode, setUserCode] = useState("");
  const [approverCode, setApproverCode] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function digits(value: string) {
    return value.replace(/\D/g, "").slice(0, 6);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          userCode,
          approverCode,
          returnTo: searchParams.get("return_to") ?? "/",
        }),
      });
      const payload = await response.json().catch(() => ({})) as LoginResponse;
      if (!response.ok) throw new Error(payload.error || "登录未完成，请稍后重试。");
      window.location.assign(payload.next?.startsWith("/") ? payload.next : "/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录未完成，请稍后重试。");
      setUserCode("");
      setApproverCode("");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="selfhost-login-form" onSubmit={submit}>
      <label htmlFor="login-email">登录邮箱
        <input id="login-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required placeholder="name@example.com" />
      </label>
      <label htmlFor="login-user-code">本人 Google 验证码
        <input id="login-user-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" value={userCode} onChange={(event) => setUserCode(digits(event.target.value))} required placeholder="6 位验证码" aria-describedby="login-user-code-note" />
        <small id="login-user-code-note">来自你本人配置的 Google 验证器。</small>
      </label>
      <label htmlFor="login-approver-code">协作人 Google 验证码
        <input id="login-approver-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" value={approverCode} onChange={(event) => setApproverCode(digits(event.target.value))} required placeholder="6 位验证码" />
        <small>由独立协作人确认，不与本人验证器共用。</small>
      </label>
      {message && <p className="login-error" role="alert">{message}</p>}
      <button className="login-action" type="submit" disabled={isSubmitting}>
        {isSubmitting ? <LoaderCircle className="button-spinner" size={19} aria-hidden="true" /> : <ShieldCheck size={19} aria-hidden="true" />}
        {isSubmitting ? "正在验证" : "验证并进入"}
      </button>
      <p className="login-note"><KeyRound size={15} aria-hidden="true" /> 本站不保存登录密码；验证成功后仅在当前设备建立短时安全会话。</p>
    </form>
  );
}
