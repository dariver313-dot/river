"use client";

import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import CompleteSetupButton from "./complete-button";

type SetupDetails = { email: string; primarySecret: string };

function tokenFromFragment() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.hash.slice(1)).get("token")?.trim() ?? "";
}

export default function SetupClient() {
  // Keep the fragment token in React state before clearing it from the address
  // bar. Effects can run more than once during development-style remounts;
  // rereading window.location there would turn a valid token into an empty one.
  const [suppliedToken] = useState(tokenFromFragment);
  const [token, setToken] = useState("");
  const [setup, setSetup] = useState<SetupDetails | null>(null);
  const [message, setMessage] = useState("正在读取初始化令牌。");

  useEffect(() => {
    // Remove the secret before any user interaction can copy or share the URL.
    window.history.replaceState(null, "", window.location.pathname);
    let active = true;
    if (!suppliedToken) {
      void Promise.resolve().then(() => {
        if (active) setMessage("初始化令牌缺失或已失效。请在服务器上重新生成初始化链接。");
      });
      return () => { active = false; };
    }
    void fetch("/api/setup/prepare", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: suppliedToken }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as SetupDetails & { error?: string };
      if (!response.ok || !payload.email || !payload.primarySecret) throw new Error(payload.error ?? "初始化令牌无效或已失效。");
      if (!active) return;
      setToken(suppliedToken);
      setSetup({ email: payload.email, primarySecret: payload.primarySecret });
      setMessage("");
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : "无法读取初始化信息。");
    });
    return () => { active = false; };
  }, [suppliedToken]);

  if (!setup) return <p className="login-error" role="alert">{message}</p>;
  return <>
    <div className="setup-account">初始管理员：<strong>{setup.email}</strong></div>
    <section className="setup-secret"><h3>Setup Key</h3><code>{setup.primarySecret}</code></section>
    <p className="login-note"><KeyRound size={15} aria-hidden="true" /> Setup Key 仅用于当前初始化；完成后请勿保留截图或文本副本。</p>
    <CompleteSetupButton token={token} />
  </>;
}
