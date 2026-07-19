"use client";

import { Check, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";

export default function CompleteSetupButton() {
  const searchParams = useSearchParams();
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);

  async function complete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving) return;
    if (password !== passwordConfirmation) {
      setMessage("两次输入的登录密码不一致。");
      return;
    }
    setIsSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/setup/complete", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: searchParams.get("token"), password }),
      });
      if (!response.ok) throw new Error("初始化令牌无效或已失效。");
      window.location.replace("/login");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "确认未完成，请稍后重试。");
      setIsSaving(false);
    }
  }

  return <form className="selfhost-login-form setup-complete-form" onSubmit={complete}>
    <label htmlFor="initial-login-password">设置管理员登录密码
      <span className="login-password-field"><input id="initial-login-password" type={isPasswordVisible ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={14} maxLength={512} autoComplete="new-password" required placeholder="至少 14 位" /><button type="button" className="icon-button" onClick={() => setIsPasswordVisible((value) => !value)} aria-label={isPasswordVisible ? "隐藏登录密码" : "显示登录密码"}>{isPasswordVisible ? <EyeOff size={17} /> : <Eye size={17} />}</button></span>
      <small>只保存不可逆的密码哈希；建议使用密码管理器生成随机密码。</small>
    </label>
    <label htmlFor="initial-login-password-confirm">再次输入登录密码
      <input id="initial-login-password-confirm" type={isPasswordVisible ? "text" : "password"} value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} minLength={14} maxLength={512} autoComplete="new-password" required />
    </label>
    <button className="login-action" type="submit" disabled={isSaving}>{isSaving ? <LoaderCircle className="button-spinner" size={19} aria-hidden="true" /> : <Check size={19} aria-hidden="true" />}{isSaving ? "正在确认" : "完成初始化并进入登录"}</button>
    {message && <p className="login-error" role="alert">{message}</p>}
  </form>;
}
