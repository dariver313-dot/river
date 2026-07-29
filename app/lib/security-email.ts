import nodemailer from "nodemailer";

function smtpConfiguration() {
  const host = process.env.DJMIMA_SMTP_HOST?.trim();
  const from = process.env.DJMIMA_SMTP_FROM?.trim();
  if (!host || !from) return null;
  const port = Number(process.env.DJMIMA_SMTP_PORT ?? "587");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const user = process.env.DJMIMA_SMTP_USER?.trim();
  const pass = process.env.DJMIMA_SMTP_PASSWORD;
  const secure = process.env.DJMIMA_SMTP_SECURE === "1";
  return { host, from, port, secure, auth: user && pass ? { user, pass } : undefined };
}

function transporterFor(config: NonNullable<ReturnType<typeof smtpConfiguration>>) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Port 587 uses STARTTLS. Do not silently send recovery codes over a
    // plaintext fallback when a mail server is misconfigured.
    requireTLS: !config.secure,
    auth: config.auth,
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
}

let transportReadiness: { checkedAt: number; ready: boolean } | null = null;

export function securityEmailConfigured() {
  return Boolean(smtpConfiguration());
}

/** Cached verification for the deployment health endpoint; no email is sent. */
export async function securityEmailReady() {
  const now = Date.now();
  if (transportReadiness && now - transportReadiness.checkedAt < 60_000) return transportReadiness.ready;
  const config = smtpConfiguration();
  if (!config) {
    transportReadiness = { checkedAt: now, ready: false };
    return false;
  }
  try {
    await transporterFor(config).verify();
    transportReadiness = { checkedAt: now, ready: true };
  } catch {
    transportReadiness = { checkedAt: now, ready: false };
  }
  return transportReadiness.ready;
}

export async function sendNewCountryChallenge(input: { to: string; code: string; countryCode: string | null; expiresAt: string }) {
  const config = smtpConfiguration();
  if (!config) throw new Error("未配置安全邮箱通知服务，暂不能确认新国家登录。");
  const place = input.countryCode || "未知地区";
  const transporter = transporterFor(config);
  await transporter.sendMail({
    from: config.from,
    to: input.to,
    subject: "djmima 登录地点确认",
    text: `检测到来自 ${place} 的登录地点变化。确认码：${input.code}\n该码将在 ${new Date(input.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 前有效。若非本人操作，请立即联系管理员。`,
  });
}

async function sendAccountCode(input: { to: string; subject: string; lead: string; code: string; expiresAt: string }) {
  const config = smtpConfiguration();
  if (!config) throw new Error("未配置安全邮箱通知服务。");
  const transporter = transporterFor(config);
  await transporter.sendMail({
    from: config.from,
    to: input.to,
    subject: input.subject,
    text: `${input.lead}\n一次性安全码：${input.code}\n该码将在 ${new Date(input.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 前有效。请勿转发或截图保存。`,
  });
}

export function sendAccountActivation(input: { to: string; code: string; expiresAt: string }) {
  return sendAccountCode({
    ...input,
    subject: "djmima 账号激活",
    lead: "你的账号已创建。请在激活页面输入以下一次性安全码，自行设置登录密码和 Google 验证器。",
  });
}

export function sendPasswordRecoveryCode(input: { to: string; code: string; expiresAt: string }) {
  return sendAccountCode({
    ...input,
    subject: "djmima 密码恢复确认",
    lead: "收到密码恢复请求。请仅在你本人发起操作时输入以下一次性安全码。",
  });
}

export function sendSecurityEmailChangeCode(input: { to: string; code: string; expiresAt: string }) {
  return sendAccountCode({
    ...input,
    subject: "djmima 安全邮箱变更确认",
    lead: "你正在将此邮箱设为 djmima 的安全邮箱。请仅在你本人发起操作时输入以下一次性安全码。",
  });
}

export function sendAuthenticatorResetCode(input: { to: string; code: string; expiresAt: string }) {
  return sendAccountCode({
    ...input,
    subject: "djmima 登录验证器重置",
    lead: "管理员已按身份核验流程重置你的 Google 验证器。请在验证器恢复页面输入以下一次性安全码并重新绑定验证器。若非本人操作，请立即联系管理员。",
  });
}
