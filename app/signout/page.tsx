"use client";

import { LogOut } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { LoadingMark } from "../components/loading-indicator";

export default function SignOutPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  async function signOut() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error("退出请求未完成，请重试。");
      window.location.replace("/login");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "退出请求未完成，请重试。");
      setIsSubmitting(false);
    }
  }

  return <main className="login-shell"><section className="login-panel" aria-labelledby="signout-title"><div className="login-card"><span className="login-card-icon" aria-hidden="true"><LogOut size={24} /></span><p className="eyebrow">安全会话</p><h1 id="signout-title">确认退出登录</h1><p className="login-copy">退出后，本设备需要重新验证账号、密码和 Google 验证码。</p>{message && <p className="login-error" role="alert">{message}</p>}<div className="login-actions"><button className="login-action" type="button" onClick={() => void signOut()} disabled={isSubmitting}>{isSubmitting ? <LoadingMark className="button-loading-mark" /> : <LogOut size={19} aria-hidden="true" />}{isSubmitting ? "正在退出" : "确认退出"}</button><Link className="login-text-link" href="/">返回应用</Link></div></div></section></main>;
}
