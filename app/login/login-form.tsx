"use client";

import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LoadingMark } from "../components/loading-indicator";

type LoginResponse = {
  next?: string;
  error?: string;
  challengeRequired?: boolean;
  challengeId?: string;
  challengeBinding?: string;
  securityEmail?: string;
  expiresAt?: string;
};

type LoginChallenge = { id: string; binding: string; securityEmail: string; expiresAt: string };

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [userCode, setUserCode] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [challengeCode, setChallengeCode] = useState("");

  function digits(value: string) {
    return value.replace(/\D/g, "").slice(0, 6);
  }

  function challengeDigits(value: string) {
    return value.replace(/\D/g, "").slice(0, 8);
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
          password,
          userCode,
          returnTo: searchParams.get("return_to") ?? "/",
        }),
      });
      const payload = await response.json().catch(() => ({})) as LoginResponse;
      if (response.status === 202 && payload.challengeRequired && payload.challengeId && payload.challengeBinding && payload.securityEmail && payload.expiresAt) {
        setChallenge({ id: payload.challengeId, binding: payload.challengeBinding, securityEmail: payload.securityEmail, expiresAt: payload.expiresAt });
        setPassword("");
        setUserCode("");
        return;
      }
      if (!response.ok) throw new Error(payload.error || "登录未完成，请稍后重试。");
      window.location.assign(payload.next?.startsWith("/") ? payload.next : "/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录未完成，请稍后重试。");
      setPassword("");
      setUserCode("");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function confirmChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge || isSubmitting) return;
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/login-challenge", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.id,
          challengeBinding: challenge.binding,
          code: challengeCode,
          returnTo: searchParams.get("return_to") ?? "/",
        }),
      });
      const payload = await response.json().catch(() => ({})) as LoginResponse;
      if (!response.ok) throw new Error(payload.error || "安全确认未完成，请稍后重试。");
      window.location.assign(payload.next?.startsWith("/") ? payload.next : "/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "安全确认未完成，请稍后重试。");
      setChallengeCode("");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (challenge) {
    return (
      <form className="selfhost-login-form" onSubmit={confirmChallenge}>
        <div className="login-challenge-heading">
          <ShieldCheck size={20} aria-hidden="true" />
          <div><strong>确认本次登录</strong><p>已向 {challenge.securityEmail} 发送 8 位安全确认码。</p></div>
        </div>
        <label htmlFor="login-challenge-code">安全确认码
          <input id="login-challenge-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" value={challengeCode} onChange={(event) => setChallengeCode(challengeDigits(event.target.value))} required autoFocus placeholder="8 位确认码" />
        </label>
        <p className="login-challenge-expiry">确认码将在 {new Date(challenge.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 失效。</p>
        {message && <p className="login-error" role="alert">{message}</p>}
        <button className="login-action" type="submit" disabled={isSubmitting}>
          {isSubmitting ? <LoadingMark className="button-loading-mark" /> : <ShieldCheck size={19} aria-hidden="true" />}
          {isSubmitting ? "正在确认" : "确认并进入"}
        </button>
        <button className="login-text-button" type="button" onClick={() => { setChallenge(null); setChallengeCode(""); setMessage(""); }} disabled={isSubmitting}>返回重新登录</button>
      </form>
    );
  }

  return (
    <form className="selfhost-login-form" onSubmit={submit}>
      <label htmlFor="login-email">登录账号
        <input id="login-email" type="text" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required placeholder="name@example.com 或 dajiang01" />
      </label>
      <label htmlFor="login-password">登录密码
        <span className="login-password-field"><input id="login-password" type={isPasswordVisible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required placeholder="输入登录密码" /><button type="button" className="icon-button" onClick={() => setIsPasswordVisible((value) => !value)} aria-label={isPasswordVisible ? "隐藏登录密码" : "显示登录密码"}>{isPasswordVisible ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>
      </label>
      <label htmlFor="login-user-code">Google 验证码
        <input id="login-user-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" value={userCode} onChange={(event) => setUserCode(digits(event.target.value))} required placeholder="6 位验证码" />
      </label>
      {message && <p className="login-error" role="alert">{message}</p>}
      <button className="login-action" type="submit" disabled={isSubmitting}>
        {isSubmitting ? <LoadingMark className="button-loading-mark" /> : <ShieldCheck size={19} aria-hidden="true" />}
        {isSubmitting ? "正在验证" : "验证并进入"}
      </button>
      <a className="login-text-link" href="/recover">忘记登录密码</a>
    </form>
  );
}
